import { createServer, IncomingMessage, ServerResponse } from 'http';
import { db } from '../database/db';
import { logger } from '../utils/logger';

interface HealthStatus {
    status: 'healthy' | 'unhealthy';
    timestamp: string;
    checks: {
        database: boolean;
        storage: boolean;
        whisper: boolean;
    };
    stats?: {
        lastRun?: string;
        lastSuccessfulRun?: string;
        totalHearings?: number;
        pendingDownloads?: number;
        pendingTranscriptions?: number;
    };
    error?: string;
}

export class HealthCheckServer {
    private server: ReturnType<typeof createServer> | null = null;
    
    async start(port: number = 3000): Promise<void> {
        this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            if (req.url === '/health') {
                const health = await this.getHealthStatus();
                
                res.statusCode = health.status === 'healthy' ? 200 : 503;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(health, null, 2));
            } else if (req.url === '/metrics') {
                const metrics = await this.getMetrics();
                
                res.statusCode = 200;
                res.setHeader('Content-Type', 'text/plain');
                res.end(metrics);
            } else {
                res.statusCode = 404;
                res.end('Not Found');
            }
        });
        
        this.server.listen(port, () => {
            logger.info(`Health check server listening on port ${port}`);
        });
    }
    
    async stop(): Promise<void> {
        if (this.server) {
            this.server.close();
            this.server = null;
        }
    }
    
    private async getHealthStatus(): Promise<HealthStatus> {
        const health: HealthStatus = {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            checks: {
                database: false,
                storage: false,
                whisper: false
            }
        };
        
        try {
            // Check database
            health.checks.database = await db.isConnected();
            
            // Check storage directories
            const fs = require('fs-extra');
            health.checks.storage = await fs.pathExists('./tmp/videos') &&
                                   await fs.pathExists('./transcriptions');
            
            // Check Python Whisper availability
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            
            try {
                await execAsync('python3 -c "import faster_whisper"');
                health.checks.whisper = true;
            } catch {
                health.checks.whisper = false;
            }
            
            // Get stats if database is healthy
            if (health.checks.database) {
                const stateResult = await db.query('SELECT key, value FROM system_state');
                const state = stateResult.rows.reduce((acc, row) => {
                    acc[row.key] = row.value;
                    return acc;
                }, {});
                
                const statsResult = await db.query(`
                    SELECT 
                        COUNT(*) as total,
                        COUNT(CASE WHEN download_status = 'pending' THEN 1 END) as pending_downloads,
                        COUNT(CASE WHEN download_status = 'completed' AND transcription_status = 'pending' THEN 1 END) as pending_transcriptions
                    FROM hearings
                `);
                
                health.stats = {
                    lastRun: state.last_run || 'never',
                    lastSuccessfulRun: state.last_successful_run || 'never',
                    totalHearings: parseInt(statsResult.rows[0].total),
                    pendingDownloads: parseInt(statsResult.rows[0].pending_downloads),
                    pendingTranscriptions: parseInt(statsResult.rows[0].pending_transcriptions)
                };
            }
            
            // Set overall status
            if (!health.checks.database) {
                health.status = 'unhealthy';
                health.error = 'Database connection failed';
            } else if (!health.checks.storage) {
                health.status = 'unhealthy';
                health.error = 'Storage directories not accessible';
            }
            
        } catch (error) {
            health.status = 'unhealthy';
            health.error = error instanceof Error ? error.message : String(error);
        }
        
        return health;
    }
    
    private async getMetrics(): Promise<string> {
        try {
            const result = await db.query(`
                SELECT 
                    chamber,
                    download_status,
                    transcription_status,
                    COUNT(*) as count
                FROM hearings
                GROUP BY chamber, download_status, transcription_status
            `);
            
            let metrics = '# HELP hearings_total Total number of hearings by status\n';
            metrics += '# TYPE hearings_total gauge\n';
            
            for (const row of result.rows) {
                metrics += `hearings_total{chamber="${row.chamber}",download_status="${row.download_status}",transcription_status="${row.transcription_status}"} ${row.count}\n`;
            }
            
            return metrics;
        } catch (error) {
            return `# Error: ${error instanceof Error ? error.message : String(error)}\n`;
        }
    }
}