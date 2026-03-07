import os
import requests
import feedparser
import datetime
from sqlalchemy.orm import Session
from .db import DataNode, SessionLocal
import random
import time

# Robust Geocoding memory to prevent repeating the same hits
GEO_CACHE = {}

# Fallback land coordinates (major tech hubs globally) to avoid ocean points
LAND_FALLBACKS = [
    (37.7749, -122.4194), # SF
    (40.7128, -74.0060),  # NY
    (51.5074, -0.1278),   # London
    (12.9716, 77.5946),   # Bengaluru
    (35.6895, 139.6917),  # Tokyo
    (32.0853, 34.7818),   # Tel Aviv
    (52.5200, 13.4050),   # Berlin
    (48.8566, 2.3522),    # Paris
    (43.6510, -79.3470),  # Toronto
    (1.3521, 103.8198),   # Singapore
]

def geocode(location_name: str):
    if not location_name or location_name.lower() in ['remote', 'anywhere', 'worldwide', 'global']:
        return random.choice(LAND_FALLBACKS)
        
    if location_name in GEO_CACHE:
        return GEO_CACHE[location_name]
        
    try:
        url = f"https://nominatim.openstreetmap.org/search?q={location_name}&format=json&limit=1"
        resp = requests.get(url, headers={'User-Agent': 'WorldMonitorApp/2.0'}, timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            if data and len(data) > 0:
                coords = (float(data[0]["lat"]), float(data[0]["lon"]))
                GEO_CACHE[location_name] = coords
                time.sleep(1) # respect API limits
                return coords
    except Exception as e:
        print(f"Geocoding failed for {location_name}: {e}")
        
    return random.choice(LAND_FALLBACKS)

def sync_live_jobs():
    """Scrapes open sourced APIs (Remotive) and stores into Database"""
    db: Session = SessionLocal()
    try:
        url = "https://remotive.com/api/remote-jobs?category=software-dev&limit=40"
        resp = requests.get(url, timeout=10)
        jobs_data = resp.json().get('jobs', [])
        
        for job in jobs_data:
            # Check if exists
            exists = db.query(DataNode).filter_by(url=job.get('url')).first()
            if exists:
                continue
                
            loc_str = job.get('candidate_required_location', 'Remote')
            lat, lng = geocode(loc_str)
            
            node = DataNode(
                node_type='job',
                title=job.get('title', 'Software Engineer'),
                company_or_source=job.get('company_name', 'Tech Corp'),
                location_name=loc_str,
                lat=lat + (random.random() - 0.5) * 1.5, # Small cluster dispersion
                lng=lng + (random.random() - 0.5) * 1.5,
                url=job.get('url')
            )
            db.add(node)
        db.commit()
    except Exception as e:
        print("Scrape Jobs Error:", e)
    finally:
        db.close()

def sync_live_news():
    """Scrapes Global RSS Feeds for real-time geopolitical & tech news"""
    db: Session = SessionLocal()
    feeds = [
        "https://techcrunch.com/feed/",
        "http://feeds.bbci.co.uk/news/technology/rss.xml",
        "https://www.theverge.com/rss/index.xml",
        "https://feeds.a.dj.com/rss/RSSWorldNews.xml"
    ]
    try:
        for url in feeds:
            d = feedparser.parse(url)
            for entry in d.entries[:10]:
                link = entry.link
                exists = db.query(DataNode).filter_by(url=link).first()
                if exists:
                    continue
                
                # Assign to major infrastructure hubs randomly for news impact viz
                lat, lng = random.choice(LAND_FALLBACKS)
                
                node = DataNode(
                    node_type='news',
                    title=entry.title,
                    company_or_source=d.feed.title if hasattr(d.feed, 'title') else "News Feed",
                    location_name="Global Wire",
                    lat=lat + (random.random() - 0.5) * 8.0,
                    lng=lng + (random.random() - 0.5) * 8.0,
                    url=link
                )
                db.add(node)
        db.commit()
    except Exception as e:
        print("Scrape News Error:", e)
    finally:
        db.close()
