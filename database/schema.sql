-- Michigan Legislature Hearing Processor Database Schema
-- PostgreSQL 15+
-- Simplified schema with only essential fields

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Main hearings table
CREATE TABLE IF NOT EXISTS hearings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
CREATE INDEX IF NOT EXISTS idx_hearings_url_hash ON hearings(url_hash);
CREATE INDEX IF NOT EXISTS idx_hearings_download_status ON hearings(download_status);
CREATE INDEX IF NOT EXISTS idx_hearings_download_transcription_status ON hearings(download_status, transcription_status);
CREATE INDEX IF NOT EXISTS idx_hearings_created_at ON hearings(created_at);

-- System state table for tracking scraper health
CREATE TABLE IF NOT EXISTS system_state (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger for updated_at
CREATE TRIGGER update_hearings_updated_at BEFORE UPDATE ON hearings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();