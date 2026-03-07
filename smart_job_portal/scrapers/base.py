from models import Job, JobStatus
import datetime

class BaseScraper:
    def __init__(self, session):
        self.session = session

    def save_job(self, title, company, url, source, location=None, pay=None, posted_date=None):
        if not posted_date:
            posted_date = datetime.datetime.utcnow()
            
        existing = self.session.query(Job).filter_by(url=url).first()
        if not existing:
            # Clean text
            location = location.strip() if location else "Remote"
            pay = pay.strip() if pay else "N/A"
            
            # Print safely to avoid charmap errors on Windows console
            try:
                print(f"  [+] Found new job: {title} at {company} ({location})")
            except UnicodeEncodeError:
                 print(f"  [+] Found new job: {title.encode('ascii', 'ignore').decode()} at {company}")

            job = Job(
                title=title,
                company=company,
                url=url,
                source=source,
                location=location,
                pay=pay,
                posted_date=posted_date,
                status=JobStatus.NEW,
                match_score=50
            )
            self.session.add(job)
            return True
        return False

    def scrape(self):
        raise NotImplementedError("Subclasses must implement scrape()")
