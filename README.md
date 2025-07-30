# Michigan Legislature Hearing Processor

**State Affairs Technical Exercise** - Automated system for downloading and transcribing Michigan Legislature hearing videos. Achieves **16.8x realtime transcription speed** while handling 1-4GB videos.

## Quick Start

### Prerequisites Checklist
- [ ] Node.js 18+ and npm
- [ ] Python 3.11+
- [ ] PostgreSQL 15+ (or Docker)
- [ ] FFmpeg
- [ ] 8GB+ RAM
- [ ] 50GB+ free disk space

### 3-Step Setup

**1. Clone and Install Dependencies**
```bash
git clone https://github.com/farazalam27/state-affairs-assignment.git
cd state-affairs-assignment

# Install Node.js dependencies
npm install

# Install Python dependencies
pip install -r requirements.txt

# Build TypeScript
npm run build
```

**2. Configure Environment**
```bash
cp .env.example .env
# Edit .env if needed (defaults work fine)
```

**3. Start Database**
```bash
docker-compose up -d postgres
# Wait 5 seconds for database to initialize
sleep 5
```

### Running the System

**Test Run (4 videos - 2 House + 2 Senate)**
```bash
MAX_HEARINGS_PER_RUN=4 ./scripts/run-local.sh --clean
```
Expected time: ~15-20 minutes for 4 videos

**Production Run (all new videos)**
```bash
./scripts/run-local.sh
```

**Run Python Processor Directly**
```bash
DATABASE_URL=postgresql://michigan_user:changeme@localhost:5432/michigan_hearings \
python3 scripts/parallel_processor.py --downloads 3 --transcriptions 2
```

**Check Progress**
```bash
# View logs
tail -f logs/processor-*.log

# Check database status
docker-compose exec postgres psql -U michigan_user -d michigan_hearings -c \
  "SELECT chamber, download_status, transcription_status, COUNT(*) 
   FROM hearings GROUP BY chamber, download_status, transcription_status;"
```

## ✅ Exercise Requirements

This system fulfills all State Affairs Technical Exercise requirements:
- ✅ Detects newly published hearing videos on House and Senate archives
- ✅ Downloads new videos that haven't been processed
- ✅ Transcribes video contents using Whisper AI
- ✅ Handles failures gracefully with retry logic
- ✅ Designed to run periodically via cron
- ✅ Tracks processed videos to avoid re-processing
- ✅ Modular, production-quality code

## Architecture

```
TypeScript Scrapers → PostgreSQL (Queue) → Python Processor
     ↓                      ↓                     ↓
  Web Scraping      Job Management         ML Transcription
  Puppeteer         Status Tracking        Faster-whisper
  Async I/O         Retry Logic            Multiprocessing
```

### Why This Architecture?
- **TypeScript**: Best browser automation for JavaScript-heavy government sites
- **PostgreSQL**: Simple, reliable job queue without external dependencies
- **Python**: 20x faster ML processing using all CPU cores
- **No SQS/Redis**: Simpler architecture, fewer dependencies

## Project Structure

```
state-affairs-assignment/
├── src/                    # TypeScript source code
│   ├── scrapers/          # House and Senate scrapers
│   ├── processors/        # Video download logic
│   └── database/          # PostgreSQL interface
├── scripts/               # Shell and Python scripts
│   ├── run-local.sh      # Main entry point
│   └── parallel_processor.py  # Python transcription
├── database/              # SQL schema
├── aws/                   # AWS deployment configs
└── tmp/                   # Temporary files (auto-created)
    ├── videos/           # Downloaded videos
    └── chunks/           # Audio chunks for processing
```

## Configuration

### Environment Variables
```bash
# Core Settings
MAX_HEARINGS_PER_RUN=10        # Videos to process per run
MAX_CONCURRENT_DOWNLOADS=3      # Parallel video downloads
MAX_CONCURRENT_TRANSCRIPTIONS=2 # Parallel transcriptions

# Scraper Limits (per chamber)
HOUSE_MAX_NEW_VIDEOS=5         # Stop after finding 5 new House videos
SENATE_MAX_NEW_VIDEOS=5        # Stop after finding 5 new Senate videos

# Advanced
WHISPER_MODEL=small            # Whisper model size (tiny/base/small/medium)
DELETE_AFTER_TRANSCRIPTION=true # Delete videos after processing
CHUNK_DURATION=30              # Audio chunk size in seconds
```

