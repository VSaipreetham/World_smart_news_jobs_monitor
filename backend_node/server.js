const path = require('path');
const fs = require('fs');
require('dotenv').config();
require('dotenv').config({ path: path.resolve(__dirname, '../backend/.env'), override: false });
try {
    const sharedEnv = require('dotenv').parse(fs.readFileSync(path.resolve(__dirname, '../../smart_job_portal/.env')));
    const sharedAllowlist = [
        'OPENROUTER_API_KEY', 'Qwen3_80b_token', 'Qwen3_4b_token', 'gpt-oss-120b_token',
        'Gemma3b_token', 'Gemma4_26b_token', 'Gemma4_31b_token',
        'HUGGINGFACE_API_KEY', 'HF_TOKEN', 'YOUTUBE_API_KEY', 'YOUTUBE_CLIENT_ID',
        'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN', 'LINKEDIN_FEED_URLS',
    ];
    sharedAllowlist.forEach(key => {
        if (!process.env[key] && sharedEnv[key]) process.env[key] = sharedEnv[key];
    });
} catch (_) { }
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Pool } = require('pg');
const axios = require('axios');
const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const ytSearch = require('yt-search');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { JOB_APIS, JOB_RSS_FEEDS, JOB_BOARD_SOURCES, NEWS_RSS_FEEDS, HN_QUERIES } = require('./sources');
const { getDailyNewsSources, getLinkedInImports, getDailyNewsBridgeStatus } = require('./dailyNewsBridge');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════
const genAI = process.env.Google_token ? new GoogleGenerativeAI(process.env.Google_token) : null;
const REFRESH_INTERVAL = Number(process.env.REFRESH_INTERVAL_MS || 10 * 60 * 1000);
const DB_PURGE_INTERVAL = Number(process.env.DB_MAINTENANCE_INTERVAL_MS || 30 * 60 * 1000);
const DB_RETENTION_HOURS = Number(process.env.DB_RETENTION_HOURS || 24);
const RSS_TIMEOUT = 8000;  // 8s per feed
const API_TIMEOUT = 10000; // 10s per API
const BATCH_SIZE = 25;     // parallel fetch batch size
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
const OPENAI_FALLBACK_MODELS = (process.env.OPENAI_FALLBACK_MODELS || 'gpt-5.4,gpt-5.2,gpt-4.1-mini')
    .split(',')
    .map(m => m.trim())
    .filter(Boolean);
const DEFAULT_OPENROUTER_MODELS = [
    'openrouter/free',
    'google/gemma-4-26b-a4b-it:free',
    'google/gemma-4-31b-it:free',
    'qwen/qwen3-next-80b-a3b-instruct:free',
    'openai/gpt-oss-120b:free',
    'openai/gpt-oss-20b:free',
    'qwen/qwen3-coder:free',
    'nvidia/nemotron-3-super-120b-a12b:free',
    'nvidia/nemotron-3-nano-30b-a3b:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'cohere/north-mini-code:free',
];
const OPENROUTER_MODELS = (process.env.OPENROUTER_MODELS || DEFAULT_OPENROUTER_MODELS.join(','))
    .split(',')
    .map(m => m.trim())
    .filter(Boolean);
const AI_CIRCUIT_BREAKER_MS = Number(process.env.AI_CIRCUIT_BREAKER_MS || 5 * 60 * 1000);
const YOUTUBE_QUERY_LIMIT = Number(process.env.YOUTUBE_QUERY_LIMIT || 36);
const VIDEO_REFRESH_INTERVAL_MS = Number(process.env.VIDEO_REFRESH_INTERVAL_MS || 10 * 60 * 1000);
const VIDEO_MAX_AGE_DAYS = Number(process.env.VIDEO_MAX_AGE_DAYS || 7);
const JOB_MAX_AGE_DAYS = Number(process.env.JOB_MAX_AGE_DAYS || 30);
const NEWS_MAX_AGE_DAYS = Number(process.env.NEWS_MAX_AGE_DAYS || 14);
const VIDEO_DB_RETENTION_HOURS = Number(process.env.VIDEO_DB_RETENTION_HOURS || 72);
const OLLAMA_BASE_URL = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const OLLAMA_MODELS = String(process.env.OLLAMA_MODELS || 'qwen3:4b,gemma3:4b,llama3.2:3b,mistral:7b')
    .split(',').map(model => model.trim()).filter(Boolean);
const HUGGINGFACE_MODELS = String(process.env.HUGGINGFACE_MODELS || 'Qwen/Qwen2.5-7B-Instruct,google/gemma-2-9b-it,mistralai/Mistral-7B-Instruct-v0.3')
    .split(',').map(model => model.trim()).filter(Boolean);
const AI_MODES = ['auto', 'free', 'ollama', 'huggingface', 'openai', 'gemini', 'openrouter', 'offline'];
let aiMode = AI_MODES.includes(String(process.env.AI_MODE || '').toLowerCase())
    ? String(process.env.AI_MODE).toLowerCase()
    : 'auto';

function getTotalJobSources() {
    return JOB_APIS.length + JOB_RSS_FEEDS.length + JOB_BOARD_SOURCES.length;
}

function getAIModePayload() {
    const openRouterTokens = getOpenRouterTokens();
    const huggingFaceToken = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN;
    return {
        active: aiMode,
        modes: [
            { id: 'auto', label: 'Auto fallback', available: Boolean(process.env.OPENAI_API_KEY || genAI || openRouterTokens.length || huggingFaceToken || OLLAMA_BASE_URL) },
            { id: 'free', label: 'Free models only', available: Boolean(openRouterTokens.length || huggingFaceToken || OLLAMA_BASE_URL), configuredModels: [...OLLAMA_MODELS, ...HUGGINGFACE_MODELS, ...OPENROUTER_MODELS] },
            { id: 'ollama', label: 'Ollama local', available: true, endpoint: OLLAMA_BASE_URL, configuredModels: OLLAMA_MODELS },
            { id: 'huggingface', label: 'Hugging Face', available: Boolean(huggingFaceToken), configuredModels: HUGGINGFACE_MODELS },
            { id: 'openai', label: 'OpenAI', available: Boolean(process.env.OPENAI_API_KEY), primaryModel: OPENAI_MODEL },
            { id: 'gemini', label: 'Gemini', available: Boolean(genAI) },
            { id: 'openrouter', label: 'OpenRouter', available: openRouterTokens.length > 0, primaryModel: OPENROUTER_MODELS[0], configuredModels: OPENROUTER_MODELS },
            { id: 'offline', label: 'Offline deterministic', available: true },
        ],
        runtime: {
            provider: aiRuntime.lastProvider,
            model: aiRuntime.lastModel,
            lastError: aiRuntime.lastError,
            available: aiRuntime.disabledUntil <= Date.now(),
            disabledUntilISO: aiRuntime.disabledUntil ? new Date(aiRuntime.disabledUntil).toISOString() : null,
        },
    };
}

function getOpenRouterTokens() {
    const extraNames = String(process.env.OPENROUTER_EXTRA_TOKEN_NAMES || '')
        .split(',')
        .map(name => name.trim())
        .filter(Boolean);
    const names = [
        'OPENROUTER_API_KEY',
        'Qwen3_80b_token',
        'gpt-oss-120b_token',
        'Qwen3_4b_token',
        'trinity-large-preview_token',
        'Gemma3b_token',
        'Gemma4_26b_token',
        'Gemma4_31b_token',
        ...extraNames,
    ];
    return names
        .map(name => process.env[name])
        .filter(Boolean)
        .filter((token, index, arr) => arr.indexOf(token) === index);
}

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
                notes TEXT,
                match_score INTEGER DEFAULT 0,
                applied_at TIMESTAMP,
                follow_up_at TIMESTAMP,
                archived_at TIMESTAMP,
                source_published_at TIMESTAMP,
                first_seen_at TIMESTAMP DEFAULT NOW(),
                last_seen_at TIMESTAMP DEFAULT NOW(),
                refreshed_at TIMESTAMP DEFAULT NOW(),
                refresh_run_id TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS news (
                id SERIAL PRIMARY KEY,
                headline TEXT, source TEXT, url TEXT UNIQUE,
                category TEXT, snippet TEXT,
                published_date TEXT,
                source_published_at TIMESTAMP,
                first_seen_at TIMESTAMP DEFAULT NOW(),
                last_seen_at TIMESTAMP DEFAULT NOW(),
                refreshed_at TIMESTAMP DEFAULT NOW(),
                refresh_run_id TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS youtube_videos (
                id SERIAL PRIMARY KEY,
                title TEXT, video_id TEXT UNIQUE,
                channel TEXT, published TEXT,
                views BIGINT DEFAULT 0,
                published_ago TEXT,
                published_at TIMESTAMP,
                refreshed_at TIMESTAMP DEFAULT NOW(),
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
        await pool.query(`
            ALTER TABLE jobs ADD COLUMN IF NOT EXISTS notes TEXT;
            ALTER TABLE jobs ADD COLUMN IF NOT EXISTS match_score INTEGER DEFAULT 0;
            ALTER TABLE jobs ADD COLUMN IF NOT EXISTS applied_at TIMESTAMP;
            ALTER TABLE jobs ADD COLUMN IF NOT EXISTS follow_up_at TIMESTAMP;
            ALTER TABLE jobs ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;
            ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_published_at TIMESTAMP;
            ALTER TABLE jobs ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMP DEFAULT NOW();
            ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP DEFAULT NOW();
            ALTER TABLE jobs ADD COLUMN IF NOT EXISTS refreshed_at TIMESTAMP DEFAULT NOW();
            ALTER TABLE jobs ADD COLUMN IF NOT EXISTS refresh_run_id TEXT;
            ALTER TABLE news ADD COLUMN IF NOT EXISTS refreshed_at TIMESTAMP DEFAULT NOW();
            ALTER TABLE news ADD COLUMN IF NOT EXISTS refresh_run_id TEXT;
            ALTER TABLE news ADD COLUMN IF NOT EXISTS source_published_at TIMESTAMP;
            ALTER TABLE news ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMP DEFAULT NOW();
            ALTER TABLE news ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP DEFAULT NOW();
            ALTER TABLE youtube_videos ADD COLUMN IF NOT EXISTS views BIGINT DEFAULT 0;
            ALTER TABLE youtube_videos ADD COLUMN IF NOT EXISTS published_ago TEXT;
            ALTER TABLE youtube_videos ADD COLUMN IF NOT EXISTS published_at TIMESTAMP;
            ALTER TABLE youtube_videos ADD COLUMN IF NOT EXISTS refreshed_at TIMESTAMP DEFAULT NOW();
        `);
        await pool.query(`
            UPDATE jobs
            SET status = 'open'
            WHERE status IS NULL OR LOWER(status) IN ('new', 'queued') OR status = 'NEW';
        `);
        console.log("✅ DB tables ensured");
    } catch (e) { console.error("DB table creation error:", e.message); }
}

