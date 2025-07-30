import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import crypto from 'crypto';
import https from 'https';
import { logger } from '../utils/logger';

type CheerioAPI = cheerio.CheerioAPI;
type Element = any;

// Define the structure of a hearing
export interface Hearing {
    sourceUrl: string;
    urlHash: string;
    title: string;
    chamber: 'house' | 'senate';
    videoUrl?: string;
}

// Base class for scrapers - contains common functionality
export abstract class BaseScraper {
    protected axios: AxiosInstance;
    protected chamber: 'house' | 'senate';

    constructor(chamber: 'house' | 'senate') {
        this.chamber = chamber;

        // Create axios instance with default config
        // Axios is an HTTP client that makes it easy to fetch web pages
        this.axios = axios.create({
            timeout: 30000, // 30 second timeout
            headers: {
                // Pretend to be a real browser to avoid being blocked
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            // Handle SSL certificate issues in Docker
            httpsAgent: new https.Agent({
                rejectUnauthorized: false
            })
        });

        // Add request/response interceptors for logging
        this.axios.interceptors.request.use(
            (config) => {
                logger.debug(`Fetching ${config.url}`);
                return config;
            },
            (error) => {
                logger.error('Request error', error);
                return Promise.reject(error);
            }
        );
    }

    // Generate SHA-256 hash of URL for deduplication
    protected generateUrlHash(url: string): string {
        return crypto.createHash('sha256').update(url).digest('hex');
    }

    // Fetch and parse a web page
    protected async fetchPage(url: string): Promise<CheerioAPI> {
        try {
            const response = await this.axios.get(url);
            // Cheerio gives us jQuery-like server-side DOM manipulation
            return cheerio.load(response.data);
        } catch (error) {
            logger.error(`Failed to fetch ${url}`, error);
            throw error;
        }
    }

    // Parse date strings in various formats
    protected parseDate(dateStr: string): Date | undefined {
        if (!dateStr) return undefined;

        try {
            // Try different date formats
            const formats = [
                // Common formats
                new Date(dateStr),
                // MM/DD/YYYY
                new Date(dateStr.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$1-$2')),
                // Month DD, YYYY
                new Date(dateStr.replace(/(\w+)\s+(\d{1,2}),\s+(\d{4})/, '$1 $2 $3'))
            ];

            for (const date of formats) {
                if (!isNaN(date.getTime())) {
                    return date;
                }
            }

            logger.warn(`Could not parse date: ${dateStr}`);
            return undefined;
        } catch {
            return undefined;
        }
    }

    // Clean up text by removing extra whitespace
    protected cleanText(text: string): string {
        return text.trim().replace(/\s+/g, ' ');
    }

    // Extract video URL from various possible formats
    protected extractVideoUrl($: CheerioAPI, element: Element): string | undefined {
        // Try different selectors that might contain video URLs
        const possibleSelectors = [
            'a[href*=".mp4"]',
            'a[href*=".m3u8"]',
            'a[href*="video"]',
            'source[src*=".mp4"]',
            'video source',
            'iframe[src*="video"]'
        ];

        for (const selector of possibleSelectors) {
            const found = $(element).find(selector).first();
            const url = found.attr('href') || found.attr('src');
            if (url) {
                // Make sure it's an absolute URL
                return this.makeAbsoluteUrl(url);
            }
        }

        return undefined;
    }

    // Convert relative URLs to absolute URLs
    protected makeAbsoluteUrl(url: string): string {
        if (url.startsWith('http')) return url;

        const baseUrl = this.chamber === 'house'
            ? 'https://house.mi.gov'
            : 'https://cloud.castus.tv';

        return new URL(url, baseUrl).href;
    }

    // Abstract method - each scraper must implement this
    abstract scrape(): Promise<Hearing[]>;
}