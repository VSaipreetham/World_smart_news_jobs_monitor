from apscheduler.schedulers.background import BackgroundScheduler
from models import Session
from scraper import scrape_jobs
from data_export import export_jobs_to_excel
from job_retention import build_prune_statement, retention_cutoff
from sqlalchemy import inspect, text
import datetime
import atexit
import os

def flush_database():
    """Legacy entry point: expire untouched listings, never application history."""
    print(f"[{datetime.datetime.now()}] Checking expired, untouched job listings...")
    session = Session()
    try:
        columns = {column['name'] for column in inspect(session.get_bind()).get_columns('jobs')}
        statement = build_prune_statement(columns)
        if statement is None:
            print("Cleanup skipped: the job schema lacks retention fields.")
            return
        cutoff = retention_cutoff(os.getenv('JOB_RETENTION_DAYS', '30'))
        result = session.execute(text(statement), {'cutoff': cutoff})
        session.commit()
        print(f"[{datetime.datetime.now()}] Expired {result.rowcount} untouched listings. Application history and notification logs retained.")
    except Exception as e:
        print(f"[{datetime.datetime.now()}] Job retention cleanup skipped: {e}")
        session.rollback()
    finally:
        session.close()

def drip_feed_process():
    """Compatibility no-op: outgoing actions require the Inbox approval button."""
    print("Scheduled outgoing notifications are disabled. Review and approve them in the Inbox.")
    return False

def scheduled_job_sequence():
    """Runs scrape then export"""
    print(f"[{datetime.datetime.now()}] Starting scheduled sequence...")
    try:
        scrape_jobs()
        export_jobs_to_excel()
        print(f"[{datetime.datetime.now()}] Scheduled sequence completed.")
    except Exception as e:
        print(f"[{datetime.datetime.now()}] Error in scheduled_job_sequence: {e}")

def check_and_flush_db_on_startup():
    """Apply the same conservative retention policy at startup."""
    flush_database()

def start_scheduler():
    scheduler = BackgroundScheduler()
    
    # 1. Run the Startup Check IMMEDIATELY before starting scheduler
    check_and_flush_db_on_startup()

    # Scrape AND Export every 10 minutes.
    scheduler.add_job(
        func=scheduled_job_sequence, 
        trigger="interval", 
        minutes=10
    )
    # Only local collection, export and retention are scheduled. Outgoing email
    # and calendar writes must be explicitly approved in the UI for each job.
    # Expire untouched listings every 10 hours; retain tracked applications.
    scheduler.add_job(func=flush_database, trigger="interval", hours=10)
    
    scheduler.start()
    print(f"[{datetime.datetime.now()}] Scheduler started...")
    atexit.register(lambda: scheduler.shutdown())
    return scheduler

