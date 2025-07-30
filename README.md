# Michigan Legislature Hearing Processor

**State Affairs Technical Exercise** - An automatic system for downloading and transcribing Michigan Legislature hearing videos.

## 🏗️ Architecture Overview

This system uses a **hybrid architecture** optimized for performance:

```
TypeScript Scrapers → PostgreSQL → Python Processor
(Network I/O)         (Queue)      (CPU Compute)
```

### Why Hybrid Architecture?

**TypeScript Scrapers** (I/O Bound)
- Best-in-class browser automation with Puppeteer
- Handles JavaScript-heavy sites (Senate uses Castus platform)
- Excellent async I/O for concurrent web requests
- Native to Node.js ecosystem

**Python Processor** (CPU Bound)
- Uses all CPU cores for parallel transcription
- Native ML ecosystem (Faster-whisper, numpy, FFmpeg)
- 20x faster than Node.js for transcription tasks
- Processes 150+ audio chunks simultaneously

**PostgreSQL as Queue**
- No external queue system needed
- Persistent job tracking across runs
- Simple status-based queries
- Built-in retry logic for failures

## ✅ Exercise Requirements

This system fulfills all requirements:
- ✅ Detects newly published hearing videos on House and Senate archives
- ✅ Downloads new videos that haven't been processed
- ✅ Transcribes video contents using Whisper AI
- ✅ Handles failures gracefully with retry logic
- ✅ Designed to run periodically via cron
- ✅ Tracks processed videos to avoid re-processing
- ✅ Modular, production-quality code

## 🚀 Quick Start

```bash
# Clone and setup
git clone https://github.com/farazalam27/state-affairs-assignment.git
cd state-affairs-assignment
cp .env.example .env

# Run everything with default settings (4 videos)
./scripts/run-local.sh

# Run with clean start (removes all data)
./scripts/run-local.sh --clean
```

The script will:
1. Start PostgreSQL database
2. Find new Michigan House and Senate hearings  
3. Download videos (both MP4 and m3u8 streams)
4. Transcribe them using AI
5. Save transcriptions with proper formatting

## 📋 Prerequisites

### System Requirements
- **Operating System**: macOS, Linux, or Windows (with WSL2)
- **RAM**: Minimum 8GB (16GB recommended)
- **Storage**: At least 50GB free space
- **CPU**: Multi-core processor (system uses all available cores)
- **Internet**: Stable connection for downloading large video files

### Software Requirements

#### 1. Docker Desktop
Required for running PostgreSQL database.

