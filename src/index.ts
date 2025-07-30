import * as cron from 'node-cron';
import dotenv from 'dotenv';
import { db, hearingDb } from './database/db';
import { logger } from './utils/logger';
import { HouseScraper } from './scrapers/michigan/houseScraper';
import { SenateScraper } from './scrapers/michigan/senateScraper';
import { Hearing } from './scrapers/baseScraper';
import { VideoProcessor } from './processors/videoProcessor';
import { HealthCheckServer } from './api/healthcheck';

// Load environment variables
dotenv.config();

class MichiganHearingsProcessor {
    private houseScraper: HouseScraper;
    private senateScraper: SenateScraper;
    private videoProcessor: VideoProcessor;
    private isProcessing: boolean = false;
    private shouldStop: boolean = false;
    private cronJob: cron.ScheduledTask | null = null;
    private healthCheckServer: HealthCheckServer;

    constructor() {
        this.houseScraper = new HouseScraper();
        this.senateScraper = new SenateScraper();
        this.videoProcessor = new VideoProcessor();
        this.healthCheckServer = new HealthCheckServer();
    }

    // Initialize the application
    async init(): Promise<void> {
        logger.info('Initializing Michigan Hearings Processor');
        
        // Test database connection
        if (!await db.isConnected()) {
            throw new Error('Failed to connect to database');
        }
        logger.info('Database connected successfully');
        
        // Log configuration
        logger.info('Configuration:', {
            videoStoragePath: process.env.VIDEO_STORAGE_PATH || './tmp/videos',
            cronSchedule: process.env.CRON_SCHEDULE || '0 2 * * *',
            maxHearingsPerRun: process.env.MAX_HEARINGS_PER_RUN || '-1'
        });
    }

    // Start the scheduled processor
    async start(): Promise<void> {
        const schedule = process.env.CRON_SCHEDULE || '0 2 * * *'; // Default: 2 AM daily
        
        // Start health check server
        const healthPort = parseInt(process.env.HEALTH_CHECK_PORT || '3000');
        await this.healthCheckServer.start(healthPort);
        
        // Run immediately if specified
        if (process.env.RUN_ON_START === 'true') {
            logger.info('Running initial processing...');
            await this.process();
        }
        
        // Set up cron job
        this.cronJob = cron.schedule(schedule, async () => {
            if (!this.shouldStop) {
                await this.process();
            }
        });
        
        logger.info(`Scheduled processor started with cron: ${schedule}`);
        
        // Set up graceful shutdown
        this.setupGracefulShutdown();
    }

    // Stop the processor
    async stop(): Promise<void> {
        logger.info('Stopping processor...');
        this.shouldStop = true;
        
        if (this.cronJob) {
            this.cronJob.stop();
        }
        
        // Stop health check server
        await this.healthCheckServer.stop();
        
        // Wait for current processing to complete
        while (this.isProcessing) {
            logger.info('Waiting for current processing to complete...');
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        await db.close();
        logger.info('Processor stopped');
    }

    // Main processing function
    async process(): Promise<void> {
        if (this.isProcessing) {
            logger.warn('Processing already in progress, skipping run');
            return;
        }

        this.isProcessing = true;
        const startTime = Date.now();

        try {
            logger.info('Starting processing run');

            // Update system state
            await db.query(
                "INSERT INTO system_state (key, value) VALUES ('last_run', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
                [JSON.stringify({ timestamp: new Date().toISOString() })]
            );

            // Step 1: Scrape for new hearings
            await this.scrapeNewHearings();

            // Step 2: Download pending videos (unless SKIP_DOWNLOAD is set)
            if (process.env.SKIP_DOWNLOAD !== 'true') {
                await this.downloadPendingVideos();
                
                // Step 3: Transcribe downloaded videos
                await this.transcribePendingVideos();
            }

            const duration = Date.now() - startTime;
            logger.info(`Processing completed in ${duration}ms`);
            
            // Update success timestamp
            await db.query(
                "INSERT INTO system_state (key, value) VALUES ('last_successful_run', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
                [JSON.stringify({ timestamp: new Date().toISOString() })]
            );

        } catch (error) {
            logger.error('Processing failed', error);
            
            // Update error state
            await db.query(
                "INSERT INTO system_state (key, value) VALUES ('last_error', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
                [JSON.stringify({ error: error instanceof Error ? error.message : String(error), timestamp: new Date().toISOString() })]
            );
            
            throw error;
        } finally {
            this.isProcessing = false;
        }
    }

    // Scrape both House and Senate sites
    private async scrapeNewHearings(): Promise<void> {
        logger.info('Scraping for new hearings');
        
        let houseHearings: Hearing[] = [];
        let senateHearings: Hearing[] = [];
        let houseStatus = 'unknown';
        let senateStatus = 'unknown';

        // Scrape House - continue even if it fails
        try {
            houseHearings = await this.houseScraper.scrape();
            logger.info(`House scraper found ${houseHearings.length} total videos`);
            houseStatus = 'healthy';
            
            // Update scraper health status
            await db.query(
                "INSERT INTO system_state (key, value) VALUES ('house_scraper_status', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
                [JSON.stringify({ status: 'healthy', lastSuccess: new Date().toISOString(), videoCount: houseHearings.length })]
            );
        } catch (error) {
            logger.error('House scraper failed', error);
            houseStatus = 'failed';
            
            await db.query(
                "INSERT INTO system_state (key, value) VALUES ('house_scraper_status', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
                [JSON.stringify({ status: 'failed', lastError: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) })]
            );
        }

        // Scrape Senate - continue even if it fails
        try {
            senateHearings = await this.senateScraper.scrape();
            logger.info(`Senate scraper found ${senateHearings.length} total videos`);
            senateStatus = 'healthy';
            
            // Update scraper health status
            await db.query(
                "INSERT INTO system_state (key, value) VALUES ('senate_scraper_status', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
                [JSON.stringify({ status: 'healthy', lastSuccess: new Date().toISOString(), videoCount: senateHearings.length })]
            );
        } catch (error) {
            logger.error('Senate scraper failed', error);
            senateStatus = 'failed';
            
            await db.query(
                "INSERT INTO system_state (key, value) VALUES ('senate_scraper_status', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
                [JSON.stringify({ status: 'failed', lastError: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) })]
            );
        }

