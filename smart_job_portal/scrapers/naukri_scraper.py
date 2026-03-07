from .base import BaseScraper
import requests
import json

class NaukriScraper(BaseScraper):
    def scrape(self):
        print("Scraping Naukri (Experimental API)...")
        # Naukri's internal API is protected, but sometimes accessible with correct headers.
        # We try to search for "Python"
        
        # Naukri requires very specific headers to look like a browser
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'appid': '109',
            'systemid': '109',
            'Client-Id': 'd3skt0p',
            'Content-Type': 'application/json',
            'Referer': 'https://www.naukri.com/'
        }
        
        # Try multiple keywords
        keywords = ['python', 'backend', 'frontend', 'react', 'fullstack', 'genai', 'machine learning', 'data scientist']
        
        for k in keywords:
            # Enhanced URL signature
            url = f"https://www.naukri.com/jobapi/v3/search?noOfResults=20&urlType=search_by_keyword&searchType=adv&keyword={k}&pageNo=1&seoKey={k}-jobs&src=jobsearchDesk"
            print(f"DEBUG: Fetching Naukri: {url}")
            
            try:
                resp = requests.get(url, headers=headers, timeout=20)
                if resp.status_code == 200:
                    try:
                        data = resp.json()
                        if 'jobDetails' in data:
                            print(f"  [+] Found {len(data['jobDetails'])} Naukri jobs for {k}")
                            for j in data['jobDetails']:
                                title = j.get('title')
                                company = j.get('companyName')
                                job_id = j.get('jobId')
                                
                                # Construct URL
                                url_slug = j.get('jdURL') 
                                full_url = f"https://www.naukri.com{url_slug}" if url_slug else f"https://www.naukri.com/job-listings-{job_id}"
                                
                                locs = [x.get('label') for x in j.get('placeholders', []) if x.get('type') == 'location']
                                location = ", ".join(locs) if locs else "India"
                                
                                pay = j.get('salary', 'N/A')
                                
                                self.save_job(title, company, full_url, "Naukri", location=location, pay=pay)
                        else:
                            print("  [-] Naukri JSON valid but no 'jobDetails'. Anti-bot active.")
                    except json.JSONDecodeError:
                         print("  [-] Naukri returned non-JSON response.")
                else:
                    print(f"  [-] Naukri API blocked : {resp.status_code}")
                    
            except Exception as e:
                print(f"Error scraping Naukri for {k}: {e}")
        
        # Commit results
        try:
            self.session.commit()
            print("Naukri jobs committed to DB.")
        except Exception as e:
            print(f"Error committing Naukri jobs: {e}")
            self.session.rollback()
