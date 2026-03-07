# Instructions

## Overview
This repository contains the "World Smart News & Jobs Monitoring" application. A sophisticated, real-time 3D dashboard combining AI-powered news aggregation and job market intelligence into a single unified situational awareness interface.

## Architecture
1. **Frontend**: Vite + React + Vanilla CSS + react-globe.gl + framer-motion
2. **Backend**: FastAPI (Python) with integration to Neon PostgreSQL Database, OpenAI/Gemini/Ollama based AI Summarization.
3. **Data Pipeline**: Python-based scraper jobs, news RSS aggregation, caching, and embeddings generation.

## Setup Instructions

### Environment
1. Requires Node v18+ and Python 3.10+.

### Frontend
```bash
cd frontend
npm install
npm run dev
```

### Backend
```bash
cd backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload
```

## Security & Deployment
* **Vercel** for optimal frontend static hosting.
* **Railway** or AWS App Runner for Python FastAPI.
* **Neon DB** for connection pooling and Serverless usage.
