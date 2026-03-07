require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');
const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const ytSearch = require('yt-search');
const { JOB_APIS, JOB_RSS_FEEDS, NEWS_RSS_FEEDS, HN_QUERIES } = require('./sources');

const app = express();
app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════
const genAI = new GoogleGenerativeAI(process.env.Google_token);
const REFRESH_INTERVAL = 10 * 60 * 1000;   // 10 minutes
const DB_PURGE_INTERVAL = 3 * 60 * 60 * 1000; // 3 hours
const RSS_TIMEOUT = 8000;  // 8s per feed
const API_TIMEOUT = 10000; // 10s per API
const BATCH_SIZE = 25;     // parallel fetch batch size

// ═══════════════════════════════════════════════════════════════
// DATABASE (Neon PostgreSQL)
// ═══════════════════════════════════════════════════════════════
let pool = null;
if (process.env.DATABASE_URL) {
    let dbUrl = process.env.DATABASE_URL;
    if (dbUrl.startsWith('postgres://')) dbUrl = dbUrl.replace('postgres://', 'postgresql://');
    pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    console.log("✅ Connected to Neon PostgreSQL");
}

// Ensure tables exist
async function ensureDBTables() {
    if (!pool) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS jobs (
                id SERIAL PRIMARY KEY,
                title TEXT, company TEXT, url TEXT UNIQUE,
                source TEXT, location TEXT, pay TEXT,
                posted_date TEXT, status TEXT DEFAULT 'open',
                created_at TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS news (
                id SERIAL PRIMARY KEY,
                headline TEXT, source TEXT, url TEXT UNIQUE,
                category TEXT, snippet TEXT,
                published_date TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS youtube_videos (
                id SERIAL PRIMARY KEY,
                title TEXT, video_id TEXT UNIQUE,
                channel TEXT, published TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
        console.log("✅ DB tables ensured");
    } catch (e) { console.error("DB table creation error:", e.message); }
}

// ═══════ 3-HOUR DATABASE PURGE ═══════
async function purgeDatabase() {
    if (!pool) return;
    console.log(`\n🗑️ [${new Date().toLocaleTimeString()}] PURGING DATABASE - 3 hour cycle...`);
    try {
        await pool.query('TRUNCATE TABLE jobs RESTART IDENTITY CASCADE;');
        await pool.query('TRUNCATE TABLE news RESTART IDENTITY CASCADE;');
        await pool.query('TRUNCATE TABLE youtube_videos RESTART IDENTITY CASCADE;');
        console.log("✅ Database purged successfully. Fresh collection starting...");
        // Immediately refresh after purge
        await refreshAllData();
    } catch (e) { console.error("❌ Purge error:", e.message); }
}

// ═══════════════════════════════════════════════════════════════
// GEO CACHE + AI GEOCODING
// ═══════════════════════════════════════════════════════════════
const LAND_FALLBACKS = [
    { name: "San Francisco", lat: 37.7749, lng: -122.4194 },
    { name: "New York", lat: 40.7128, lng: -74.0060 },
    { name: "Toronto", lat: 43.6510, lng: -79.3470 },
    { name: "Austin", lat: 30.2672, lng: -97.7431 },
    { name: "Seattle", lat: 47.6062, lng: -122.3321 },
    { name: "Mexico City", lat: 19.4326, lng: -99.1332 },
    { name: "São Paulo", lat: -23.5505, lng: -46.6333 },
    { name: "Buenos Aires", lat: -34.6037, lng: -58.3816 },
    { name: "Bogotá", lat: 4.7110, lng: -74.0721 },
    { name: "London", lat: 51.5074, lng: -0.1278 },
    { name: "Berlin", lat: 52.5200, lng: 13.4050 },
    { name: "Paris", lat: 48.8566, lng: 2.3522 },
    { name: "Amsterdam", lat: 52.3676, lng: 4.9041 },
    { name: "Stockholm", lat: 59.3293, lng: 18.0686 },
    { name: "Madrid", lat: 40.4168, lng: -3.7038 },
    { name: "Lagos", lat: 6.5244, lng: 3.3792 },
    { name: "Nairobi", lat: -1.2864, lng: 36.8172 },
    { name: "Cape Town", lat: -33.9249, lng: 18.4241 },
    { name: "Cairo", lat: 30.0444, lng: 31.2357 },
    { name: "Dubai", lat: 25.2048, lng: 55.2708 },
    { name: "Tel Aviv", lat: 32.0853, lng: 34.7818 },
    { name: "Bengaluru", lat: 12.9716, lng: 77.5946 },
    { name: "Mumbai", lat: 19.0760, lng: 72.8777 },
    { name: "Delhi", lat: 28.6139, lng: 77.2090 },
    { name: "Tokyo", lat: 35.6895, lng: 139.6917 },
    { name: "Singapore", lat: 1.3521, lng: 103.8198 },
    { name: "Seoul", lat: 37.5665, lng: 126.9780 },
    { name: "Shanghai", lat: 31.2304, lng: 121.4737 },
    { name: "Beijing", lat: 39.9042, lng: 116.4074 },
    { name: "Shenzhen", lat: 22.5431, lng: 114.0579 },
    { name: "Jakarta", lat: -6.2088, lng: 106.8456 },
    { name: "Sydney", lat: -33.8688, lng: 151.2093 },
    { name: "Melbourne", lat: -37.8136, lng: 144.9631 },
    { name: "Auckland", lat: -36.8485, lng: 174.7633 },
    { name: "Riyadh", lat: 24.7136, lng: 46.6753 },
    { name: "Zurich", lat: 47.3769, lng: 8.5417 },
    { name: "Dublin", lat: 53.3498, lng: -6.2603 },
    { name: "Warsaw", lat: 52.2297, lng: 21.0122 },
    { name: "Lisbon", lat: 38.7223, lng: -9.1393 },
    { name: "Helsinki", lat: 60.1699, lng: 24.9384 },
];

function getRandomHub() {
    return LAND_FALLBACKS[Math.floor(Math.random() * LAND_FALLBACKS.length)];
}

const geoCache = new Map();

async function batchGeocodeWithAI(locations) {
    const uniqueLocs = [...new Set(locations)].filter(l => l && !geoCache.has(l));
    if (uniqueLocs.length === 0) return;
    // Process in chunks of 30 to avoid token limits
    for (let i = 0; i < uniqueLocs.length; i += 30) {
        const chunk = uniqueLocs.slice(i, i + 30);
        const prompt = `Geocode these locations. If "Remote", pick a random major tech hub. Return ONLY JSON: keys=location strings, values={lat,lng}.\nLocations: ${JSON.stringify(chunk)}`;
        try {
            const result = await getAIInsight(prompt);
            if (result) {
                Object.entries(result).forEach(([loc, coords]) => {
                    if (coords && typeof coords.lat === 'number' && typeof coords.lng === 'number') {
                        geoCache.set(loc, coords);
                    }
                });
            }
        } catch (e) { /* silently skip */ }
    }
}

function getPreciseCoords(loc) {
    if (geoCache.has(loc)) return geoCache.get(loc);
    return getRandomHub();
}

// ═══════════════════════════════════════════════════════════════
// MULTI-MODEL AI FALLBACK MATRIX
// ═══════════════════════════════════════════════════════════════
async function getAIInsight(prompt) {
    const models = [
        { name: "Gemini 2.0 Flash", model: "gemini-2.0-flash", type: "gemini" },
        { name: "Gemini 1.5 Flash", model: "gemini-1.5-flash-latest", type: "gemini" },
        { name: "Gemini 1.5 Pro", model: "gemini-1.5-pro-latest", type: "gemini" },
    ];
    // Try Gemini models
    for (const m of models) {
        try {
            const model = genAI.getGenerativeModel({ model: m.model, generationConfig: { responseMimeType: "application/json" } });
            const result = await model.generateContent(prompt);
            return JSON.parse(result.response.text());
        } catch (e) {
            console.error(`AI Model ${m.name} failed:`, e.message);
        }
    }
    // OpenRouter fallbacks
    const orModels = [
        { name: "Qwen3", model: "qwen/qwen-2.5-72b-instruct", token: process.env.Qwen3_80b_token },
        { name: "GPT-4o-mini", model: "openai/gpt-4o-mini", token: process.env['gpt-oss-120b_token'] },
    ];
    for (const m of orModels) {
        try {
            const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
                model: m.model,
                messages: [{ role: "user", content: prompt + "\n\nReturn ONLY valid JSON." }],
                temperature: 0.5,
                max_tokens: 1500
            }, { headers: { "Authorization": `Bearer ${m.token}`, "Content-Type": "application/json" }, timeout: API_TIMEOUT });
            const raw = res.data.choices[0].message.content;
            return JSON.parse(raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
        } catch (e) {
            console.error(`OpenRouter Model ${m.name} failed:`, e.message);
        }
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════
// BATCH FETCH UTILITY
// ═══════════════════════════════════════════════════════════════
const parser = new Parser({ timeout: RSS_TIMEOUT, headers: { 'User-Agent': 'Mozilla/5.0 SmartNewsTracker/1.0' } });

async function fetchBatched(urls, fetcher, batchSize = BATCH_SIZE) {
    const results = [];
    for (let i = 0; i < urls.length; i += batchSize) {
        const batch = urls.slice(i, i + batchSize);
        const batchResults = await Promise.allSettled(batch.map(u => fetcher(u)));
        batchResults.forEach(r => { if (r.status === 'fulfilled' && r.value) results.push(...(Array.isArray(r.value) ? r.value : [r.value])); });
    }
    return results;
}

// ═══════════════════════════════════════════════════════════════
// JOB SCRAPING ENGINE (200+ sources)
// ═══════════════════════════════════════════════════════════════
const getScrapedJobs = async () => {
    console.log(`📡 Scraping jobs from ${JOB_APIS.length} APIs + ${JOB_RSS_FEEDS.length} RSS feeds...`);
    const jobs = [];

    // 1. Fetch from APIs
    const apiJobs = await fetchBatched(JOB_APIS, async (source) => {
        try {
            const res = await axios.get(source.url, { timeout: API_TIMEOUT });
            const items = [];
            if (source.type === 'remotive' && res.data?.jobs) {
                res.data.jobs.forEach(j => items.push({
                    title: j.title, company: j.company_name || 'Startup',
                    location: j.candidate_required_location || 'Remote',
                    url: j.url, isRemote: true, pay: j.salary || 'N/A',
                    time: "🔴 LIVE", source: source.name
                }));
            } else if (source.type === 'muse' && res.data?.results) {
                res.data.results.forEach(j => items.push({
                    title: j.name, company: j.company?.name || 'Company',
                    location: j.locations?.[0]?.name || 'Flexible',
                    url: j.refs?.landing_page || '#', isRemote: (j.locations?.[0]?.name || '').toLowerCase().includes('remote'),
                    pay: 'N/A', time: "⚡ POSTED", source: source.name
                }));
            } else if (source.type === 'hn-jobs' && res.data?.hits) {
                res.data.hits.slice(0, 15).forEach(h => items.push({
                    title: h.title, company: 'HackerNews',
                    location: 'Remote / Global', url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
                    isRemote: true, pay: 'N/A', time: "🟠 HN", source: source.name
                }));
            }
            return items;
        } catch (e) { return []; }
    });

    // 2. Fetch from RSS
    const rssJobs = await fetchBatched(JOB_RSS_FEEDS, async (feedUrl) => {
        try {
            const feed = await parser.parseURL(feedUrl);
            return (feed.items || []).slice(0, 15).map(item => ({
                title: item.title || 'Role', company: feed.title || 'Company',
                location: item.categories?.[0] || 'Remote',
                url: item.link || '#', isRemote: true,
                pay: 'N/A', time: "🟢 RSS LIVE", source: feed.title || feedUrl
            }));
        } catch (e) { return []; }
    });

    const allRawJobs = [...apiJobs, ...rssJobs];

    // Deduplicate by URL
    const seen = new Set();
    const uniqueJobs = allRawJobs.filter(j => {
        if (!j.url || seen.has(j.url)) return false;
        seen.add(j.url);
        return true;
    });

    // Geocode all locations
    const allLocs = uniqueJobs.map(j => j.location);
    await batchGeocodeWithAI(allLocs);

    // Map to globe points
    uniqueJobs.forEach((j, i) => {
        const hub = getPreciseCoords(j.location);
        jobs.push({
            id: `job-${i}-${Date.now()}`,
            type: "job", lat: hub.lat + (Math.random() - 0.5) * 0.08,
            lng: hub.lng + (Math.random() - 0.5) * 0.08,
            company: j.company, title: j.title, location: j.location,
            url: j.url, isRemote: j.isRemote, time: j.time,
            size: 0.4, color: "#00e676"
        });
    });

    // Save to Neon DB
    await saveJobsToNeonDB(uniqueJobs);
    console.log(`✅ Jobs scraped: ${jobs.length} unique from ${JOB_APIS.length + JOB_RSS_FEEDS.length} sources`);
    return jobs;
};

// ═══════════════════════════════════════════════════════════════
// NEWS SCRAPING ENGINE (1000+ sources)
// ═══════════════════════════════════════════════════════════════
const getScrapedNews = async () => {
    console.log(`📡 Scraping news from ${NEWS_RSS_FEEDS.length} RSS + ${HN_QUERIES.length} HN queries...`);
    const news = [];

    // 1. HackerNews multi-query
    const hnNews = await fetchBatched(HN_QUERIES, async (query) => {
        try {
            const res = await axios.get(`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=10`, { timeout: API_TIMEOUT });
            return (res.data?.hits || []).map(h => ({
                headline: h.title, source: "HackerNews",
                url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
                category: "ai", snippet: `${h.points || 0} pts • ${h.num_comments || 0} comments`,
                date: h.created_at, icon: "🧠"
            }));
        } catch (e) { return []; }
    });

    // 2. RSS feeds in batches
    const rssNews = await fetchBatched(NEWS_RSS_FEEDS, async (feedUrl) => {
        try {
            const feed = await parser.parseURL(feedUrl);
            const cat = feedUrl.includes('arxiv') ? 'research' : feedUrl.includes('ai') || feedUrl.includes('machine') ? 'ai' : 'tech';
            const icon = cat === 'research' ? '🔬' : cat === 'ai' ? '🧠' : '📱';
            return (feed.items || []).slice(0, 8).map(item => ({
                headline: (item.title || '').replace(/<[^>]*>/g, '').trim(),
                source: feed.title || 'RSS', url: item.link || '#',
                category: cat, snippet: (item.contentSnippet || '').substring(0, 150).replace(/<[^>]*>/g, ''),
                date: item.pubDate || new Date().toISOString(), icon
            }));
        } catch (e) { return []; }
    });

    const allRawNews = [...hnNews, ...rssNews];
    const seen = new Set();
    const uniqueNews = allRawNews.filter(n => {
        if (!n.url || seen.has(n.url)) return false;
        seen.add(n.url);
        return true;
    });

    // Geocode headlines in chunks
    const headlines = uniqueNews.slice(0, 200).map(n => n.headline);
    await batchGeocodeWithAI(headlines);

    uniqueNews.forEach((n, i) => {
        const hub = getPreciseCoords(n.headline) || getRandomHub();
        news.push({
            id: `news-${i}-${Date.now()}`, type: "news",
            lat: hub.lat + (Math.random() - 0.5) * 0.1,
            lng: hub.lng + (Math.random() - 0.5) * 0.1,
            headline: n.headline, source: n.source, url: n.url,
            time: "🔴 LIVE", radius: 4.5, color: "#ff3333"
        });
    });

    // Save to DB
    await saveNewsToNeonDB(uniqueNews);
    console.log(`✅ News scraped: ${news.length} unique from ${NEWS_RSS_FEEDS.length + HN_QUERIES.length} sources`);
    return news;
};

// ═══════════════════════════════════════════════════════════════
// TRENDS ENGINE
// ═══════════════════════════════════════════════════════════════
const getLatestTrends = async () => {
    const trends = [];
    const trendFeeds = [
        { url: "https://techcrunch.com/feed/", icon: "📱", cat: "tech" },
        { url: "https://www.theverge.com/rss/index.xml", icon: "⚡", cat: "tech" },
        { url: "http://export.arxiv.org/rss/cs.AI", icon: "🔬", cat: "research" },
        { url: "http://export.arxiv.org/rss/cs.LG", icon: "🔬", cat: "research" },
        { url: "https://feeds.arstechnica.com/arstechnica/technology-lab", icon: "🖥️", cat: "tech" },
        { url: "https://venturebeat.com/feed/", icon: "🚀", cat: "ai" },
        { url: "https://www.wired.com/feed/rss", icon: "🔮", cat: "tech" },
        { url: "https://www.technologyreview.com/feed/", icon: "🧪", cat: "research" },
        { url: "https://openai.com/blog/rss.xml", icon: "🤖", cat: "ai" },
        { url: "https://blogs.nvidia.com/feed/", icon: "💻", cat: "ai" },
        { url: "https://ai.meta.com/blog/rss/", icon: "🧠", cat: "ai" },
        { url: "https://blog.google/technology/ai/rss/", icon: "🌐", cat: "ai" },
        { url: "https://huggingface.co/blog/feed.xml", icon: "🤗", cat: "ai" },
        { url: "https://www.marktechpost.com/feed/", icon: "📊", cat: "ai" },
        { url: "https://spectrum.ieee.org/feeds/feed.rss", icon: "📡", cat: "research" },
    ];

    // HN trends
    try {
        const hnRes = await axios.get('https://hn.algolia.com/api/v1/search_by_date?query=AI+OR+LLM+OR+startup+OR+funding&tags=story&hitsPerPage=20', { timeout: API_TIMEOUT });
        (hnRes.data?.hits || []).forEach(h => {
            trends.push({
                id: `hn-trend-${h.objectID}`, title: h.title, source: "Hacker News",
                category: "ai", url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
                snippet: `${h.points || 0} points • ${h.num_comments || 0} comments`,
                date: h.created_at, icon: "🧠"
            });
        });
    } catch (e) { }

    // RSS trends
    const rssTrends = await fetchBatched(trendFeeds, async (f) => {
        try {
            const feed = await parser.parseURL(f.url);
            return (feed.items || []).slice(0, 10).map(item => ({
                id: `trend-${item.guid || item.link}`, title: (item.title || '').replace(/<[^>]*>/g, '').trim(),
                source: feed.title || 'Source', category: f.cat, url: item.link,
                snippet: (item.contentSnippet || '').substring(0, 150), date: item.pubDate || new Date().toISOString(),
                icon: f.icon
            }));
        } catch (e) { return []; }
    });

    trends.push(...rssTrends);
    return trends.sort(() => Math.random() - 0.5);
};

// ═══════════════════════════════════════════════════════════════
// YOUTUBE VIDEOS (Multi-Source Scraping)
// ═══════════════════════════════════════════════════════════════
const YOUTUBE_BASE_QUERIES = [
    // AI & ML
    "artificial intelligence news today",
    "machine learning tutorial 2026",
    "large language model LLM news",
    "generative AI latest developments",
    // Software Engineering
    "software engineering trends 2026",
    "coding tutorial react python",
    "system design interview",
    "devops kubernetes docker",
    // Startups & Business
    "tech startup funding news",
    "venture capital silicon valley",
    "Y Combinator startup demo",
    // Cybersecurity
    "cybersecurity news hacking",
    "ethical hacking tutorial",
    // Cloud & Infrastructure
    "cloud computing AWS Azure GCP",
    "serverless computing edge",
    // Robotics & Hardware
    "robotics AI automation",
    "quantum computing breakthrough",
    // Data & Analytics
    "data science analytics",
    "big data pipeline engineering",
    // Blockchain & Web3
    "blockchain cryptocurrency news",
    "web3 decentralized apps",
    // Research & Science
    "computer science research paper",
    "tech conference keynote",
];

const getYouTubeVideos = async () => {
    // Combine base queries with AI-generated trending queries
    let aiQueries = [];
    try {
        const aiRes = await getAIInsight(`Provide 5 YouTube search queries for TODAY's most trending AI/Tech/Startup topics in 2026. Return JSON: { "queries": ["q1","q2","q3","q4","q5"] }`);
        if (aiRes?.queries?.length) aiQueries = aiRes.queries;
    } catch (e) { }

    const allQueries = [...YOUTUBE_BASE_QUERIES, ...aiQueries];
    console.log(`🎥 Scraping YouTube with ${allQueries.length} queries...`);

    const videos = [];
    const uniqueIds = new Set();

    const fetchVideos = await fetchBatched(allQueries, async (query) => {
        try {
            const r = await ytSearch(query);
            return (r.videos || []).slice(0, 8).map(v => ({
                title: v.title, videoId: v.videoId,
                channel: v.author?.name || 'YouTube',
                views: v.views || 0,
                published: `🔴 LIVE • ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`,
                category: query.includes('AI') || query.includes('machine') ? 'ai' :
                    query.includes('startup') || query.includes('funding') ? 'startup' :
                        query.includes('cyber') || query.includes('hacking') ? 'security' :
                            query.includes('cloud') || query.includes('devops') ? 'cloud' :
                                query.includes('robot') || query.includes('quantum') ? 'hardware' :
                                    query.includes('blockchain') || query.includes('web3') ? 'web3' : 'tech'
            }));
        } catch (e) { return []; }
    }, 5); // batch 5 at a time to avoid rate limits

    fetchVideos.forEach(v => {
        if (v.videoId && !uniqueIds.has(v.videoId)) {
            uniqueIds.add(v.videoId);
            videos.push(v);
        }
    });

    await saveVideosToNeonDB(videos);
    console.log(`✅ YouTube: ${videos.length} unique videos from ${allQueries.length} queries`);
    return videos.sort(() => Math.random() - 0.5).slice(0, 60);
};

// ═══════════════════════════════════════════════════════════════
// DATABASE SAVE FUNCTIONS
// ═══════════════════════════════════════════════════════════════
const saveJobsToNeonDB = async (jobsArr) => {
    if (!pool || jobsArr.length === 0) return;
    // Insert in chunks of 50
    for (let i = 0; i < jobsArr.length; i += 50) {
        const chunk = jobsArr.slice(i, i + 50);
        const values = []; const placeholders = []; let c = 1;
        for (const j of chunk) {
            placeholders.push(`($${c++},$${c++},$${c++},$${c++},$${c++},$${c++},$${c++},'NEW')`);
            values.push(j.title, j.company, j.url, j.source || j.time, j.location || 'Remote', j.pay || 'N/A', new Date().toISOString());
        }
        try {
            await pool.query(`INSERT INTO jobs (title,company,url,source,location,pay,posted_date,status) VALUES ${placeholders.join(',')} ON CONFLICT (url) DO NOTHING;`, values);
        } catch (e) { console.error('💾 DB insert error:', e.message); }
    }
    console.log(`💾 Saved ${jobsArr.length} jobs to Neon DB`);
};

const saveNewsToNeonDB = async (newsArr) => {
    if (!pool || newsArr.length === 0) return;
    for (let i = 0; i < newsArr.length; i += 50) {
        const chunk = newsArr.slice(i, i + 50);
        const values = []; const placeholders = []; let c = 1;
        for (const n of chunk) {
            placeholders.push(`($${c++},$${c++},$${c++},$${c++},$${c++},$${c++})`);
            values.push(n.headline, n.source, n.url, n.category || 'tech', n.snippet || '', n.date || new Date().toISOString());
        }
        try {
            await pool.query(`INSERT INTO news (headline,source,url,category,snippet,published_date) VALUES ${placeholders.join(',')} ON CONFLICT (url) DO NOTHING;`, values);
        } catch (e) { /* skip */ }
    }
};

const saveVideosToNeonDB = async (vids) => {
    if (!pool || vids.length === 0) return;
    const values = []; const placeholders = []; let c = 1;
    for (const v of vids) {
        placeholders.push(`($${c++},$${c++},$${c++},$${c++})`);
        values.push(v.title, v.videoId, v.channel, v.published);
    }
    try {
        await pool.query(`INSERT INTO youtube_videos (title,video_id,channel,published) VALUES ${placeholders.join(',')} ON CONFLICT (video_id) DO NOTHING;`, values);
    } catch (e) { /* skip */ }
};

// ═══════════════════════════════════════════════════════════════
// CACHE + AUTO-REFRESH
// ═══════════════════════════════════════════════════════════════
let cache = { dashboardData: null, videos: null, trends: null, lastRefresh: 0, stats: {} };

async function refreshAllData() {
    console.log(`\n🔄 [${new Date().toLocaleTimeString()}] Refreshing ALL data from ${JOB_APIS.length + JOB_RSS_FEEDS.length} job + ${NEWS_RSS_FEEDS.length + HN_QUERIES.length} news sources...`);
    try {
        const [jobs, news] = await Promise.all([getScrapedJobs(), getScrapedNews()]);
        cache.dashboardData = [...jobs, ...news].sort(() => Math.random() - 0.5);
        cache.videos = await getYouTubeVideos();
        cache.trends = await getLatestTrends();
        cache.lastRefresh = Date.now();
        cache.stats = {
            totalJobs: jobs.length, totalNews: news.length,
            totalVideos: cache.videos.length, totalTrends: cache.trends.length,
            jobSources: JOB_APIS.length + JOB_RSS_FEEDS.length,
            newsSources: NEWS_RSS_FEEDS.length + HN_QUERIES.length,
        };
        console.log(`✅ CACHE REFRESHED: ${jobs.length} jobs, ${news.length} news, ${cache.videos.length} videos, ${cache.trends.length} trends`);
    } catch (e) { console.error("❌ Refresh error:", e.message); }
}

// ═══════════════════════════════════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════════════════════════════════
app.get('/api/dashboard-data', async (req, res) => {
    if (cache.dashboardData) return res.json({ data: cache.dashboardData, lastRefresh: cache.lastRefresh, stats: cache.stats });
    const [jobs, news] = await Promise.all([getScrapedJobs(), getScrapedNews()]);
    const merged = [...jobs, ...news].sort(() => Math.random() - 0.5);
    res.json({ data: merged, lastRefresh: Date.now(), stats: cache.stats });
});

app.get('/api/latest-trends', async (req, res) => {
    try {
        if (cache.trends) return res.json({ trends: cache.trends });
        const trends = await getLatestTrends();
        res.json({ trends });
    } catch (e) { res.json({ trends: [] }); }
});

app.get('/api/ai-insights', async (req, res) => {
    let videos = cache.videos || [];
    try {
        const newsSlice = (cache.dashboardData || []).filter(d => d.type === 'news').slice(0, 10);
        const jobsSlice = (cache.dashboardData || []).filter(d => d.type === 'job').slice(0, 5);

        if (newsSlice.length === 0 || jobsSlice.length === 0) {
            return res.json({ summary_news: "Initializing Live Intelligence.", summary_jobs: "Starting Global Scan.", videos });
        }

        const prompt = `You are a Silicon Valley Intelligence Analyst. Analyze:
NEWS: ${newsSlice.map(n => n.headline).join(' | ')}
JOBS: ${jobsSlice.map(j => `${j.company} hiring ${j.title}`).join(' | ')}
Provide: 1) "summary_news": 3-sentence tech trends summary. 2) "summary_jobs": 2-sentence hiring summary.
Return JSON: {"summary_news":"...","summary_jobs":"..."}`;

        const aiJson = await getAIInsight(prompt);
        if (aiJson) {
            aiJson.videos = videos;
            return res.json(aiJson);
        }
        res.json({ summary_news: "Live Data Active.", summary_jobs: `${jobsSlice.length} Roles Active.`, videos });
    } catch (e) {
        res.json({ summary_news: "AI Unavailable. Live Streams Active.", summary_jobs: "Global Hiring Active.", videos });
    }
});

app.get('/api/company-intel', async (req, res) => {
    const { company } = req.query;
    if (!company) return res.json({ branches: [] });
    const cacheKey = `company_${company.toLowerCase()}`;
    if (cache[cacheKey]) return res.json({ branches: cache[cacheKey] });
    try {
        const aiJson = await getAIInsight(`Provide top 5 global office locations for "${company}". Return JSON: {"branches":[{"city":"City, Country","lat":0,"lng":0}]}`);
        if (aiJson?.branches) { cache[cacheKey] = aiJson.branches; return res.json({ branches: aiJson.branches }); }
        res.json({ branches: [] });
    } catch (e) { res.json({ branches: [] }); }
});

// ═══════════════════════════════════════════════════════════════
// SMART JOB PORTAL API (Embedded Portal)
// ═══════════════════════════════════════════════════════════════
app.get('/api/portal-jobs', async (req, res) => {
    if (!pool) return res.json({ jobs: [], total: 0 });
    const { search, page = 1, limit = 20, location, source } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let whereClause = '';
    const params = [];
    const conditions = [];
    let paramCount = 1;

    if (search) {
        conditions.push(`(title ILIKE $${paramCount} OR company ILIKE $${paramCount})`);
        params.push(`%${search}%`);
        paramCount++;
    }
    if (location) {
        conditions.push(`location ILIKE $${paramCount}`);
        params.push(`%${location}%`);
        paramCount++;
    }
    if (source) {
        conditions.push(`source ILIKE $${paramCount}`);
        params.push(`%${source}%`);
        paramCount++;
    }

    if (conditions.length > 0) whereClause = 'WHERE ' + conditions.join(' AND ');

    try {
        const countRes = await pool.query(`SELECT COUNT(*) FROM jobs ${whereClause}`, params);
        const total = parseInt(countRes.rows[0].count);

        const jobsRes = await pool.query(
            `SELECT id, title, company, url, source, location, pay, posted_date, status 
             FROM jobs ${whereClause} 
             ORDER BY id DESC 
             LIMIT $${paramCount} OFFSET $${paramCount + 1}`,
            [...params, parseInt(limit), offset]
        );

        res.json({ jobs: jobsRes.rows, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
    } catch (e) {
        console.error("Portal jobs error:", e.message);
        res.json({ jobs: [], total: 0 });
    }
});

app.get('/api/stats', (req, res) => res.json(cache.stats));

// ═══════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════
const PORT = 8000;
app.listen(PORT, async () => {
    console.log(`\n🚀 Smart News & Job Tracker Backend on port ${PORT}`);
    console.log(`📊 Job Sources: ${JOB_APIS.length} APIs + ${JOB_RSS_FEEDS.length} RSS = ${JOB_APIS.length + JOB_RSS_FEEDS.length} total`);
    console.log(`📰 News Sources: ${NEWS_RSS_FEEDS.length} RSS + ${HN_QUERIES.length} HN queries = ${NEWS_RSS_FEEDS.length + HN_QUERIES.length} total`);
    await ensureDBTables();
    setTimeout(() => refreshAllData(), 3000);
    setInterval(() => refreshAllData(), REFRESH_INTERVAL);
    setInterval(() => purgeDatabase(), DB_PURGE_INTERVAL);
    console.log(`⏱️  Auto-refresh: every 10 min | DB purge: every 3 hours`);
});
