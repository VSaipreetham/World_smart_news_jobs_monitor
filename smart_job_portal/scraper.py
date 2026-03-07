from models import Session
from scrapers.registry import run_all_scrapers

def scrape_jobs(progress_callback=None, cancel_event=None):
    print("Starting Main Scrape Sequence...")
    session = Session()
    try:
        run_all_scrapers(session, progress_callback=progress_callback, cancel_event=cancel_event)
        print("All scrapers finished.")
    except Exception as e:
        print(f"Global Scraper Error: {e}")
    finally:
        session.close()

if __name__ == "__main__":
    scrape_jobs()
