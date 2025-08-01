import { Pool, PoolClient } from "pg";
import { logger } from "../utils/logger";
import dotenv from "dotenv";

dotenv.config();

// PostgreSQL connection pool
// A pool maintains multiple connections and reuses them for better performance
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Alternative individual settings:
    // host: process.env.DB_HOST,
    // port: parseInt(process.env.DB_PORT || '5432'),
    // database: process.env.DB_NAME,
    // user: process.env.DB_USER,
    // password: process.env.DB_PASSWORD,
    max: 10, // Maximum number of clients in the pool
    idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
    connectionTimeoutMillis: 2000, // Timeout if can't connect in 2 seconds
});

// Log pool errors
pool.on('error', (err) => {
    logger.error('Unexpected PostgreSQL pool error', err);
});

// Database interface with common operations
export const db = {
    // Get a client from the pool
    async getClient(): Promise<PoolClient> {
        return pool.connect();
    },

    // Execute a simple query
    async query(text: string, params?: any[]) {
        const start = Date.now();
        try {
            const result = await pool.query(text, params);
            const duration = Date.now() - start;
            logger.debug('Query executed', { text, duration, rows: result.rowCount });
            return result;
        } catch (error) {
            logger.error('Query error', { text, error });
            throw error;
        }
    },

    // Transaction helper - ensures commit/rollback
    async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await callback(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    },

    // Check if database is connected
    async isConnected(): Promise<boolean> {
        try {
            await pool.query('SELECT 1');
            return true;
        } catch {
            return false;
        }
    },

    // Close all connections
    async close(): Promise<void> {
        await pool.end();
    }
};

// Type definitions
export interface HearingRecord {
    id: string;
    url: string;
    source_url: string;
    url_hash: string;
    title: string;
    chamber: 'house' | 'senate';
    video_file_path?: string;
    video_size_bytes?: number;
    download_status: string;
    transcription_status: string;
    retry_count: number;
}

// Hearing-specific database operations
export const hearingDb = {

    // Batch check if URLs exist - returns Set of existing URL hashes
    async existsBatch(urlHashes: string[]): Promise<Set<string>> {
        if (urlHashes.length === 0) return new Set();
        
        // Create parameterized placeholders ($1, $2, $3, ...)
        const placeholders = urlHashes.map((_, i) => `$${i + 1}`).join(', ');
        
        const result = await db.query(
            `SELECT url_hash FROM hearings WHERE url_hash IN (${placeholders})`,
            urlHashes
        );
        
        return new Set(result.rows.map(row => row.url_hash));
    },

    // Insert a new hearing
    async create(hearing: {
        sourceUrl: string;
        urlHash: string;
        title?: string;
        chamber: 'house' | 'senate';
        videoUrl?: string;
    }) {
        const result = await db.query(
            `INSERT INTO hearings 
       (source_url, url_hash, title, chamber, url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
            [
                hearing.sourceUrl,
                hearing.urlHash,
                hearing.title,
                hearing.chamber,
                hearing.videoUrl || hearing.sourceUrl
            ]
        );
        return result.rows[0];
    },

    // Batch insert multiple hearings at once
    async createBatch(hearings: Array<{
        sourceUrl: string;
        urlHash: string;
        title?: string;
        chamber: 'house' | 'senate';
        videoUrl?: string;
    }>): Promise<number> {
        if (hearings.length === 0) return 0;
        
        // Build VALUES clause with parameterized placeholders
        const values: any[] = [];
        const valueClauses: string[] = [];
        
        hearings.forEach((hearing, index) => {
            const offset = index * 5; // 5 fields per hearing
            valueClauses.push(
                `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`
            );
            
            values.push(
                hearing.sourceUrl,
                hearing.urlHash,
                hearing.title,
                hearing.chamber,
                hearing.videoUrl || hearing.sourceUrl  // Use videoUrl if available, otherwise sourceUrl
            );
        });
        
        const query = `
            INSERT INTO hearings 
            (source_url, url_hash, title, chamber, url)
            VALUES ${valueClauses.join(', ')}
            ON CONFLICT (url_hash) DO NOTHING
            RETURNING id
        `;
        
        const result = await db.query(query, values);
        logger.info(`Batch inserted ${result.rowCount} new hearings out of ${hearings.length} total`);
        
        return result.rowCount || 0;
    },

    // Get hearings that need processing
    async getPendingHearings(limit: number = 10): Promise<HearingRecord[]> {
        const result = await db.query(
            `SELECT * FROM hearings 
       WHERE download_status = 'pending' 
          OR (download_status = 'failed' AND retry_count < 3)
          OR (download_status = 'failed' AND transcription_status != 'completed')
          OR (download_status = 'downloading' AND updated_at < NOW() - INTERVAL '30 minutes')
       ORDER BY created_at ASC
       LIMIT $1`,
            [limit]
        );
        return result.rows;
    },

    // Update hearing status
    async updateStatus(
        id: string,
        updates: {
            downloadStatus?: string;
            transcriptionStatus?: string;
            downloadStartedAt?: Date;
            downloadCompletedAt?: Date;
            videoFilePath?: string;
            videoSizeBytes?: number;
            transcriptionStartedAt?: Date;
            transcriptionCompletedAt?: Date;
            transcriptionText?: string;
            transcriptionJson?: any;
            retryCount?: number;
        }
    ) {
        const fields: string[] = [];
        const values: any[] = [];
        let paramCount = 1;

        // Build dynamic UPDATE query
        Object.entries(updates).forEach(([key, value]) => {
            if (value !== undefined) {
                // Convert camelCase to snake_case
                const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
                fields.push(`${snakeKey} = $${paramCount}`);
                values.push(value);
                paramCount++;
            }
        });

        if (fields.length === 0) return;

        values.push(id); // Add ID as last parameter
        const query = `
      UPDATE hearings 
      SET ${fields.join(', ')}
      WHERE id = $${paramCount}
    `;

        await db.query(query, values);
    },
};
