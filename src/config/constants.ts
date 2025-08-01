// Timeout values in milliseconds
export const TIMEOUTS = {
    NAVIGATION: 30000,      // 30 seconds for page navigation
    ELEMENT_WAIT: 10000,    // 10 seconds to wait for elements
    BETWEEN_PAGES: 5000,    // 5 seconds between page loads
    INITIAL_LOAD: 6000,     // 6 seconds for initial page load
    YEAR_SELECT: 1500,      // 1.5 seconds after year selection
    SCRAPER_RETRY: 1000,    // 1 second between retry attempts
} as const;

// Retry configuration
export const RETRIES = {
    FILTER_BUTTON: parseInt(process.env.MAX_FILTER_RETRIES || '3'),
    EMPTY_PAGE: parseInt(process.env.MAX_EMPTY_PAGE_RETRIES || '3'),
    VIDEO_FETCH: parseInt(process.env.MAX_VIDEO_FETCH_RETRIES || '3'),
} as const;

// Senate scraper configuration
export const SENATE_CONFIG = {
    PAGE_SIZES: [10, 20],  // Valid page size options
    DEFAULT_PAGE_SIZE: parseInt(process.env.SENATE_PAGE_SIZE || '20'),
} as const;

// Progress logging
export const LOGGING = {
    PAGE_LOG_INTERVAL: 10,  // Log progress every N pages
} as const;