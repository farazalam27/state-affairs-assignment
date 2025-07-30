import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import { pipeline } from 'stream/promises';
import { logger } from '../utils/logger';
import { hearingDb } from '../database/db';

export class VideoProcessor {
    private videoStoragePath: string;
    private maxVideoSizeMB: number;
    private maxConcurrentDownloads: number;
    private activeDownloads: Set<string> = new Set();

    constructor() {
        this.videoStoragePath = process.env.VIDEO_STORAGE_PATH || './tmp/videos';
        this.maxVideoSizeMB = parseInt(process.env.MAX_VIDEO_SIZE_MB || '4000'); // Support up to 4GB videos
        this.maxConcurrentDownloads = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '2');

        // Ensure video storage directory exists
        fs.ensureDirSync(this.videoStoragePath);
    }

    // Process a hearing record - download video if needed
    async processHearing(hearingId: string, videoUrl: string): Promise<string> {
        // Check if we're at download limit
        if (this.activeDownloads.size >= this.maxConcurrentDownloads) {
            throw new Error('Maximum concurrent downloads reached');
        }

        this.activeDownloads.add(hearingId);

        try {
            // Update status to downloading
            await hearingDb.updateStatus(hearingId, { 
                downloadStatus: 'downloading',
                downloadStartedAt: new Date()
            });
            // Log action removed - no processing_logs table in new schema

            // Generate filename based on hearing ID
            const filename = `${hearingId}.mp4`;
            const filepath = path.join(this.videoStoragePath, filename);

            // Check if file already exists
            if (await fs.pathExists(filepath)) {
                const stats = await fs.stat(filepath);
                if (stats.size > 0) {
                    logger.info(`Video already exists for hearing ${hearingId}`);
                    await hearingDb.updateStatus(hearingId, {
                        downloadStatus: 'completed',
                        downloadCompletedAt: new Date(),
                        videoFilePath: filepath,
                        videoSizeBytes: stats.size
                    });
                    return filepath;
                }
            }

            // Download the video
            const downloadedPath = await this.downloadVideoFile(videoUrl, filepath, hearingId);

            // Get file stats
            const stats = await fs.stat(downloadedPath);

            // Update database with success
            await hearingDb.updateStatus(hearingId, {
                downloadStatus: 'completed',
                downloadCompletedAt: new Date(),
                videoFilePath: downloadedPath,
                videoSizeBytes: stats.size
            });

            // Log action removed - no processing_logs table in new schema

            return downloadedPath;

        } catch (error: any) {
            logger.error(`Failed to process video for hearing ${hearingId}`, error);

            // Update database with failure
            await hearingDb.updateStatus(hearingId, {
                downloadStatus: 'failed'
            });

            // Log action removed - no processing_logs table in new schema

            throw error;

        } finally {
            this.activeDownloads.delete(hearingId);
        }
    }

    // Download video file with progress tracking and resume support
    private async downloadVideoFile(url: string, filepath: string, hearingId: string): Promise<string> {
        logger.info(`Starting download from ${url} to ${filepath}`);

        // Check if this is an m3u8 stream
        if (url.includes('.m3u8')) {
            return this.downloadM3U8Stream(url, filepath, hearingId);
        }

        // Create a temporary file first
        const tempPath = filepath + '.downloading';
        
        try {
            // Prepare headers
            const headers: any = {
                'User-Agent': 'Mozilla/5.0 (compatible; MichiganHearingsBot/1.0)'
            };

            // Make HTTP request with streaming
            const response = await axios({
                method: 'GET',
                url: url,
                responseType: 'stream',
                timeout: 0, // No timeout for large downloads
                maxContentLength: Infinity, // Allow large files
                maxBodyLength: Infinity, // Allow large files
                headers: headers,
                // Handle redirects
                maxRedirects: 5,
                // Ignore SSL certificate errors (for development/government sites)
                httpsAgent: new (require('https').Agent)({
                    rejectUnauthorized: false
                })
            });

            // Check content length
            const contentLength = parseInt(response.headers['content-length'] || '0');
            if (contentLength > this.maxVideoSizeMB * 1024 * 1024) {
                throw new Error(`Video too large: ${contentLength} bytes`);
            }

            // Create write stream (always write from beginning)
            const writer = fs.createWriteStream(tempPath, { flags: 'w' });

            // Track download progress
            let downloadedBytes = 0;
            let lastLogTime = Date.now();

            response.data.on('data', (chunk: Buffer) => {
                downloadedBytes += chunk.length;

                // Log progress every 5 seconds
                if (Date.now() - lastLogTime > 5000) {
                    const progress = contentLength > 0
                        ? Math.round((downloadedBytes / contentLength) * 100)
                        : 0;
                    logger.info(`Download progress for ${hearingId}: ${progress}% (${downloadedBytes} bytes)`);
                    lastLogTime = Date.now();
                }
            });

            // Use pipeline to handle streams properly
            await pipeline(response.data, writer);

            // Verify the download
            const stats = await fs.stat(tempPath);
            if (stats.size === 0) {
                throw new Error('Downloaded file is empty');
            }

            // Move temp file to final location
            await fs.move(tempPath, filepath, { overwrite: true });

            logger.info(`Download completed for ${hearingId}: ${stats.size} bytes`);
            return filepath;

        } catch (error: any) {
            // Clean up temp file on error
            await fs.remove(tempPath).catch(() => {});

            if (error.response?.status === 404) {
                throw new Error('Video not found (404)');
            } else if (error.code === 'ECONNABORTED') {
                throw new Error('Download timeout');
            } else if (error.message?.includes('maxContentLength')) {
                throw new Error('Video exceeds size limit');
            }

            throw error;
        }
    }

    // Download m3u8 HLS stream using ffmpeg
    private async downloadM3U8Stream(url: string, filepath: string, hearingId: string): Promise<string> {
        logger.info(`Downloading m3u8 stream from ${url} to ${filepath}`);
        
        const tempPath = filepath + '.downloading';
        
        try {
            // Use ffmpeg to download the m3u8 stream
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            
            // FFmpeg command to download m3u8 stream
            const command = `ffmpeg -i "${url}" -c copy -bsf:a aac_adtstoasc -f mp4 "${tempPath}" -y`;
            
            logger.info(`Executing: ${command}`);
            
            // Execute ffmpeg with a long timeout for large videos
            const { stderr } = await execAsync(command, {
                maxBuffer: 10 * 1024 * 1024, // 10MB buffer
                timeout: 3600000 // 1 hour timeout
            });
            
            if (stderr && !stderr.includes('muxing overhead')) {
                logger.warn(`FFmpeg stderr: ${stderr}`);
            }
            
            // Verify the download
            const stats = await fs.stat(tempPath);
            if (stats.size === 0) {
                throw new Error('Downloaded file is empty');
            }
            
            // Move temp file to final location
            await fs.move(tempPath, filepath, { overwrite: true });
            
            logger.info(`M3U8 download completed for ${hearingId}: ${stats.size} bytes`);
            return filepath;
            
        } catch (error: any) {
            // Clean up temp file on error
            await fs.remove(tempPath).catch(() => {});
            
            logger.error(`Failed to download m3u8 stream: ${error.message}`);
            throw new Error(`M3U8 download failed: ${error.message}`);
        }
    }


    
    // Public method for downloading videos - called from index.ts
    async downloadVideo(hearing: any): Promise<void> {
        const { id, url } = hearing;
        
        if (!url) {
            throw new Error(`No video URL for hearing ${id}`);
        }
        
        await this.processHearing(id, url);
    }
}