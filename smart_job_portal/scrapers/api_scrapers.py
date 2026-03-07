from .base import BaseScraper
import requests
import datetime
import time 
from random import uniform

class RemotiveScraper(BaseScraper):
    def scrape(self):
        print("Scraping Remotive...")
        categories = ['software-dev', 'data']
        for cat in categories:
            try:
                url = f"https://remotive.com/api/remote-jobs?category={cat}"
                resp = requests.get(url, timeout=20)
                data = resp.json()
                jobs = data.get('jobs', [])
                
                # Limit to recent 30 per cat to avoid hammering DB
                for j in jobs[:30]:
                    title = j.get('title')
                    company = j.get('company_name')
                    url = j.get('url')
                    location = j.get('candidate_required_location', 'Remote') 
                    pay = j.get('salary', 'N/A')
                    publication_date = j.get('publication_date') # ISO timestamp
                    
                    posted_date = datetime.datetime.utcnow()
                    
                    self.save_job(title, company, url, "Remotive", location=location, pay=pay, posted_date=posted_date)
                    
            except Exception as e:
                print(f"Error Remotive ({cat}): {e}")

class HackerNewsScraper(BaseScraper):
    def scrape(self):
        print("Scraping Hacker News (Who is Hiring)...")
        # 1. Find the latest "Who is hiring" thread via Algolia or Firebase
        # Shortcut: Use Algolia search API for "who is hiring"
        try:
            search_url = "http://hn.algolia.com/api/v1/search_by_date?query=who%20is%20hiring&tags=story"
            resp = requests.get(search_url, timeout=20)
            hits = resp.json().get('hits', [])
            
            if not hits: return
            
            latest_id = hits[0]['objectID']
            
            # 2. Get comments (jobs)
            # This can be huge, so we just take the top 20 recent comments for demo
            item_url = f"https://hacker-news.firebaseio.com/v0/item/{latest_id}.json"
            item_resp = requests.get(item_url, timeout=20).json()
            kids = item_resp.get('kids', [])
            
            # Process first 30 comments
            for kid_id in kids[:30]:
                try:
                    comment_url = f"https://hacker-news.firebaseio.com/v0/item/{kid_id}.json"
                    c = requests.get(comment_url, timeout=10).json()
                    
                    if not c or 'text' not in c or c.get('deleted'): continue
                    
                    text = c.get('text', '')
                    # Heuristic parsing: First line is usually "Company | Role | Location"
                    # We will just take the first 50 chars as title for now or "HN Job"
                    
                    # Very rough parsing
                    lines = text.split('<p>')
                    header = lines[0].replace('&#x2F;', '/').replace('&amp;', '&')
                    
                    # Create a direct link to the comment
                    hn_link = f"https://news.ycombinator.com/item?id={kid_id}"
                    
                    self.save_job(
                        title=f"Role at {header[:30]}...", 
                        company="HackerNews Startup", 
                        url=hn_link, 
                        source="HackerNews", 
                        location="See Thread", 
                        pay="N/A"
                    )
                    time.sleep(0.1)
                except:
                    pass
                    
        except Exception as e:
            print(f"Error HackerNews: {e}")
