import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import os
from dotenv import load_dotenv

load_dotenv()

SMTP_SERVER = "smtp.gmail.com"
SMTP_PORT = 587
GMAIL_USER = os.getenv("GMAIL_USER")
GMAIL_APP_PASSWORD = os.getenv("GMAIL_APP_PASSWORD")

def send_email_notification(job_title, job_company, job_url):
    if not GMAIL_USER or not GMAIL_APP_PASSWORD:
        print("Email credentials not set. Skipping email.")
        return False

    subject = f"New Job Alert: {job_title} at {job_company}"
    body = f"""
    <h2>New Job Opportunity</h2>
    <p><strong>Role:</strong> {job_title}</p>
    <p><strong>Company:</strong> {job_company}</p>
    <p><a href="{job_url}">View Job Posting</a></p>
    """

    msg = MIMEMultipart()
    msg['From'] = GMAIL_USER
    msg['To'] = GMAIL_USER # Send to self
    msg['Subject'] = subject
    msg.attach(MIMEText(body, 'html'))

    try:
        server = smtplib.SMTP(SMTP_SERVER, SMTP_PORT)
        server.starttls()
        server.login(GMAIL_USER, GMAIL_APP_PASSWORD)
        text = msg.as_string()
        server.sendmail(GMAIL_USER, GMAIL_USER, text)
        server.quit()
        print(f"Email sent for {job_title}")
        return True
    except Exception as e:
        print(f"Failed to send email: {e}")
        return False
