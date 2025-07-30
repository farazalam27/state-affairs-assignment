import winston from "winston";
import path from 'path';

// Winston is a professional logging library that helps track what's happening
// in your application. Better than console.log because it:
// 1. Can write to multiple destinations (console, files, databases)
// 2. Has log levels (error, warn, info, debug)
// 3. Can format logs as JSON for easy parsing
// 4. Can include metadata and timestamps

const logDir = path.join(process.cwd(), 'logs');

// Define custom log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss'}),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Console format for development (more readable)
const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'HH:mm:ss'}),
    winston.format.printf(({ timestamp, level, message, ...metadata }) => {
        let msg = `${timestamp} [${level}]: ${message}`;
        if (Object.keys(metadata).length > 0) {
            try {
                // Handle circular references by using a replacer function
                const seen = new WeakSet();
                const sanitized = JSON.stringify(metadata, (key, value) => {
                    if (typeof value === "object" && value !== null) {
                        if (seen.has(value)) {
                            return "[Circular]";
                        }
                        seen.add(value);
                    }
                    // Don't log huge buffers or request objects
                    if (key === 'request' || key === 'response' || key === '_currentRequest' || key === '_redirectable') {
                        return "[Object]";
                    }
                    return value;
                });
                msg += ` ${sanitized}`;
            } catch (e) {
                msg += ` [Error stringifying metadata]`;
            }
        }
        return msg;
    })
);

// Create the logger instance
export const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: logFormat,
    defaultMeta: { service: 'michigan-processor' },
    transports: [
        // Write all logs to console
        new winston.transports.Console({
            format: process.env.NODE_ENV === 'production' ? logFormat : consoleFormat
        }),
        // Write all logs to combined.log
        new winston.transports.File({
            filename: path.join(logDir, 'combined.log'),
            maxsize: 10485760, // 10MB
            maxFiles: 5 // Keep 5 backup files
        }),
        // Write only errors to error.log
        new winston.transports.File({
            filename: path.join(logDir, 'error.log'),
            level: 'error',
            maxsize: 10485760,
            maxFiles: 5
        })
    ],
    // Handle exceptions and promise rejections
    exceptionHandlers: [
        new winston.transports.File({ filename: path.join(logDir, 'exceptions.log') })
    ],
    rejectionHandlers: [
        new winston.transports.File({ filename: path.join(logDir, 'rejections.log') })
    ]
});

// Create log directory if it doesn't exist
import fs from 'fs';
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

// Convenience methods for structured logging
export const log = {
    info: (message: string, meta?: any) => logger.info(message, meta),
    error: (message: string, error?: any, meta?: any) => {
        logger.error(message, { error: error?.message || error, stack: error?.stack, ...meta });
    },
    warn: (message: string, meta?: any) => logger.warn(message, meta),
    debug: (message: string, meta?: any) => logger.debug(message, meta),

    // Log HTTP requests
    http: (method: string, url: string, status?: number, duration?: number) => {
        logger.info('HTTP Request', { method, url, status, duration });
    },

    // Log database operations
    db: (operation: string, table: string, duration: number, rowCount?: number) => {
        logger.debug('Database Operation', { operation, table, duration, rowCount });
    },

    // Log processing steps
    process: (step: string, hearingId: string, details?: any) => {
        logger.info('Processing Step', { step, hearingId, ...details });
    }
};