import asyncio
from fastapi import FastAPI, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from typing import Dict, Any

from db import SessionLocal, DataNode
from scrapers import sync_live_jobs, sync_live_news
from ai_service import generate_insights_and_videos

app = FastAPI(title="World Monitor V2 Live Production Backend")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.on_event("startup")
async def start_background_scrapers():
    """Immediately fire real scrapers when the server boots"""
    sync_live_news()
    sync_live_jobs()

@app.get("/api/dashboard-data")
async def get_dashboard_data():
    db = SessionLocal()
    try:
        # Pull latest 100 rows directly from Postgres/SQLite 
        nodes = db.query(DataNode).order_by(DataNode.timestamp.desc()).limit(150).all()
        data = []
        for n in nodes:
            remote = "remote" in (n.location_name or "").lower() or "anywhere" in (n.location_name or "").lower()
            data.append({
                "id": str(n.id),
                "type": n.node_type,
                "lat": n.lat,
                "lng": n.lng,
                "company": n.company_or_source if n.node_type == 'job' else None,
                "headline": n.title if n.node_type == 'news' else None,
                "source": n.company_or_source if n.node_type == 'news' else None,
                "title": n.title if n.node_type == 'job' else None,
                "location": n.location_name,
                "url": n.url,
                "isRemote": remote,
                "time": n.timestamp.strftime("%H:%M") if n.timestamp else "Recent",
                "size": 0.4 if n.node_type == 'job' else None,
                "color": "#00e676" if n.node_type == 'job' else "#ff3333",
                "radius": 4.5 if n.node_type == 'news' else None,
            })
        return {"data": data}
    finally:
        db.close()

@app.get("/api/ai-insights")
def get_ai_insights():
    db = SessionLocal()
    try:
        # Separate latest nodes by type
        nodes = db.query(DataNode).order_by(DataNode.timestamp.desc()).limit(30).all()
        headlines = [n.title for n in nodes if n.node_type == 'news']
        jobs = [{"company_or_source": n.company_or_source, "title": n.title} for n in nodes if n.node_type == 'job']
        
        # Analyze directly with Gemini inside the AI module
        insight_json = generate_insights_and_videos(headlines, jobs)
        return insight_json
    finally:
        db.close()
