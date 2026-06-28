const Parser = require('rss-parser');
const axios = require('axios');
const cheerio = require('cheerio');

const parser = new Parser({
    timeout: 8000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
});

let proxyStatus = {
    available: false,
    lastScrape: null,
    items: 0,
    method: 'not_checked',
    lastError: null,
};

const LINKEDIN_GUEST_ENDPOINT = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const REQUEST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
};

function cleanText(value = '') {
    return String(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchLinkedInGuestPage({ keywords, location, start }) {
    const response = await axios.get(LINKEDIN_GUEST_ENDPOINT, {
        params: { keywords, location, start, f_TPR: 'r604800' },
        headers: REQUEST_HEADERS,
        timeout: 15000,
        validateStatus: status => status >= 200 && status < 500,
    });
    if (response.status >= 400 || typeof response.data !== 'string') {
        throw new Error(`LinkedIn guest endpoint HTTP ${response.status}`);
    }
    const $ = cheerio.load(response.data);
    return $('li .base-search-card').map((_, card) => {
        const node = $(card);
        const rawUrl = node.find('a.base-card__full-link').attr('href') || '';
        const publishedAt = node.find('time').attr('datetime') || null;
        return {
            title: cleanText(node.find('.base-search-card__title').text()),
            company: cleanText(node.find('.base-search-card__subtitle').text()) || 'LinkedIn employer',
            location: cleanText(node.find('.job-search-card__location').text()) || location || 'Remote',
            url: rawUrl.replace(/&amp;/g, '&').split('?')[0],
            sourcePublishedAt: publishedAt ? new Date(`${publishedAt}T00:00:00Z`).toISOString() : null,
            isRemote: /remote/i.test(`${location} ${node.find('.job-search-card__location').text()}`),
            source: 'LinkedIn public jobs',
            time: 'LinkedIn guest listing',
            integration: 'linkedin_guest_api',
        };
    }).get().filter(item => item.title && item.url);
}

async function scrapeLinkedInGuestJobs(maxItems = 60) {
    const searches = [
        { keywords: 'software engineer', location: 'India' },
        { keywords: 'artificial intelligence engineer', location: 'India' },
        { keywords: 'data scientist', location: 'India' },
        { keywords: 'software engineer', location: 'Remote' },
    ];
    const requests = searches.flatMap(search => [0, 10].map(start => fetchLinkedInGuestPage({ ...search, start })));
    const settled = await Promise.allSettled(requests);
    const seen = new Set();
    const jobs = settled.flatMap(result => result.status === 'fulfilled' ? result.value : [])
        .filter(job => {
            if (seen.has(job.url)) return false;
            seen.add(job.url);
            return true;
        })
        .slice(0, maxItems);
    const failures = settled.filter(result => result.status === 'rejected');
    proxyStatus = {
        available: jobs.length > 0,
        lastScrape: new Date().toISOString(),
        items: jobs.length,
        method: 'linkedin_guest_api',
        lastError: jobs.length ? null : (failures[0]?.reason?.message || 'no_public_jobs_returned'),
    };
    return jobs;
}

async function fetchGoogleNewsRss(query) {
    try {
        const encodedQuery = encodeURIComponent(query);
        const feedUrl = `https://news.google.com/rss/search?q=${encodedQuery}&hl=en&gl=US&ceid=US:en`;
        const feed = await parser.parseURL(feedUrl);
        return feed.items || [];
    } catch (error) {
        console.error(`❌ [LinkedIn Scraper] Error fetching Google News RSS for query: ${query}`, error.message);
        return [];
    }
}

async function scrapeLinkedInViaGoogle(queries, category = 'linkedin', maxItems = 30) {
    const feeds = await Promise.all(queries.map(query => fetchGoogleNewsRss(`${query} when:7d`)));
    const allItems = [];
    const seenUrls = new Set();

    for (const items of feeds) {
        for (const item of items) {
            if (allItems.length >= maxItems) break;
            
            // Extract the actual LinkedIn URL if possible, otherwise use the Google News redirect URL
            const url = item.link;
            
            if (url && !seenUrls.has(url)) {
                seenUrls.add(url);
                allItems.push({
                    title: item.title?.replace(/ - .*$/, '') || 'LinkedIn Post',
                    url: url,
                    source: 'LinkedIn via Google',
                    category: category,
                    snippet: item.contentSnippet || item.content || '',
                    publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
                    integration: 'linkedin_proxy'
                });
            }
        }
        
        if (allItems.length >= maxItems) break;
    }
    
    return allItems;
}

async function scrapeLinkedInJobsViaGoogle() {
    try {
        const guestJobs = await scrapeLinkedInGuestJobs(60);
        if (guestJobs.length) return guestJobs;
    } catch (error) {
        proxyStatus.lastError = error.message;
    }
    const queries = [
        'site:linkedin.com/jobs "software engineer"',
        'site:linkedin.com/jobs "machine learning"',
        'site:linkedin.com/jobs "data scientist"',
        'site:linkedin.com/jobs remote'
    ];
    
    console.log(`🌐 [LinkedIn Scraper] Fetching LinkedIn Jobs via Google RSS...`);
    const jobs = await scrapeLinkedInViaGoogle(queries, 'linkedin_job', 30);
    
    proxyStatus = {
        available: jobs.length > 0,
        lastScrape: new Date().toISOString(),
        items: jobs.length,
        method: 'google_news_rss_fallback',
        lastError: jobs.length ? null : proxyStatus.lastError || 'no_linkedin_results',
    };
    
    return jobs;
}

async function scrapeLinkedInArticlesViaGoogle() {
    const queries = [
        'site:linkedin.com/pulse "technology"',
        'site:linkedin.com/pulse "artificial intelligence"',
        'site:linkedin.com/pulse "software engineering"'
    ];
    
    console.log(`📰 [LinkedIn Scraper] Fetching LinkedIn Articles via Google RSS...`);
    const articles = await scrapeLinkedInViaGoogle(queries, 'linkedin_article', 30);
    
    if (articles.length > 0) {
        proxyStatus.available = true;
        proxyStatus.lastScrape = new Date().toISOString();
        proxyStatus.items = Math.max(proxyStatus.items || 0, articles.length);
    }
    
    return articles;
}

function getLinkedInProxyStatus() {
    return proxyStatus;
}

module.exports = {
    scrapeLinkedInGuestJobs,
    scrapeLinkedInJobsViaGoogle,
    scrapeLinkedInArticlesViaGoogle,
    getLinkedInProxyStatus
};