// ═══════ 3-HOUR DATABASE PURGE ═══════
async function pruneDatabase() {
    if (!pool) return;
    console.log(`\n🗑️ [${new Date().toLocaleTimeString()}] PURGING DATABASE - 3 hour cycle...`);
    try {
        const interval = `${DB_RETENTION_HOURS} hours`;
        const videoInterval = `${VIDEO_DB_RETENTION_HOURS} hours`;
        await pool.query("DELETE FROM jobs WHERE COALESCE(last_seen_at, refreshed_at, created_at) < NOW() - $1::interval;", [interval]);
        await pool.query("DELETE FROM news WHERE COALESCE(last_seen_at, refreshed_at, created_at) < NOW() - $1::interval;", [interval]);
        await pool.query("DELETE FROM youtube_videos WHERE COALESCE(refreshed_at, created_at) < NOW() - $1::interval;", [videoInterval]);
        console.log("✅ Database purged successfully. Fresh collection starting...");
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

function hashString(value = '') {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
        hash = ((hash << 5) - hash) + value.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}

function getTimestamp(value) {
    const time = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(time) ? time : 0;
}

function isRecentDate(value, maxAgeDays = NEWS_MAX_AGE_DAYS) {
    const time = getTimestamp(value);
    if (!time) return false;
    const ageMs = Date.now() - time;
    return ageMs >= 0 && ageMs <= maxAgeDays * 24 * 60 * 60 * 1000;
}

function sortByDateDesc(items = [], dateKey = 'date') {
    return [...items].sort((a, b) => getTimestamp(b[dateKey]) - getTimestamp(a[dateKey]));
}

function toIsoOrNull(value) {
    const timestamp = getTimestamp(value);
    return timestamp ? new Date(timestamp).toISOString() : null;
}

function freshnessLabel(publishedAt, firstSeenAt, lastSeenAt) {
    const published = getTimestamp(publishedAt);
    const firstSeen = getTimestamp(firstSeenAt);
    const lastSeen = getTimestamp(lastSeenAt);
    const ageHours = published ? Math.max(0, (Date.now() - published) / 3_600_000) : null;
    return {
        state: ageHours != null && ageHours <= 24 ? 'breaking' : (firstSeen && Date.now() - firstSeen <= 3_600_000 ? 'new' : 'verified'),
        ageHours: ageHours == null ? null : Math.round(ageHours * 10) / 10,
        publishedAt: published ? new Date(published).toISOString() : null,
        firstSeenAt: firstSeen ? new Date(firstSeen).toISOString() : null,
        verifiedAt: lastSeen ? new Date(lastSeen).toISOString() : null,
    };
}

function inferCoordsFromText(value = '') {
    const text = value.toLowerCase();
    const directMatches = [
        ['san francisco', 'San Francisco'], ['sf', 'San Francisco'], ['new york', 'New York'],
        ['toronto', 'Toronto'], ['austin', 'Austin'], ['seattle', 'Seattle'],
        ['mexico', 'Mexico City'], ['sao paulo', 'Sao Paulo'], ['são paulo', 'Sao Paulo'],
        ['buenos aires', 'Buenos Aires'], ['bogota', 'Bogota'], ['bogotá', 'Bogota'],
        ['london', 'London'], ['berlin', 'Berlin'], ['paris', 'Paris'],
        ['amsterdam', 'Amsterdam'], ['stockholm', 'Stockholm'], ['madrid', 'Madrid'],
        ['lagos', 'Lagos'], ['nairobi', 'Nairobi'], ['cape town', 'Cape Town'],
        ['cairo', 'Cairo'], ['dubai', 'Dubai'], ['tel aviv', 'Tel Aviv'],
        ['bengaluru', 'Bengaluru'], ['bangalore', 'Bengaluru'], ['mumbai', 'Mumbai'],
        ['delhi', 'Delhi'], ['tokyo', 'Tokyo'], ['singapore', 'Singapore'],
        ['seoul', 'Seoul'], ['shanghai', 'Shanghai'], ['beijing', 'Beijing'],
        ['shenzhen', 'Shenzhen'], ['jakarta', 'Jakarta'], ['sydney', 'Sydney'],
        ['melbourne', 'Melbourne'], ['auckland', 'Auckland'], ['riyadh', 'Riyadh'],
        ['zurich', 'Zurich'], ['dublin', 'Dublin'], ['warsaw', 'Warsaw'],
        ['lisbon', 'Lisbon'], ['helsinki', 'Helsinki'],
    ];
    const match = directMatches.find(([needle]) => text.includes(needle));
    if (match) return LAND_FALLBACKS.find(hub => hub.name === match[1]) || getRandomHub();
    return LAND_FALLBACKS[hashString(value) % LAND_FALLBACKS.length];
}

async function batchGeocodeWithAI(locations) {
    const uniqueLocs = [...new Set(locations)].filter(l => l && !geoCache.has(l));
    if (uniqueLocs.length === 0) return;
    uniqueLocs.forEach(loc => geoCache.set(loc, inferCoordsFromText(loc)));
}

function getPreciseCoords(loc) {
    if (geoCache.has(loc)) return geoCache.get(loc);
    return inferCoordsFromText(loc || 'global');
}

function toJobPoint(j, index = 0) {
    const hub = getPreciseCoords(j.location || j.location_name || j.company || j.title || 'Remote');
    const freshness = freshnessLabel(j.source_published_at || j.posted_date, j.first_seen_at || j.created_at, j.last_seen_at || j.refreshed_at);
    return {
        id: j.id ? `job-db-${j.id}` : `job-${index}-${hashString(j.url || j.title || String(index))}`,
        type: 'job',
        lat: hub.lat + (Math.random() - 0.5) * 0.08,
        lng: hub.lng + (Math.random() - 0.5) * 0.08,
        company: j.company || j.company_or_source || 'Company',
        title: j.title || 'Open role',
        location: j.location || j.location_name || 'Remote',
        url: j.url || '#',
        isRemote: /remote|anywhere|global|worldwide/i.test(j.location || ''),
        time: j.time || freshness.publishedAt || 'Recently verified',
        publishedAt: freshness.publishedAt,
        firstSeenAt: freshness.firstSeenAt,
        verifiedAt: freshness.verifiedAt,
        freshness: freshness.state,
        ageHours: freshness.ageHours,
        collectedAt: getTimestamp(freshness.publishedAt || freshness.firstSeenAt),
        refreshRunId: j.refresh_run_id || null,
        size: 0.4,
        color: '#15b86a',
    };
}

function toNewsPoint(n, index = 0) {
    const hub = getPreciseCoords(n.headline || n.title || n.source || 'Global');
    const freshness = freshnessLabel(n.source_published_at || n.published_date, n.first_seen_at || n.created_at, n.last_seen_at || n.refreshed_at);
    return {
        id: n.id ? `news-db-${n.id}` : `news-${index}-${hashString(n.url || n.headline || String(index))}`,
        type: 'news',
        lat: hub.lat + (Math.random() - 0.5) * 0.1,
        lng: hub.lng + (Math.random() - 0.5) * 0.1,
        headline: n.headline || n.title || 'News signal',
        source: n.source || n.company_or_source || 'Source',
        location: n.location || 'Global',
        url: n.url || '#',
        time: n.time || freshness.publishedAt || 'Recently verified',
        publishedAt: freshness.publishedAt,
        firstSeenAt: freshness.firstSeenAt,
        verifiedAt: freshness.verifiedAt,
        freshness: freshness.state,
        ageHours: freshness.ageHours,
        collectedAt: getTimestamp(freshness.publishedAt || freshness.firstSeenAt),
        refreshRunId: n.refresh_run_id || null,
        radius: 4.5,
        color: '#ef4444',
    };
}

// ═══════════════════════════════════════════════════════════════
// MULTI-MODEL AI FALLBACK MATRIX
// ═══════════════════════════════════════════════════════════════
let aiRuntime = {
    lastProvider: null,
    lastModel: null,
    lastError: null,
    disabledUntil: 0,
    attempts: [],
};

function parseJsonFromModel(raw) {
    if (!raw) return null;
    if (typeof raw !== 'string') return raw;
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    try {
        return JSON.parse(cleaned);
    } catch (_) {
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try {
                return JSON.parse(cleaned.slice(start, end + 1));
            } catch (_) { }
        }
        if (cleaned.length > 0) return { answer: cleaned, result: cleaned, text: cleaned };
        throw new Error('Model response was not valid JSON');
    }
}

function coerceModelObject(ai) {
    if (!ai || typeof ai !== 'object') return ai;
    for (const key of ['answer', 'result', 'text']) {
        const value = ai[key];
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
            return { ...ai, ...JSON.parse(trimmed) };
        } catch (_) {
            const match = trimmed.match(/"(answer|result)"\s*:\s*"([\s\S]*?)"\s*(,\s*"[^"]+"\s*:|}\s*$)/);
            if (match?.[2]) {
                return { ...ai, [match[1]]: match[2].replace(/\\n/g, '\n').replace(/\\"/g, '"') };
            }
        }
    }
    return ai;
}

function cleanModelText(value) {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    if (!trimmed.startsWith('{')) return trimmed;
    try {
        const parsed = JSON.parse(trimmed);
        return parsed.answer || parsed.result || parsed.text || trimmed;
    } catch (_) {
        const match = trimmed.match(/"(answer|result)"\s*:\s*"([\s\S]*?)"\s*(,\s*"[^"]+"\s*:|}\s*$)/);
        if (match?.[2]) return match[2].replace(/\\n/g, '\n').replace(/\\"/g, '"');
    }
    return trimmed;
}

function summarizeModelError(err) {
    const status = err.response?.status;
    if (status) return `HTTP ${status}`;
    if (err.code) return err.code;
    if (err.message?.includes('quota') || err.message?.includes('429')) return 'rate_limited';
    if (err.message?.includes('404')) return 'not_available';
    return 'request_failed';
}

async function callOpenAIResponses(prompt, modelName) {
    const res = await axios.post('https://api.openai.com/v1/responses', {
        model: modelName,
        input: [
            { role: 'system', content: 'Return only valid JSON. No markdown, no prose outside JSON.' },
            { role: 'user', content: prompt }
        ],
        text: { format: { type: 'json_object' } },
    }, {
        headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
        },
        timeout: API_TIMEOUT,
    });
    return parseJsonFromModel(res.data.output_text || res.data.output?.[0]?.content?.[0]?.text);
}

async function callOpenAIChat(prompt, modelName) {
    const res = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: modelName,
        messages: [
            { role: 'system', content: 'Return only valid JSON. No markdown, no prose outside JSON.' },
            { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
    }, {
        headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
        },
        timeout: API_TIMEOUT,
    });
    return parseJsonFromModel(res.data.choices?.[0]?.message?.content);
}

async function callOllama(prompt, modelName) {
    const res = await axios.post(`${OLLAMA_BASE_URL}/api/chat`, {
        model: modelName,
        stream: false,
        format: 'json',
        messages: [
            { role: 'system', content: 'Return only valid JSON. Do not wrap it in markdown.' },
            { role: 'user', content: prompt },
        ],
        options: { temperature: 0.25 },
    }, { timeout: Number(process.env.OLLAMA_TIMEOUT_MS || 45000) });
    return parseJsonFromModel(res.data?.message?.content || res.data?.response);
}

async function callHuggingFace(prompt, modelName) {
    const token = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN;
    if (!token) throw new Error('HUGGINGFACE_API_KEY is not configured');
    const res = await axios.post('https://router.huggingface.co/v1/chat/completions', {
        model: modelName,
        messages: [
            { role: 'system', content: 'Return only valid JSON. Do not wrap it in markdown.' },
            { role: 'user', content: prompt },
        ],
        temperature: 0.25,
        max_tokens: 1600,
    }, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: Number(process.env.HUGGINGFACE_TIMEOUT_MS || 25000),
    });
    return parseJsonFromModel(res.data?.choices?.[0]?.message?.content);
}

async function inspectOllama() {
    try {
        const res = await axios.get(`${OLLAMA_BASE_URL}/api/tags`, { timeout: 1800 });
        return {
            reachable: true,
            endpoint: OLLAMA_BASE_URL,
            installed: (res.data?.models || []).map(item => item.name).filter(Boolean),
        };
    } catch (error) {
        return { reachable: false, endpoint: OLLAMA_BASE_URL, installed: [], error: summarizeModelError(error) };
    }
}

async function getAIInsight(prompt) {
    if (aiMode === 'offline') {
        aiRuntime.lastError = 'offline_mode';
        return null;
    }
    const allowOpenAI = aiMode === 'auto' || aiMode === 'openai';
    const allowGemini = aiMode === 'auto' || aiMode === 'gemini';
    const allowOpenRouter = aiMode === 'auto' || aiMode === 'free' || aiMode === 'openrouter';
    const allowOllama = aiMode === 'ollama' || aiMode === 'free' || (aiMode === 'auto' && String(process.env.OLLAMA_ENABLED || '').toLowerCase() === 'true');
    const allowHuggingFace = aiMode === 'huggingface' || aiMode === 'free' || (aiMode === 'auto' && Boolean(process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN));
    const attempts = [];
    const recordFailure = (provider, model, err) => {
        const error = summarizeModelError(err);
        attempts.push({ provider, model, ok: false, error });
        aiRuntime.lastError = `${provider}/${model}: ${error}`;
        if (aiMode !== 'auto' && ['HTTP 402', 'HTTP 429', 'rate_limited'].includes(error)) {
            aiRuntime.disabledUntil = Math.max(aiRuntime.disabledUntil, Date.now() + AI_CIRCUIT_BREAKER_MS);
        }
    };
    const recordSuccess = (provider, model, data) => {
        attempts.push({ provider, model, ok: true });
        aiRuntime = { lastProvider: provider, lastModel: model, lastError: null, disabledUntil: 0, attempts, mode: aiMode };
        return data;
    };

    if (allowOllama) {
        for (const modelName of OLLAMA_MODELS) {
            try {
                return recordSuccess('Ollama', modelName, await callOllama(prompt, modelName));
            } catch (error) {
                recordFailure('Ollama', modelName, error);
                if (['ECONNREFUSED', 'ETIMEDOUT'].includes(error.code)) break;
            }
        }
    }

    if (allowHuggingFace) {
        for (const modelName of HUGGINGFACE_MODELS) {
            try {
                return recordSuccess('Hugging Face', modelName, await callHuggingFace(prompt, modelName));
            } catch (error) {
                recordFailure('Hugging Face', modelName, error);
            }
        }
    }

    if (allowOpenAI && process.env.OPENAI_API_KEY) {
        for (const modelName of [OPENAI_MODEL, ...OPENAI_FALLBACK_MODELS]) {
            try {
                return recordSuccess('OpenAI Responses', modelName, await callOpenAIResponses(prompt, modelName));
            } catch (e) {
                recordFailure('OpenAI Responses', modelName, e);
                try {
                    return recordSuccess('OpenAI Chat', modelName, await callOpenAIChat(prompt, modelName));
                } catch (chatError) {
                    recordFailure('OpenAI Chat', modelName, chatError);
                }
            }
        }
    }

    const geminiModels = [
        { name: "Gemini 2.0 Flash", model: "gemini-2.0-flash" },
        { name: "Gemini 1.5 Flash", model: "gemini-1.5-flash" },
        { name: "Gemini 1.5 Pro", model: "gemini-1.5-pro" },
    ];
    if (allowGemini && genAI) {
        for (const m of geminiModels) {
            try {
                const model = genAI.getGenerativeModel({ model: m.model, generationConfig: { responseMimeType: "application/json" } });
                const result = await model.generateContent(prompt);
                return recordSuccess('Gemini', m.model, parseJsonFromModel(result.response.text()));
            } catch (e) {
                recordFailure('Gemini', m.model, e);
            }
        }
    }

    const openRouterTokens = getOpenRouterTokens();
    const orModels = [];
    for (const token of openRouterTokens) {
        for (const model of OPENROUTER_MODELS) {
            orModels.push({ name: model, model, token });
        }
    }

    if (allowOpenRouter) {
        for (const m of orModels) {
            try {
            const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
                model: m.model,
                messages: [{ role: "user", content: prompt + "\n\nReturn ONLY valid JSON." }],
                temperature: 0.5,
                max_tokens: 1500
            }, {
                headers: {
                    "Authorization": `Bearer ${m.token}`,
                    "Content-Type": "application/json",
                    "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "http://localhost:5173",
                    "X-Title": "World Smart News Jobs Monitor",
                },
                timeout: API_TIMEOUT
            });
                return recordSuccess('OpenRouter', m.model, parseJsonFromModel(res.data.choices[0].message.content));
            } catch (e) {
                recordFailure('OpenRouter', m.model, e);
            }
        }
    }

    aiRuntime.attempts = attempts;
    return null;
}