        // If both scrapers failed, log and return
        if (houseStatus === 'failed' && senateStatus === 'failed') {
            logger.error('Both scrapers failed - no new hearings to process');
            return;
        }

        // Combine all hearings
        const allHearings = [...houseHearings, ...senateHearings];
        logger.info(`Total videos found across both chambers: ${allHearings.length}`);

        if (allHearings.length === 0) {
            logger.info('No hearings found to process');
            return;
        }

        // Batch check which hearings already exist
        const urlHashes = allHearings.map(h => h.urlHash);
        const existingHashes = await hearingDb.existsBatch(urlHashes);
        
        // Filter to only new hearings
        const newHearings = allHearings.filter(h => !existingHashes.has(h.urlHash));
        logger.info(`Found ${newHearings.length} new videos out of ${allHearings.length} total`);

        if (newHearings.length === 0) {
            logger.info('No new hearings to add');
            return;
        }

        // Fetch video URLs for new hearings that don't have them
        logger.info('Fetching video URLs for new hearings...');
        const hearingsToInsert: Hearing[] = [];
        
        for (const hearing of newHearings) {
            try {
                // House hearings always need video URL fetched
                if (hearing.chamber === 'house' && !hearing.videoUrl) {
                    hearing.videoUrl = await this.houseScraper.fetchVideoUrl(hearing);
                }
                // Senate hearings might already have video URL
                else if (hearing.chamber === 'senate' && !hearing.videoUrl) {
                    hearing.videoUrl = await this.senateScraper.fetchVideoUrl(hearing);
                }
                
                if (hearing.videoUrl) {
                    hearingsToInsert.push(hearing);
                } else {
                    logger.warn(`Could not fetch video URL for: ${hearing.title}`);
                }
            } catch (error) {
                logger.error(`Failed to fetch video URL for ${hearing.title}`, error);
            }
        }

        // Batch insert all new hearings
        if (hearingsToInsert.length > 0) {
            const insertedCount = await hearingDb.createBatch(hearingsToInsert);
            logger.info(`Successfully inserted ${insertedCount} new hearings into database`);
        }
    }

    // Download videos that haven't been downloaded yet
    private async downloadPendingVideos(): Promise<void> {
        // Apply MAX_HEARINGS_PER_RUN limit at download time
        const maxHearingsPerRun = parseInt(process.env.MAX_HEARINGS_PER_RUN || '-1');
        const limit = maxHearingsPerRun > 0 ? maxHearingsPerRun : 100; // Default to 100 if unlimited
        
        const pendingHearings = await hearingDb.getPendingHearings(limit);
        logger.info(`Found ${pendingHearings.length} videos to download (limit: ${maxHearingsPerRun > 0 ? maxHearingsPerRun : 'unlimited'})`);

        for (let i = 0; i < pendingHearings.length; i++) {
            if (this.shouldStop) break;
            
            const hearing = pendingHearings[i];
            logger.info(`Downloading video ${i + 1}/${pendingHearings.length}: ${hearing.title}`);
            
            try {
                await this.videoProcessor.downloadVideo(hearing);
            } catch (error) {
                logger.error(`Failed to download video for hearing ${hearing.id}`, error);
            }
        }
    }

    // Transcribe videos that have been downloaded
    private async transcribePendingVideos(): Promise<void> {
        // Transcription is now handled by Python parallel_processor.py
        // This method is kept for compatibility but does nothing
        logger.info('Transcription is handled by Python parallel_processor.py');
        
        // Log pending transcriptions for visibility
        const result = await db.query(
            `SELECT COUNT(*) as count FROM hearings 
             WHERE download_status = 'completed' 
               AND transcription_status = 'pending'`
        );
        
        if (result.rows[0].count > 0) {
            logger.info(`${result.rows[0].count} videos pending transcription - run parallel_processor.py to process them`);
        }
    }

    // Set up graceful shutdown handlers
    private setupGracefulShutdown(): void {
        const gracefulShutdown = async (signal: string) => {
            logger.info(`Received ${signal}, starting graceful shutdown...`);
            await this.stop();
            process.exit(0);
        };

        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
        process.on('uncaughtException', (error) => {
            logger.error('Uncaught exception:', error);
            gracefulShutdown('uncaughtException');
        });
        process.on('unhandledRejection', (reason, promise) => {
            logger.error('Unhandled rejection at:', promise, 'reason:', reason);
            gracefulShutdown('unhandledRejection');
        });
    }
}

// Main entry point
async function main() {
    const processor = new MichiganHearingsProcessor();
    
    try {
        await processor.init();
        
        // If RUN_ONCE is set, just run once and exit
        if (process.env.RUN_ONCE === 'true') {
            logger.info('Running in single execution mode');
            await processor.process();
            await processor.stop();
            process.exit(0);
        } else {
            // Otherwise, start the scheduled processor
            await processor.start();
            logger.info('Michigan Hearings Processor is running. Press Ctrl+C to stop.');
        }
    } catch (error) {
        logger.error('Failed to start processor:', error);
        process.exit(1);
    }
}

// Run the application
main().catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
});