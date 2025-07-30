# Use Python base image for Whisper support
FROM python:3.11-slim AS builder

# Install Node.js and build dependencies
RUN apt-get update && apt-get install -y \
    curl \
    build-essential \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install ALL dependencies (including dev dependencies for TypeScript compilation)
RUN npm ci && \
    npm cache clean --force

# Copy source code
COPY src ./src

# Build TypeScript
RUN npm install -g typescript && \
    npm run build

# Production stage
FROM python:3.11-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    curl \
    ffmpeg \
    postgresql-client \
    tini \
    ca-certificates \
    && update-ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install faster-whisper (includes PyAV, no need for separate ffmpeg-python) and psycopg2
RUN pip install --no-cache-dir faster-whisper psycopg2-binary

WORKDIR /app

# Copy built application
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./

# Copy Python scripts for fast processing
COPY scripts/docker_fast_processor.py scripts/transcribe_video.py ./scripts/

# Create directories for storage
RUN mkdir -p /app/videos /app/transcriptions /app/.cache

# Create non-root user
RUN useradd -m -u 1000 appuser && \
    chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Environment variables
ENV NODE_ENV=production \
    VIDEO_STORAGE_PATH=/app/videos \
    TRANSCRIPTION_STORAGE_PATH=/app/transcriptions \
    TRANSCRIPTION_SERVICE=local \
    WHISPER_MODEL=base \
    WHISPER_DEVICE=cpu \
    HF_HOME=/app/.cache \
    NODE_TLS_REJECT_UNAUTHORIZED=0

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('pg').Pool({connectionString: process.env.DATABASE_URL}).query('SELECT 1')"

# Use tini for proper signal handling
ENTRYPOINT ["/usr/bin/tini", "--"]

# Run the application
CMD ["node", "dist/index.js"]