// ═══════════════════════════════════════════════════════════════
// BATCH FETCH UTILITY
// ═══════════════════════════════════════════════════════════════
const parser = new Parser({ timeout: RSS_TIMEOUT, headers: { 'User-Agent': 'Mozilla/5.0 SmartNewsTracker/1.0' } });
const sourceHealth = new Map();

function recordSourceHealth(kind, source, ok, itemCount = 0, detail = null) {
    const key = `${kind}:${source}`;
    const previous = sourceHealth.get(key) || { consecutiveFailures: 0 };
    sourceHealth.set(key, {
        kind,
        source,
        ok,
        itemCount,
        detail,
        checkedAt: new Date().toISOString(),
        consecutiveFailures: ok ? 0 : previous.consecutiveFailures + 1,
    });
}

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
function cleanText(value = '') {
    return String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function absoluteUrl(href, baseUrl) {
    try {
        return new URL(href, baseUrl).toString();
    } catch (_) {
        return href || baseUrl;
    }
}

function canonicalSourceUrl(value) {
    try {
        const url = new URL(value);
        url.hash = '';
        [...url.searchParams.keys()].forEach(key => {
            if (/^(utm_.+|ref|source|campaign|trk)$/i.test(key)) url.searchParams.delete(key);
        });
        return url.toString().replace(/\/$/, '');
    } catch (_) {
        return value;
    }
}

const NON_JOB_ANCHOR_PATTERN = /(manual|handbook|flowchart|registration|login|sign in|join now|post new job|post international jobs|employer|recruiter|view jobs|jobs archives|job fairs|jobs by|job alerts|jobs app|report an issue|resume database|find companies|find more jobs|career advice|model career centers|career schemes|career information|links to govt|find domestic|find international|training by|advisories|international resources|ncs meta data|international job opportunities|privacy|terms|about us|contact us|faq|help|sitemap)/i;
const GENERIC_NON_ROLE_PATTERN = /^(software development|software testing|content writing|consulting|business consulting|business analysis|debugging|agile development|project management|prototyping|mobile app development|web development|data management|international jobs|marketing|digital marketing|data entry|translation|research|training|design|graphic design|accounting|call center|electrical engineering|event management|artificial intelligence)$/i;
const ROLE_TITLE_PATTERN = /(engineer|developer|architect|analyst|scientist|specialist|consultant|manager|designer|writer|administrator|officer|executive|associate|assistant|trainee|intern|operator|technician|accountant|recruiter|sales|support|nurse|teacher|lead|director|head|python|react|node|java|golang|devops|full[ -]?stack|front[ -]?end|back[ -]?end|software|cloud|security|machine learning|data)/i;

function isLikelyPersistableJob(job = {}) {
    const title = cleanText(job.title || '');
    const source = cleanText(job.source || '');
    if (!title || title.length < 4) return false;
    if (NON_JOB_ANCHOR_PATTERN.test(title)) return false;
    if (GENERIC_NON_ROLE_PATTERN.test(title)) return false;
    if (/source connected -/i.test(title)) return true;
    if (/freelancer/i.test(source) && !/(engineer|developer|architect|analyst|specialist|consultant|manager|designer|writer|python|react|node|java|software|web|mobile|app|ai|data|cloud|security|devops|wordpress|shopify)/i.test(title)) {
        return false;
    }
    if (/ncs/i.test(source) && !/(engineer|developer|analyst|manager|specialist|consultant|associate|officer|executive|assistant|trainee|intern|operator|designer|architect|scientist|teacher|nurse|technician|accountant|sales|support|data|software|cloud|security|ai|machine learning|full stack|frontend|backend)/i.test(title)) {
        return false;
    }
    return true;
}

function extractJsonLdJobs(html, source) {
    const jobs = [];
    const scripts = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const script of scripts) {
        const jsonText = script.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '').trim();
        try {
            const parsed = JSON.parse(jsonText);
            const nodes = Array.isArray(parsed) ? parsed : [parsed, ...(parsed['@graph'] || [])];
            nodes.flat().forEach((node) => {
                if (!node || node['@type'] !== 'JobPosting') return;
                const company = cleanText(node.hiringOrganization?.name || node.organization?.name || source.name);
                const locationNode = Array.isArray(node.jobLocation) ? node.jobLocation[0] : node.jobLocation;
                const location = cleanText(locationNode?.address?.addressLocality || locationNode?.address?.addressRegion || locationNode?.address?.addressCountry || source.region || 'Remote');
                jobs.push({
                    title: cleanText(node.title || 'Job opening'),
                    company,
                    location,
                    url: node.url || source.url,
                    isRemote: /remote/i.test(`${node.jobLocationType || ''} ${location}`),
                    pay: cleanText(node.baseSalary?.value?.value || node.baseSalary?.value || 'N/A'),
                    sourcePublishedAt: toIsoOrNull(node.datePosted),
                    time: 'Board',
                    source: source.name,
                });
            });
        } catch (_) { }
    }
    return jobs;
}

function extractAnchorJobs(html, source) {
    const jobs = [];
    const seen = new Set();
    const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorRegex.exec(html)) && jobs.length < 20) {
        const href = match[1];
        const text = cleanText(match[2]);
        const detailUrl = /(\/jobs?\/view\/\d+|\/job\/[^?#]+|job[_-]?id=|jk=|viewjob|job-listing|job-details?|jobdetail|\/opportunit(?:y|ies)\/[^?#]+|\/project\/\d+)/i.test(href);
        const looksLikeJob = detailUrl && ROLE_TITLE_PATTERN.test(text) && !NON_JOB_ANCHOR_PATTERN.test(text);
        if (!looksLikeJob || text.length < 8 || text.length > 140 || !isLikelyPersistableJob({ title: text, source: source.name })) continue;
        const url = absoluteUrl(href, source.url);
        if (seen.has(url)) continue;
        seen.add(url);
        jobs.push({
            title: text,
            company: source.name,
            location: source.region || 'See posting',
            url,
            isRemote: /remote/i.test(text),
            pay: 'N/A',
            time: 'Board',
            source: source.name,
        });
    }
    return jobs;
}

async function getBoardSourceJobs() {
    console.log(`Scraping ${JOB_BOARD_SOURCES.length} configured job board pages...`);
    return fetchBatched(JOB_BOARD_SOURCES, async (source) => {
        try {
            const res = await axios.get(source.url, {
                timeout: API_TIMEOUT,
                maxRedirects: 3,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 SmartJobMonitor/3.0',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                },
                validateStatus: status => status >= 200 && status < 500,
            });
            if (res.status >= 400 || typeof res.data !== 'string') {
                recordSourceHealth('job_board', source.name, false, 0, `HTTP ${res.status}`);
                return [];
            }
            const jsonLdJobs = extractJsonLdJobs(res.data, source);
            const anchorJobs = jsonLdJobs.length ? [] : extractAnchorJobs(res.data, source);
            const found = [...jsonLdJobs, ...anchorJobs].slice(0, 25);
            recordSourceHealth('job_board', source.name, true, found.length, found.length ? null : 'reachable_no_public_jobs');
            return found;
        } catch (e) {
            recordSourceHealth('job_board', source.name, false, 0, summarizeModelError(e));
            return [];
        }
    }, 4);
}

const getScrapedJobs = async (refreshRunId = null) => {
    console.log(`📡 Scraping jobs from ${JOB_APIS.length} APIs + ${JOB_RSS_FEEDS.length} RSS feeds + ${JOB_BOARD_SOURCES.length} board scrapers...`);
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
                    sourcePublishedAt: toIsoOrNull(j.publication_date),
                    time: "🔴 LIVE", source: source.name
                }));
            } else if (source.type === 'muse' && res.data?.results) {
                res.data.results.forEach(j => items.push({
                    title: j.name, company: j.company?.name || 'Company',
                    location: j.locations?.[0]?.name || 'Flexible',
                    url: j.refs?.landing_page || '#', isRemote: (j.locations?.[0]?.name || '').toLowerCase().includes('remote'),
                    sourcePublishedAt: toIsoOrNull(j.publication_date),
                    pay: 'N/A', time: "⚡ POSTED", source: source.name
                }));
            } else if (source.type === 'hn-jobs' && res.data?.hits) {
                res.data.hits.slice(0, 15).forEach(h => items.push({
                    title: h.title, company: 'HackerNews',
                    location: 'Remote / Global', url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
                    sourcePublishedAt: toIsoOrNull(h.created_at),
                    isRemote: true, pay: 'N/A', time: "🟠 HN", source: source.name
                }));
            }
            recordSourceHealth('job_api', source.name, true, items.length);
            return items;
        } catch (e) {
            recordSourceHealth('job_api', source.name, false, 0, summarizeModelError(e));
            return [];
        }
    });

    // 2. Fetch from RSS
    const rssJobs = await fetchBatched(JOB_RSS_FEEDS, async (feedUrl) => {
        try {
            const feed = await parser.parseURL(feedUrl);
            const items = (feed.items || []).slice(0, 15).map(item => ({
                title: cleanText(item.title || 'Role'), company: cleanText(feed.title || 'Company'),
                location: item.categories?.[0] || 'Remote',
                url: item.link || '#', isRemote: true,
                sourcePublishedAt: toIsoOrNull(item.isoDate || item.pubDate),
                pay: 'N/A', time: "🟢 RSS LIVE", source: feed.title || feedUrl
            }));
            recordSourceHealth('job_rss', feed.title || feedUrl, true, items.length);
            return items;
        } catch (e) {
            recordSourceHealth('job_rss', feedUrl, false, 0, summarizeModelError(e));
            return [];
        }
    });

    const boardJobs = await getBoardSourceJobs();
    const allRawJobs = [...apiJobs, ...rssJobs, ...boardJobs];

    // Deduplicate by URL
    const seen = new Set();
    const uniqueJobs = allRawJobs.filter(j => {
        if (j.sourcePublishedAt && !isRecentDate(j.sourcePublishedAt, JOB_MAX_AGE_DAYS)) return false;
        if (!isLikelyPersistableJob(j)) return false;
        const canonicalUrl = canonicalSourceUrl(j.url);
        if (!canonicalUrl || seen.has(canonicalUrl)) return false;
        j.url = canonicalUrl;
        seen.add(canonicalUrl);
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
            source: j.source,
            sourcePublishedAt: j.sourcePublishedAt || null,
            publishedAt: j.sourcePublishedAt || null,
            collectedAt: getTimestamp(j.sourcePublishedAt),
            freshness: j.sourcePublishedAt && isRecentDate(j.sourcePublishedAt, 1) ? 'breaking' : 'verified',
            refreshRunId,
            size: 0.4, color: "#00e676"
        });
    });

    // Save to Neon DB
    await saveJobsToNeonDB(uniqueJobs, refreshRunId);
    console.log(`✅ Jobs scraped: ${jobs.length} unique from ${getTotalJobSources()} sources`);
    return jobs;
};

// ═══════════════════════════════════════════════════════════════
// NEWS SCRAPING ENGINE (1000+ sources)
// ═══════════════════════════════════════════════════════════════
const getScrapedNews = async (refreshRunId = null) => {
    console.log(`📡 Scraping news from ${NEWS_RSS_FEEDS.length} RSS + ${HN_QUERIES.length} HN queries...`);
    const news = [];

    const dailyConfig = await getDailyNewsSources().catch(() => ({ feeds: [], mediumFeeds: [], googleNewsQueries: [] }));
    const bridgeFeeds = [
        ...(dailyConfig.feeds || []).map(item => item.url),
        ...(dailyConfig.mediumFeeds || []),
        ...(dailyConfig.googleNewsQueries || []).map(query => `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`),
    ];
    const allNewsFeeds = [...new Set([...NEWS_RSS_FEEDS, ...bridgeFeeds])];

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
    const rssNews = await fetchBatched(allNewsFeeds, async (feedUrl) => {
        try {
            const feed = await parser.parseURL(feedUrl);
            const cat = feedUrl.includes('arxiv') ? 'research' : feedUrl.includes('ai') || feedUrl.includes('machine') ? 'ai' : 'tech';
            const icon = cat === 'research' ? '🔬' : cat === 'ai' ? '🧠' : '📱';
            const items = (feed.items || []).slice(0, 8).map(item => ({
                headline: (item.title || '').replace(/<[^>]*>/g, '').trim(),
                source: feed.title || 'RSS', url: item.link || '#',
                category: cat, snippet: (item.contentSnippet || '').substring(0, 150).replace(/<[^>]*>/g, ''),
                date: item.isoDate || item.pubDate || null, icon,
                integration: bridgeFeeds.includes(feedUrl) ? 'DailyNewsUpdate' : 'native',
            }));
            recordSourceHealth('news_rss', feed.title || feedUrl, true, items.length);
            return items;
        } catch (e) {
            recordSourceHealth('news_rss', feedUrl, false, 0, summarizeModelError(e));
            return [];
        }
    });

    const linkedInNews = await getLinkedInImports().catch(error => {
        recordSourceHealth('linkedin', 'DailyNewsUpdate import', false, 0, error.message);
        return [];
    });
    recordSourceHealth('linkedin', 'DailyNewsUpdate import', linkedInNews.length > 0, linkedInNews.length, linkedInNews.length ? null : 'authorization_or_import_required');
    const allRawNews = [...hnNews, ...rssNews, ...linkedInNews];
    const candidateNews = allRawNews.filter(n => isRecentDate(n.date));
    const seen = new Set();
    const uniqueNews = sortByDateDesc(candidateNews).filter(n => {
        const canonicalUrl = canonicalSourceUrl(n.url);
        if (!canonicalUrl || seen.has(canonicalUrl)) return false;
        n.url = canonicalUrl;
        seen.add(canonicalUrl);
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
            category: n.category, snippet: n.snippet, integration: n.integration || 'native',
            time: "🔴 LIVE", collectedAt: Date.now(), refreshRunId, radius: 4.5, color: "#ff3333"
        });
    });

    news.forEach((point, index) => {
        const sourceItem = uniqueNews[index];
        point.time = sourceItem.date;
        point.publishedAt = sourceItem.date;
        point.collectedAt = getTimestamp(sourceItem.date);
        point.freshness = isRecentDate(sourceItem.date, 1) ? 'breaking' : 'recent';
    });

    // Save to DB
    await saveNewsToNeonDB(uniqueNews, refreshRunId);
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
    const recentTrends = trends.filter(item => isRecentDate(item.date));
    return sortByDateDesc(recentTrends);
};