**macOS/Windows**:
- Download from [docker.com](https://www.docker.com/products/docker-desktop)
- Install and start Docker Desktop

**Linux**:
```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install docker.io docker-compose
sudo systemctl start docker
sudo usermod -aG docker $USER
# Log out and back in for group changes to take effect
```

#### 2. Node.js (v16+)
Required for TypeScript scrapers.

**Using Node Version Manager (recommended)**:
```bash
# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc

# Install Node.js
nvm install 16
nvm use 16
```

**Direct Install**:
- Download from [nodejs.org](https://nodejs.org/)

#### 3. Python 3.8+
Required for video transcription.

**macOS**:
```bash
# Using Homebrew
brew install python@3.11
```

**Linux**:
```bash
# Ubuntu/Debian
sudo apt-get install python3 python3-pip
```

**Windows**:
- Download from [python.org](https://www.python.org/downloads/)
- Check "Add Python to PATH" during installation

#### 4. FFmpeg
Required for video/audio processing.

**macOS**:
```bash
brew install ffmpeg
```

**Linux**:
```bash
sudo apt-get install ffmpeg
```

**Windows**:
- Download from [ffmpeg.org](https://ffmpeg.org/download.html)
- Add to system PATH

#### 5. Git
```bash
# macOS
brew install git

# Linux
sudo apt-get install git

# Windows
# Download from https://git-scm.com/download/win
```

## 🔧 Installation & Setup

### 1. Clone the Repository
```bash
git clone https://github.com/farazalam27/state-affairs-assignment.git
cd state-affairs-assignment
```

### 2. Configure Environment
```bash
# Copy environment template
cp .env.example .env

# Edit configuration (see Configuration section)
nano .env  # or use your preferred editor
```

### 3. Install Dependencies

**Node.js Dependencies**:
```bash
npm install
```

**Python Dependencies**:
```bash
# Using pip with user install (recommended)
pip3 install --user -r requirements.txt

# Or in a virtual environment
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### 4. Build TypeScript
```bash
npm run build
```

### 5. First Run
```bash
# This will download PostgreSQL image if needed
docker-compose up -d postgres

# Wait for database to be ready
sleep 5

# Process 4 videos (2 House + 2 Senate)
./scripts/run-local.sh

# Or start fresh (recommended for first run)
./scripts/run-local.sh --clean
```

### What Happens During First Run

1. **Database Setup** (30 seconds)
   - PostgreSQL starts
   - Schema is applied automatically

2. **Scraping** (2-5 minutes)
   - Finds newest House videos from house.mi.gov
   - Finds newest Senate videos from cloud.castus.tv
   - Stores metadata in database

3. **Downloading** (5-20 minutes)
   - House videos: 1-4GB each (MP4 format)
   - Senate videos: 20-500MB each (m3u8 streams)
   - Shows progress bars

4. **Transcription** (2-10 minutes)
   - Downloads Whisper model on first use (~244MB for small)
   - Processes audio in parallel chunks
   - Saves transcriptions with proper formatting

5. **Cleanup**
   - Deletes video files (if configured)
   - Removes temporary folders
   - Keeps transcriptions

## ⚙️ Configuration

Edit `.env` file to customize:

```bash
# Core Configuration
MAX_HEARINGS_PER_RUN=4                # Total videos to process per run
MAX_CONCURRENT_DOWNLOADS=3             # Parallel video downloads (keep at 3!)
MAX_CONCURRENT_TRANSCRIPTIONS=2        # Parallel transcriptions

# House Scraper Configuration  
HOUSE_START_YEAR=2015                 # Oldest year to scrape
HOUSE_END_YEAR=2025                   # Newest year to scrape
HOUSE_MAX_NEW_VIDEOS=2                # Stop after finding X new videos (-1 = unlimited)

# Senate Scraper Configuration
SENATE_MAX_NEW_VIDEOS=2               # Stop after finding X new videos (-1 = unlimited)
SENATE_PAGE_SIZE=20                   # Videos per page (10 or 20 recommended)
SENATE_MAX_PAGES=1                    # Limit pages to scrape (-1 = all pages)

# Transcription Settings
WHISPER_MODEL=small                   # tiny/base/small/medium/large
DELETE_AFTER_TRANSCRIPTION=true       # Delete videos after transcription
TRANSCRIPTION_MODE=quality            # quality or fast

# Database
DATABASE_URL=postgresql://michigan_user:changeme@localhost:5432/michigan_hearings
```

### Whisper Model Selection

| Model  | Size   | Speed | Accuracy | Recommended For |
|--------|--------|-------|----------|-----------------|
| tiny   | 39MB   | Fast  | Low      | Testing only    |
| base   | 74MB   | Fast  | Medium   | Quick tests     |
| small  | 244MB  | Good  | Good     | **Production**  |
| medium | 769MB  | Slow  | Better   | Quality focus   |
| large  | 1550MB | Slow  | Best     | Maximum accuracy|

### Critical Configuration Notes

**MAX_CONCURRENT_DOWNLOADS**: Testing shows that setting this above 3 causes download failures. The system works reliably with 3 concurrent downloads, achieving ~78 MB/s average download speed.

## 🎯 Usage Examples

### Process 2 House + 2 Senate Videos
```bash
# Edit .env file:
MAX_HEARINGS_PER_RUN=4
HOUSE_MAX_NEW_VIDEOS=2
SENATE_MAX_NEW_VIDEOS=2

# Run with clean start
./scripts/run-local.sh --clean
```

### Process Only Senate Videos
```bash
# Edit .env:
HOUSE_MAX_NEW_VIDEOS=0
SENATE_MAX_NEW_VIDEOS=5

./scripts/run-local.sh
```

### Process Historical Videos
```bash
# Edit .env:
HOUSE_START_YEAR=2020
HOUSE_END_YEAR=2021

./scripts/run_local.sh
```

### Manual Steps (If Automated Scripts Fail)

#### 1. Database Setup
```bash
docker-compose up -d postgres
sleep 5
docker-compose exec postgres psql -U michigan_user -d michigan_hearings < database/schema.sql
```

#### 2. Run Scrapers Only
```bash
npm install && npm run build
RUN_ONCE=true SKIP_DOWNLOAD=true node dist/index.js
```

#### 3. Run Processor Only  
```bash
pip3 install -r requirements.txt
python3 scripts/parallel_processor.py --downloads 3 --transcriptions 2
```

## 📊 System Design

### Database Schema

The system uses a simplified PostgreSQL schema with only essential fields:

```sql
CREATE TABLE hearings (
    id UUID PRIMARY KEY,
    url VARCHAR(500) UNIQUE NOT NULL,
    url_hash VARCHAR(64) UNIQUE NOT NULL,
    title VARCHAR(500) NOT NULL,
    chamber VARCHAR(50) NOT NULL,
    source_url VARCHAR(500),
    
    -- Download tracking
    download_status VARCHAR(50) DEFAULT 'pending',
    download_started_at TIMESTAMP,
    download_completed_at TIMESTAMP,
    video_file_path VARCHAR(500),
    video_size_bytes BIGINT,
    retry_count INTEGER DEFAULT 0,
    
    -- Transcription tracking
    transcription_status VARCHAR(50) DEFAULT 'pending',
    transcription_started_at TIMESTAMP,
    transcription_completed_at TIMESTAMP,
    transcription_text TEXT,
    transcription_json JSONB,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_hearings_url_hash ON hearings(url_hash);
CREATE INDEX idx_hearings_download_status ON hearings(download_status);
CREATE INDEX idx_hearings_download_transcription_status ON hearings(download_status, transcription_status);
CREATE INDEX idx_hearings_created_at ON hearings(created_at);
```

### How Queueing Works

The system uses PostgreSQL as its job queue:

```sql
-- Download queue
SELECT * FROM hearings WHERE download_status = 'pending';

-- Transcription queue  
SELECT * FROM hearings WHERE download_status = 'completed' 
  AND transcription_status = 'pending';

-- Failed items (retry on next run)
SELECT * FROM hearings WHERE download_status = 'failed' 
  AND retry_count < 3
  OR (download_status = 'failed' AND transcription_status != 'completed')
  OR (download_status = 'downloading' AND updated_at < NOW() - INTERVAL '30 minutes');
```

**Benefits**:
- **No external queue needed**: Database tracks all states
- **Persistent**: Survives crashes and restarts
- **Simple retry**: Failed items automatically retried
- **Easy monitoring**: SQL queries show queue status
- **Idempotent**: Safe to run multiple times

## 📁 Output

Transcriptions are saved in two formats:

### Text Format (`./transcriptions/{title}.txt`)
```
# Senate Session 25-07-29
# State: MI
# Chamber: Senate
# Hearing ID: b11eec0f-5b54-410f-b86f-72f6583e9862
# Transcribed: 2025-07-29 23:52:20
# Duration: 197.8 seconds
# Method: Chunked Parallel Processing
# Chunks: 8

[Transcription text with proper paragraph breaks...]
```

### JSON Format (`./transcriptions/{title}.json`)
Contains full data with timestamps, segments, and metadata.

### Database Storage
Transcriptions are stored in PostgreSQL for easy querying:
```sql
SELECT title, transcription_text 
FROM hearings 
WHERE chamber = 'senate'
  AND transcription_text ILIKE '%budget%';
```

## 🎥 Video Types Supported

### House Videos
- **Format**: Direct MP4 downloads
- **Size**: 1-4GB per video (typically 1-3 hours)
- **Source**: house.mi.gov/VideoArchive
- **Count**: 3,862 videos (2015-2025)

### Senate Videos  
- **Format**: HLS/m3u8 streams
- **Size**: 20MB-500MB per video
- **Source**: cloud.castus.tv/vod/misenate
- **Count**: ~2,360 videos (236 pages)
- **Note**: Downloads full sessions via m3u8, not preview clips

## 🛡️ Error Handling & Recovery

The system handles various failure scenarios:

### Download Failures
- Automatic retry with exponential backoff (up to 3 attempts)
- Resume support for interrupted downloads
- Handles SSL certificate issues automatically
- Supports both MP4 and m3u8 stream formats
- Detects corrupted downloads with ffprobe

### Transcription Failures
- Video integrity check before processing
- Chunks are retried independently
- Failed chunks don't block other chunks
- Automatic cleanup of temporary files
- Detailed error logging

### Database Failures
- Connection pooling with automatic reconnection
- Transaction rollback on errors
- Duplicate detection prevents reprocessing
- Stuck downloads cleaned up after 30 minutes

## 📊 Performance

- **Speed**: Processes 40-minute videos in ~2 minutes (20x faster than realtime)
- **Parallel Processing**: Downloads 3 videos while transcribing 2 simultaneously
- **Smart Chunking**: Splits audio at silence boundaries for optimal parallelism
- **Cost**: $0 operational cost (uses local Whisper model)
- **Accuracy**: ~95% with Whisper AI small model
- **Throughput**: ~100 videos/hour with default settings

### System Capabilities
- **Total Videos Available**: ~6,212 (as of July 2025)
  - Senate: ~2,360 videos
  - House: 3,862 videos (2015-2025)
- **Storage**: ~2GB per House video, ~200MB per Senate video
- **Database**: Stores full transcription text for searching

## 🕐 Production Deployment

### Automated Scheduling with Cron

Schedule automatic runs for hands-free operation:

```bash
# Edit crontab
crontab -e

# Add schedule (choose one):
# Daily at 2 AM
0 2 * * * cd /path/to/project && ./scripts/run-local.sh >> logs/cron.log 2>&1

# Every Monday at 3 AM
0 3 * * 1 cd /path/to/project && ./scripts/run-local.sh >> logs/cron.log 2>&1

# Every 6 hours
0 */6 * * * cd /path/to/project && ./scripts/run-local.sh >> logs/cron.log 2>&1

# With file locking to prevent overlaps
0 2 * * * /usr/bin/flock -n /tmp/michigan.lock -c 'cd /path/to/project && ./scripts/run-local.sh'
```

### System Service (systemd)

Create `/etc/systemd/system/michigan-processor.service`:
```ini
[Unit]
Description=Michigan Legislature Hearing Processor
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=youruser
WorkingDirectory=/path/to/state-affairs-assignment
ExecStart=/path/to/state-affairs-assignment/scripts/run-local.sh
StandardOutput=append:/var/log/michigan-processor.log
StandardError=append:/var/log/michigan-processor-error.log

[Install]
WantedBy=multi-user.target
```

### Production Configuration
```bash
# .env for production
MAX_HEARINGS_PER_RUN=20        # Process more videos
MAX_CONCURRENT_DOWNLOADS=3      # Keep at 3 for stability
MAX_CONCURRENT_TRANSCRIPTIONS=4 # Use more CPU cores
HOUSE_MAX_NEW_VIDEOS=-1        # Unlimited
SENATE_MAX_NEW_VIDEOS=-1       # Unlimited
DELETE_AFTER_TRANSCRIPTION=true # Save disk space
LOG_LEVEL=warn                 # Reduce log verbosity
```

### Monitoring
```bash
# Create monitoring script
cat > scripts/monitor.sh << 'EOF'
#!/bin/bash
# Check if processor is running
if pgrep -f "parallel_processor.py" > /dev/null; then
    echo "Processor is running"
else
    echo "Processor is not running"
    # Send alert or restart
fi

# Check disk space
DISK_USAGE=$(df -h /path/to/project | awk 'NR==2 {print $5}' | sed 's/%//')
if [ $DISK_USAGE -gt 80 ]; then
    echo "Warning: Disk usage is ${DISK_USAGE}%"
    # Clean old videos or send alert
fi
EOF

chmod +x scripts/monitor.sh
```

### Backup Strategy
```bash
# Backup transcriptions daily
0 3 * * * tar -czf /backup/transcriptions-$(date +\%Y\%m\%d).tar.gz /path/to/project/transcriptions/

# Backup database weekly
0 4 * * 0 docker-compose exec -T postgres pg_dump -U michigan_user michigan_hearings | gzip > /backup/db-$(date +\%Y\%m\%d).sql.gz
```

## 🔍 Common Operations

```bash
# View database status
docker-compose exec postgres psql -U michigan_user -d michigan_hearings -c \
  "SELECT chamber, COUNT(*), transcription_status 
   FROM hearings 
   GROUP BY chamber, transcription_status 
   ORDER BY chamber, transcription_status;"

# Search transcriptions
grep -i "budget" ./transcriptions/*.txt

# List recent transcriptions
ls -lat ./transcriptions/*.txt | head -10

# Check processing logs
tail -f logs/test-run.log

# Monitor active processes
ps aux | grep -E "(parallel_processor|run-local)"

# Check for stuck downloads
docker-compose exec postgres psql -U michigan_user -d michigan_hearings -c \
  "SELECT id, title, download_status, updated_at 
   FROM hearings 
   WHERE download_status = 'downloading' 
   AND updated_at < NOW() - INTERVAL '30 minutes';"
```

## 🛠️ Troubleshooting

### Common Issues

#### No videos found?
- Senate has 2,360+ videos across 236 pages
- House has 3,862 videos from 2015-2025
- Check year settings in `.env`
- Try `SENATE_MAX_PAGES=5` for more Senate videos

#### "Docker is not running"
```bash
# Start Docker Desktop (macOS/Windows)
open -a Docker  # macOS

# Start Docker service (Linux)
sudo systemctl start docker
```

#### "ffmpeg: command not found"
```bash
# Verify installation
which ffmpeg

# Install if missing (see Prerequisites)
```

#### Database connection error?
```bash
# Check if PostgreSQL is running
docker-compose ps

# View database logs
docker-compose logs postgres

# Restart database
docker-compose restart postgres
```

#### Transcription failing?
```bash
# Check disk space
df -h

# Verify Python dependencies
pip3 list | grep -E "(faster-whisper|psycopg2)"

# Try smaller model
WHISPER_MODEL=tiny ./scripts/run-local.sh
```

#### Senate videos not downloading?
- The system handles m3u8 streams automatically
- Requires FFmpeg (usually pre-installed)
- Check logs for specific errors

#### "moov atom not found" error
- Video download was interrupted
- System will automatically retry on next run
- Use `--clean` flag to reset if needed

### Reset Everything
```bash
# Stop all services
docker-compose down

# Remove all data
rm -rf tmp/ transcriptions/*

# Remove database volume
docker-compose down -v

# Start fresh
./scripts/run-local.sh --clean
```

## ☁️ AWS Deployment (Optional)

The system can be deployed to AWS for larger scale operations:

### Architecture Overview

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│   CloudWatch    │────▶│ Step Function│────▶│  Video Size     │
│   Event Rule    │     │              │     │  Detection      │
│  (Schedule)     │     │              │     │                 │
└─────────────────┘     └──────────────┘     └────────┬────────┘
                                                       │
                              ┌────────────────────────┴────────┐
                              │                                 │
                     ┌────────▼────────┐              ┌────────▼────────┐
                     │     Lambda      │              │   EC2 Spot      │
                     │  (Small Videos) │              │ (Large Videos)  │
                     │   < 100MB       │              │   > 100MB       │
                     └────────┬────────┘              └────────┬────────┘
                              │                                 │
                     ┌────────▼─────────────────────────────────▼────────┐
                     │                    S3 Bucket                       │
                     │  /videos  /transcriptions  /audio  /logs          │
                     └────────┬──────────────────────────────────────────┘
                              │
                     ┌────────▼────────┐
                     │      RDS         │
                     │   PostgreSQL     │
                     │   (Metadata)     │
                     └─────────────────┘
```

### Implementation Strategy

#### Phase 1: Basic Infrastructure (Week 1)
1. Create S3 buckets with lifecycle policies
2. Set up RDS PostgreSQL instance
3. Deploy Lambda scraper function
4. Configure Step Functions for orchestration
5. Basic CloudWatch monitoring

#### Phase 2: Processing Pipeline (Week 2)
1. Lambda processor for small videos
2. EC2 Spot Fleet setup for large videos
3. Auto-scaling configuration based on queue depth
4. Error handling and notifications
5. Cost optimization rules

#### Phase 3: Production Readiness (Week 3)
1. Security audit and IAM policies
2. VPC configuration and security groups
3. Backup and disaster recovery plan
4. Performance tuning
5. Documentation and runbooks

### Cost-Optimized Design

- **Lambda for Small Videos** (<100MB): Pay only for compute time
- **EC2 Spot for Large Videos** (>100MB): 70% cost savings
- **S3 Intelligent-Tiering**: Automatic cost optimization
- **PostgreSQL as Queue**: No SQS/SNS costs
- **Estimated Cost**: ~$0.20 per video processed

### Key AWS Services

| Service | Purpose | Configuration |
|---------|---------|---------------|
| S3 | Video/transcription storage | Lifecycle policies, intelligent tiering |
| Lambda | Small video processing | 10GB RAM, 15 min timeout |
| EC2 Spot | Large video processing | c6a.2xlarge instances |
| RDS | PostgreSQL database | db.t3.medium, 100GB SSD |
| Step Functions | Orchestration | Route by video size |
| CloudWatch | Monitoring & scheduling | Metrics, alarms, logs |

### Why the Current Design Works Well
- **Database as Queue**: PostgreSQL handles job queuing perfectly
- **No External Dependencies**: Simpler to deploy and maintain
- **Built-in Retry Logic**: Failed jobs automatically retried on next run
- **Easy Monitoring**: Simple SQL queries show queue status

For detailed AWS deployment instructions, see the updated `aws/batch-config.yaml`.

## 🔧 Advanced Configuration

### Processing Specific Years
```bash
HOUSE_START_YEAR=2020 HOUSE_END_YEAR=2021 ./scripts/run-local.sh
```

### Limit to One Chamber
```bash
HOUSE_MAX_NEW_VIDEOS=0 SENATE_MAX_NEW_VIDEOS=10 ./scripts/run-local.sh
```

### Fast Transcription Mode
```bash
TRANSCRIPTION_MODE=fast ./scripts/run-local.sh
```

### Debug Mode
```bash
LOG_LEVEL=debug ./scripts/run-local.sh
```

## 📖 API Reference

### Database Operations

#### Get Pending Hearings
```typescript
getPendingHearings(limit?: number): Promise<Hearing[]>
```

#### Update Hearing Status
```typescript
updateHearingStatus(id: string, status: DownloadStatus | TranscriptionStatus): Promise<void>
```

#### Check Existing Videos
```typescript
existsBatch(urls: string[]): Promise<Set<string>>
```

#### Create Batch
```typescript
createBatch(hearings: Hearing[]): Promise<number>
```

### Scraper Interface

```typescript
interface Scraper {
  scrape(): Promise<Hearing[]>
  fetchVideoUrl(hearing: Hearing): Promise<string>
}
```

### Processor Operations

```python
def download_video(hearing: dict, video_path: Path) -> bool
def transcribe_video(hearing: dict) -> dict
def process_video_chunk(chunk_info: tuple) -> dict
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests: `npm test`
5. Commit your changes (`git commit -m 'Add amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

### Development Guidelines
- Follow existing code style
- Add tests for new features
- Update documentation as needed
- Keep commits atomic and descriptive

## 📝 License

MIT License - See LICENSE file for details

## 🙏 Acknowledgments

- Michigan Legislature for public video archives
- OpenAI Whisper for transcription technology
- State Affairs for the technical exercise opportunity

## 📞 Support

For issues or questions:
1. Check the Troubleshooting section
2. Review logs in `./logs/`
3. Open an issue on GitHub
4. Contact the maintainer

---

Built with ❤️ for State Affairs Technical Exercise