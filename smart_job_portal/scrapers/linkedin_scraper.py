from .base import BaseScraper
import requests
from bs4 import BeautifulSoup
import time
from random import choice, uniform

USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:90.0) Gecko/20100101 Firefox/90.0'
]

class LinkedInScraper(BaseScraper):
    def scrape(self):
        print("Scraping LinkedIn (Guest Mode)...")
        # Added "India" to locations to satisfy user request for Indian results
        searches = [
            {"keywords": "genai engineer", "location": "India"},
            {"keywords": "automation engineer", "location": "India"},
            {"keywords": "SDE", "location": "India"},
            {"keywords": "python developer", "location": "India"},
            {"keywords": "frontend developer", "location": "India"},
            {"keywords": "fullstack engineer", "location": "India"},
            {"keywords": "fullstack engineer", "location": "Remote"},
            {"keywords": "backend engineer", "location": "India"},
            {"keywords": "backend engineer", "location": "Remote"},
            {"keywords": "software engineer", "location": "Remote"},
            {"keywords": "data engineer", "location": "Remote"},
            {"keywords": "data scientist", "location": "Remote"},
            {"keywords": "machine learning engineer", "location": "Remote"},
            {"keywords": "machine learning engineer", "location": "India"},
            {"keywords": "deep learning engineer", "location": "Remote"},
            {"keywords": "deep learning engineer", "location": "India"},
            {"keywords": "data analyst", "location": "Remote"},
            {"keywords":  "cloud" ,"location": "Remote"},
            {"keywords":  "cloud" ,"location": "India"},
            {"keywords":  "GenAI" ,"location": "Remote"},
            {"keywords":  "GenAI" ,"location": "India"},

        ]
        
        for s in searches:
            k = s['keywords']
            loc = s['location']
            try:
                # LinkedIn 'Guest' API for job search
                # We can fetch the first page of results (approx 25 jobs) without login
                
                # Using a fresh User-Agent
                headers = {
                    'User-Agent': choice(USER_AGENTS),
                    'Accept-Language': 'en-US,en;q=0.9',
                }
                
                # Added &f_TPR=r86400 to filter for "Last 24 Hours" only. This prevents stale/repeat jobs.
                url = f"https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords={k}&location={loc}&f_TPR=r86400"
                print(f"DEBUG: Fetching LinkedIn URL: {url}")
                
                response = requests.get(url, headers=headers, timeout=10)
                
                if response.status_code != 200:
                    print(f"  [-] LinkedIn blocked/failed for '{k}' (Status: {response.status_code})")
                    # Fallback or retry could go here
                    continue
                    
                soup = BeautifulSoup(response.content, 'html.parser')
                job_cards = soup.find_all("li")
                
                if not job_cards:
                     # Sometimes it returns <li> directly, sometimes inside <ul>
                     # Debug what we got
                     print(f"  [-] No job cards found for '{k}'. Response length: {len(response.content)}")
                     continue
                     
                print(f"  [+] Found {len(job_cards)} LinkedIn jobs for '{k}'")
                
                for card in job_cards:
                    try:
                        # Extract Title
                        title_tag = card.find("h3", class_="base-search-card__title")
                        title = title_tag.text.strip() if title_tag else "Unknown Role"
                        
                        # Extract Company
                        company_tag = card.find("h4", class_="base-search-card__subtitle")
                        company = company_tag.text.strip() if company_tag else "Unknown Company"
                        
                        # Extract Location
                        loc_tag = card.find("span", class_="job-search-card__location")
                        location = loc_tag.text.strip() if loc_tag else "Remote"
                        
                        # Extract URL
                        link_tag = card.find("a", class_="base-card__full-link")
                        url = link_tag['href'] if link_tag else None
                        
                        if url:
                            # Clean URL (remove tracking params)
                            if "?" in url:
                                url = url.split("?")[0]
                                
                            self.save_job(
                                title=title, 
                                company=company, 
                                url=url, 
                                source="LinkedIn", 
                                location=location, 
                                pay="See Listing" # LinkedIn hides pay in detail view usually
                            )
                        else:
                            print(f"DEBUG: Job card for {title} had no URL.")
                            
                    except Exception as e:
                        print(f"DEBUG: Parsing error on card: {e}")
                        continue
                
                # Sleep briefly to be nice
                time.sleep(uniform(2.0, 5.0))
                
            except Exception as e:
                print(f"Error scraping LinkedIn for {k}: {e}")
        
        # Commit all found jobs
        try:
            self.session.commit()
            print("LinkedIn jobs committed to DB.")
        except Exception as e:
            print(f"Error committing LinkedIn jobs: {e}")
            self.session.rollback()