// ═══════════════════════════════════════════════════════════════
// YOUTUBE VIDEOS (Multi-Source Scraping)
// ═══════════════════════════════════════════════════════════════
const YOUTUBE_FRESH_QUERIES = [
    "AI news today",
    "artificial intelligence news last 24 hours",
    "OpenAI news today",
    "Google Gemini AI news today",
    "NVIDIA AI news today",
    "startup funding news today",
    "technology news today",
    "cybersecurity news today",
    "software engineering news today",
    "cloud computing news today",
];

const YOUTUBE_BASE_QUERIES = [
    // AI & MACHINE LEARNING (The Heart)
    "artificial intelligence news today", "machine learning tutorial 2026", "large language model LLM news",
    "generative AI latest developments", "OpenAI GPT-5 leaks and rumors", "Google DeepMind Gemini news",
    "Anthropic Claude AI updates", "Mistral AI open source news", "NVIDIA AI Blackwell GPU latest",
    "AI agents autonomous workflows", "Llama 3.1 405B benchmarks", "AI hardware startups 2026",
    "stable diffusion 3 generation", "AI for software engineering", "vector databases pinecone weaviate",
    "langchain langgraph tutorials", "pytorch vs tensorflow 2026", "computer vision breakthroughs",
    "natural language processing 2026", "reinforcement learning robotics",

    // SOFTWARE ENGINEERING & WEB DEV (The Foundation)
    "software engineering trends 2026", "coding tutorial react python", "system design interview questions",
    "next.js 15 app router tutorial", "typescript advanced patterns", "rust programming for beginners",
    "go language backend microservices", "flutter vs react native 2026", "tailwindcss best practices",
    "web assembly wasm performance", "bun vs nodejs vs deno", "postgresql scaling strategies",
    "redis insight and caching", "graphql vs restful apis", "testing library vitest tutorial",
    "playwright end to end testing", "clean code architecture tips", "solid principles in javascript",
    "functional programming concepts", "software developer roadmap 2026",

    // CLOUD & DEVOPS (The Scale)
    "devops kubernetes docker tutorial", "AWS lambda serverless news", "google cloud platform gcp 2026",
    "azure infrastructure as code", "terraform vs opentofu", "ansible automation guide",
    "prometheus and grafana monitoring", "ci/cd pipeline github actions", "jenkins automation server",
    "cloud native computing foundation", "edge computing 5g future", "serverless database neon planetscale",
    "observability with opentelemetry", "site reliability engineering sre", "platform engineering vs devops",
    "kubernetes k8s troubleshooting", "docker swarm vs k8s", "cloudflare workers tech",
    "vercel vs netlify choice", "cloud security best practices",

    // CYBERSECURITY & HACKING (The Shield)
    "cybersecurity news hacking 2026", "ethical hacking tutorial beginner", "penetration testing kali linux",
    "zero trust architecture guide", "ransomware trends prevention", "owasp top 10 web security",
    "network security firewalls vpn", "malware analysis reverse engineering", "cryptography for developers",
    "bug bounty hunting tips", "security audits devsecops", "phishing attack prevention",
    "social engineering awareness", "identity access management iam", "incident response plan",
    "cloud security architecture", "cyber war documentaries", "advanced persistent threats",
    "security tokens and mfa", "ethical hacking live streams",

    // STARTUPS & BUSINESS (The Hustle)
    "tech startup funding news monthly", "venture capital silicon valley trends", "Y Combinator startup demo day",
    "SaaS startup growth marketing", "how to raise seed funding 2026", "fintech industry 2026 outlook",
    "edtech virtual reality learning", "healthtech ai diagnostics", "proptech real estate tech",
    "startup culture and burnout", "indie hackers solo developer", "product hunt launch strategy",
    "agile scrum for product teams", "lean startup methodology", "business model canvas guide",
    "angel investors for tech", "ipo vs acquisition exit", "founder stories and lessons",
    "remote work future trends", "startup pitch deck examples",

    // ROBOTICS & HARDWARE (The Steel)
    "robotics AI automation future", "quantum computing breakthrough 2026", "tesla bot optimus progress",
    "boston dynamics atlas new", "industrial robots manufacturing", "humanoid robot startups",
    "raspberry pi projects 2026", "arduino iot home automation", "autonomous drones tech",
    "space tech spacex starship", "ev battery tech news", "semiconductor manufacturing lithography",
    "arm vs x86 cpu wars", "apple m4 chip benchmarks", "open source hardware risc-v",
    "wearable tech health sensors", "smart city infrastructure", "3d printing metal composite",
    "iot security vulnerabilities", "robot wars competition news",

    // BLOCKCHAIN & WEB3 (The Ledger)
    "blockchain cryptocurrency news daily", "web3 decentralized apps tutorial", "ethereum scaling layer 2",
    "solana performance and dapps", "bitcoin lightning network news", "smart contract auditing rust",
    "nft market trends 2026", "decentralized finance defi 2.0", "dao governance models",
    "polygon zkevm latest", "cardano vs polkadot vs cosmos", "crypto wallet security",
    "blockchain in supply chain", "tokenomics and game theory", "proof of stake vs work",
    "cbdc global landscape news", "metaverse development unity", "web3 gaming play to earn",
    "privacy coins zkp tech", "blockchain interoperability bridge"
];

function parseYouTubeAgeDays(ago = '') {
    const text = String(ago || '').toLowerCase();
    if (!text) return 999;
    if (/second|minute|hour|today|just now/.test(text)) return 0;
    const amount = Number((text.match(/(\d+)/) || [])[1] || (text.includes('a ') || text.includes('an ') ? 1 : 0));
    if (/day/.test(text)) return amount || 1;
    if (/week/.test(text)) return (amount || 1) * 7;
    if (/month/.test(text)) return (amount || 1) * 30;
    if (/year/.test(text)) return (amount || 1) * 365;
    return 999;
}

function normalizeYouTubeVideo(v, query) {
    const ageDays = parseYouTubeAgeDays(v.ago);
    const publishedAt = toIsoOrNull(v.publishedAt || v.uploadDate)
        || (ageDays < 999 ? new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString() : null);
    const refreshed = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    return {
        title: v.title,
        videoId: v.videoId,
        channel: v.author?.name || 'YouTube',
        views: Number(v.views || 0),
        ago: v.ago || 'recent',
        published: `${v.ago || 'recent'} • refreshed ${refreshed}`,
        publishedAgeDays: ageDays,
        publishedAt,
        category: query.includes('AI') || query.includes('ai') || query.includes('machine') ? 'ai' :
            query.includes('startup') || query.includes('funding') ? 'startup' :
                query.includes('cyber') || query.includes('hacking') ? 'security' :
                    query.includes('cloud') || query.includes('devops') ? 'cloud' :
                        query.includes('robot') || query.includes('quantum') ? 'hardware' :
                            query.includes('blockchain') || query.includes('web3') ? 'web3' : 'tech'
    };
}

