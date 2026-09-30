import smtplib
from email.mime.text import MIMEText
import os
import ssl
from dotenv import load_dotenv

load_dotenv()

SMTP_SERVER = "smtp.gmail.com"
SMTP_PORT = 587
GMAIL_USER = os.getenv("GMAIL_USER")
GMAIL_APP_PASSWORD = os.getenv("GMAIL_APP_PASSWORD")

def build_email_preview(job_title, job_company, job_url):
    """Return exactly the recipient and plain text content shown before approval."""
    title = str(job_title or '')
    company = str(job_company or '')
    subject = f"New Job Alert: {title} at {company}".replace('\r', ' ').replace('\n', ' ')
    body = f"New Job Opportunity\n\nRole: {title}\nCompany: {company}\n\nView Job Posting:\n{job_url or ''}\n"
    return {'to': GMAIL_USER or '', 'subject': subject, 'body': body}


def send_email_notification(job_title, job_company, job_url, *, approved=False):
    if approved is not True:
        print("Email not sent: explicit approval is required.")
        return False
    if not GMAIL_USER or not GMAIL_APP_PASSWORD:
        print("Email credentials not set. Skipping email.")
        return False

    preview = build_email_preview(job_title, job_company, job_url)
    msg = MIMEText(preview['body'], 'plain', 'utf-8')
    msg['From'] = GMAIL_USER
    msg['To'] = preview['to']  # Send only to the configured account shown in preview.
    msg['Subject'] = preview['subject']

    accepted = False
    try:
        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT, timeout=30) as server:
            server.starttls(context=ssl.create_default_context())
            server.login(GMAIL_USER, GMAIL_APP_PASSWORD)
            server.sendmail(GMAIL_USER, preview['to'], msg.as_string())
            accepted = True
        print(f"Email sent for {job_title}")
        return True
    except Exception as e:
        # A QUIT/connection-close failure after SMTP acceptance is not a reason
        # to resend a message which has already been submitted.
        if accepted:
            print("Email accepted; SMTP connection cleanup failed.")
            return True
        print(f"Failed to send email: {e}")
        return False
