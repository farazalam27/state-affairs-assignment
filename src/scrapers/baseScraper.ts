import crypto from 'crypto';

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
    protected chamber: 'house' | 'senate';

    constructor(chamber: 'house' | 'senate') {
        this.chamber = chamber;
    }

    // Generate SHA-256 hash of URL for deduplication
    protected generateUrlHash(url: string): string {
        return crypto.createHash('sha256').update(url).digest('hex');
    }


    // Clean up text by removing extra whitespace
    protected cleanText(text: string): string {
        return text.trim().replace(/\s+/g, ' ');
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