async function getYouTubeApiVideos(queries) {
    if (!process.env.YOUTUBE_API_KEY) return [];
    const publishedAfter = new Date(Date.now() - VIDEO_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    return fetchBatched(queries.slice(0, Math.min(queries.length, 12)), async (query) => {
        try {
            const res = await axios.get('https://www.googleapis.com/youtube/v3/search', {
                params: {
                    key: process.env.YOUTUBE_API_KEY,
                    part: 'snippet',
                    q: query,
                    type: 'video',
                    order: 'date',
                    publishedAfter,
                    maxResults: 10,
                    safeSearch: 'moderate',
                },
                timeout: API_TIMEOUT,
            });
            const items = (res.data?.items || []).map(item => ({
                title: cleanText(item.snippet?.title),
                videoId: item.id?.videoId,
                channel: item.snippet?.channelTitle || 'YouTube',
                views: 0,
                ago: 'recent upload',
                published: item.snippet?.publishedAt,
                publishedAt: item.snippet?.publishedAt,
                publishedAgeDays: Math.max(0, (Date.now() - getTimestamp(item.snippet?.publishedAt)) / 86_400_000),
                category: /AI|machine|GPT|Gemini/i.test(query) ? 'ai' : 'tech',
            })).filter(item => item.videoId && item.publishedAt);
            recordSourceHealth('youtube_api', query, true, items.length);
            return items;
        } catch (error) {
            recordSourceHealth('youtube_api', query, false, 0, summarizeModelError(error));
            return [];
        }
    }, 3);
}

function withTimeout(promise, ms, fallback) {
    return Promise.race([
        promise,
        new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
    ]);
}

const getYouTubeVideos = async () => {
    // Combine base queries with AI-generated trending queries
    let aiQueries = [];
    try {
        const aiRes = await getAIInsight(`Provide 5 YouTube search queries for TODAY's most trending AI/Tech/Startup topics in 2026. Return JSON: { "queries": ["q1","q2","q3","q4","q5"] }`);
        if (aiRes?.queries?.length) aiQueries = aiRes.queries;
    } catch (e) { }

    const allQueries = [...aiQueries, ...YOUTUBE_FRESH_QUERIES, ...YOUTUBE_BASE_QUERIES].slice(0, YOUTUBE_QUERY_LIMIT);
    console.log(`🎥 Scraping YouTube with ${allQueries.length} queries...`);

    const videos = [];
    const uniqueIds = new Set();

    const apiVideos = await getYouTubeApiVideos(allQueries);
    const searchVideos = await fetchBatched(allQueries, async (query) => {
        try {
            const r = await withTimeout(ytSearch(query), API_TIMEOUT, { videos: [] });
            return (r.videos || []).slice(0, 10).map(v => normalizeYouTubeVideo(v, query));
        } catch (e) { return []; }
    }, 5); // batch 5 at a time to avoid rate limits

    [...apiVideos, ...searchVideos].forEach(v => {
        if (v.videoId && !uniqueIds.has(v.videoId)) {
            uniqueIds.add(v.videoId);
            if (v.publishedAt && v.publishedAgeDays <= VIDEO_MAX_AGE_DAYS) videos.push(v);
        }
    });

    const selectedVideos = videos
        .sort((a, b) => getTimestamp(b.publishedAt) - getTimestamp(a.publishedAt) || ((b.views || 0) - (a.views || 0)))
        .slice(0, 60);
    await saveVideosToNeonDB(selectedVideos);
    console.log(`✅ YouTube: ${selectedVideos.length} fresh videos from ${allQueries.length} queries`);
    return selectedVideos;
};

// ═══════════════════════════════════════════════════════════════
// DATABASE SAVE FUNCTIONS
// ═══════════════════════════════════════════════════════════════
async function cleanupKnownJobNoise() {
    if (!pool) return;
    try {
        await pool.query(`
            DELETE FROM jobs
            WHERE LOWER(COALESCE(source, '')) LIKE '%ncs%'
              AND LOWER(COALESCE(title, '')) ~ '(manual|handbook|flowchart|registration|post new job|view jobs|jobs archives|job fairs|model career centers|career schemes|career information|links to govt|find domestic|find international|training by)';
        `);
        await pool.query(`
            DELETE FROM jobs
            WHERE LOWER(TRIM(COALESCE(title, ''))) IN ('software development','content writing','consulting','business consulting','business analysis','debugging','agile development','project management','prototyping','mobile app development','web development','data management','international jobs','marketing','data entry','translation','research','training','design','testing','advisories for international jobseeker','international resources','post international jobs','ncs meta data','international job opportunities');
        `);
        await pool.query(`
            DELETE FROM jobs
            WHERE source = ANY($1::text[])
              AND (
                LOWER(COALESCE(title, '')) ~ '(join now|jobs by|job alerts|jobs app|report an issue|resume database|find companies|find more jobs|career advice|privacy|terms|about us|contact us|sign in|login)'
                OR LOWER(COALESCE(title, '')) !~ '(engineer|developer|architect|analyst|scientist|specialist|consultant|manager|designer|writer|administrator|officer|executive|associate|assistant|trainee|intern|operator|technician|accountant|recruiter|sales|support|nurse|teacher|lead|director|head|python|react|node|java|golang|devops|full.?stack|front.?end|back.?end|software|cloud|security|machine learning|data)'
                OR LOWER(COALESCE(url, '')) !~ '(\/jobs?\/view\/([0-9]+)|\/job\/|job[_-]?id=|jk=|viewjob|job-listing|job-details?|jobdetail|\/opportunit(y|ies)\/|\/project\/[0-9]+)'
              );
        `, [JOB_BOARD_SOURCES.map(source => source.name)]);
        await pool.query(`
            DELETE FROM jobs older
            USING jobs newer
            WHERE older.id < newer.id
              AND LOWER(TRIM(COALESCE(older.title, ''))) = LOWER(TRIM(COALESCE(newer.title, '')))
              AND LOWER(TRIM(COALESCE(older.company, ''))) = LOWER(TRIM(COALESCE(newer.company, '')))
              AND LOWER(TRIM(COALESCE(older.source, ''))) = LOWER(TRIM(COALESCE(newer.source, '')))
              AND LOWER(TRIM(COALESCE(older.location, ''))) = LOWER(TRIM(COALESCE(newer.location, '')));
        `);
    } catch (e) {
        console.error('Job cleanup error:', e.message);
    }
}

const saveJobsToNeonDB = async (jobsArr, refreshRunId = null) => {
    if (!pool || jobsArr.length === 0) return;
    jobsArr = jobsArr.filter(isLikelyPersistableJob);
    if (jobsArr.length === 0) return;
    // Insert in chunks of 50
    for (let i = 0; i < jobsArr.length; i += 50) {
        const chunk = jobsArr.slice(i, i + 50);
        const values = []; const placeholders = []; let c = 1;
        for (const j of chunk) {
            placeholders.push(`($${c++},$${c++},$${c++},$${c++},$${c++},$${c++},$${c++},$${c++},'open',NOW(),NOW(),NOW(),$${c++})`);
            values.push(j.title, j.company, j.url, j.source || j.time, j.location || 'Remote', j.pay || 'N/A', j.sourcePublishedAt, j.sourcePublishedAt, refreshRunId);
        }
        try {
            await pool.query(`
                INSERT INTO jobs (title,company,url,source,location,pay,posted_date,source_published_at,status,first_seen_at,last_seen_at,refreshed_at,refresh_run_id)
                VALUES ${placeholders.join(',')}
                ON CONFLICT (url) DO UPDATE SET
                    title = EXCLUDED.title,
                    company = EXCLUDED.company,
                    source = EXCLUDED.source,
                    location = EXCLUDED.location,
                    pay = EXCLUDED.pay,
                    posted_date = COALESCE(EXCLUDED.posted_date, jobs.posted_date),
                    source_published_at = COALESCE(EXCLUDED.source_published_at, jobs.source_published_at),
                    last_seen_at = NOW(),
                    refreshed_at = NOW(),
                    refresh_run_id = EXCLUDED.refresh_run_id;
            `, values);
        } catch (e) { console.error('💾 DB insert error:', e.message); }
    }
    await cleanupKnownJobNoise();
    console.log(`💾 Saved ${jobsArr.length} jobs to Neon DB`);
};

const saveNewsToNeonDB = async (newsArr, refreshRunId = null) => {
    if (!pool || newsArr.length === 0) return;
    for (let i = 0; i < newsArr.length; i += 50) {
        const chunk = newsArr.slice(i, i + 50);
        const values = []; const placeholders = []; let c = 1;
        for (const n of chunk) {
            placeholders.push(`($${c++},$${c++},$${c++},$${c++},$${c++},$${c++},$${c++},NOW(),NOW(),NOW(),$${c++})`);
            values.push(n.headline, n.source, n.url, n.category || 'tech', n.snippet || '', n.date, n.date, refreshRunId);
        }
        try {
            await pool.query(`
                INSERT INTO news (headline,source,url,category,snippet,published_date,source_published_at,first_seen_at,last_seen_at,refreshed_at,refresh_run_id)
                VALUES ${placeholders.join(',')}
                ON CONFLICT (url) DO UPDATE SET
                    headline = EXCLUDED.headline,
                    source = EXCLUDED.source,
                    category = EXCLUDED.category,
                    snippet = EXCLUDED.snippet,
                    published_date = COALESCE(EXCLUDED.published_date, news.published_date),
                    source_published_at = COALESCE(EXCLUDED.source_published_at, news.source_published_at),
                    last_seen_at = NOW(),
                    refreshed_at = NOW(),
                    refresh_run_id = EXCLUDED.refresh_run_id;
            `, values);
        } catch (e) { /* skip */ }
    }
};

const saveVideosToNeonDB = async (vids) => {
    if (!pool || vids.length === 0) return;
    const values = []; const placeholders = []; let c = 1;
    for (const v of vids) {
        placeholders.push(`($${c++},$${c++},$${c++},$${c++},$${c++},$${c++},$${c++})`);
        values.push(v.title, v.videoId, v.channel, v.published, Number(v.views || 0), v.ago || v.published || 'recent', v.publishedAt || null);
    }
    try {
        await pool.query(`
            INSERT INTO youtube_videos (title,video_id,channel,published,views,published_ago,published_at)
            VALUES ${placeholders.join(',')}
            ON CONFLICT (video_id) DO UPDATE SET
                title = EXCLUDED.title,
                channel = EXCLUDED.channel,
                published = EXCLUDED.published,
                views = EXCLUDED.views,
                published_ago = EXCLUDED.published_ago,
                published_at = COALESCE(EXCLUDED.published_at, youtube_videos.published_at),
                refreshed_at = NOW();
        `, values);
    } catch (e) { /* skip */ }
};

// Smart Job Portal helpers
const CRM_STATUSES = new Set(['open', 'new', 'queued', 'applied', 'interview', 'offer', 'rejected', 'archived']);
const TECH_KEYWORDS = [
    'python', 'javascript', 'typescript', 'react', 'node', 'java', 'go', 'rust', 'sql', 'postgres',
    'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'terraform', 'ai', 'ml', 'llm', 'rag',
    'data', 'security', 'devops', 'backend', 'frontend', 'fullstack', 'cloud', 'linux',
];
const SQL_CLEAN = (column) => `TRIM(REGEXP_REPLACE(COALESCE(${column}, ''), '[[:space:]]+', ' ', 'g'))`;

function normalizeJobStatus(status = 'open') {
    const normalized = String(status).toLowerCase().trim();
    if (normalized === 'new' || normalized === 'queued') return 'open';
    return CRM_STATUSES.has(normalized) ? normalized : 'open';
}

function tokenizeText(text = '') {
    return String(text).toLowerCase().match(/[a-z0-9+#.]{2,}/g) || [];
}

function scoreJobAgainstResume(resumeText = '', job = {}) {
    const resumeTokens = new Set(tokenizeText(resumeText));
    const jobText = [job.title, job.company, job.location, job.source, job.pay].filter(Boolean).join(' ');
    const jobTokens = [...new Set(tokenizeText(jobText))];
    if (!resumeTokens.size || !jobTokens.length) return 0;
    const overlap = jobTokens.filter(token => resumeTokens.has(token)).length;
    const techBoost = TECH_KEYWORDS.filter(token => resumeTokens.has(token) && jobTokens.includes(token)).length * 4;
    const base = Math.round((overlap / Math.max(jobTokens.length, 1)) * 100);
    return Math.min(99, Math.max(1, base + techBoost));
}

function classifySeniority(title = '') {
    const text = title.toLowerCase();
    if (/principal|staff|lead|architect|head/.test(text)) return 'lead';
    if (/senior|sr\.?/.test(text)) return 'senior';
    if (/junior|jr\.?|entry|graduate|intern/.test(text)) return 'early';
    return 'mid';
}

function classifyWorkMode(location = '') {
    const text = location.toLowerCase();
    if (/remote|anywhere|worldwide|global/.test(text)) return 'remote';
    if (/hybrid/.test(text)) return 'hybrid';
    return 'onsite';
}

function buildJobPromptContext(job = {}) {
    return `Title: ${job.title || 'Role'}
Company: ${job.company || 'Company'}
Location: ${job.location || 'Remote'}
Pay: ${job.pay || 'Not listed'}
Source: ${job.source || 'Unknown'}
URL: ${job.url || 'N/A'}`;
}

function fallbackCareerText(type, job = {}, resumeText = '') {
    const title = job.title || 'this role';
    const company = job.company || 'the company';
    const keywords = TECH_KEYWORDS.filter(k => `${resumeText} ${title} ${job.source || ''}`.toLowerCase().includes(k)).slice(0, 6);
    if (type === 'cover-letter') {
        return `Dear Hiring Team,\n\nI am excited to apply for ${title} at ${company}. My background aligns with the role's focus on ${keywords.join(', ') || 'building reliable software and solving practical business problems'}. I bring a strong bias for ownership, clear communication, and production-quality execution.\n\nI would welcome the opportunity to discuss how I can contribute to your team.\n\nSincerely,`;
    }
    if (type === 'interview-prep') {
        return `1. Why are you interested in ${company} and this ${title} role?\n2. Walk through a production system you built or improved that relates to this role.\n3. Describe a tradeoff you made between speed, reliability, and maintainability.\n\nAnswer strategy: connect your experience to the role, quantify impact, and prepare one technical deep dive.`;
    }
    if (type === 'cold-message') {
        return `Hi, I saw the ${title} opening at ${company} and it strongly matches my background. I would be grateful to connect and learn what the team is prioritizing for this role.`;
    }
    if (type === 'skill-gap') {
        const missing = TECH_KEYWORDS.filter(k => !resumeText.toLowerCase().includes(k) && `${title} ${job.source || ''}`.toLowerCase().includes(k)).slice(0, 5);
        return `Likely skill gaps: ${missing.join(', ') || 'no obvious keyword gaps from the available job metadata'}.\n\nRecommended path: add measurable project bullets, mirror the role's core keywords, and prepare one story showing impact in a similar environment.`;
    }
    return 'AI provider is cooling down. The deterministic career assistant is still available.';
}

const ROLE_FAMILIES = [
    ['ai/ml', /(ai|machine learning|ml|llm|rag|nlp|computer vision|data scientist|deep learning)/i],
    ['frontend', /(frontend|front-end|react|vue|angular|ui engineer|web developer)/i],
    ['backend', /(backend|back-end|node|java|spring|api|microservice|server)/i],
    ['fullstack', /(full[ -]?stack|mern|mean|full stack)/i],
    ['data', /(data engineer|analytics|etl|bi|warehouse|spark|sql)/i],
    ['devops/cloud', /(devops|sre|cloud|aws|azure|gcp|kubernetes|docker|platform engineer)/i],
    ['security', /(security|cyber|soc|iam|penetration|appsec|devsecops)/i],
    ['product/design', /(product manager|designer|ux|ui\/ux|figma|product owner)/i],
    ['qa/testing', /(qa|test engineer|automation testing|sdet|quality)/i],
];

function classifyRoleFamily(title = '') {
    const match = ROLE_FAMILIES.find(([, pattern]) => pattern.test(title));
    return match ? match[0] : 'general software';
}

function extractResumeProfile(resumeText = '') {
    const text = String(resumeText || '').toLowerCase();
    const skills = TECH_KEYWORDS.filter(skill => text.includes(skill));
    const roleSignals = ROLE_FAMILIES
        .filter(([, pattern]) => pattern.test(text))
        .map(([label]) => label);
    const yearMatch = text.match(/(\d{1,2})\+?\s*(years|yrs|year)/);
    return {
        skills,
        roleSignals: roleSignals.length ? [...new Set(roleSignals)] : ['general software'],
        seniority: /principal|staff|architect|lead|manager/.test(text) ? 'lead' : /senior|sr\.?/.test(text) || Number(yearMatch?.[1] || 0) >= 5 ? 'senior' : /intern|junior|entry|fresher/.test(text) ? 'early' : 'mid',
        years: yearMatch ? Number(yearMatch[1]) : null,
        keywords: [...new Set(tokenizeText(resumeText).filter(token => token.length > 2))].slice(0, 80),
    };
}

function scoreJobForRag(job = {}, profile = {}, query = '') {
    const jobText = `${job.title || ''} ${job.company || ''} ${job.location || ''} ${job.source || ''} ${job.pay || ''}`.toLowerCase();
    const queryTokens = new Set(tokenizeText(query));
    const skillHits = (profile.skills || []).filter(skill => jobText.includes(skill));
    const queryHits = [...queryTokens].filter(token => jobText.includes(token));
    const roleHit = (profile.roleSignals || []).some(role => classifyRoleFamily(job.title || '') === role);
    const seniorityHit = classifySeniority(job.title || '') === profile.seniority;
    const remoteBoost = /remote|hybrid/i.test(job.location || '') ? 4 : 0;
    return (skillHits.length * 9) + (queryHits.length * 5) + (roleHit ? 12 : 0) + (seniorityHit ? 5 : 0) + remoteBoost;
}

function summarizeRows(rows = []) {
    const countBy = (fn, limit = 8) => {
        const map = new Map();
        rows.forEach(row => {
            const key = fn(row) || 'Unknown';
            map.set(key, (map.get(key) || 0) + 1);
        });
        return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([label, count]) => ({ label, count }));
    };
    return {
        companies: countBy(row => row.company, 10),
        sources: countBy(row => row.source, 10),
        locations: countBy(row => row.location, 10),
        roleFamilies: countBy(row => classifyRoleFamily(row.title), 10),
        seniority: countBy(row => classifySeniority(row.title), 6),
        workModes: countBy(row => classifyWorkMode(row.location), 4),
    };
}

async function retrieveJobsForRag({ resumeText = '', question = '', limit = 24, sampleLimit = 1600 } = {}) {
    if (!pool) return { profile: extractResumeProfile(resumeText), jobs: [], analytics: summarizeRows([]) };
    const profile = extractResumeProfile(resumeText);
    const jobsRes = await pool.query(
        `SELECT id, ${SQL_CLEAN('title')} AS title, ${SQL_CLEAN('company')} AS company, url, source,
                ${SQL_CLEAN('location')} AS location, pay, posted_date, status, notes, match_score, created_at
             FROM jobs
             WHERE LOWER(COALESCE(status, 'open')) NOT IN ('archived', 'rejected')
         ORDER BY COALESCE(refreshed_at, created_at) DESC, id DESC
         LIMIT $1`,
        [sampleLimit]
    );
    const scored = jobsRes.rows
        .map(job => ({
            ...job,
            match_score: Math.max(scoreJobAgainstResume(resumeText, job), scoreJobForRag(job, profile, question)),
            role_family: classifyRoleFamily(job.title),
            seniority: classifySeniority(job.title),
            work_mode: classifyWorkMode(job.location),
        }))
        .sort((a, b) => b.match_score - a.match_score);
    return {
        profile,
        jobs: scored.slice(0, limit),
        analytics: summarizeRows(scored.slice(0, 250)),
        sampleSize: jobsRes.rows.length,
    };
}

function buildAgenticResumeReport(resumeText = '', retrieved = {}) {
    const profile = retrieved.profile || extractResumeProfile(resumeText);
    const jobs = retrieved.jobs || [];
    const topSkills = profile.skills.slice(0, 12);
    const marketSkills = [...new Set(jobs.flatMap(job => TECH_KEYWORDS.filter(skill => `${job.title} ${job.source}`.toLowerCase().includes(skill))))];
    const missingSkills = marketSkills.filter(skill => !profile.skills.includes(skill)).slice(0, 10);
    const companies = [...new Set(jobs.map(job => job.company).filter(Boolean))].slice(0, 10);
    const targetRoles = [...new Set(jobs.map(job => job.role_family).filter(Boolean))].slice(0, 6);
    return {
        summary: `Profile reads as ${profile.seniority} level with focus on ${profile.roleSignals.join(', ')}. Retrieved ${jobs.length} strong job matches from ${retrieved.sampleSize || jobs.length} live roles.`,
        profile,
        topSkills,
        missingSkills,
        targetRoles,
        companies,
        actions: [
            `Tune resume headline toward: ${targetRoles.slice(0, 3).join(', ') || 'software engineering'}.`,
            `Add measurable bullets for: ${(topSkills.length ? topSkills : profile.keywords.slice(0, 5)).join(', ') || 'core project impact'}.`,
            `Build or highlight proof for missing market skills: ${missingSkills.slice(0, 5).join(', ') || 'no obvious critical gaps'}.`,
            `Apply first to: ${companies.slice(0, 5).join(', ') || 'the highest match companies shown below'}.`,
        ],
        evidence: jobs.slice(0, 8).map(job => `${job.match_score}% ${job.title} @ ${job.company} (${job.location || 'Remote'})`),
    };
}

function formatAgenticReport(report = {}, jobs = []) {
    return [
        `Agentic RAG Resume Report`,
        ``,
        `Summary: ${report.summary || 'Resume analyzed against the live jobs database.'}`,
        ``,
        `Target roles: ${(report.targetRoles || []).join(', ') || 'Not enough signal yet'}`,
        `Matched skills: ${(report.topSkills || []).join(', ') || 'No strong explicit skill signals found'}`,
        `Skill gaps: ${(report.missingSkills || []).join(', ') || 'No critical gaps detected from retrieved jobs'}`,
        ``,
        `Recommended actions:`,
        ...(report.actions || []).map(item => `- ${item}`),
        ``,
        `Evidence from retrieved jobs:`,
        ...(report.evidence || jobs.slice(0, 8).map(job => `${job.match_score}% ${job.title} @ ${job.company}`)).map(item => `- ${item}`),
    ].join('\n');
}

function formatMarketAnswer(question = '', retrieved = {}) {
    const jobs = retrieved.jobs || [];
    const analytics = retrieved.analytics || summarizeRows(jobs);
    const companies = analytics.companies.map(item => `${item.label} (${item.count})`).join(', ') || 'No dominant companies';
    const sources = analytics.sources.map(item => `${item.label} (${item.count})`).join(', ') || 'No dominant sources';
    const roles = analytics.roleFamilies.map(item => `${item.label} (${item.count})`).join(', ') || 'No clear role cluster';
    const locations = analytics.locations.map(item => `${item.label} (${item.count})`).join(', ') || 'No clear location cluster';
    const topJobs = jobs.slice(0, 8).map(job => `- ${job.match_score}% ${job.title} @ ${job.company} (${job.location || 'Remote'}) [${job.source || 'source'}]`).join('\n');
    return `Agentic RAG market answer\n\nQuestion: ${question}\n\nRetrieved ${jobs.length} relevant jobs from ${retrieved.sampleSize || jobs.length} live rows.\n\nRole clusters: ${roles}\nCompanies: ${companies}\nLocations: ${locations}\nSources: ${sources}\n\nTop evidence:\n${topJobs || '- No evidence rows found. Try a skill, role, company, or location keyword.'}`;
}

function fallbackToolkitAgentic(type, job = {}, resumeText = '', retrieved = {}) {
    const report = buildAgenticResumeReport(resumeText, retrieved);
    const evidence = (retrieved.jobs || []).slice(0, 5).map(item => `- ${item.match_score}% ${item.title} @ ${item.company}`).join('\n');
    if (type === 'resume-summary') {
        return `Resume positioning summary\n\nTarget: ${job.title || 'selected role'} at ${job.company || 'the company'}\n\n${report.summary}\n\nStrong signals: ${(report.topSkills || []).join(', ') || 'project execution and delivery'}\nGaps to cover: ${(report.missingSkills || []).slice(0, 6).join(', ') || 'no obvious gaps'}\n\nEvidence:\n${evidence}`;
    }
    if (type === 'recruiter-email') {
        return `Subject: Interest in ${job.title || 'the role'}\n\nHi,\n\nI found the ${job.title || 'open'} role at ${job.company || 'your company'} and it closely matches my background in ${(report.topSkills || []).slice(0, 5).join(', ') || 'software delivery'}.\n\nA few relevant signals from my profile: ${report.summary}\n\nI would appreciate the chance to discuss how I can contribute to this team.\n\nBest,`;
    }
    return `${fallbackCareerText(type, job, resumeText)}\n\nRAG evidence:\n${evidence || '- No adjacent evidence available.'}\n\nNext actions:\n${(report.actions || []).map(item => `- ${item}`).join('\n')}`;
}

// ═══════════════════════════════════════════════════════════════
// CACHE + AUTO-REFRESH
// ═══════════════════════════════════════════════════════════════
let cache = {
    dashboardData: null,
    videos: [],
    videoLastRefresh: 0,
    videoLastStarted: 0,
    trends: [],
    lastRefresh: 0,
    lastStarted: 0,
    lastError: null,
    refreshCount: 0,
    lastRefreshRunId: null,
    stats: {},
};
let isRefreshing = false;
let isVideoRefreshing = false;
let videoRefreshPromise = null;
const REFRESH_RESPONSE_WAIT_MS = Number(process.env.REFRESH_RESPONSE_WAIT_MS || 45000);

function makeRefreshRunId() {
    return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function refreshVideosIfNeeded(force = false) {
    const stale = !cache.videoLastRefresh || (Date.now() - cache.videoLastRefresh > VIDEO_REFRESH_INTERVAL_MS);
    if (!force && !stale && cache.videos?.length) return cache.videos;
    if (isVideoRefreshing) return force && videoRefreshPromise ? await videoRefreshPromise : (cache.videos || []);
    isVideoRefreshing = true;
    cache.videoLastStarted = Date.now();
    videoRefreshPromise = (async () => {
        const freshVideos = await getYouTubeVideos();
        const recentCached = (cache.videos || []).map(video => ({
            ...video,
            videoId: video.videoId || video.video_id,
            publishedAt: video.publishedAt || video.published_at,
        })).filter(video => video.videoId && isRecentDate(video.publishedAt, VIDEO_MAX_AGE_DAYS));
        const seen = new Set();
        cache.videos = [...(freshVideos || []), ...recentCached]
            .filter(video => {
                if (!video.videoId || seen.has(video.videoId)) return false;
                seen.add(video.videoId);
                return true;
            })
            .sort((a, b) => getTimestamp(b.publishedAt) - getTimestamp(a.publishedAt))
            .slice(0, 60);
        cache.videoLastRefresh = Date.now();
        return cache.videos || [];
    })();
    try {
        return await videoRefreshPromise;
    } catch (e) {
        console.error("Video refresh error:", e.message);
        return cache.videos || [];
    } finally {
        isVideoRefreshing = false;
        videoRefreshPromise = null;
    }
}

async function refreshAllData() {
    if (isRefreshing) return;
    isRefreshing = true;
    cache.lastStarted = Date.now();
    const refreshRunId = makeRefreshRunId();
    cache.lastRefreshRunId = refreshRunId;
    console.log(`\n🔄 [${new Date().toLocaleTimeString()}] Starting background data refresh...`);

    try {
        // Pre-load from DB if cache is empty to avoid blank UI
        if (!cache.dashboardData && pool) {
            console.log("💾 Loading initial data from Database...");
            const [dbJobs, dbNews, dbVids] = await Promise.all([
                pool.query('SELECT * FROM jobs ORDER BY COALESCE(refreshed_at, created_at) DESC LIMIT 500'),
                pool.query('SELECT * FROM news ORDER BY COALESCE(refreshed_at, created_at) DESC LIMIT 500'),
                pool.query('SELECT * FROM youtube_videos WHERE published_at >= NOW() - $1::interval ORDER BY published_at DESC, id DESC LIMIT 60', [`${VIDEO_MAX_AGE_DAYS} days`])
            ]);

            if (dbJobs.rows.length > 0 || dbNews.rows.length > 0) {
                const jobs = dbJobs.rows.map(toJobPoint);
                const news = dbNews.rows.map(toNewsPoint);
                cache.dashboardData = [...jobs, ...news];
                cache.videos = dbVids.rows;
                cache.videoLastRefresh = dbVids.rows[0]?.refreshed_at ? new Date(dbVids.rows[0].refreshed_at).getTime() : cache.videoLastRefresh;
                console.log(`✅ Pre-loaded ${cache.dashboardData.length} items from DB`);
            }
        }

        // Run fresh scraping in parallel
        const scrapeMainData = async () => {
            const [jobs, news] = await Promise.all([getScrapedJobs(refreshRunId), getScrapedNews(refreshRunId)]);
            cache.dashboardData = [...jobs, ...news].sort((a, b) => (b.collectedAt || 0) - (a.collectedAt || 0));
            return { jobs, news };
        };

        const scrapeSecondaryData = async () => {
            const [videos, trends] = await Promise.all([refreshVideosIfNeeded(true), getLatestTrends()]);
            if (videos?.length) cache.videos = videos;
            if (trends?.length) cache.trends = trends;
            return { videos, trends };
        };

        const secondaryPromise = scrapeSecondaryData().catch(e => {
            console.error("Secondary refresh error:", e.message);
            return { videos: cache.videos, trends: cache.trends };
        });
        const { jobs, news } = await scrapeMainData();

        cache.lastRefresh = Date.now();
        cache.stats = {
            totalJobs: jobs.length,
            totalNews: news.length,
            totalVideos: cache.videos.length,
            totalTrends: cache.trends.length,
            jobSources: getTotalJobSources(),
            newsSources: NEWS_RSS_FEEDS.length + HN_QUERIES.length,
            modelProvider: aiRuntime.lastProvider,
            modelName: aiRuntime.lastModel,
            dbConnected: Boolean(pool),
            lastRefreshISO: new Date(cache.lastRefresh).toISOString(),
            refreshRunId,
        };
        cache.refreshCount += 1;
        cache.lastError = null;
        secondaryPromise.then(({ videos, trends }) => {
            cache.stats.totalVideos = (videos || cache.videos || []).length;
            cache.stats.totalTrends = (trends || cache.trends || []).length;
            console.log(`Secondary cache updated: ${cache.stats.totalVideos} videos, ${cache.stats.totalTrends} trends`);
        });
        console.log(`✅ CACHE UPDATED: ${jobs.length} jobs, ${news.length} news, ${cache.videos.length} videos`);
    } catch (e) {
        console.error("❌ Refresh error:", e.message);
        cache.lastError = e.message;
    } finally {
        isRefreshing = false;
    }
}

// ═══════════════════════════════════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════════════════════════════════
function getServiceHealth() {
    const ageMs = cache.lastRefresh ? Date.now() - cache.lastRefresh : null;
    return {
        ok: !cache.lastError,
        isRefreshing,
        dbConnected: Boolean(pool),
        lastRefresh: cache.lastRefresh,
        lastRefreshISO: cache.lastRefresh ? new Date(cache.lastRefresh).toISOString() : null,
        refreshRunId: cache.lastRefreshRunId,
        ageSeconds: ageMs == null ? null : Math.round(ageMs / 1000),
        refreshCount: cache.refreshCount,
        lastError: cache.lastError,
        videos: {
            count: cache.videos.length,
            isRefreshing: isVideoRefreshing,
            lastRefresh: cache.videoLastRefresh,
            lastRefreshISO: cache.videoLastRefresh ? new Date(cache.videoLastRefresh).toISOString() : null,
            maxAgeDays: VIDEO_MAX_AGE_DAYS,
        },
        ai: {
            mode: aiMode,
            provider: aiRuntime.lastProvider,
            model: aiRuntime.lastModel,
            lastError: aiRuntime.lastError,
            available: aiRuntime.disabledUntil <= Date.now(),
            disabledUntilISO: aiRuntime.disabledUntil ? new Date(aiRuntime.disabledUntil).toISOString() : null,
            attempts: aiRuntime.attempts.slice(-6),
        },
        sources: {
            jobSources: getTotalJobSources(),
            newsSources: NEWS_RSS_FEEDS.length + HN_QUERIES.length,
        },
    };
}

function getDashboardPayload(extra = {}) {
    return {
        data: cache.dashboardData || [],
        trends: cache.trends || [],
        videos: cache.videos || [],
        stats: cache.stats || {},
        lastRefresh: cache.lastRefresh,
        health: getServiceHealth(),
        ...extra,
    };
}

app.get('/', (req, res) => {
    res.send('<h1>✅ Smart News & Job Tracker API Backend is Running!</h1><p>Use /api/dashboard-data to access the endpoints.</p>');
});

app.get('/api/health', (req, res) => {
    res.status(cache.lastError ? 503 : 200).json(getServiceHealth());
});

app.get('/api/ai-modes', (req, res) => {
    res.json(getAIModePayload());
});

app.post('/api/ai-modes', (req, res) => {
    const requested = String(req.body?.mode || '').toLowerCase();
    if (!AI_MODES.includes(requested)) return res.status(400).json({ error: 'unsupported_mode', modes: AI_MODES });
    aiMode = requested;
    aiRuntime.disabledUntil = 0;
    res.json(getAIModePayload());
});

app.get('/api/free-models', async (req, res) => {
    const [ollama, bridge] = await Promise.all([inspectOllama(), getDailyNewsBridgeStatus()]);
    const huggingFaceToken = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN;
    res.json({
        activeMode: aiMode,
        providers: [
            {
                id: 'ollama',
                name: 'Ollama',
                kind: 'local',
                configured: true,
                reachable: ollama.reachable,
                endpoint: ollama.endpoint,
                models: OLLAMA_MODELS.map(id => ({ id, installed: ollama.installed.includes(id) })),
                installed: ollama.installed,
                note: ollama.reachable ? 'Private local inference is ready.' : 'Start Ollama locally or configure OLLAMA_BASE_URL on a reachable host.',
            },
            {
                id: 'openrouter',
                name: 'OpenRouter Free',
                kind: 'hosted',
                configured: getOpenRouterTokens().length > 0,
                reachable: getOpenRouterTokens().length > 0,
                models: OPENROUTER_MODELS.map(id => ({ id, installed: true })),
                note: 'Free-model router with automatic per-model fallback.',
            },
            {
                id: 'huggingface',
                name: 'Hugging Face Inference',
                kind: 'hosted',
                configured: Boolean(huggingFaceToken),
                reachable: Boolean(huggingFaceToken),
                models: HUGGINGFACE_MODELS.map(id => ({ id, installed: true })),
                note: huggingFaceToken ? 'Open-source hosted inference is configured.' : 'Set HUGGINGFACE_API_KEY or HF_TOKEN to enable hosted inference.',
            },
        ],
        routing: ['Ollama local', 'Hugging Face', 'OpenRouter free', 'deterministic offline fallback'],
        lastRuntime: getAIModePayload().runtime,
        dailyNewsUpdate: bridge,
    });
});

app.get('/api/integrations', async (req, res) => {
    const bridge = await getDailyNewsBridgeStatus();
    res.json({
        dailyNewsUpdate: bridge,
        linkedin: {
            connected: bridge.connected && bridge.linkedInImports > 0,
            items: bridge.linkedInImports || 0,
            mode: 'authorized_feed_or_import',
            requiredPath: 'smart_job_portal/daily_news_updater/data/imports/linkedin.json',
        },
        youtube: {
            apiConfigured: Boolean(process.env.YOUTUBE_API_KEY),
            oauthConfigured: Boolean(process.env.YOUTUBE_REFRESH_TOKEN && process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET),
            maxAgeDays: VIDEO_MAX_AGE_DAYS,
        },
    });
});

app.get('/api/source-health', (req, res) => {
    const sources = [...sourceHealth.values()].sort((a, b) => String(b.checkedAt).localeCompare(String(a.checkedAt)));
    res.json({
        checked: sources.length,
        healthy: sources.filter(item => item.ok).length,
        failing: sources.filter(item => !item.ok).length,
        sources,
    });
});

app.get('/api/source-registry', (req, res) => {
    res.json({
        counts: {
            apis: JOB_APIS.length,
            rss: JOB_RSS_FEEDS.length,
            boards: JOB_BOARD_SOURCES.length,
            totalJobs: getTotalJobSources(),
            news: NEWS_RSS_FEEDS.length + HN_QUERIES.length,
        },
        boards: JOB_BOARD_SOURCES.map(source => ({
            name: source.name,
            host: source.host,
            url: source.url,
            region: source.region,
            mode: 'resilient_html_probe',
        })),
    });
});

app.post('/api/refresh', async (req, res) => {
    if (isRefreshing) {
        return res.status(202).json(getDashboardPayload({
            accepted: true,
            status: 'already_refreshing',
            message: 'A refresh is already running. Returning the latest completed snapshot while the new scrape finishes.',
        }));
    }
    const refreshTask = refreshAllData();
    const refreshStatus = await Promise.race([
        refreshTask.then(() => 'completed'),
        wait(REFRESH_RESPONSE_WAIT_MS).then(() => 'refreshing'),
    ]);
    if (refreshStatus === 'refreshing') {
        return res.status(202).json(getDashboardPayload({
            accepted: true,
            status: 'refreshing',
            message: 'Refresh is still running. Returning the latest completed snapshot and continuing in the background.',
        }));
    }
    res.json(getDashboardPayload({
        accepted: true,
        status: cache.lastError ? 'completed_with_error' : 'completed',
    }));
});

app.get('/api/dashboard-data', async (req, res) => {
    const forceFresh = req.query.fresh === '1' || req.query.refresh === '1' || req.query.fresh === 'true';
    if (!forceFresh && cache.dashboardData) return res.json({ data: cache.dashboardData, lastRefresh: cache.lastRefresh, stats: cache.stats, health: getServiceHealth() });
    if (forceFresh && isRefreshing) {
        return res.status(202).json(getDashboardPayload({
            accepted: true,
            status: 'already_refreshing',
        }));
    }
    const refreshRunId = makeRefreshRunId();
    const [jobs, news] = await Promise.all([getScrapedJobs(refreshRunId), getScrapedNews(refreshRunId)]);
    const merged = [...jobs, ...news].sort((a, b) => (b.collectedAt || 0) - (a.collectedAt || 0));
    cache.dashboardData = merged;
    cache.lastRefresh = Date.now();
    cache.lastRefreshRunId = refreshRunId;
    cache.stats = {
        totalJobs: jobs.length,
        totalNews: news.length,
        totalVideos: cache.videos.length,
        totalTrends: cache.trends.length,
        jobSources: getTotalJobSources(),
        newsSources: NEWS_RSS_FEEDS.length + HN_QUERIES.length,
        modelProvider: aiRuntime.lastProvider,
        modelName: aiRuntime.lastModel,
        dbConnected: Boolean(pool),
        lastRefreshISO: new Date(cache.lastRefresh).toISOString(),
        refreshRunId,
    };
    res.json({ data: merged, lastRefresh: cache.lastRefresh, stats: cache.stats, health: getServiceHealth() });
});

app.get('/api/latest-trends', async (req, res) => {
    try {
        const forceFresh = req.query.fresh === '1' || req.query.refresh === '1' || req.query.fresh === 'true';
        if (!forceFresh && cache.trends && cache.trends.length > 0) return res.json({ trends: cache.trends });
        const trends = await getLatestTrends();
        cache.trends = trends;
        res.json({ trends });
    } catch (e) { res.json({ trends: [] }); }
});

app.get('/api/videos', async (req, res) => {
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    const videos = await refreshVideosIfNeeded(force);
    res.json({
        videos,
        lastRefresh: cache.videoLastRefresh,
        lastRefreshISO: cache.videoLastRefresh ? new Date(cache.videoLastRefresh).toISOString() : null,
        isRefreshing: isVideoRefreshing,
    });
});

app.get('/api/ai-insights', async (req, res) => {
    let videos = await refreshVideosIfNeeded(false);
    try {
        const newsSlice = (cache.dashboardData || []).filter(d => d.type === 'news').slice(0, 10);
        const jobsSlice = (cache.dashboardData || []).filter(d => d.type === 'job').slice(0, 5);
        const totalNews = (cache.dashboardData || []).filter(d => d.type === 'news').length;
        const totalJobs = (cache.dashboardData || []).filter(d => d.type === 'job').length;

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
            aiJson.provider = aiRuntime.lastProvider;
            aiJson.model = aiRuntime.lastModel;
            aiJson.fallback = false;
            return res.json(aiJson);
        }
        res.json({
            summary_news: `Live data active across ${totalNews} news signals.`,
            summary_jobs: `${totalJobs} tracked roles are currently active.`,
            videos,
            provider: 'Deterministic',
            model: 'offline-summary',
            fallback: true,
        });
    } catch (e) {
        res.json({
            summary_news: "AI Unavailable. Live Streams Active.",
            summary_jobs: "Global Hiring Active.",
            videos,
            provider: 'Deterministic',
            model: 'offline-summary',
            fallback: true,
        });
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
app.post('/api/portal-resume-upload', upload.single('resume'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'resume_file_required' });
    const fileName = req.file.originalname || 'resume';
    const mime = req.file.mimetype || '';
    const lowerName = fileName.toLowerCase();
    try {
        let text = '';
        if (mime.includes('pdf') || lowerName.endsWith('.pdf')) {
            const parsed = await pdfParse(req.file.buffer);
            text = parsed.text || '';
        } else if (mime.includes('wordprocessingml') || lowerName.endsWith('.docx')) {
            const parsed = await mammoth.extractRawText({ buffer: req.file.buffer });
            text = parsed.value || '';
        } else if (mime.startsWith('text/') || lowerName.endsWith('.txt') || lowerName.endsWith('.md')) {
            text = req.file.buffer.toString('utf8');
        } else {
            return res.status(400).json({ error: 'unsupported_resume_type', supported: ['pdf', 'docx', 'txt', 'md'] });
        }
        const cleaned = cleanText(text).slice(0, 50000);
        if (!cleaned) return res.status(422).json({ error: 'empty_resume_text' });
        res.json({
            text: cleaned,
            name: fileName,
            type: mime,
            size: req.file.size,
            characters: cleaned.length,
        });
    } catch (e) {
        console.error("Resume upload parse error:", e.message);
        res.status(422).json({ error: 'resume_parse_failed' });
    }
});

app.get('/api/portal-jobs', async (req, res) => {
    if (!pool) return res.json({ jobs: [], total: 0 });
    const { search, page = 1, limit = 20, location, source, status } = req.query;
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
    if (status && status !== 'all') {
        if (normalizeJobStatus(status) === 'open') {
            conditions.push(`LOWER(COALESCE(status, 'open')) IN ('open', 'new', 'queued')`);
        } else {
            conditions.push(`LOWER(COALESCE(status, 'open')) = $${paramCount}`);
            params.push(normalizeJobStatus(status));
            paramCount++;
        }
    }

    if (conditions.length > 0) whereClause = 'WHERE ' + conditions.join(' AND ');

    try {
        const countRes = await pool.query(`SELECT COUNT(*) FROM jobs ${whereClause}`, params);
        const total = parseInt(countRes.rows[0].count);

        const jobsRes = await pool.query(
            `SELECT id, ${SQL_CLEAN('title')} AS title, ${SQL_CLEAN('company')} AS company, url, source, ${SQL_CLEAN('location')} AS location, pay, posted_date, status, notes, match_score, applied_at, follow_up_at, archived_at, refreshed_at, refresh_run_id
             FROM jobs ${whereClause}
             ORDER BY COALESCE(refreshed_at, created_at) DESC, id DESC
             LIMIT $${paramCount} OFFSET $${paramCount + 1}`,
            [...params, parseInt(limit), offset]
        );

        res.json({ jobs: jobsRes.rows, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
    } catch (e) {
        console.error("Portal jobs error:", e.message);
        res.json({ jobs: [], total: 0 });
    }
});

app.patch('/api/portal-jobs/:id', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'database_unavailable' });
    const id = Number(req.params.id);
    const status = req.body.status ? normalizeJobStatus(req.body.status) : null;
    const notes = typeof req.body.notes === 'string' ? req.body.notes.slice(0, 5000) : null;
    const followUpAt = req.body.follow_up_at || null;
    const updates = [];
    const params = [];
    let c = 1;
    if (status) {
        updates.push(`status = $${c++}`);
        params.push(status);
        if (status === 'applied') updates.push(`applied_at = COALESCE(applied_at, NOW())`);
        if (status === 'archived') updates.push(`archived_at = NOW()`);
    }
    if (notes !== null) {
        updates.push(`notes = $${c++}`);
        params.push(notes);
    }
    if (followUpAt !== null) {
        updates.push(`follow_up_at = $${c++}`);
        params.push(followUpAt ? new Date(followUpAt).toISOString() : null);
    }
    if (!updates.length || !Number.isFinite(id)) return res.status(400).json({ error: 'no_updates' });
    params.push(id);
    try {
        const result = await pool.query(
            `UPDATE jobs SET ${updates.join(', ')} WHERE id = $${c}
             RETURNING id, title, company, url, source, location, pay, posted_date, status, notes, match_score, applied_at, follow_up_at, archived_at`,
            params
        );
        if (!result.rows.length) return res.status(404).json({ error: 'not_found' });
        res.json({ job: result.rows[0] });
    } catch (e) {
        console.error("Portal update error:", e.message);
        res.status(500).json({ error: 'update_failed' });
    }
});

app.delete('/api/portal-jobs/:id', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'database_unavailable' });
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' });
    try {
        await pool.query('DELETE FROM jobs WHERE id = $1', [id]);
        res.json({ deleted: true });
    } catch (e) {
        res.status(500).json({ error: 'delete_failed' });
    }
});

