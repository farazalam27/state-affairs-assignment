#!/usr/bin/env python3
"""
Parallel Download and Transcription Processor
Downloads videos and transcribes them concurrently for maximum efficiency
"""

import os
import sys
import time
import json
import logging
import asyncio
import aiohttp
import aiofiles
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor
import psycopg2
from psycopg2.extras import RealDictCursor
from datetime import datetime
import subprocess
from tqdm.asyncio import tqdm as async_tqdm
from tqdm import tqdm
import random
from multiprocessing import Pool, cpu_count

# Import necessary modules for transcription
import numpy as np
from faster_whisper import WhisperModel

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Module-level function for multiprocessing
def transcribe_chunk_worker(args):
    """Worker function for transcribing chunks (must be at module level for multiprocessing)"""
    chunk_info, whisper_model, transcription_mode = args
    
    # Initialize model for this process
    model = WhisperModel(
        whisper_model, 
        device="cpu",
        compute_type="int8",
        cpu_threads=2
    )
    
    # Select transcription parameters based on mode
    if transcription_mode == 'fast':
        beam_size = 3
        best_of = 3
        condition_on_previous_text = False
    else:  # quality mode
        beam_size = 5
        best_of = 5
        condition_on_previous_text = True
    
    # Transcribe
    segments, info = model.transcribe(
        str(chunk_info['path']),
        language="en",
        beam_size=beam_size,
        best_of=best_of,
        condition_on_previous_text=condition_on_previous_text,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500)
    )
    
    # Convert generator to list and adjust timestamps
    segment_list = []
    text_parts = []
    
    for segment in segments:
        # Adjust timestamps to account for chunk offset
        adjusted_segment = {
            'start': segment.start + chunk_info['start'],
            'end': segment.end + chunk_info['start'],
            'text': segment.text.strip()
        }
        if adjusted_segment['text']:
            segment_list.append(adjusted_segment)
            text_parts.append(adjusted_segment['text'])
    
    # Clean up chunk file
    Path(chunk_info['path']).unlink()
    
    return {
        'text': '\n'.join(text_parts),
        'segments': segment_list,
        'chunk_index': chunk_info['index']
    }

