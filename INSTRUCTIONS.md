# Smart News and Job Tracker - System Documentation

## 📌 Architecture Overview
This application is a **Global Intelligence & Jobs Engine** that tracks real-time jobs, tech news, AI research, and YouTube streams from **1200+ sources worldwide**.

### Components:
- **Frontend (React + Vite):** 3D Globe visualization using `react-globe.gl` with real-time data points
- **Backend (Node.js/Express):** Scraping engine on port `8000` with 10-minute auto-refresh
- **Smart Job Portal (Streamlit):** Full-featured job CRM with AI career coaching
- **Database (Neon PostgreSQL):** Cloud database with 3-hour auto-purge cycle

## 📊 Data Sources

### Jobs (200+ Sources)
- **APIs:** Remotive (7 categories), TheMuse (6 categories), HackerNews Jobs
- **RSS Feeds:** WeWorkRemotely, RemoteOK, Jobicy, AuthenticJobs, Dribbble Jobs, crypto.jobs, Web3 Career, USAJobs, Arbeitnow, TechnoJobs, Naukri, SEEK, Jobberman, Computrabajo, Torre, and 50+ more worldwide
- **Regions:** North America, Europe, Asia, Africa, Middle East, Latin America, Oceania

### News (1000+ Sources)
- **Tier 1 (50):** TechCrunch, The Verge, Ars Technica, Wired, BBC Tech, Reuters Tech, CNET, ZDNet, Engadget, Mashable
- **Tier 2 (100+):** MIT AI Blog, Google AI, OpenAI, NVIDIA, Meta AI, DeepMind, HuggingFace, Anthropic, Stability AI
- **Tier 3 (18):** ArXiv feeds (cs.AI, cs.LG, cs.CL, cs.CV, cs.NE, cs.RO, cs.CR, cs.SE, stat.ML)
- **Tier 4 (50+):** Dev.to, CSS-Tricks, GitHub Blog, Docker Blog, Kubernetes, Cloud blogs (AWS, GCP, Azure)
- **Tier 5 (20+):** Crunchbase, PitchBook, YC News, ProductHunt, a16z, Sequoia
- **Tier 6 (15):** Nature, Science, PhysOrg, Quanta Magazine, IEEE Spectrum
- **Tier 7-12:** Cybersecurity, Blockchain, Regional Tech, Gaming, Data, Space/Robotics

## 🧠 AI Multi-Model Fallback Matrix
1. **Gemini 2.0 Flash** (Primary)
2. **Gemini 1.5 Flash** (Fallback #1)
3. **Gemini 2.5 Flash Preview** (Fallback #2)
4. **OpenRouter Qwen3 235B** (Fallback #3)
5. **OpenRouter GPT-4o-mini** (Final fallback)

## 🔄 Auto-Refresh Cycles
- **10-minute cycle:** Backend scrapes all sources, refreshes cache, frontend re-fetches
- **3-hour cycle:** Database purge (TRUNCATE all tables) to prevent unbounded growth
- **Immediate refresh:** After every purge, data is scraped fresh

## 🗄️ Database Schema (Neon PostgreSQL)
```sql
-- Jobs table
CREATE TABLE jobs (
    id SERIAL PRIMARY KEY,
    title TEXT, company TEXT, url TEXT UNIQUE,
    source TEXT, location TEXT, pay TEXT,
    posted_date TEXT, status TEXT DEFAULT 'open',
    created_at TIMESTAMP DEFAULT NOW()
);

-- News table
CREATE TABLE news (
    id SERIAL PRIMARY KEY,
    headline TEXT, source TEXT, url TEXT UNIQUE,
    category TEXT, snippet TEXT, published_date TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- YouTube videos table
CREATE TABLE youtube_videos (
    id SERIAL PRIMARY KEY,
    title TEXT, video_id TEXT UNIQUE,
    channel TEXT, published TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
```

## 🚀 How to Run

### 1. Backend Server
```bash
cd backend_node
npm install
node server.js
```

### 2. Frontend React Client
```bash
cd frontend
npm install
npm run dev
```

### 3. Smart Job Portal (Optional)
```bash
cd smart_job_portal
pip install -r requirements.txt
streamlit run app.py
```

## 🔑 Environment Variables Required (.env)
```
Google_token=<Gemini API Key>
DATABASE_URL=<Neon PostgreSQL Connection String>
Qwen3_80b_token=<OpenRouter API Key>
gpt-oss-120b_token=<OpenRouter API Key>
```

## 📡 API Endpoints
| Endpoint | Description |
|----------|-------------|
| `GET /api/dashboard-data` | Returns all scraped jobs + news with geo coords |
| `GET /api/latest-trends` | Returns trending articles from 15+ top sources |
| `GET /api/ai-insights` | AI-generated summaries + YouTube videos |
| `GET /api/company-intel?company=X` | AI-generated company branch locations |
| `GET /api/stats` | Source counts and scraping statistics |
