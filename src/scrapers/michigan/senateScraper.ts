import { BaseScraper, Hearing } from '../baseScraper';
import { logger } from '../../utils/logger';
import puppeteer from 'puppeteer';
import { hearingDb } from '../../database/db';

export class SenateScraper extends BaseScraper {
    private readonly baseUrl = 'https://cloud.castus.tv/vod/misenate/';
    private readonly pageSize: number;
    private readonly maxPages: number;
    private readonly maxNewVideos: number;

    constructor() {
        super('senate');
        this.pageSize = parseInt(process.env.SENATE_PAGE_SIZE || '20'); // Default to 20 per page
        this.maxPages = parseInt(process.env.SENATE_MAX_PAGES || '-1');
        this.maxNewVideos = parseInt(process.env.SENATE_MAX_NEW_VIDEOS || '-1'); // -1 means unlimited
    }

    async scrape(): Promise<Hearing[]> {
        // Platform-specific Puppeteer configuration
        const launchArgs = process.platform === 'win32' 
            ? [] // Windows doesn't need special flags
            : process.platform === 'darwin'
            ? ['--disable-setuid-sandbox', '--disable-dev-shm-usage'] // macOS
            : ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']; // Linux
        
        const browser = await puppeteer.launch({
            headless: true,
            args: launchArgs
        });
        
        try {
            logger.info('Starting Senate scraper with Puppeteer');
            const hearings: Hearing[] = [];
            let newVideosFound = 0;
            let existingUrlHashes = new Set<string>();
            
            // If we have a limit on new videos, preload existing URLs to check against
            if (this.maxNewVideos > 0) {
                logger.info(`Smart limit enabled: looking for ${this.maxNewVideos} new videos`);
                // Get all existing URL hashes from database
                const allExisting = await hearingDb.getAllUrlHashes();
                existingUrlHashes = new Set(allExisting);
                logger.info(`Found ${existingUrlHashes.size} existing videos in database`);
            }
            
            const page = await browser.newPage();
            
            // Navigate to the Senate video archive with page=ALL
            const url = `${this.baseUrl}?page=ALL`;
            logger.info(`Navigating to: ${url}`);
            
            await page.goto(url, { 
                waitUntil: 'networkidle2',
                timeout: 30000 
            });
            
            // Wait for video container to load
            await page.waitForSelector('.row.mb-3.border-bottom', {
                timeout: 10000
            }).catch(() => {
                logger.warn('Could not find video container, trying alternative approach');
            });
            
            // Extra wait for initial page content to fully load
            logger.info('Waiting for initial page content to load...');
            await new Promise(resolve => setTimeout(resolve, 6000));
            
            // Optionally set page size to 10 or 20 (NOT 50)
            try {
                await page.select('.avResPerPage select', '20');
                await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for reload
            } catch (error) {
                logger.debug('Could not set page size, continuing with default');
            }
            
            // Try to detect total pages from the UI
            let totalPages = 0;
            try {
                totalPages = await page.evaluate(() => {
                    // Look for page count indicator like "Page 1 of 236"
                    const pageCountText = document.querySelector('.avPageCount')?.textContent;
                    if (pageCountText) {
                        const match = pageCountText.match(/Page \d+ of (\d+)/);
                        if (match) return parseInt(match[1]);
                    }
                    return 0; // No fallback - we'll detect it as we go
                });
                if (totalPages > 0) {
                    logger.info(`Detected ${totalPages} total pages`);
                } else {
                    logger.info('Could not detect total pages upfront, will continue until no more videos found');
                }
            } catch (error) {
                logger.warn('Could not detect total pages, will continue until no more videos found', error);
            }
            
            let currentPage = 1;
            let hasMorePages = true;
            let consecutiveEmptyPages = 0;
            
            while (hasMorePages && (this.maxPages === -1 || currentPage <= this.maxPages)) {
                // Log progress every 10 pages
                if (currentPage % 10 === 0 || currentPage === 1) {
                    logger.info(`Scraping Senate page ${currentPage}/${totalPages} (${hearings.length} videos so far)`);
                } else {
                    logger.debug(`Scraping Senate page ${currentPage}`);
                }
                
                // Get all video elements on the current page
                let videoData: any[] = [];
                
                // Special handling for page 1 - retry if empty
                if (currentPage === 1) {
                    let retries = 0;
                    while (videoData.length === 0 && retries < 3) {
                        if (retries > 0) {
                            logger.debug(`Page 1 retry ${retries}/3 - waiting longer...`);
                            await new Promise(resolve => setTimeout(resolve, 5000));
                        }
                        
                        videoData = await page.evaluate(() => {
                            const videos: any[] = [];
                            
                            // Find video container
                            const videoContainer = document.querySelector('.row.mb-3.border-bottom');
                            if (!videoContainer) return videos;
                            
                            // Find all video elements within the container
                            const videoElements = videoContainer.querySelectorAll('.col-3.mb-3');
                            
                            videoElements.forEach((element: any) => {
                                // Extract video ID from thumbnail URL
                                const thumbnail = element.querySelector('.thumbnail-img');
                                if (!thumbnail) return;
                                
                                const thumbnailSrc = thumbnail.src;
                                // Extract ID from URL like: /outputs/{id}/Default/Thumbnails/
                                const idMatch = thumbnailSrc.match(/\/outputs\/([a-z0-9]+)\//i);
                                if (!idMatch || !idMatch[1]) return;
                                
                                const videoId = idMatch[1];
                                
                                // Extract title - it's the text content after the thumbnail div
                                const thumbnailDiv = element.querySelector('.thumbnail');
                                if (!thumbnailDiv) return;
                                
                                // Get text after thumbnail div but before .dt
                                const titleElement = thumbnailDiv.nextSibling;
                                let title = '';
                                if (titleElement && titleElement.nodeType === Node.TEXT_NODE) {
                                    title = titleElement.textContent.trim();
                                }
                                
                                // Extract view count from .dt element
                                const viewElement = element.querySelector('.dt');
                                const viewText = viewElement?.textContent?.trim();
                                
                                if (videoId && title) {
                                    videos.push({
                                        videoId,
                                        title,
                                        viewText,
                                        thumbnail: thumbnailSrc,
                                        sourceUrl: `https://cloud.castus.tv/vod/misenate/video/${videoId}`
                                    });
                                }
                            });
                            
                            return videos;
                        });
                        
                        retries++;
                    }
                } else {
                    // For other pages, single attempt
                    videoData = await page.evaluate(() => {
                        const videos: any[] = [];
                        
                        // Find video container
                        const videoContainer = document.querySelector('.row.mb-3.border-bottom');
                        if (!videoContainer) return videos;
                        
                        // Find all video elements within the container
                        const videoElements = videoContainer.querySelectorAll('.col-3.mb-3');
                        
                            videoElements.forEach((element: any) => {
                                // Extract video ID from thumbnail URL
                                const thumbnail = element.querySelector('.thumbnail-img');
                                if (!thumbnail) return;
                                
                                const thumbnailSrc = thumbnail.src;
                                // Extract ID from URL like: /outputs/{id}/Default/Thumbnails/
                                const idMatch = thumbnailSrc.match(/\/outputs\/([a-z0-9]+)\//i);
                                if (!idMatch || !idMatch[1]) return;
                                
                                const videoId = idMatch[1];
                                
                                // Extract title - it's the text content after the thumbnail div
                                const thumbnailDiv = element.querySelector('.thumbnail');
                                if (!thumbnailDiv) return;
                                
                                // Get text after thumbnail div but before .dt
                                const titleElement = thumbnailDiv.nextSibling;
                                let title = '';
                                if (titleElement && titleElement.nodeType === Node.TEXT_NODE) {
                                    title = titleElement.textContent.trim();
                                }
                                
                                // Extract view count from .dt element
                                const viewElement = element.querySelector('.dt');
                                const viewText = viewElement?.textContent?.trim();
                                
                                if (videoId && title) {
                                    videos.push({
                                        videoId,
                                        title,
                                        viewText,
                                        thumbnail: thumbnailSrc,
                                        sourceUrl: `https://cloud.castus.tv/vod/misenate/video/${videoId}`
                                    });
                                }
                            });
                            
                            return videos;
                        });
                    }
                
                logger.info(`Found ${videoData.length} videos on page ${currentPage}`);
                
                // Process video data
                for (const video of videoData) {
                    const urlHash = this.generateUrlHash(video.sourceUrl);
                    
                    // Check if this is a new video
                    const isNew = this.maxNewVideos <= 0 || !existingUrlHashes.has(urlHash);
                    
                    if (isNew) {
                        const hearing: Hearing = {
                            sourceUrl: video.sourceUrl,
                            urlHash: urlHash,
                            title: this.cleanText(video.title),
                            chamber: this.chamber
                        };
                        
                        // Optionally fetch video URL immediately
                        if (process.env.FETCH_VIDEO_URLS_DURING_SCRAPE === 'true') {
                            try {
                                logger.debug(`Fetching video URL for: ${hearing.title}`);
                                hearing.videoUrl = await this.fetchVideoUrl(hearing);
                            } catch (error) {
                                logger.warn(`Failed to fetch video URL during scrape: ${hearing.title}`, error);
                            }
                        }
                        
                        hearings.push(hearing);
                        logger.debug(`Found new Senate hearing: ${hearing.title}`);
                        
                        if (this.maxNewVideos > 0) {
                            newVideosFound++;
                            logger.info(`New videos found: ${newVideosFound}/${this.maxNewVideos}`);
                            
                            // Stop if we've found enough new videos
                            if (newVideosFound >= this.maxNewVideos) {
                                logger.info(`Reached limit of ${this.maxNewVideos} new videos, stopping scrape`);
                                hasMorePages = false;
                                break;
                            }
                        }
                    } else {
                        logger.debug(`Skipping existing video: ${video.title}`);
                    }
                }
                
                // Check for next page
                if (videoData.length === 0) {
                    consecutiveEmptyPages++;
                    logger.warn(`Empty page found (${consecutiveEmptyPages} consecutive)`);
                    
                    // Stop if we've seen 3 consecutive empty pages
                    if (consecutiveEmptyPages >= 3) {
                        logger.info('Stopping after 3 consecutive empty pages');
                        hasMorePages = false;
                    } else if (currentPage >= totalPages) {
                        logger.info(`Reached total pages limit (${totalPages})`);
                        hasMorePages = false;
                    }
                } else {
                    consecutiveEmptyPages = 0; // Reset counter
                }
                
                // Continue to next page if we haven't reached the end
                if (hasMorePages && (totalPages === 0 || currentPage < totalPages)) {
                    currentPage++;
                    
                    try {
                        // Find and click the next page button (bottom right arrow)
                        const nextButton = await page.$('button.btn.btn-outline-primary');
                        if (nextButton) {
                            await nextButton.click();
                            
                            // Wait 3-4 seconds for new videos to load
                            await new Promise(resolve => setTimeout(resolve, 4000));
                            
                            // Wait for the video container to be present
                            await page.waitForSelector('.row.mb-3.border-bottom', {
                                timeout: 10000
                            });
                        } else {
                            logger.warn('Next page button not found');
                            hasMorePages = false;
                        }
                    } catch (error) {
                        logger.error(`Failed to navigate to page ${currentPage}`, error);
                        hasMorePages = false;
                    }
                } else {
                    hasMorePages = false;
                }
            }
            
            logger.info(`Senate scraper found ${hearings.length} hearings`);
            return hearings;

        } catch (error) {
            logger.error('Senate scraper failed', error);
            throw error;
        } finally {
            await browser.close();
        }
    }

    private parseVideoElement($: any, element: any): Hearing | null {
        try {
            const $element = $(element);
            
            // Extract video ID from thumbnail URL
            const thumbnailImg = $element.find('img').first();
            const thumbnailSrc = thumbnailImg.attr('src');
            
            if (!thumbnailSrc) {
                logger.debug('No thumbnail found in video element');
                return null;
            }
            
            // Extract ID from URL like: https://dlttx48mxf9m3.cloudfront.net/outputs/{id}/Default/Thumbnails/out_003.png
            const idMatch = thumbnailSrc.match(/\/outputs\/([a-z0-9]+)\//i);
            if (!idMatch || !idMatch[1]) {
                logger.debug('Could not extract video ID from thumbnail URL');
                return null;
            }
            
            const videoId = idMatch[1];
            
            // Build the video page URL
            const sourceUrl = `${this.baseUrl}video/${videoId}?page=HOME`;
            
            // Extract title from alt text or nearby text
            const title = this.cleanText(
                thumbnailImg.attr('alt') || 
                $element.find('.title, h3, h4, .video-title').text() ||
                $element.text()
            );
            
            if (!title) {
                logger.debug('No title found for video');
                return null;
            }
            
            const urlHash = this.generateUrlHash(sourceUrl);

            const hearing: Hearing = {
                sourceUrl,
                urlHash,
                title,
                chamber: this.chamber
            };

            logger.debug(`Parsed Senate hearing: ${title} (ID: ${videoId})`);
            return hearing;

        } catch (error) {
            logger.warn('Failed to parse Senate video element', error);
            return null;
        }
    }

    // Override to fetch video URL from detail page
    async fetchVideoUrl(hearing: Hearing): Promise<string | undefined> {
        // Platform-specific Puppeteer configuration
        const launchArgs = process.platform === 'win32' 
            ? [] // Windows doesn't need special flags
            : process.platform === 'darwin'
            ? ['--disable-setuid-sandbox', '--disable-dev-shm-usage'] // macOS
            : ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']; // Linux
        
        const browser = await puppeteer.launch({
            headless: true,
            args: launchArgs
        });
        
        try {
            logger.debug(`Fetching video URL for: ${hearing.title}`);
            
            const page = await browser.newPage();
            
            // Enable request interception to catch video URLs
            await page.setRequestInterception(true);
            
            let videoUrl: string | undefined;
            
            page.on('request', (request) => {
                const url = request.url();
                // Look for video file requests
                if (url.includes('.mp4') || url.includes('.m3u8') || url.includes('/media/') || url.includes('/video/')) {
                    logger.debug(`Found potential video URL: ${url}`);
                    // Prioritize m3u8 master playlist or mp4 files
                    if (url.includes('.m3u8') && !url.includes('.ts')) {
                        videoUrl = url;
                        logger.debug(`Found HLS master playlist: ${url}`);
                    } else if (url.includes('.mp4')) {
                        videoUrl = url;
                        logger.debug(`Found MP4 video: ${url}`);
                    }
                }
                request.continue();
            });
            
            // Also listen for responses
            page.on('response', (response) => {
                const url = response.url();
                const contentType = response.headers()['content-type'];
                
                if (contentType?.includes('video') || url.includes('.mp4')) {
                    logger.debug(`Found video response: ${url}`);
                    videoUrl = url;
                }
            });
            
            // Navigate to the hearing detail page
            await page.goto(hearing.sourceUrl, { 
                waitUntil: 'networkidle2',
                timeout: 30000 
            });
            
            // Wait for video player to load
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Try to click play button to trigger video load
            try {
                await page.evaluate(() => {
                    // Try different selectors for play button
                    const playButton = document.querySelector('.vjs-play-control, .play-button, button[title*="Play"], .vjs-big-play-button');
                    if (playButton) {
                        (playButton as HTMLElement).click();
                        return true;
                    }
                    // Try to find and play video element directly
                    const video = document.querySelector('video');
                    if (video) {
                        video.play().catch(() => {});
                        return true;
                    }
                    return false;
                });
                
                // Wait for video to start loading
                await new Promise(resolve => setTimeout(resolve, 3000));
            } catch (error) {
                logger.debug('Could not trigger video playback', error);
            }
            
            // Try to find video URL in the page
            if (!videoUrl) {
                videoUrl = await page.evaluate(() => {
                    // Check for video elements
                    const video = document.querySelector('video');
                    if (video) {
                        return video.src || video.querySelector('source')?.src;
                    }
                    
                    // Check for download links
                    const downloadLink = document.querySelector('a[download], a[href*=".mp4"], .download-btn');
                    if (downloadLink) {
                        return (downloadLink as HTMLAnchorElement).href;
                    }
                    
                    // Check in scripts for video URLs
                    const scripts = Array.from(document.querySelectorAll('script'));
                    for (const script of scripts) {
                        const content = script.textContent || '';
                        // Look for m3u8 URLs first (master playlist)
                        const m3u8Match = content.match(/https?:\/\/[^"'\s]+\.m3u8(?!\w)/);
                        if (m3u8Match && !m3u8Match[0].includes('.ts')) {
                            return m3u8Match[0];
                        }
                        // Then mp4
                        const mp4Match = content.match(/https?:\/\/[^"'\s]+\.mp4/);
                        if (mp4Match) {
                            return mp4Match[0];
                        }
                    }
                    
                    // Check data attributes
                    const elements = Array.from(document.querySelectorAll('[data-video-url], [data-src], [data-stream-url]'));
                    for (const elem of elements) {
                        const url = elem.getAttribute('data-video-url') || 
                                   elem.getAttribute('data-src') || 
                                   elem.getAttribute('data-stream-url');
                        if (url && (url.includes('.m3u8') || url.includes('.mp4'))) {
                            return url;
                        }
                    }
                    
                    return undefined;
                });
            }
            
            // If we found an m3u8 URL, we need to handle it differently
            if (videoUrl?.includes('.m3u8')) {
                logger.warn(`Found HLS stream URL for ${hearing.title}: ${videoUrl}`);
                logger.warn('HLS streams require special handling - may need to use ffmpeg to download');
                // For now, return the m3u8 URL and handle it in the video processor
            }
            
            if (videoUrl) {
                logger.info(`Found video URL for ${hearing.title}: ${videoUrl}`);
                return videoUrl;
            }
            
            // Try share button method as fallback
            logger.info(`Trying share button method for ${hearing.title}`);
            try {
                // Look for share button
                const shareButton = await page.$('i.fas.fa-share.text-secondary.mr-2');
                if (shareButton) {
                    logger.debug('Found share button, clicking...');
                    await shareButton.click();
                    
                    // Wait for share menu to appear
                    await page.waitForSelector('.share-item', { timeout: 5000 });
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    
                    // Click download button
                    const downloadButton = await page.$('div.share-item[data-for="downloadVideo"]');
                    if (downloadButton) {
                        logger.debug('Found download button, clicking...');
                        
                        // Set up request interception to capture download URL
                        const downloadPromise = new Promise<string>((resolve) => {
                            page.on('response', (response) => {
                                const url = response.url();
                                if (url.includes('.mp4') || url.includes('download')) {
                                    logger.debug(`Captured potential download URL: ${url}`);
                                    resolve(url);
                                }
                            });
                            
                            // Also check for new tabs/windows
                            browser.on('targetcreated', async (target) => {
                                const newPage = await target.page();
                                if (newPage) {
                                    const url = newPage.url();
                                    if (url && url.includes('.mp4')) {
                                        logger.debug(`Captured download URL from new tab: ${url}`);
                                        resolve(url);
                                    }
                                }
                            });
                        });
                        
                        // Click download and wait for URL
                        await downloadButton.click();
                        
                        // Wait up to 10 seconds for download URL
                        videoUrl = await Promise.race([
                            downloadPromise,
                            new Promise<string>((resolve) => setTimeout(() => resolve(''), 10000))
                        ]);
                        
                        if (videoUrl) {
                            logger.info(`Found video URL via share button: ${videoUrl}`);
                            return videoUrl;
                        }
                    }
                }
            } catch (error) {
                logger.warn('Share button method failed', error);
            }
            
            logger.warn(`No video URL found for Senate hearing: ${hearing.title}`);
            return undefined;
            
        } catch (error) {
            logger.error(`Failed to fetch video URL for Senate hearing: ${hearing.title}`, error);
            return undefined;
        } finally {
            await browser.close();
        }
    }
}