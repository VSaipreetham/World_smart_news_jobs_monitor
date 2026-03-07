# 🌐 Smart News and Job Tracker

> Real-time global intelligence dashboard tracking **200+ job sources** and **1000+ news sources** worldwide with AI-powered insights, 3D globe visualization, and automated database management.

## ✨ Features

- 🌍 **3D Globe Visualization** — Live job postings (green) and news events (red) plotted on an interactive globe
- 📡 **1200+ Data Sources** — RSS feeds, APIs, and web scrapers from every continent
- 🧠 **AI Multi-Model Fallback** — Gemini 2.0/1.5/2.5 → OpenRouter Qwen3 → GPT-4o-mini
- 🔄 **10-Minute Auto-Refresh** — Both backend and frontend auto-update
- 🗑️ **3-Hour Database Purge** — Automated cleanup to prevent unbounded growth
- 🎥 **Live YouTube Streams** — AI-curated trending tech videos
- 📊 **Trending Analysis** — Tech, AI, and research paper trends
- 🏢 **Deep Company Intel** — AI-powered corporate branch mapping
- 💼 **Smart Job Portal** — Full CRM with application tracking, AI career coaching

## 🚀 Quick Start

```bash
# 1. Start Backend
cd backend_node && npm install && node server.js

# 2. Start Frontend
cd frontend && npm install && npm run dev

# 3. (Optional) Start Smart Job Portal
cd smart_job_portal && pip install -r requirements.txt && streamlit run app.py
```

## 📦 Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, Vite 7, react-globe.gl, Framer Motion |
| Backend | Node.js, Express 5, RSS Parser, yt-search |
| AI | Google Gemini, OpenRouter (Qwen3, GPT-4o) |
| Database | Neon PostgreSQL (Cloud) |
| Job Portal | Streamlit, SQLAlchemy, Pandas |

## 📄 License
MIT
