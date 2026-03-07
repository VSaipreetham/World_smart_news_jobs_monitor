from models import Session, Job, JobStatus, DailyLog
import datetime

def check_system():
    session = Session()
    try:
        print("--- Database Stats ---")
        total_jobs = session.query(Job).count()
        print(f"Total Jobs: {total_jobs}")
        
        for status in JobStatus:
            count = session.query(Job).filter(Job.status == status).count()
            print(f"  {status.value}: {count}")
            
        print("\n--- Recent Jobs (Top 5) ---")
        recent = session.query(Job).order_by(Job.posted_date.desc()).limit(5).all()
        for j in recent:
            print(f"  [{j.posted_date}] {j.title} @ {j.company} ({j.status.value})")
            
        print("\n--- Daily Logs ---")
        logs = session.query(DailyLog).order_by(DailyLog.date.desc()).limit(5).all()
        for l in logs:
            print(f"  {l.date}: Count={l.count}")

    except Exception as e:
        print(f"Error checking DB: {e}")
    finally:
        session.close()

if __name__ == "__main__":
    check_system()
