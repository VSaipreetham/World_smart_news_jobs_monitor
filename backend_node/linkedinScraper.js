const Parser = require('rss-parser');
const axios = require('axios');

const parser = new Parser({
    timeout: 8000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
});

let proxyStatus = {
    available: false,
    lastScrape: null,
    items: 0
};

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
    let allItems = [];
    const seenUrls = new Set();

    for (const query of queries) {
        const items = await fetchGoogleNewsRss(query);
        
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
    const queries = [
        'site:linkedin.com/jobs "software engineer"',
        'site:linkedin.com/jobs "machine learning"',
        'site:linkedin.com/jobs "data scientist"',
        'site:linkedin.com/jobs remote'
    ];
    
    console.log(`🌐 [LinkedIn Scraper] Fetching LinkedIn Jobs via Google RSS...`);
    const jobs = await scrapeLinkedInViaGoogle(queries, 'linkedin_job', 30);
    
    if (jobs.length > 0) {
        proxyStatus.available = true;
        proxyStatus.lastScrape = new Date().toISOString();
        proxyStatus.items += jobs.length;
    }
    
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
        proxyStatus.items += articles.length;
    }
    
    return articles;
}

function getLinkedInProxyStatus() {
    return proxyStatus;
}

module.exports = {
    scrapeLinkedInJobsViaGoogle,
    scrapeLinkedInArticlesViaGoogle,
    getLinkedInProxyStatus
};
