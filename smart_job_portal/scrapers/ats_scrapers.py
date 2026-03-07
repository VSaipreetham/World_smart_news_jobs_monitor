import requests
from .base import BaseScraper
import datetime

class GreenhouseScraper(BaseScraper):
    def __init__(self, session, company_token):
        super().__init__(session)
        self.company_token = company_token
        self.api_url = f"https://boards-api.greenhouse.io/v1/boards/{company_token}/jobs"

    def scrape(self):
        print(f"Scraping Greenhouse: {self.company_token}...")
        try:
            # Add User-Agent to avoid blocking
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
            resp = requests.get(f"{self.api_url}?content=true", headers=headers, timeout=20)
            if resp.status_code != 200:
                print(f"  [-] Failed to fetch {self.company_token} (Status: {resp.status_code})")
                return

            data = resp.json()
            jobs = data.get('jobs', [])
            
            for j in jobs:
                title = j.get('title')
                url = j.get('absolute_url')
                company = self.company_token.capitalize()
                
                # Extract Location
                loc = j.get('location', {}).get('name')
                if loc is None:
                    loc = "Remote"
                elif isinstance(loc, dict):
                     # Some GH boards return weird location objects
                     loc = loc.get('text') or "Remote"
                
                # Check updated_at
                posted_date = datetime.datetime.utcnow()
                
                # Pay is usually hidden in metadata or description, very unstructured in GH API free tier
                # Metadata might have it
                pay = "N/A"
                if j.get('metadata'):
                    for m in j.get('metadata'):
                        if 'salary' in m.get('name', '').lower() or 'pay' in m.get('name', '').lower():
                            if m.get('value'):
                                pay = str(m.get('value')) # Ensure string
                            break

                self.save_job(title, company, url, f"Greenhouse-{self.company_token}", location=str(loc), pay=str(pay), posted_date=posted_date)
            
            self.session.commit()
            
        except Exception as e:
            print(f"Error scraping greenhouse {self.company_token}: {e}")

class LeverScraper(BaseScraper):
    def __init__(self, session, company_name):
        super().__init__(session)
        self.company_name = company_name
        self.api_url = f"https://api.lever.co/v0/postings/{company_name}?mode=json"

    def scrape(self):
        print(f"Scraping Lever: {self.company_name}...")
        try:
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
            resp = requests.get(self.api_url, headers=headers, timeout=20)
            if resp.status_code != 200:
                print(f"  [-] Failed to fetch {self.company_name} (Status: {resp.status_code})")
                return

            jobs = resp.json()
            
            for j in jobs:
                title = j.get('text')
                url = j.get('hostedUrl')
                company = self.company_name.capitalize()
                created_at = j.get('createdAt')
                
                posted_date = datetime.datetime.utcnow()
                if created_at:
                    posted_date = datetime.datetime.fromtimestamp(created_at / 1000.0)

                # Location
                loc = j.get('categories', {}).get('location')
                
                # Pay - Lever puts it in "salaryRange" sometimes
                pay = "N/A"
                salary = j.get('salaryRange')
                if salary:
                    min_s = salary.get('min')
                    max_s = salary.get('max')
                    currency = salary.get('currency', '')
                    if min_s and max_s:
                        pay = f"{min_s}-{max_s} {currency}"
                
                self.save_job(title, company, url, f"Lever-{self.company_name}", location=loc, pay=pay, posted_date=posted_date)

            self.session.commit()

        except Exception as e:
            print(f"Error scraping lever {self.company_name}: {e}")

class AshbyScraper(BaseScraper):
    def __init__(self, session, company_token):
        super().__init__(session)
        self.company_token = company_token
        self.api_url = f"https://api.ashbyhq.com/posting-api/job-board/{company_token}"

    def scrape(self):
        print(f"Scraping Ashby: {self.company_token}...")
        try:
            # Ashby requires a POST request
            headers = {
                'User-Agent': 'Mozilla/5.0'
            }
            body = {"includes": "location,team,department"}
            
            resp = requests.post(self.api_url, json=body, headers=headers, timeout=20)
            if resp.status_code != 200:
                print(f"  [-] Failed to fetch {self.company_token} (Status: {resp.status_code})")
                return

            jobs = resp.json().get('jobs', [])
            
            for j in jobs:
                title = j.get('title')
                url = j.get('jobUrl')
                company = self.company_token.capitalize()
                loc = j.get('location') or "Remote"
                
                # Try to parse published date if available (Ashby format usually ISO)
                # Example: "2023-10-05T12:00:00.000Z"
                posted_date = datetime.datetime.now() 
                if j.get('publishedAt'):
                    try:
                        # Simple truncation for ISO format if needed
                        d_str = j.get('publishedAt').split('.')[0]
                        posted_date = datetime.datetime.strptime(d_str, "%Y-%m-%dT%H:%M:%S")
                    except:
                        pass
                
                self.save_job(title, company, url, f"Ashby-{self.company_token}", location=loc, posted_date=posted_date)
            
            self.session.commit()
            
        except Exception as e:
            print(f"Error scraping Ashby {self.company_token}: {e}")
