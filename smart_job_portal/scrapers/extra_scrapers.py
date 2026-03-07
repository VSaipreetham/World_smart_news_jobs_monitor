from .base import BaseScraper
import requests
from bs4 import BeautifulSoup
import datetime
import urllib.parse
from random import choice

USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36'
]

class GoogleJobsScraper(BaseScraper):
    """
    Experimental "Google Jobs" Scraper.
    Direct scraping of Google Jobs is notoriously hard due to dynamic classes and strict bots.
    This is a "Lite" version scraping the search result snippet if possible.
    """
    def scrape(self):
        print("Scraping Google Jobs (Experimental)...")
        # Queries for google
        queries = ["software engineer jobs remote", "python developer jobs remote"]
        
        for q in queries:
            try:
                # We use the search endpoint. 
                # Note: Real "Google Jobs" UI (ibp=htl) content is often hidden/obfuscated for basic search.
                # We will try to find standard organic results from aggregating sites like LinkedIn/Naukri 
                # that appear in Google Results.
                
                url = f"https://www.google.com/search?q={urllib.parse.quote(q)}&ibp=htl;jobs"
                headers = {'User-Agent': choice(USER_AGENTS)}
                
                resp = requests.get(url, headers=headers)
                soup = BeautifulSoup(resp.content, 'html.parser')
                
                # Google Jobs listing often uses these classes (might change)
                # Look for 'iFjolb' (list item) or similar. 
                # This is highly volatile.
                
                # Fallback: Scrape the 'generic' organic results for aggregator links
                for g in soup.find_all('div', class_='g'):
                    anchors = g.find_all('a')
                    if anchors:
                        link = anchors[0]['href']
                        title = anchors[0].h3.text if anchors[0].h3 else "Unknown Job"
                        snippet = g.find('div', style='-webkit-line-clamp:2')
                        snippet_text = snippet.text if snippet else ""
                        
                        # Only save if it looks like a job
                        if "linkedin.com/jobs" in link or "naukri.com" in link:
                            # We found a link to a portal!
                            company_guess = "Aggregator"
                            if "linkedin" in link: company_guess = "LinkedIn"
                            if "naukri" in link: company_guess = "Naukri"
                            
                            self.save_job(
                                title=title,
                                company=company_guess,
                                url=link,
                                source=f"GoogleSearch-{company_guess}",
                                location="See Link",
                                pay="N/A"
                            )
            except Exception as e:
                print(f"Error scraping Google for {q}: {e}")
                
class RemoteOKScraper(BaseScraper):
    # RemoteOK is friendly and has an API/RSS
    def scrape(self):
        print("Scraping RemoteOK...")
        try:
            resp = requests.get("https://remoteok.com/api", headers={'User-Agent': choice(USER_AGENTS)})
            if resp.status_code == 200:
                jobs = resp.json()
                # First item is legal text usually, skip it
                for j in jobs[1:]:
                    title = j.get('position')
                    company = j.get('company')
                    url = j.get('url')
                    date_str = j.get('date') # ISO string
                    location = j.get('location', '')
                    tags = j.get('tags', [])
                    
                    # pay is usually not explicit in API but sometimes in description
                    
                    # Filter for dev jobs
                    if 'dev' in tags or 'engineer' in tags or 'python' in title.lower():
                         self.save_job(
                            title=title,
                            company=company,
                            url=url,
                            source="RemoteOK",
                            location=location,
                            pay="N/A"
                        )
        except Exception as e:
            print(f"Error RemoteOK: {e}")