app.get('/api/portal-analytics', async (req, res) => {
    if (!pool) return res.json({ totals: {}, topCompanies: [], topSources: [], topLocations: [], keywords: [], funnel: [] });
    try {
        const jobsRes = await pool.query(
            `SELECT id, ${SQL_CLEAN('title')} AS title, ${SQL_CLEAN('company')} AS company, source, ${SQL_CLEAN('location')} AS location, pay, status, posted_date, created_at, refreshed_at, applied_at
             FROM jobs ORDER BY COALESCE(refreshed_at, created_at) DESC, id DESC LIMIT 2500`
        );
        const rows = jobsRes.rows;
        const countBy = (fn, limit = 12) => {
            const map = new Map();
            rows.forEach(row => {
                const key = fn(row) || 'Unknown';
                map.set(key, (map.get(key) || 0) + 1);
            });
            return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([label, count]) => ({ label, count }));
        };
        const keywordCounts = new Map();
        rows.forEach(row => {
            TECH_KEYWORDS.forEach(keyword => {
                if (`${row.title} ${row.source} ${row.company} ${row.location}`.toLowerCase().includes(keyword)) {
                    keywordCounts.set(keyword, (keywordCounts.get(keyword) || 0) + 1);
                }
            });
        });
        const statusCounts = countBy(row => normalizeJobStatus(row.status));
        const now = Date.now();
        const ageBucket = (row) => {
            const created = row.refreshed_at ? new Date(row.refreshed_at).getTime() : (row.created_at ? new Date(row.created_at).getTime() : now);
            const hours = (now - created) / (60 * 60 * 1000);
            if (hours <= 6) return 'last 6h';
            if (hours <= 24) return 'last 24h';
            if (hours <= 72) return 'last 3d';
            return 'older';
        };
        const activeCount = rows.filter(r => !['archived', 'rejected'].includes(normalizeJobStatus(r.status))).length;
        const appliedCount = rows.filter(r => ['applied', 'interview', 'offer'].includes(normalizeJobStatus(r.status))).length;
        const interviewCount = rows.filter(r => ['interview', 'offer'].includes(normalizeJobStatus(r.status))).length;
        const offerCount = rows.filter(r => normalizeJobStatus(r.status) === 'offer').length;
        res.json({
            totals: {
                jobs: rows.length,
                active: activeCount,
                applied: appliedCount,
                interviews: interviewCount,
                offers: offerCount,
                companies: new Set(rows.map(r => r.company).filter(Boolean)).size,
                sources: new Set(rows.map(r => r.source).filter(Boolean)).size,
                remote: rows.filter(r => classifyWorkMode(r.location) === 'remote').length,
                fresh24h: rows.filter(r => ageBucket(r) !== 'older' && ageBucket(r) !== 'last 3d').length,
            },
            conversion: {
                applyRate: rows.length ? Math.round((appliedCount / rows.length) * 100) : 0,
                interviewRate: appliedCount ? Math.round((interviewCount / appliedCount) * 100) : 0,
                offerRate: appliedCount ? Math.round((offerCount / appliedCount) * 100) : 0,
            },
            funnel: ['open', 'applied', 'interview', 'offer', 'rejected', 'archived'].map(label => ({
                label,
                count: statusCounts.find(item => item.label === label)?.count || 0,
            })),
            topCompanies: countBy(row => row.company),
            topSources: countBy(row => row.source),
            topLocations: countBy(row => row.location),
            workModes: countBy(row => classifyWorkMode(row.location)),
            seniority: countBy(row => classifySeniority(row.title)),
            roleFamilies: countBy(row => classifyRoleFamily(row.title)),
            freshness: countBy(ageBucket),
            topTitles: countBy(row => row.title, 15),
            sourceWorkMode: countBy(row => `${row.source || 'Source'} / ${classifyWorkMode(row.location)}`, 12),
            keywords: [...keywordCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([label, count]) => ({ label, count })),
        });
    } catch (e) {
        console.error("Analytics error:", e.message);
        res.status(500).json({ error: 'analytics_failed' });
    }
});

