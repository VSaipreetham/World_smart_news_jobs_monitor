import pandas as pd
from models import Session, Job
import datetime

def export_jobs_to_excel():
    print("Exporting jobs to Excel...")
    session = Session()
    try:
        # Fetch all jobs
        jobs = session.query(Job).all()
        
        data = []
        for j in jobs:
            data.append({
                "ID": j.id,
                "Title": j.title,
                "Company": j.company,
                "Location": j.location,
                "Pay": j.pay,
                "Source": j.source,
                "Status": j.status.value,
                "Posted Date": j.posted_date,
                "URL": j.url
            })
            
        if data:
            df = pd.DataFrame(data)
            # Overwrite the file
            filename = "jobs_list.xlsx"
            df.to_excel(filename, index=False)
            print(f"Exported {len(data)} jobs to {filename}")
        else:
            print("No jobs to export.")
            
    except Exception as e:
        print(f"Error exporting to Excel: {e}")
    finally:
        session.close()

if __name__ == "__main__":
    export_jobs_to_excel()
