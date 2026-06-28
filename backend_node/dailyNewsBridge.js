const fs = require('fs/promises');
const path = require('path');
const { scrapeLinkedInArticlesViaGoogle, getLinkedInProxyStatus } = require('./linkedinScraper');

const DEFAULT_ROOT = path.resolve(__dirname, '../../smart_job_portal/daily_news_updater');
const root = path.resolve(process.env.DAILY_NEWS_UPDATER_PATH || DEFAULT_ROOT);

async function readJson(relativePath, fallback) {
    const fullPath = path.join(root, relativePath);
    try {
        return JSON.parse(await fs.readFile(fullPath, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') {
            try {
                await fs.mkdir(path.dirname(fullPath), { recursive: true });
                await fs.writeFile(fullPath, JSON.stringify(fallback, null, 2));
            } catch (mkdirError) {
                console.error(`❌ [Bridge] Could not create fallback file ${relativePath}`, mkdirError.message);
            }
            return fallback;
        }
        throw error;
    }
}

async function getDailyNewsSources() {
    const config = await readJson('config/sources.json', {});
    return {
        feeds: Array.isArray(config.feeds) ? config.feeds.filter(item => item?.url) : [],
        mediumFeeds: Array.isArray(config.mediumFeeds) ? config.mediumFeeds.filter(Boolean) : [],
        googleNewsQueries: Array.isArray(config.googleNewsQueries) ? config.googleNewsQueries.filter(Boolean) : [],
        arxivQueries: Array.isArray(config.arxivQueries) ? config.arxivQueries.filter(Boolean) : [],
    };
}

async function getLinkedInImports() {
    const items = await readJson('data/imports/linkedin.json', []);
    const parsedItems = Array.isArray(items) ? items
        .filter(item => item?.title && item?.url)
        .map(item => ({
            headline: String(item.title).trim(),
            source: item.author ? `LinkedIn - ${String(item.author).trim()}` : 'LinkedIn import',
            url: String(item.url).trim(),
            category: 'linkedin',
            snippet: String(item.summary || item.content || '').replace(/\s+/g, ' ').trim().slice(0, 500),
            date: item.publishedAt || null,
            integration: 'DailyNewsUpdate',
        })) : [];

    let proxyItems = [];
    try {
        const proxyRaw = await scrapeLinkedInArticlesViaGoogle();
        proxyItems = proxyRaw.map(item => ({
            headline: item.title,
            source: item.source,
            url: item.url,
            category: item.category,
            snippet: item.snippet,
            date: item.publishedAt,
            integration: item.integration
        }));
    } catch (e) {
        console.error("LinkedIn Proxy scrape failed in bridge:", e.message);
    }
    
    const seenUrls = new Set(parsedItems.map(i => i.url));
    for (const item of proxyItems) {
        if (!seenUrls.has(item.url)) {
            parsedItems.push(item);
        }
    }
    
    return parsedItems;
}

async function getDailyNewsBridgeStatus() {
    try {
        const [sources, linkedIn] = await Promise.all([getDailyNewsSources(), getLinkedInImports()]);
        return {
            connected: true,
            mode: 'read_only',
            root,
            feeds: sources.feeds.length + sources.mediumFeeds.length,
            googleNewsQueries: sources.googleNewsQueries.length,
            arxivQueries: sources.arxivQueries.length,
            linkedInImports: linkedIn.length,
            linkedinProxy: getLinkedInProxyStatus(),
        };
    } catch (error) {
        return { connected: false, mode: 'read_only', root, error: error.message };
    }
}

module.exports = {
    getDailyNewsSources,
    getLinkedInImports,
    getDailyNewsBridgeStatus,
};