app.post('/api/portal-rank-resume', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'database_unavailable' });
    const resumeText = String(req.body.resumeText || '').slice(0, 20000);
    if (!resumeText.trim()) return res.status(400).json({ error: 'resume_required' });
    const limit = Math.min(Number(req.body.limit || 25), 100);
    try {
        const retrieved = await retrieveJobsForRag({ resumeText, question: req.body.goal || '', limit, sampleLimit: 1800 });
        const ranked = retrieved.jobs;
        for (const job of ranked.slice(0, 50)) {
            await pool.query('UPDATE jobs SET match_score = $1 WHERE id = $2', [job.match_score, job.id]);
        }
        const report = buildAgenticResumeReport(resumeText, retrieved);
        res.json({
            matches: ranked,
            report,
            reportMarkdown: formatAgenticReport(report, ranked),
            retrieval: {
                sampleSize: retrieved.sampleSize,
                analytics: retrieved.analytics,
            },
        });
    } catch (e) {
        console.error("Resume rank error:", e.message);
        res.status(500).json({ error: 'rank_failed' });
    }
});

app.post('/api/portal-agentic-rag', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'database_unavailable' });
    const resumeText = String(req.body.resumeText || '').slice(0, 20000);
    const question = String(req.body.question || req.body.goal || 'Find my strongest job matches and gaps.').slice(0, 1200);
    try {
        const retrieved = await retrieveJobsForRag({ resumeText, question, limit: 30, sampleLimit: 2000 });
        const report = buildAgenticResumeReport(resumeText, retrieved);
        const deterministic = question.trim()
            ? `${formatAgenticReport(report, retrieved.jobs)}\n\n${formatMarketAnswer(question, retrieved)}`
            : formatAgenticReport(report, retrieved.jobs);
        const prompt = `You are an Agentic RAG career coach. Use only the retrieved evidence. Improve the answer but do not invent companies or jobs.
Question: ${question}
Resume profile: ${JSON.stringify(report.profile)}
Retrieved jobs:
${retrieved.jobs.slice(0, 16).map(job => `- ${job.match_score}% ${job.title} @ ${job.company} (${job.location}) [${job.source}]`).join('\n')}
Deterministic draft:
${deterministic}
Return JSON: {"answer":"markdown answer","actions":["action"],"risks":["risk"]}`;
        const ai = coerceModelObject(await getAIInsight(prompt));
        res.json({
            answer: cleanModelText(ai?.answer) || deterministic,
            actions: ai?.actions || report.actions,
            risks: ai?.risks || [],
            matches: retrieved.jobs,
            report,
            retrieval: { sampleSize: retrieved.sampleSize, analytics: retrieved.analytics },
            provider: aiRuntime.lastProvider,
            model: aiRuntime.lastModel,
            fallback: !ai?.answer,
        });
    } catch (e) {
        console.error("Agentic RAG error:", e.message);
        res.status(500).json({ error: 'agentic_rag_failed' });
    }
});

