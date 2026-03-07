from apscheduler.schedulers.background import BackgroundScheduler
from models import Session, Job, DailyLog, JobStatus
from scraper import scrape_jobs
from notifications import send_email_notification
from calendar_integration import create_calendar_note
from data_export import export_jobs_to_excel
import datetime
import atexit
import time

def flush_database():
    """Flushes the entire job database for the new day."""
    print(f"[{datetime.datetime.now()}] Flushing database for the new day...")
    session = Session()
    try:
        # Delete all jobs
        num_jobs = session.query(Job).delete()
        
        # Reset daily logs for a fresh start
        session.query(DailyLog).delete()
        
        session.commit()
        print(f"[{datetime.datetime.now()}] Database flushed. {num_jobs} jobs deleted. Log cleaned.")
    except Exception as e:
        print(f"[{datetime.datetime.now()}] Error flushing database: {e}")
        session.rollback()
    finally:
        session.close()

def drip_feed_process():
    print(f"[{datetime.datetime.now()}] Running Drip Feed Process...")
    session = Session()
    try:
        today = datetime.date.today()
        log = session.query(DailyLog).filter_by(date=today).first()
        
        if not log:
            log = DailyLog(date=today, count=0)
            session.add(log)
            session.commit()
            # refetch to be safe
            log = session.query(DailyLog).filter_by(date=today).first()

        if log.count >= 2:
            print("Daily limit reached. No notifications sent.")
            return

        # Get top 1 NEW job
        # Prioritize by score then date
        job = session.query(Job).filter(Job.status == JobStatus.NEW)\
            .order_by(Job.match_score.desc(), Job.posted_date.desc()).first()

        if job:
            print(f"Processing job: {job.title}")
            
            # Send Email
            email_sent = send_email_notification(job.title, job.company, job.url)
            
            # Add to Calendar
            cal_added = create_calendar_note(job.title, job.url)
            
            if email_sent or cal_added:
                job.status = JobStatus.NOTIFIED
                log.count += 1
                session.commit()
                print("Job notified and status updated.")
            else:
                print("Falied to notify, keeping status as NEW.")
        else:
            print("No NEW jobs to process.")

    except Exception as e:
        print(f"Error in drip_feed: {e}")
    finally:
        session.close()

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
    """
    Cloud-Proof Flush: Checks if the DB has data from a previous day on startup.
    If yes, flushes it to ensure a fresh start.
    """
    print(f"[{datetime.datetime.now()}] Checking for stale data...")
    session = Session()
    try:
        # Check the date of the most recent job
        last_job = session.query(Job).order_by(Job.posted_date.desc()).first()
        
        if last_job:
            last_job_date = last_job.posted_date.date()
            today = datetime.date.today()
            
            if last_job_date < today:
                print(f"[{datetime.datetime.now()}] Stale data detected (Last job: {last_job_date}). Flushing...")
                # Call the flush function
                flush_database()
            else:
                print(f"[{datetime.datetime.now()}] Data is fresh ({last_job_date}). No flush needed.")
        else:
            print("Database is empty. Ready for new jobs.")
            
    except Exception as e:
        print(f"Error checking stale data: {e}")
    finally:
        session.close()

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
    # Check for drip feed every 60 minutes
    scheduler.add_job(func=drip_feed_process, trigger="interval", minutes=60)
    
    # Flush the database every 10 hours
    scheduler.add_job(func=flush_database, trigger="interval", hours=10)
    
    scheduler.start()
    print(f"[{datetime.datetime.now()}] Scheduler started...")
    atexit.register(lambda: scheduler.shutdown())
    return scheduler