## Installation Details

### macOS
```bash
# Install Homebrew (if not installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install dependencies
brew install node python@3.11 postgresql@15 ffmpeg

# Install Python packages
pip3 install -r requirements.txt
```

### Ubuntu/Debian
```bash
# Update package list
sudo apt update

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Install other dependencies
sudo apt install -y python3.11 python3-pip postgresql ffmpeg

# Install Python packages
pip3 install -r requirements.txt
```

### Windows (WSL2)
```bash
# In WSL2 Ubuntu terminal
# Follow Ubuntu instructions above
# Ensure Docker Desktop is installed and WSL2 integration enabled
```

## Troubleshooting

### Common Issues

**1. "Failed to launch browser process" (Puppeteer)**
```bash
# macOS fix
npx puppeteer browsers install chrome

# Linux fix
sudo apt-get install -y chromium-browser
```

**2. Database Connection Refused**
```bash
# Ensure PostgreSQL is running
docker-compose ps

# Restart if needed
docker-compose down
docker-compose up -d postgres
```

**3. "ffprobe: command not found"**
```bash
# Install FFmpeg
# macOS: brew install ffmpeg
# Linux: sudo apt install ffmpeg
# Windows: Download from ffmpeg.org
```

**4. Out of Disk Space**
```bash
# Clean up old videos
rm -rf tmp/videos/*

# Check transcriptions size
du -sh transcriptions/
```

## Performance

### Tested Configuration
- **Machine**: M3 Max MacBook Pro (14 cores)
- **Videos**: 1-4GB Michigan Legislature hearings
- **Results**: 
  - Download speed: ~78 MB/s average
  - Transcription: 16.8x realtime
  - 4 videos processed in ~15 minutes

### Optimization Tips
- Keep `MAX_CONCURRENT_DOWNLOADS=3` for stability
- Increase `MAX_CONCURRENT_TRANSCRIPTIONS` based on CPU cores
- Use `WHISPER_MODEL=base` for faster processing (lower accuracy)
- Use `WHISPER_MODEL=medium` for better accuracy (slower)

## Database Schema

The system tracks complete processing pipeline:

```sql
hearings
├── id (UUID)
├── url (video URL)
├── title
├── chamber (house/senate)
├── download_status (pending/downloading/completed/failed)
├── download_started_at
├── download_completed_at
├── transcription_status (pending/processing/completed/failed)
├── transcription_started_at
├── transcription_completed_at
├── transcription_text (full text)
└── transcription_json (segments with timestamps)
```

## How It Works

1. **Scraping**: TypeScript scrapers find videos on House/Senate websites
2. **Deduplication**: Check database to skip already-processed videos
3. **Downloading**: Download videos (MP4/m3u8) with progress tracking
4. **Processing**: Extract audio and split into 30-second chunks
5. **Transcription**: Process chunks in parallel using Whisper AI
6. **Storage**: Save transcription text and JSON with timestamps

## Production Deployment

### Built-in Scheduling

The system includes a built-in scheduler using node-cron:

```bash
# Run with default schedule (2 AM daily)
npm start

# Custom schedule via environment variable
CRON_SCHEDULE="0 */6 * * *" npm start  # Every 6 hours
```

### System Cron (Recommended for Production)

```bash
# Edit crontab
crontab -e

# Add one of these schedules:
# Daily at 2 AM
0 2 * * * cd /path/to/project && ./scripts/run-local.sh >> logs/cron.log 2>&1

# Every Monday at 3 AM
0 3 * * 1 cd /path/to/project && ./scripts/run-local.sh >> logs/cron.log 2>&1

# Every 6 hours
0 */6 * * * cd /path/to/project && ./scripts/run-local.sh >> logs/cron.log 2>&1
```

### AWS Deployment
See `aws/batch-config.yaml` for Lambda + EC2 Spot configuration

### Monitoring
- Health check endpoint: http://localhost:3000/health
- Metrics endpoint: http://localhost:3000/metrics

## Testing

```bash
# Run TypeScript tests
npm test

# Test scrapers only
SKIP_DOWNLOAD=true npm start

# Test specific chambers
HOUSE_MAX_NEW_VIDEOS=1 SENATE_MAX_NEW_VIDEOS=0 ./scripts/run-local.sh
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests
5. Submit a pull request