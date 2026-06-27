const fs = require('fs/promises');
const path = require('path');

const DEFAULT_ROOT = path.resolve(__dirname, '../../smart_job_portal/daily_news_updater');
const root = path.resolve(process.env.DAILY_NEWS_UPDATER_PATH || DEFAULT_ROOT);

async function readJson(relativePath, fallback) {
    try {
        return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return fallback;
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
    if (!Array.isArray(items)) return [];
    return items
        .filter(item => item?.title && item?.url)
        .map(item => ({
            headline: String(item.title).trim(),
            source: item.author ? `LinkedIn - ${String(item.author).trim()}` : 'LinkedIn import',
            url: String(item.url).trim(),
            category: 'linkedin',
            snippet: String(item.summary || item.content || '').replace(/\s+/g, ' ').trim().slice(0, 500),
            date: item.publishedAt || null,
            integration: 'DailyNewsUpdate',
        }));
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
