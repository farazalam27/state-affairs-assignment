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
            msg += ` ${JSON.stringify(metadata)}`;
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
        })
    ]
});

// Create log directory if it doesn't exist
import fs from 'fs';
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}