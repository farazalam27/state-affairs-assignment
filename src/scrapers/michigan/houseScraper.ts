import { BaseScraper, Hearing } from '../baseScraper';
import { logger } from '../../utils/logger';
import puppeteer from 'puppeteer';
import { hearingDb } from '../../database/db';
import { TIMEOUTS, RETRIES } from '../../config/constants';

export class HouseScraper extends BaseScraper {
    private readonly baseUrl = 'https://house.mi.gov/VideoArchive';
    private readonly startYear: number;
    private readonly endYear: number;
    private readonly maxNewVideos: number;

    constructor() {
        super('house');
        // Default to scraping all years from 2015 to current year
        this.startYear = parseInt(process.env.HOUSE_START_YEAR || '2015');
        this.endYear = parseInt(process.env.HOUSE_END_YEAR || new Date().getFullYear().toString());
        this.maxNewVideos = parseInt(process.env.HOUSE_MAX_NEW_VIDEOS || '-1'); // -1 means unlimited
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
            logger.info(`Starting House scraper for years ${this.startYear}-${this.endYear}`);
            const allHearings: Hearing[] = [];
            let newVideosFound = 0;
            
            // If we have a limit on new videos, we'll check each one individually
            if (this.maxNewVideos > 0) {
                logger.info(`Smart limit enabled: looking for ${this.maxNewVideos} new videos`);
            }
            
            const page = await browser.newPage();
            
            // Navigate to the House video archive
            await page.goto(this.baseUrl, {
                waitUntil: 'networkidle2',
                timeout: TIMEOUTS.NAVIGATION
            });
            
            // Wait for the page to load
            await page.waitForSelector('#FilterYear', { timeout: TIMEOUTS.ELEMENT_WAIT });

            // Iterate through each year in reverse order (newest first)
            for (let year = this.endYear; year >= this.startYear; year--) {
                logger.info(`Scraping House videos for year ${year}`);
                
                // Select the year from dropdown
                await page.select('#FilterYear', year.toString());
                
                // Wait 1-2 seconds to ensure selection is registered
                await new Promise(resolve => setTimeout(resolve, TIMEOUTS.YEAR_SELECT));
                
                // Try clicking filter button up to 3 times
                let filterSuccess = false;
                for (let attempt = 1; attempt <= RETRIES.FILTER_BUTTON; attempt++) {
                    logger.debug(`Filter button click attempt ${attempt}/3 for year ${year}`);
                    
                    const filterButton = await page.$('#FilterCommand');
                    if (!filterButton) {
                        throw new Error('Filter button not found');
                    }
                    await filterButton.click();
                    
                    // Wait for page update
                    await Promise.race([
                        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {}),
                        new Promise(resolve => setTimeout(resolve, 5000))
                    ]);
                    
                    // Check if we got videos from the correct year
                    const firstVideoTitle = await page.evaluate(() => {
                        const firstVideo = document.querySelector('.page-search-object a');
                        return firstVideo ? firstVideo.textContent?.trim() : null;
                    });
                    
                    if (firstVideoTitle && firstVideoTitle.includes(year.toString())) {
                        filterSuccess = true;
                        break;
                    } else if (attempt < 3) {
                        logger.debug(`Year mismatch in results, retrying filter...`);
                        await new Promise(resolve => setTimeout(resolve, TIMEOUTS.SCRAPER_RETRY));
                    }
                }
                
                if (!filterSuccess) {
                    logger.warn(`Filter may not have worked properly for year ${year}`);
                }
                
                // Wait for video elements to appear
                await page.waitForSelector('.page-search-object', { 
                    timeout: 10000 
                }).catch(() => {
                    logger.warn(`No videos found for year ${year}`);
                });
                
                // Verify the year is still selected
                const selectedYear = await page.evaluate(() => {
                    const select = document.querySelector('#FilterYear') as HTMLSelectElement;
                    return select ? select.value : null;
                });
                
                if (selectedYear !== year.toString()) {
                    logger.warn(`Year mismatch: expected ${year}, got ${selectedYear}`);
                }
                
                // Extract video data
                const yearHearings = await page.evaluate(() => {
                    const hearings: any[] = [];
                    const elements = document.querySelectorAll('.page-search-object');
                    
                    elements.forEach((element: any) => {
                        const linkElement = element.querySelector('a');
                        if (!linkElement) return;
                        
                        const relativeUrl = linkElement.getAttribute('href');
                        const title = linkElement.textContent?.trim();
                        
                        if (relativeUrl && title) {
                            // Extract additional info if available
                            const dateText = element.querySelector('.date, .datetime, time')?.textContent?.trim();
                            
                            hearings.push({
                                relativeUrl,
                                title,
                                dateText
                            });
                        }
                    });
                    
                    return hearings;
                });
                
                logger.info(`Found ${yearHearings.length} videos for year ${year}`);
                
                // Parse all videos first
                const parsedHearings: Hearing[] = [];
                for (const data of yearHearings) {
                    const hearing = this.parseVideoData(data);
                    if (hearing) {
                        parsedHearings.push(hearing);
                    }
                }
                
                // Batch check which videos already exist
                let newHearings = parsedHearings;
                if (this.maxNewVideos > 0 && parsedHearings.length > 0) {
                    const urlHashes = parsedHearings.map(h => h.urlHash);
                    const existingHashes = await hearingDb.existsBatch(urlHashes);
                    newHearings = parsedHearings.filter(h => !existingHashes.has(h.urlHash));
                    logger.info(`Batch check: ${newHearings.length} new videos out of ${parsedHearings.length} total`);
                }
                
                // Process only new videos
                let yearNewVideos = 0;
                for (const hearing of newHearings) {
                    // Optionally fetch video URL immediately
                    if (process.env.FETCH_VIDEO_URLS_DURING_SCRAPE === 'true' && !hearing.videoUrl) {
                        try {
                            logger.debug(`Fetching video URL for: ${hearing.title}`);
                            hearing.videoUrl = await this.fetchVideoUrl(hearing);
                        } catch (error) {
                            logger.warn(`Failed to fetch video URL during scrape: ${hearing.title}`, error);
                        }
                    }
                    
                    allHearings.push(hearing);
                    yearNewVideos++;
                    
                    if (this.maxNewVideos > 0) {
                        newVideosFound++;
                        logger.info(`New videos found: ${newVideosFound}/${this.maxNewVideos}`);
                        
                        // Stop if we've found enough new videos
                        if (newVideosFound >= this.maxNewVideos) {
                            logger.info(`Reached limit of ${this.maxNewVideos} new videos, stopping scrape`);
                            break;
                        }
                    }
                }
                
                logger.info(`Found ${yearNewVideos} new videos for year ${year}`);
                
                // Stop iterating years if we've found enough
                if (this.maxNewVideos > 0 && newVideosFound >= this.maxNewVideos) {
                    break;
                }
                
                // Add a small delay between years to be respectful
                if (year > this.startYear) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            logger.info(`House scraper found ${allHearings.length} total hearings across ${this.endYear - this.startYear + 1} years`);
            return allHearings;

        } catch (error) {
            logger.error('House scraper failed', error);
            throw error;
        } finally {
            await browser.close();
        }
    }

    private parseVideoData(data: any): Hearing | null {
        try {
            if (!data.relativeUrl || !data.title) {
                return null;
            }
            
            // The sourceUrl should be the VideoArchivePlayer URL
            const sourceUrl = this.makeAbsoluteUrl(data.relativeUrl);
            const urlHash = this.generateUrlHash(sourceUrl);

            const hearing: Hearing = {
                sourceUrl,
                urlHash,
                title: this.cleanText(data.title),
                chamber: this.chamber
            };

            logger.debug(`Parsed hearing: ${hearing.title} (${sourceUrl})`);
            return hearing;

        } catch (error) {
            logger.warn('Failed to parse video data', error);
            return null;
        }
    }
    

    // Override to fetch video URL from detail page
    async fetchVideoUrl(hearing: Hearing): Promise<string | undefined> {
        try {
            logger.debug(`Fetching video URL from player page: ${hearing.sourceUrl}`);
            
            // The sourceUrl should be like: https://house.mi.gov/VideoArchivePlayer?video=AGRI-032019.mp4
            // Extract the video filename from the query parameter
            const url = new URL(hearing.sourceUrl);
            const videoParam = url.searchParams.get('video');
            
            if (videoParam && videoParam.endsWith('.mp4')) {
                // Based on the JavaScript pattern found on the player page:
                // file: "https://www.house.mi.gov/ArchiveVideoFiles/" + video
                const videoUrl = `https://www.house.mi.gov/ArchiveVideoFiles/${videoParam}`;
                logger.info(`Constructed video URL: ${videoUrl}`);
                return videoUrl;
            }
            
            logger.warn(`No video parameter found in URL: ${hearing.sourceUrl}`);
            return undefined;
            
        } catch (error) {
            logger.error(`Failed to fetch video URL for hearing: ${hearing.title}`, error);
            return undefined;
        }
    }
}