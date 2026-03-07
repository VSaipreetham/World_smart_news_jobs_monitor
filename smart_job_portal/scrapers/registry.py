from .ats_scrapers import GreenhouseScraper, LeverScraper, AshbyScraper
from .base import BaseScraper
from .extra_scrapers import RemoteOKScraper, GoogleJobsScraper
from .linkedin_scraper import LinkedInScraper
from .naukri_scraper import NaukriScraper
from .api_scrapers import RemotiveScraper, HackerNewsScraper
import requests
from bs4 import BeautifulSoup
import datetime
from models import Job, JobStatus

# Configuration for Multi-Portal Scraping
TARGETS = [
    # --- GREENHOUSE ---
    {"type": "greenhouse", "id": "github"},
    {"type": "greenhouse", "id": "gitlab"},
    {"type": "greenhouse", "id": "twitch"},
    {"type": "greenhouse", "id": "pinterest"},
    {"type": "greenhouse", "id": "stripe"},
    {"type": "greenhouse", "id": "airbnb"},
    {"type": "greenhouse", "id": "dropbox"},
    {"type": "greenhouse", "id": "discord"},
    {"type": "greenhouse", "id": "canonical"},
    {"type": "greenhouse", "id": "doordash"}, 
    {"type": "greenhouse", "id": "uber"},     
    {"type": "greenhouse", "id": "lyft"},     
    {"type": "greenhouse", "id": "instacart"},
    {"type": "greenhouse", "id": "reddit"},   
    {"type": "greenhouse", "id": "grammarly"},
    {"type": "greenhouse", "id": "rubrik"},   
    {"type": "greenhouse", "id": "cruise"},   
    {"type": "greenhouse", "id": "block"},    
    {"type": "greenhouse", "id": "affirm"},   

    # --- LEVER ---
    {"type": "lever", "id": "netflix"},
    {"type": "lever", "id": "spotify"},
    {"type": "lever", "id": "atlassian"},
    {"type": "lever", "id": "palantir"},
    {"type": "lever", "id": "udemy"},
    {"type": "lever", "id": "figma"},
    {"type": "lever", "id": "plaid"},       
    {"type": "lever", "id": "notion"},      
    
    # --- ASHBY ---
    {"type": "ashby", "id": "linear"},
    {"type": "ashby", "id": "scale"},
]

class WWRScraper(BaseScraper):

    def scrape(self):
        print("Scraping We Work Remotely...")
        try:
            url = "https://weworkremotely.com/categories/remote-back-end-programming-jobs"
            resp = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
            soup = BeautifulSoup(resp.content, 'html.parser')
            
            nodes = soup.select('section.jobs li a')
            for node in nodes:
                if 'view-all' in node.get('class', []): continue
                
                title_tag = node.find(class_='title')
                company_tag = node.find(class_='company')
                region_tag = node.find(class_='region')
                
                if not title_tag or not company_tag: continue
                
                title = title_tag.get_text(strip=True)
                company = company_tag.get_text(strip=True)
                # Region is usually location
                location = region_tag.get_text(strip=True) if region_tag else "Remote"
                
                href = node['href']
                full_url = f"https://weworkremotely.com{href}"
                
                self.save_job(title, company, full_url, "WeWorkRemotely", location=location)
            
            self.session.commit()
        except Exception as e:
            print(f"Error scraping WWR: {e}")

from models import Session # Import Session factory
import concurrent.futures

def scrape_wrapper(scraper_class, *args):
    """Helper to run a scraper in its own DB session"""
    session = Session()
    try:
        scraper = scraper_class(session, *args)
        scraper.scrape()
        # Safety commit: In case the scraper forgot to commit, we do it here.
        # If it already committed, this is a no-op or harmless.
        session.commit()
    except Exception as e:
        print(f"Error in {scraper_class.__name__}: {e}")
        session.rollback()
    finally:
        session.close()

def run_all_scrapers(legacy_session_ignored=None, progress_callback=None, cancel_event=None):
    """
    Runs all scrapers in parallel. 
    Ignores the passed session (if any) to enforce thread-safety with new sessions.
    progress_callback: function(float) -> None. Receives 0.0 to 1.0 progress.
    cancel_event: threading.Event. If set, stops the process.
    """
    total_tasks = 7 + len(TARGETS) # 7 standard + N targets
    print(f"Starting parallel scrape with ~{total_tasks} workers...")
    
    # We use a large thread pool to run almost everything at once
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        futures = []
        
        # 1. Standard Boards
        futures.append(executor.submit(scrape_wrapper, LinkedInScraper))
        futures.append(executor.submit(scrape_wrapper, NaukriScraper))
        futures.append(executor.submit(scrape_wrapper, RemotiveScraper))
        futures.append(executor.submit(scrape_wrapper, HackerNewsScraper))
        futures.append(executor.submit(scrape_wrapper, WWRScraper))
        futures.append(executor.submit(scrape_wrapper, RemoteOKScraper))
        futures.append(executor.submit(scrape_wrapper, GoogleJobsScraper))
        
        # 2. ATS Targets
        for t in TARGETS:
            if t['type'] == 'greenhouse':
                futures.append(executor.submit(scrape_wrapper, GreenhouseScraper, t['id']))
            elif t['type'] == 'lever':
                futures.append(executor.submit(scrape_wrapper, LeverScraper, t['id']))
            elif t['type'] == 'ashby':
                futures.append(executor.submit(scrape_wrapper, AshbyScraper, t['id']))
        
        # Track progress
        completed_count = 0
        
        # Iterate as they complete
        try:
            for future in concurrent.futures.as_completed(futures):
                # CHECK CANCELLATION
                if cancel_event and cancel_event.is_set():
                    print("Scrape Cancelled by User.")
                    executor.shutdown(wait=False, cancel_futures=True)
                    return # Exit immediately

                completed_count += 1
                if progress_callback:
                    progress = min(1.0, completed_count / total_tasks)
                    try:
                        progress_callback(progress)
                    except Exception:
                        pass # Ignore UI errors
        except Exception as e:
            print(f"Error in scraping loop: {e}")
        
        print("All parallel scrapers finished.")