class ParallelProcessor:
    def __init__(self, db_url, max_downloads=3, max_transcriptions=2, chunk_duration=30):
        self.db_url = db_url
        self.max_downloads = max_downloads
        self.max_transcriptions = max_transcriptions
        self.chunk_duration = chunk_duration  # For audio chunking
        
        # Paths
        self.project_root = Path(__file__).parent.parent
        self.videos_dir = self.project_root / "tmp" / "videos"
        self.temp_dir = self.project_root / "tmp" / "chunks"
        
        # Create tmp directories if they don't exist
        self.videos_dir.mkdir(parents=True, exist_ok=True)
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        logger.info(f"Created temporary directories: {self.videos_dir} and {self.temp_dir}")
        
        # Queues for coordination
        self.download_queue = asyncio.Queue()
        self.transcription_queue = asyncio.Queue()
        
        # Progress tracking
        self.download_progress = {}
        self.transcription_progress = {}
        
        # Performance metrics
        self.performance_stats = {
            'downloads': {'successful': 0, 'failed': 0, 'total_bytes': 0, 'total_time': 0},
            'transcriptions': {'successful': 0, 'failed': 0, 'total_audio_duration': 0, 'total_time': 0}
        }
        
        # Transcription settings
        self.transcriptions_dir = self.project_root / "transcriptions"
        self.transcriptions_dir.mkdir(parents=True, exist_ok=True)
        self.whisper_model = os.environ.get('WHISPER_MODEL', 'small')
        self.delete_after = os.environ.get('DELETE_AFTER_TRANSCRIPTION', 'true').lower() == 'true'
        self.transcription_mode = os.environ.get('TRANSCRIPTION_MODE', 'quality')  # 'quality' or 'fast'
        
        # Initialize Whisper model
        logger.info(f"Loading Whisper model: {self.whisper_model}")
        self.model = WhisperModel(self.whisper_model, device="cpu", compute_type="int8")
        
        # CPU info for chunking
        self.total_cores = cpu_count()
        logger.info(f"System has {self.total_cores} CPU cores available")
        
    async def download_video(self, hearing, retry_count=0):
        """Download a video with progress tracking and retry logic"""
        video_id = hearing['id']
        video_url = hearing['url']
        video_path = self.videos_dir / f"{video_id}.mp4"
        max_retries = 3
        
        # Skip if already downloaded
        if video_path.exists() and video_path.stat().st_size > 0:
            logger.info(f"Video already downloaded: {hearing['title']}")
            return video_path
        
        logger.info(f"Starting download: {hearing['title']} (attempt {retry_count + 1}/{max_retries + 1})")
        
        # Track download start time
        self.download_progress[video_id] = {'start_time': time.time()}
        
        # Update status
        await self.update_status(video_id, 'download_status', 'downloading')
        
        try:
            # Check if this is an m3u8 stream
            if video_url.endswith('.m3u8') or 'HLS' in video_url:
                # Use ffmpeg for m3u8 streams
                logger.info(f"Detected m3u8 stream, using ffmpeg for {hearing['title']}")
                temp_path = str(video_path) + '.downloading'
                
                # FFmpeg command to download m3u8 stream
                cmd = [
                    'ffmpeg', '-i', video_url,
                    '-c', 'copy',
                    '-bsf:a', 'aac_adtstoasc',
                    '-f', 'mp4',
                    temp_path,
                    '-y'  # Overwrite if exists
                ]
                
                logger.info(f"Executing: {' '.join(cmd)}")
                
                # Run ffmpeg
                process = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                
                stdout, stderr = await process.communicate()
                
                if process.returncode != 0:
                    error_msg = stderr.decode() if stderr else "Unknown error"
                    raise Exception(f"FFmpeg failed: {error_msg}")
                
                # Move temp file to final location
                Path(temp_path).rename(video_path)
                
                # Get file size for stats
                file_size = video_path.stat().st_size
                logger.info(f"M3U8 download completed for {video_id}: {file_size} bytes")
                
            else:
                # Use regular HTTP download for direct MP4 files
                # Create SSL context that ignores certificate errors
                import ssl
                ssl_context = ssl.create_default_context()
                ssl_context.check_hostname = False
                ssl_context.verify_mode = ssl.CERT_NONE
                
                # Download with progress
                async with aiohttp.ClientSession(connector=aiohttp.TCPConnector(ssl=ssl_context)) as session:
                    async with session.get(video_url) as response:
                        total_size = int(response.headers.get('Content-Length', 0))
                        
                        # Initialize progress bar
                        progress_bar = async_tqdm(
                            total=total_size,
                            unit='B',
                            unit_scale=True,
                            desc=f"Downloading {hearing['title'][:30]}..."
                        )
                        
                        downloaded = 0
                        async with aiofiles.open(video_path, 'wb') as file:
                            async for chunk in response.content.iter_chunked(8192):
                                await file.write(chunk)
                                downloaded += len(chunk)
                                progress_bar.update(len(chunk))
                                
                                # Update progress tracking
                                self.download_progress[video_id] = {
                                    'total': total_size,
                                    'downloaded': downloaded,
                                    'percent': (downloaded / total_size * 100) if total_size > 0 else 0
                                }
                        
                        progress_bar.close()
            
            # Update database
            file_size = video_path.stat().st_size
            await self.update_download_complete(video_id, str(video_path.name), file_size)
            
            # Update performance stats
            download_time = time.time() - (self.download_progress.get(video_id, {}).get('start_time', time.time()))
            self.performance_stats['downloads']['successful'] += 1
            self.performance_stats['downloads']['total_bytes'] += file_size
            self.performance_stats['downloads']['total_time'] += download_time
            
            logger.info(f"Download complete: {hearing['title']} ({file_size / 1024 / 1024:.1f} MB)")
            return video_path
            
        except Exception as e:
            logger.error(f"Download failed for {hearing['title']}: {str(e)}")
            
            # Retry with exponential backoff
            if retry_count < max_retries:
                wait_time = (2 ** retry_count) + random.uniform(0, 1)  # Exponential backoff with jitter
                logger.info(f"Retrying download in {wait_time:.1f} seconds...")
                await asyncio.sleep(wait_time)
                return await self.download_video(hearing, retry_count + 1)
            else:
                logger.error(f"Max retries reached for {hearing['title']}")
                await self.update_status(video_id, 'download_status', 'failed', str(e))
                return None
    
    async def update_status(self, hearing_id, status_field, status_value, error_msg=None):
        """Update status in database"""
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self._update_status_sync, hearing_id, status_field, status_value, error_msg)
    
    def _update_status_sync(self, hearing_id, status_field, status_value, error_msg=None):
        """Synchronous database update"""
        with psycopg2.connect(self.db_url) as conn:
            with conn.cursor() as cur:
                # Add timestamp fields based on status changes
                if status_field == 'download_status' and status_value == 'downloading':
                    cur.execute(
                        f"UPDATE hearings SET {status_field} = %s, download_started_at = NOW() WHERE id = %s",
                        (status_value, hearing_id)
                    )
                elif status_field == 'transcription_status' and status_value == 'processing':
                    cur.execute(
                        f"UPDATE hearings SET {status_field} = %s, transcription_started_at = NOW() WHERE id = %s",
                        (status_value, hearing_id)
                    )
                else:
                    cur.execute(
                        f"UPDATE hearings SET {status_field} = %s WHERE id = %s",
                        (status_value, hearing_id)
                    )
                conn.commit()
    
    async def update_download_complete(self, hearing_id, filename, file_size):
        """Update download completion in database"""
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self._update_download_complete_sync, hearing_id, filename, file_size)
    
    def _update_download_complete_sync(self, hearing_id, filename, file_size):
        """Synchronous download completion update"""
        with psycopg2.connect(self.db_url) as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE hearings 
                    SET download_status = 'completed',
                        video_file_path = %s,
                        video_size_bytes = %s,
                        download_completed_at = NOW()
                    WHERE id = %s
                """, (filename, file_size, hearing_id))
                conn.commit()
    
    def get_audio_duration(self, audio_path):
        """Get duration of audio file in seconds"""
        cmd = [
            'ffprobe', '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            str(audio_path)
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        return float(result.stdout.strip())
    
    def extract_audio(self, video_path, audio_path):
        """Extract audio from video using ffmpeg"""
        cmd = [
            'ffmpeg', '-i', str(video_path),
            '-vn', '-acodec', 'pcm_s16le',
            '-ar', '16000', '-ac', '1',
            str(audio_path), '-y', '-loglevel', 'error'
        ]
        subprocess.run(cmd, check=True)
        return audio_path
    
    def split_audio_with_silence_detection(self, audio_path, hearing_id):
        """Split audio into chunks at silence boundaries"""
        duration = self.get_audio_duration(audio_path)
        chunks = []
        
        # First, detect silence periods
        silence_cmd = [
            'ffmpeg', '-i', str(audio_path),
            '-af', 'silencedetect=noise=-40dB:d=0.5',
            '-f', 'null', '-'
        ]
        result = subprocess.run(silence_cmd, capture_output=True, text=True)
        
        # Parse silence periods from stderr
        silence_periods = []
        for line in result.stderr.split('\n'):
            if 'silence_start:' in line:
                start = float(line.split('silence_start: ')[1].split()[0])
                silence_periods.append({'start': start})
            elif 'silence_end:' in line and silence_periods and 'end' not in silence_periods[-1]:
                end = float(line.split('silence_end: ')[1].split()[0])
                silence_periods[-1]['end'] = end
        
        # Create chunks based on silence periods
        current_start = 0
        chunk_num = 0
        
        while current_start < duration:
            # Target end time
            target_end = min(current_start + self.chunk_duration, duration)
            
            # Find nearest silence period to target_end
            best_split = target_end
            min_distance = float('inf')
            
            for silence in silence_periods:
                if 'end' in silence and current_start < silence['end'] <= target_end + 5:
                    distance = abs(silence['end'] - target_end)
                    if distance < min_distance:
                        min_distance = distance
                        best_split = silence['end']
            
            # Create chunk
            chunk_path = self.temp_dir / f"{hearing_id}_chunk_{chunk_num:03d}.wav"
            chunk_duration = best_split - current_start
            
            if chunk_duration > 0.5:  # Skip very short chunks
                cmd = [
                    'ffmpeg', '-i', str(audio_path),
                    '-ss', str(current_start),
                    '-t', str(chunk_duration),
                    '-c', 'copy', str(chunk_path),
                    '-y', '-loglevel', 'error'
                ]
                subprocess.run(cmd, check=True)
                
                chunks.append({
                    'path': chunk_path,
                    'start': current_start,
                    'duration': chunk_duration,
                    'index': chunk_num
                })
                chunk_num += 1
            
            current_start = best_split
        
        logger.info(f"Split audio into {len(chunks)} chunks")
        return chunks
    
    def merge_chunks(self, chunk_results):
        """Merge chunk transcriptions maintaining proper timestamps"""
        # Sort by chunk index
        chunk_results.sort(key=lambda x: x['chunk_index'])
        
        # Merge text with proper line breaks
        full_text = '\n\n'.join(chunk['text'] for chunk in chunk_results if chunk['text'])
        
        # Merge segments
        all_segments = []
        for chunk in chunk_results:
            all_segments.extend(chunk.get('segments', []))
        
        # Sort segments by start time
        all_segments.sort(key=lambda x: x['start'])
        
        return {
            'text': full_text.strip(),
            'segments': all_segments
        }
    
    async def download_worker(self):
        """Worker that processes download queue"""
        while True:
            try:
                hearing = await self.download_queue.get()
                if hearing is None:  # Shutdown signal
                    break
                
                # Download video
                video_path = await self.download_video(hearing)
                
                if video_path:
                    # Add to transcription queue
                    await self.transcription_queue.put(hearing)
                
                self.download_queue.task_done()
                
            except Exception as e:
                logger.error(f"Download worker error: {str(e)}")
    
    async def transcription_worker(self):
        """Worker that processes transcription queue"""
        while True:
            try:
                hearing = await self.transcription_queue.get()
                if hearing is None:  # Shutdown signal
                    break
                
                # Run transcription in thread pool (CPU-bound)
                loop = asyncio.get_event_loop()
                
                logger.info(f"Starting transcription: {hearing['title']}")
                
                # Run transcription
                await loop.run_in_executor(
                    None,
                    self.transcribe_video,
                    hearing
                )
                
                self.transcription_queue.task_done()
                
            except Exception as e:
                logger.error(f"Transcription worker error: {str(e)}")
    
    def cleanup_orphaned_files(self):
        """Clean up orphaned video and chunk files from previous runs"""
        logger.info("Checking for orphaned files...")
        
        # Get list of completed hearing IDs
        completed_ids = set()
        with psycopg2.connect(self.db_url) as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT id FROM hearings 
                    WHERE transcription_status = 'completed'
                """)
                completed_ids = {row[0] for row in cur.fetchall()}
        
        # Clean up videos for completed hearings
        cleaned_videos = 0
        for video_file in self.videos_dir.glob("*.mp4"):
            # Extract hearing ID from filename (format: {hearing_id}.mp4)
            hearing_id = video_file.stem
            if hearing_id in completed_ids:
                video_file.unlink()
                cleaned_videos += 1
                logger.info(f"Cleaned up completed video: {video_file.name}")
        
        # Clean up all chunks (they should be temporary)
        cleaned_chunks = 0
        for chunk_file in self.temp_dir.glob("*_chunk_*.wav"):
            chunk_file.unlink()
            cleaned_chunks += 1
        
        if cleaned_videos > 0 or cleaned_chunks > 0:
            logger.info(f"Cleanup complete: removed {cleaned_videos} videos and {cleaned_chunks} chunks")
        else:
            logger.info("No orphaned files found")
    
    async def process_hearings(self):
        """Main processing function"""
        # Clean up orphaned files first
        self.cleanup_orphaned_files()
        
        # Get pending hearings
        with psycopg2.connect(self.db_url) as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                # Get videos that need downloading
                cur.execute("""
                    SELECT id, title, url, chamber
                    FROM hearings
                    WHERE download_status = 'pending'
                       OR (download_status = 'failed' AND (retry_count < 3 OR transcription_status != 'completed'))
                       OR (download_status = 'downloading' AND updated_at < NOW() - INTERVAL '30 minutes')
                    ORDER BY created_at ASC
                    LIMIT %s
                """, (self.max_downloads * 2,))  # Get extra for queue
                
                hearings_to_download = cur.fetchall()
                
                # Get videos that need transcription
                cur.execute("""
                    SELECT id, title, video_file_path, chamber
                    FROM hearings
                    WHERE download_status = 'completed'
                    AND transcription_status = 'pending'
                    ORDER BY created_at ASC
                """)
                
                hearings_to_transcribe = cur.fetchall()
        
        logger.info(f"Found {len(hearings_to_download)} videos to download")
        logger.info(f"Found {len(hearings_to_transcribe)} videos to transcribe")
        
        # Create workers
        download_workers = [
            asyncio.create_task(self.download_worker())
            for _ in range(self.max_downloads)
        ]
        
        transcription_workers = [
            asyncio.create_task(self.transcription_worker())
            for _ in range(self.max_transcriptions)
        ]
        
        # Start queue status monitor
        status_monitor = asyncio.create_task(self.print_queue_status())
        
        # Add items to queues
        for hearing in hearings_to_download:
            await self.download_queue.put(hearing)
        
        for hearing in hearings_to_transcribe:
            await self.transcription_queue.put(hearing)
        
        # Wait for all tasks to complete
        await self.download_queue.join()
        await self.transcription_queue.join()
        
        # Shutdown workers
        for _ in download_workers:
            await self.download_queue.put(None)
        for _ in transcription_workers:
            await self.transcription_queue.put(None)
        
        # Wait for workers to finish
        await asyncio.gather(*download_workers, *transcription_workers)
        
        # Cancel status monitor
        status_monitor.cancel()
        
        # Print performance summary
        self.print_performance_summary()
        
        logger.info("All processing complete!")
    
    def get_progress_summary(self):
        """Get current progress summary"""
        summary = {
            'downloads': {
                'active': len(self.download_progress),
                'queued': self.download_queue.qsize(),
                'details': self.download_progress
            },
            'transcriptions': {
                'active': len(self.transcription_progress),
                'queued': self.transcription_queue.qsize(),
                'details': self.transcription_progress
            }
        }
        return summary
    
    async def print_queue_status(self):
        """Print queue status periodically"""
        while True:
            await asyncio.sleep(30)  # Print every 30 seconds
            summary = self.get_progress_summary()
            logger.info(f"Queue Status - Downloads: {summary['downloads']['queued']} queued, "
                       f"{summary['downloads']['active']} active | "
                       f"Transcriptions: {summary['transcriptions']['queued']} queued, "
                       f"{summary['transcriptions']['active']} active")
    
    def cleanup_tmp_folder(self):
        """Clean up the entire tmp folder after processing"""
        tmp_folder = self.project_root / "tmp"
        if tmp_folder.exists():
            # Count files before cleanup
            video_count = len(list(self.videos_dir.glob("*.mp4"))) if self.videos_dir.exists() else 0
            chunk_count = len(list(self.temp_dir.glob("*.wav"))) if self.temp_dir.exists() else 0
            
            if video_count > 0 or chunk_count > 0:
                logger.warning(f"Cleaning up {video_count} leftover videos and {chunk_count} leftover chunks")
            
            # Remove the entire tmp folder
            import shutil
            shutil.rmtree(tmp_folder)
            logger.info("Removed tmp folder completely")
    
    def print_performance_summary(self):
        """Print performance summary statistics"""
        download_stats = self.performance_stats['downloads']
        trans_stats = self.performance_stats['transcriptions']
        
        logger.info("="*60)
        logger.info("PERFORMANCE SUMMARY")
        logger.info("="*60)
        
        # Download statistics
        if download_stats['successful'] > 0:
            avg_download_speed = download_stats['total_bytes'] / download_stats['total_time'] / 1024 / 1024
            logger.info(f"Downloads:")
            logger.info(f"  - Successful: {download_stats['successful']}")
            logger.info(f"  - Failed: {download_stats['failed']}")
            logger.info(f"  - Total data: {download_stats['total_bytes'] / 1024 / 1024:.1f} MB")
            logger.info(f"  - Average speed: {avg_download_speed:.1f} MB/s")
        
        # Transcription statistics
        if trans_stats['successful'] > 0:
            avg_speedup = trans_stats['total_audio_duration'] / trans_stats['total_time']
            avg_time_per_video = trans_stats['total_time'] / trans_stats['successful']
            logger.info(f"Transcriptions:")
            logger.info(f"  - Successful: {trans_stats['successful']}")
            logger.info(f"  - Failed: {trans_stats['failed']}")
            logger.info(f"  - Total audio: {trans_stats['total_audio_duration'] / 60:.1f} minutes")
            logger.info(f"  - Total processing time: {trans_stats['total_time'] / 60:.1f} minutes")
            logger.info(f"  - Average speedup: {avg_speedup:.1f}x realtime")
            logger.info(f"  - Average time per video: {avg_time_per_video:.1f} seconds")
        
        logger.info("="*60)
    
    def transcribe_video(self, hearing):
        """Transcribe a video file using chunk-based parallel processing"""
        hearing_id = hearing['id']
        title = hearing['title']
        chamber = hearing.get('chamber', 'house')
        
        # Get video path
        video_file_path = hearing.get('video_file_path', None)
        if video_file_path:
            video_path = Path(video_file_path)
        else:
            video_path = self.videos_dir / f"{hearing_id}.mp4"
        audio_path = self.temp_dir / f"{hearing_id}_full.wav"
        
        if not video_path.exists():
            logger.error(f"Video not found: {video_path}")
            self._update_status_sync(hearing_id, 'transcription_status', 'failed', f"Video not found: {video_path}")
            return
        
        # Verify video integrity
        verify_cmd = ['ffprobe', '-v', 'error', '-show_format', '-show_streams', str(video_path)]
        try:
            result = subprocess.run(verify_cmd, capture_output=True, text=True, timeout=10)
            if result.returncode != 0:
                logger.error(f"Video corrupted or incomplete: {video_path}")
                self._update_status_sync(hearing_id, 'transcription_status', 'failed', f"Video corrupted: {result.stderr}")
                # Delete corrupted video
                if self.delete_after and video_path.exists():
                    video_path.unlink()
                    logger.info(f"Deleted corrupted video: {video_filename}")
                return
        except subprocess.TimeoutExpired:
            logger.error(f"Video verification timeout: {video_path}")
            self._update_status_sync(hearing_id, 'transcription_status', 'failed', "Video verification timeout")
            return
        
        try:
            # Update status
            self._update_status_sync(hearing_id, 'transcription_status', 'processing')
            
            logger.info(f"Starting chunked transcription: {title}")
            start_time = time.time()
            
            # Extract audio from video
            logger.info(f"Extracting audio from video: {title}")
            self.extract_audio(video_path, audio_path)
            audio_duration = self.get_audio_duration(audio_path)
            logger.info(f"Audio duration: {audio_duration:.1f}s")
            
            # Split into chunks
            chunks = self.split_audio_with_silence_detection(audio_path, hearing_id)
            logger.info(f"Created {len(chunks)} chunks for parallel processing")
            
            # Transcribe chunks in parallel
            chunk_workers = min(self.total_cores // 2, len(chunks))  # Use half the cores
            logger.info(f"Processing chunks with {chunk_workers} workers")
            
            # Prepare arguments for worker function
            worker_args = [(chunk, self.whisper_model, self.transcription_mode) for chunk in chunks]
            
            # Create pool and ensure proper cleanup
            pool = Pool(processes=chunk_workers)
            try:
                chunk_results = list(tqdm(
                    pool.imap(transcribe_chunk_worker, worker_args),
                    total=len(chunks),
                    desc=f"Transcribing {title[:30]}..."
                ))
            finally:
                pool.close()
                pool.join()
                pool.terminate()  # Ensure all processes are terminated
            
            # Merge results
            merged_result = self.merge_chunks(chunk_results)
            
            # Save transcription
            safe_title = title.replace('/', '_').replace('\\', '_')[:100]
            
            # Save text version
            text_path = self.transcriptions_dir / f"{safe_title}.txt"
            with open(text_path, 'w') as f:
                f.write(f"# {title}\n"
                       f"# State: MI\n"
                       f"# Chamber: {chamber.capitalize()}\n"
                       f"# Hearing ID: {hearing_id}\n"
                       f"# Transcribed: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
                       f"# Duration: {audio_duration:.1f} seconds\n"
                       f"# Method: Chunked Parallel Processing\n"
                       f"# Chunks: {len(chunks)}\n\n"
                       f"{merged_result['text']}")
            
            # Prepare transcription JSON
            transcription_json = {
                "hearing_id": hearing_id,
                "title": title,
                "state": "MI",
                "chamber": chamber,
                "duration": audio_duration,
                "transcribed_at": datetime.now().isoformat(),
                "segments": merged_result['segments'],
                "method": "chunked_parallel",
                "chunks": len(chunks),
                "model": self.whisper_model
            }
            
            # Save JSON version
            json_path = self.transcriptions_dir / f"{safe_title}.json"
            with open(json_path, 'w') as f:
                json.dump({**transcription_json, "full_text": merged_result['text']}, f, indent=2)
            
            # Update database and performance stats
            duration = time.time() - start_time
            speedup = audio_duration / duration if duration > 0 else 0
            
            self._update_transcription_complete_sync(
                hearing_id, 
                str(text_path.name), 
                len(merged_result['text']),
                duration,
                transcription_json
            )
            
            # Update performance metrics
            self.performance_stats['transcriptions']['successful'] += 1
            self.performance_stats['transcriptions']['total_audio_duration'] += audio_duration
            self.performance_stats['transcriptions']['total_time'] += duration
            
            logger.info(f"Transcription complete: {title} ({duration:.1f}s, {speedup:.1f}x realtime)")
            
            # Clean up
            if audio_path.exists():
                audio_path.unlink()
                logger.info(f"Deleted audio file: {audio_path}")
            
            # Clean up all chunks for this hearing
            chunk_pattern = self.temp_dir / f"{hearing_id}_chunk_*.wav"
            for chunk_file in self.temp_dir.glob(f"{hearing_id}_chunk_*.wav"):
                if chunk_file.exists():
                    chunk_file.unlink()
                    logger.info(f"Deleted chunk: {chunk_file.name}")
            
            # Delete video if configured
            if self.delete_after and video_path.exists():
                video_path.unlink()
                logger.info(f"Deleted video: {video_path.name}")
                
        except Exception as e:
            logger.error(f"Transcription failed for {title}: {str(e)}")
            self._update_status_sync(hearing_id, 'transcription_status', 'failed', str(e))
            self.performance_stats['transcriptions']['failed'] += 1
            
            # Clean up on failure
            if audio_path.exists():
                audio_path.unlink()
            
            # Clean up any chunks created
            for chunk_file in self.temp_dir.glob(f"{hearing_id}_chunk_*.wav"):
                if chunk_file.exists():
                    chunk_file.unlink()
    
    def _update_transcription_complete_sync(self, hearing_id, filename, text_length, duration, transcription_json):
        """Update transcription completion in database"""
        with psycopg2.connect(self.db_url) as conn:
            with conn.cursor() as cur:
                # Read transcription text from file
                text_path = self.transcriptions_dir / filename
                transcription_text = ""
                if text_path.exists():
                    with open(text_path, 'r') as f:
                        transcription_text = f.read()
                
                cur.execute("""
                    UPDATE hearings 
                    SET transcription_status = 'completed',
                        transcription_text = %s,
                        transcription_json = %s,
                        transcription_completed_at = NOW()
                    WHERE id = %s
                """, (transcription_text, json.dumps(transcription_json), hearing_id))
                conn.commit()

async def main():
    import argparse
    parser = argparse.ArgumentParser(description='Parallel video download and transcription with chunking')
    parser.add_argument('--downloads', type=int, default=3, help='Max concurrent downloads')
    parser.add_argument('--transcriptions', type=int, default=2, help='Max concurrent transcriptions')
    parser.add_argument('--chunk-duration', type=int, default=30, help='Duration of each audio chunk in seconds')
    parser.add_argument('--db-url', help='Database URL (or use env DATABASE_URL)')
    
    args = parser.parse_args()
    
    # Get database URL
    db_url = args.db_url or os.environ.get('DATABASE_URL')
    if not db_url:
        logger.error("Database URL not provided. Set DATABASE_URL or use --db-url")
        sys.exit(1)
    
    # Create processor
    processor = ParallelProcessor(
        db_url=db_url,
        max_downloads=args.downloads,
        max_transcriptions=args.transcriptions,
        chunk_duration=args.chunk_duration
    )
    
    # Run processing
    start_time = time.time()
    try:
        await processor.process_hearings()
    finally:
        # Always clean up tmp folder
        processor.cleanup_tmp_folder()
    
    # Summary
    duration = time.time() - start_time
    logger.info(f"Total processing time: {duration:.1f} seconds")

def lambda_handler(event, context):
    """AWS Lambda handler for serverless execution"""
    import os
    
    # Set up environment
    db_url = os.environ.get('DATABASE_URL')
    if not db_url:
        return {
            'statusCode': 400,
            'body': json.dumps({'error': 'DATABASE_URL not configured'})
        }
    
    # Get parameters from event
    max_downloads = event.get('max_downloads', 1)
    max_transcriptions = event.get('max_transcriptions', 1)
    
    # Create processor
    processor = ParallelProcessor(
        db_url=db_url,
        max_downloads=max_downloads,
        max_transcriptions=max_transcriptions
    )
    
    # Run processing
    try:
        asyncio.run(processor.process_hearings())
        
        # Return performance stats
        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': 'Processing complete',
                'stats': processor.performance_stats
            })
        }
    except Exception as e:
        logger.error(f"Lambda processing failed: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }

if __name__ == '__main__':
    asyncio.run(main())