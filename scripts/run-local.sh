#!/bin/bash

# Michigan Legislature Hearing Processor - Master Run Script
# This script orchestrates the entire process:
# 1. Starts PostgreSQL database
# 2. Runs TypeScript scraper to find and download videos
# 3. Runs Python transcriber to process videos
# 4. Cleans up after processing
#
# Usage: ./scripts/run-local.sh [--clean]
#   --clean: Clear database and transcriptions before starting

set -e  # Exit on error

# Parse command line arguments
CLEAN_DATABASE=false
for arg in "$@"; do
    case $arg in
        --clean)
            CLEAN_DATABASE=true
            shift
            ;;
        *)
            echo "Unknown option: $arg"
            echo "Usage: $0 [--clean]"
            exit 1
            ;;
    esac
done

echo "🚀 Michigan Legislature Hearing Processor"
echo "========================================"

# Check if .env exists
if [ ! -f .env ]; then
    echo "❌ Error: .env file not found!"
    echo "Please copy .env.example to .env and configure it:"
    echo "  cp .env.example .env"
    exit 1
fi

# Load environment variables
set -a
source .env
set +a

# Check required commands
command -v docker >/dev/null 2>&1 || { echo "❌ Error: docker is required but not installed."; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "❌ Error: npm is required but not installed."; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "❌ Error: python3 is required but not installed."; exit 1; }

echo "✅ All required tools are installed"
echo ""

# Step 0a: Clean database if requested
if [ "$CLEAN_DATABASE" = true ]; then
    echo "🧹 Cleaning database and transcriptions..."
    
    # Clean database
    docker-compose exec -T postgres psql -U michigan_user -d michigan_hearings -c "TRUNCATE TABLE hearings CASCADE;" 2>/dev/null || true
    echo "   ✓ Database cleared"
    
    # Apply schema
    docker-compose exec -T postgres psql -U michigan_user -d michigan_hearings < database/schema.sql 2>/dev/null || true
    echo "   ✓ Database schema applied"
    
    # Clean transcription files
    rm -f transcriptions/*.txt transcriptions/*.json 2>/dev/null || true
    echo "   ✓ Transcription files removed"
    
    # Clean tmp folder completely
    rm -rf tmp/ 2>/dev/null || true
    echo "   ✓ Temporary folder removed"
    
    echo ""
fi

# Step 0b: Clean up any leftover tmp folder from previous runs
if [ -d "tmp" ]; then
    echo "🧹 Cleaning up leftover tmp folder from previous run..."
    rm -rf tmp/
    echo "   ✓ Removed tmp folder"
fi

echo ""

# Step 1: Start PostgreSQL database
echo "📦 Starting PostgreSQL database..."
docker-compose up -d postgres

# Wait for database to be ready
echo "⏳ Waiting for database to be ready..."
for i in {1..30}; do
    if docker-compose exec -T postgres pg_isready -U michigan_user -d michigan_hearings >/dev/null 2>&1; then
        echo "✅ Database is ready!"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "❌ Database failed to start after 30 seconds"
        exit 1
    fi
    sleep 1
done

# Apply database schema
docker-compose exec -T postgres psql -U michigan_user -d michigan_hearings < database/schema.sql 2>/dev/null || true

echo ""

# Step 2: Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing Node.js dependencies..."
    npm install
fi

# Install Python dependencies
echo "📦 Installing Python dependencies..."
if [ -f requirements.txt ]; then
    python3 -m pip install --user --break-system-packages -r requirements.txt
else
    echo "❌ Error: requirements.txt not found!"
    exit 1
fi

echo ""

# Step 3: Build TypeScript if needed
if [ ! -d "dist" ] || [ "src" -nt "dist" ]; then
    echo "🔨 Building TypeScript..."
    npm run build
fi

echo ""

# Step 4: Run the scraper to find new hearings
echo "🔍 Scraping for new hearings..."
echo "   Max videos per run: ${MAX_HEARINGS_PER_RUN:-3}"
echo ""
echo "   House Configuration:"
echo "     - Years: ${HOUSE_START_YEAR:-2015} to ${HOUSE_END_YEAR:-2025}"
echo "     - Max new videos: ${HOUSE_MAX_NEW_VIDEOS:--1 (unlimited)}"
echo ""
echo "   Senate Configuration:"
echo "     - Max new videos: ${SENATE_MAX_NEW_VIDEOS:--1 (unlimited)}"
echo "     - Page size: ${SENATE_PAGE_SIZE:-20}"
echo "     - Max pages: ${SENATE_MAX_PAGES:--1 (all)}"
echo "     - Fetch URLs during scrape: ${FETCH_VIDEO_URLS_DURING_SCRAPE:-true}"
echo ""

# Run scraper only (no downloading)
RUN_ONCE=true SKIP_DOWNLOAD=true node dist/index.js

echo ""

# Step 5: Run the parallel processor for downloading and transcription
echo "🚀 Starting parallel download and transcription processor..."
echo "   Max concurrent downloads: ${MAX_CONCURRENT_DOWNLOADS:-3}"
echo "   Max concurrent transcriptions: ${MAX_CONCURRENT_TRANSCRIPTIONS:-2}"
echo "   Using Whisper model: ${WHISPER_MODEL:-small}"
echo "   Delete after transcription: ${DELETE_AFTER_TRANSCRIPTION:-true}"
echo ""

python3 scripts/parallel_processor.py --downloads "${MAX_CONCURRENT_DOWNLOADS:-3}" --transcriptions "${MAX_CONCURRENT_TRANSCRIPTIONS:-2}"

echo ""

# Step 7: Show summary
echo "📊 Summary"
echo "========="

# Count transcriptions
TRANSCRIPTION_COUNT=$(find ./transcriptions -name "*.txt" 2>/dev/null | wc -l | tr -d ' ')
echo "✅ Transcriptions completed: $TRANSCRIPTION_COUNT"

# Show database summary
echo ""
echo "📈 Database Status:"
docker-compose exec -T postgres psql -U michigan_user -d michigan_hearings -t -c "
SELECT 
    'Total hearings: ' || COUNT(*) || E'\n' ||
    'Completed: ' || COUNT(*) FILTER (WHERE transcription_status = 'completed') || E'\n' ||
    'Pending: ' || COUNT(*) FILTER (WHERE transcription_status = 'pending') || E'\n' ||
    'Failed: ' || COUNT(*) FILTER (WHERE transcription_status = 'failed')
FROM hearings;
"

echo ""
echo "✅ Process complete!"
echo ""
echo "💡 Tips:"
echo "   - View transcriptions in: ./transcriptions/"
echo "   - Access database at: postgresql://localhost:5432/michigan_hearings"
echo "   - Run again anytime with: ./scripts/run-local.sh"