app.post('/api/portal-ai-toolkit', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'database_unavailable' });
    const jobId = Number(req.body.jobId);
    const type = String(req.body.type || 'skill-gap');
    const resumeText = String(req.body.resumeText || '').slice(0, 12000);
    const allowed = new Set(['cover-letter', 'interview-prep', 'cold-message', 'skill-gap', 'resume-summary', 'recruiter-email']);
    if (!allowed.has(type) || !Number.isFinite(jobId)) return res.status(400).json({ error: 'bad_request' });
    try {
        const jobRes = await pool.query('SELECT * FROM jobs WHERE id = $1', [jobId]);
        if (!jobRes.rows.length) return res.status(404).json({ error: 'not_found' });
        const job = jobRes.rows[0];
        const retrieved = await retrieveJobsForRag({ resumeText, question: `${type} ${job.title} ${job.company}`, limit: 12, sampleLimit: 1200 });
        const report = buildAgenticResumeReport(resumeText, retrieved);
        const prompt = `You are an expert Agentic RAG career coach. Generate ${type} content for this job using only the resume, selected job, and retrieved evidence.
Resume:
${resumeText || 'No resume provided.'}

Job:
${buildJobPromptContext(job)}

Retrieved evidence:
${retrieved.jobs.slice(0, 10).map(item => `- ${item.match_score}% ${item.title} @ ${item.company} (${item.location})`).join('\n')}

Detected profile:
${JSON.stringify(report.profile)}

Return JSON: {"result":"markdown content"}`;
        const ai = coerceModelObject(await getAIInsight(prompt));
        res.json({
            result: cleanModelText(ai?.result || ai?.answer) || fallbackToolkitAgentic(type, job, resumeText, retrieved),
            provider: aiRuntime.lastProvider,
            model: aiRuntime.lastModel,
            fallback: !ai?.result,
            retrieval: { sampleSize: retrieved.sampleSize, evidence: retrieved.jobs.slice(0, 8), report },
        });
    } catch (e) {
        console.error("Toolkit error:", e.message);
        res.status(500).json({ error: 'toolkit_failed' });
    }
});

app.post('/api/portal-market-query', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'database_unavailable' });
    const question = String(req.body.question || '').slice(0, 1000);
    if (!question.trim()) return res.status(400).json({ error: 'question_required' });
    try {
        const retrieved = await retrieveJobsForRag({ question, resumeText: String(req.body.resumeText || ''), limit: 35, sampleLimit: 2200 });
        const context = retrieved.jobs.map(j => `- ${j.match_score}% ${j.title} @ ${j.company} (${j.location || 'Remote'}) ${j.pay || ''} [${j.source || 'source'}]`).join('\n');
        const deterministic = formatMarketAnswer(question, retrieved);
        const prompt = `Answer the user's job-market question using only this retrieved job database evidence.
Question: ${question}
Retrieved evidence:
${context}
Deterministic draft:
${deterministic}
Return JSON: {"answer":"concise markdown answer with evidence","supporting_companies":["company1","company2"],"signals":["signal"]}`;
        const ai = coerceModelObject(await getAIInsight(prompt));
        res.json({
            answer: cleanModelText(ai?.answer) || deterministic,
            supporting_companies: ai?.supporting_companies || [...new Set(retrieved.jobs.map(r => r.company).filter(Boolean))].slice(0, 12),
            signals: ai?.signals || retrieved.analytics.roleFamilies?.map(item => `${item.label}: ${item.count}`) || [],
            retrieval: { sampleSize: retrieved.sampleSize, analytics: retrieved.analytics, evidence: retrieved.jobs.slice(0, 12) },
            provider: aiRuntime.lastProvider,
            model: aiRuntime.lastModel,
            fallback: !ai?.answer,
        });
    } catch (e) {
        console.error("Market query error:", e.message);
        res.status(500).json({ error: 'market_query_failed' });
    }
});

app.get('/api/portal-export.csv', async (req, res) => {
    if (!pool) return res.status(503).send('database unavailable');
    try {
        const jobsRes = await pool.query(
            `SELECT id, title, company, location, pay, source, status, match_score, posted_date, applied_at, follow_up_at, notes, url
             FROM jobs ORDER BY id DESC LIMIT 5000`
        );
        const headers = ['id', 'title', 'company', 'location', 'pay', 'source', 'status', 'match_score', 'posted_date', 'applied_at', 'follow_up_at', 'notes', 'url'];
        const escapeCsv = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
        const csv = [headers.join(','), ...jobsRes.rows.map(row => headers.map(h => escapeCsv(row[h])).join(','))].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="smart-job-portal-export.csv"');
        res.send(csv);
    } catch (e) {
        res.status(500).send('export failed');
    }
});

app.get('/api/stats', (req, res) => res.json({ ...cache.stats, health: getServiceHealth() }));

// ═══════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════
const PORT = Number(process.env.PORT || 8000);
app.listen(PORT, async () => {
    console.log(`\n🚀 Smart News & Job Tracker Backend on port ${PORT}`);
    console.log(`📊 Job Sources: ${JOB_APIS.length} APIs + ${JOB_RSS_FEEDS.length} RSS + ${JOB_BOARD_SOURCES.length} boards = ${getTotalJobSources()} total`);
    console.log(`📰 News Sources: ${NEWS_RSS_FEEDS.length} RSS + ${HN_QUERIES.length} HN queries = ${NEWS_RSS_FEEDS.length + HN_QUERIES.length} total`);
    await ensureDBTables();
    await cleanupKnownJobNoise();
    refreshAllData(); // Trigger immediately on start
    setInterval(() => refreshAllData(), REFRESH_INTERVAL);
    setInterval(() => pruneDatabase(), DB_PURGE_INTERVAL);
    console.log(`⏱️  Auto-refresh: every 10 min | DB purge: every 3 hours`);
});
