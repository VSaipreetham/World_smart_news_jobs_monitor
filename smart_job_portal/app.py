import streamlit as st
import pandas as pd
from models import Session, Job, JobStatus, engine
from sqlalchemy import func
from scraper import scrape_jobs
from data_export import export_jobs_to_excel
from scheduler_service import start_scheduler
from notifications import send_email_notification
from calendar_integration import create_calendar_note

import os
import datetime
import requests
import time
from dotenv import load_dotenv

load_dotenv() # Load environment variables


# Page Config
st.set_page_config(page_title="Smart Job Portal", layout="wide")

@st.cache_resource
def init_scheduler():
    try:
        return start_scheduler()
    except Exception as e:
        print(f"Failed to start scheduler: {e}")
        return None

if 'scheduler' not in st.session_state:
    st.session_state['scheduler'] = init_scheduler() 

def get_session():
    return Session()

st.title("🚀 Smart Job Portal V3")

# --- SIDEBAR FILTERS ---
st.sidebar.header("🔎 Search & Filters")
search_query = st.sidebar.text_input("Keywords (Title/Company)")
location_filter = st.sidebar.text_input("Location")

# Dynamic Source Filter
session = get_session()
# Get unique sources for multiselect
sources = [r[0] for r in session.query(Job.source).distinct()]
source_filter = st.sidebar.multiselect("Filter by Source", sources, default=[])
date_sort = st.sidebar.selectbox("Sort By Date", ["Newest First", "Oldest First"])

# --- TIME SLOT FILTER ---
st.sidebar.markdown("---")
st.sidebar.header("⏳ Time Slot Filter")
use_time_filter = st.sidebar.checkbox("Enable Time Filter", value=False)

start_dt_filter = None
end_dt_filter = None

if use_time_filter:
    # Get range from DB to set sensible defaults
    # min_date_db = session.query(func.min(Job.posted_date)).scalar()
    # max_date_db = session.query(func.max(Job.posted_date)).scalar()
    
    # User feedback: defaults were showing 2019. 
    # Better default: Show Today's jobs by default when filter is enabled.
    now = datetime.datetime.now()
    default_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    default_end = now.replace(hour=23, minute=59, second=59, microsecond=0)

    c_t1, c_t2 = st.sidebar.columns(2)
    with c_t1:
        start_d = st.date_input("Start Date", value=default_start.date())
        start_t = st.time_input("Start Time", value=default_start.time())
    with c_t2:
        end_d = st.date_input("End Date", value=default_end.date())
        end_t = st.time_input("End Time", value=default_end.time())
        
    start_dt_filter = datetime.datetime.combine(start_d, start_t)
    end_dt_filter = datetime.datetime.combine(end_d, end_t)

# --- WORLD TIME CONVERTER ---
st.sidebar.markdown("---")
st.sidebar.header("🌍 World Time to IST")
city_input = st.sidebar.text_input("Enter City (e.g. New York, Tokyo)")
check_time_btn = st.sidebar.button("Check Time")

if check_time_btn and city_input:
    # Basic mapping of common tech hubs to Timezones
    CITY_MAP = {
        'new york': 'America/New_York',
        'sf': 'America/Los_Angeles',
        'san francisco': 'America/Los_Angeles',
        'bay area': 'America/Los_Angeles',
        'london': 'Europe/London',
        'tokyo': 'Asia/Tokyo',
        'sydney': 'Australia/Sydney',
        'melbourne': 'Australia/Melbourne',
        'singapore': 'Asia/Singapore',
        'dublin': 'Europe/Dublin',
        'berlin': 'Europe/Berlin',
        'paris': 'Europe/Paris',
        'toronto': 'America/Toronto',
        'vancouver': 'America/Vancouver',
        'chicago': 'America/Chicago',
        'austin': 'America/Chicago',
        'seattle': 'America/Los_Angeles',
        'bengaluru': 'Asia/Kolkata',
        'bangalore': 'Asia/Kolkata'
    }
    
    tz = CITY_MAP.get(city_input.lower())
    if not tz:
        # Try fuzzy match or just warn
        st.sidebar.warning(f"Could not auto-detect timezone for '{city_input}'. Using UTC.")
        tz = "Etc/UTC"
    
    try:
        # Fetch current time for that zone
        # We use a reliable public API for checking, with User-Agent to avoid blocking
        url = f"http://worldtimeapi.org/api/timezone/{tz}"
        headers = {'User-Agent': 'SmartJobPortal/1.0'}
        
        # Retry logic: Try worldtimeapi, if fail, try fuzzy calculation (Manual Fallbacks for common zones)
        
        try:
            resp = requests.get(url, timeout=3, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            local_str = data['datetime']
            unixtime = data['unixtime']
            raw_offset = data['utc_offset']
            ist_time = datetime.datetime.utcfromtimestamp(unixtime) + datetime.timedelta(hours=5, minutes=30)
            
            st.sidebar.success(f"✅ Zone: {tz}")
            st.sidebar.write(f"**Local:** {local_str[11:19]} ({raw_offset})")
            st.sidebar.write(f"**IST:** {ist_time.strftime('%H:%M:%S')}")
            
        except (requests.exceptions.RequestException, ValueError):
            # Fallback: Simple manual calculation for known zones if API fails
            # This is "Rough" because it doesn't account for DST perfectly without pytz, 
            # but it is better than crashing.
            st.sidebar.warning("API unstable, using offline estimate (Checking DST manually is complex without pytz).")
            
            utc_now = datetime.datetime.utcnow()
            
            # Rough Standard Offsets (Approximation)
            OFFSETS = {
                'America/New_York': -5, # EST (Standard)
                'America/Chicago': -6,  # CST
                'America/Los_Angeles': -8, # PST
                'Europe/London': 0,
                'Europe/Paris': 1,
                'Asia/Tokyo': 9,
                'Australia/Sydney': 11,
                'Asia/Singapore': 8,
                'Asia/Kolkata': 5.5
            }
            
            offset = OFFSETS.get(tz, 0)
            local_est = utc_now + datetime.timedelta(hours=offset)
            ist_est = utc_now + datetime.timedelta(hours=5.5)
            
            st.sidebar.write(f"**Est. Local:** {local_est.strftime('%H:%M')} (Std Time)")
            st.sidebar.write(f"**IST:** {ist_est.strftime('%H:%M')}")
            
    except Exception as e:
        st.sidebar.error(f"Error: {e}")

# Stats
new_count = session.query(Job).filter(Job.status.in_([JobStatus.NEW, JobStatus.QUEUED])).count()
notified_count = session.query(Job).filter(Job.status == JobStatus.NOTIFIED).count()
archived_count = session.query(Job).filter(Job.status == JobStatus.ARCHIVED).count()
total_count = session.query(Job).count()

# Recent Activity Stats
utc_now = datetime.datetime.utcnow()
ten_mins_ago = utc_now - datetime.timedelta(minutes=10)
recent_count = session.query(Job).filter(Job.posted_date >= ten_mins_ago).count()

last_job = session.query(Job).order_by(Job.posted_date.desc()).first()
last_scrape_str = "N/A"
if last_job and last_job.posted_date:
    # Convert to IST for display
    last_ist = last_job.posted_date + datetime.timedelta(hours=5, minutes=30)
    last_scrape_str = last_ist.strftime("%I:%M %p")

# Layout: Total | New (30m) | Notified | Archived | Last Update | Button
# Adjust column weights to prevent truncation:
# Fresh Jobs needs space for delta. Last Update needs space for timestamp.
c1, c2, c3, c4, c5, c6 = st.columns([1, 1.3, 0.8, 0.8, 1.5, 1.2])

c1.metric("Total Jobs", total_count)
# "Flushed" counter: Only shows jobs from last 10 minutes
c2.metric("Fresh Jobs (10m)", recent_count, delta=f"Inbox: {new_count}")
c3.metric("Notified", notified_count)
c4.metric("Archived", archived_count)
c5.metric("Last Update", last_scrape_str)

with c6:
    st.write("") # Spacer to align button with metrics which have labels
    import threading
    
    # --- SCRAPING STATE MANAGEMENT ---
    if 'scraping_active' not in st.session_state:
        st.session_state['scraping_active'] = False
    
    if 'scrape_progress' not in st.session_state:
        st.session_state['scrape_progress'] = 0.0
        
    if 'scrape_cancel_event' not in st.session_state:
        st.session_state['scrape_cancel_event'] = threading.Event()
        
    # Function to run in background thread
    def run_scrape_in_background(callback, cancel_evt):
        try:
            scrape_jobs(progress_callback=callback, cancel_event=cancel_evt)
            if not cancel_evt.is_set():
                export_jobs_to_excel()
        except Exception as e:
            print(f"Thread Error: {e}")
        finally:
            st.session_state['scraping_done'] = True # Signal completion
    
    # UI Logic
    from streamlit.runtime.scriptrunner import add_script_run_ctx
    
    @st.fragment
    def manual_scrape_panel():
        if 'scraping_active' not in st.session_state:
            st.session_state['scraping_active'] = False
        
        if not st.session_state['scraping_active']:
            if st.button("🔄 Manual Scrape", use_container_width=True):
                 st.session_state['scraping_active'] = True
                 st.session_state['scrape_progress'] = 0.0
                 st.session_state['scraping_done'] = False
                 st.session_state['scrape_cancel_event'].clear()
                 
                 # Define thread-safe update
                 def update_p(p): 
                     # Update session state safely
                     st.session_state['scrape_progress'] = p
                 
                 t = threading.Thread(target=run_scrape_in_background, args=(update_p, st.session_state['scrape_cancel_event']))
                 add_script_run_ctx(t) # CRITICAL: Allows thread to write to session_state
                 st.session_state['scrape_thread'] = t
                 t.start()
                 st.rerun()
            
            # Show Last Updated Time
            if os.path.exists("jobs_list.xlsx"):
                last_mod = datetime.datetime.fromtimestamp(os.path.getmtime("jobs_list.xlsx"))
                st.caption(f"Last updated: {last_mod.strftime('%I:%M %p, %d %b')}")
        else:
            # ACTIVE STATE (Inside Fragment)
            with st.status("🚀 Scraper Agents Deployed...", expanded=True) as status:
                p = st.session_state.get('scrape_progress', 0.0)
                
                # Fun Quotes
                quotes = [
                     "“Choose a job you love...”",
                     "“The future belongs to believers...”",
                     "“Opportunities are created...”",
                     "“Courage to continue counts...”",
                     "Searching hidden corners...",
                     "Handshaking with servers...",
                     "Unlocking opportunities...",
                     "Negotiating firewalls...",
                     "Parsing the matrix...",
                     "Filtering roles...",
                ]
                # Rotate quotes based on time
                quote_idx = int(time.time() / 3) % len(quotes)
                st.info(f"💡 {quotes[quote_idx]}")
                
                st.progress(p, text=f"Processing... {int(p*100)}%")
                
                if st.button("🛑 Cancel Scrape", type="primary"):
                    st.session_state['scrape_cancel_event'].set()
                    st.warning("Stopping...")
                
                # Check Completion State
                if st.session_state.get('scraping_done', False):
                    status.update(label="✅ Scrape Completed!", state="complete", expanded=False)
                    st.session_state['scraping_active'] = False
                    st.success("Database Updated!")
                    time.sleep(1)
                    st.rerun()
                elif st.session_state['scrape_cancel_event'].is_set():
                     status.update(label="🚫 Scrape Cancelled!", state="error", expanded=False)
                     st.session_state['scraping_active'] = False
                     st.error("Operation Cancelled.")
                     time.sleep(1)
                     st.rerun()
                else:
                    # Rerun fragment to update progress
                    time.sleep(0.5)
                    st.rerun()
    
    manual_scrape_panel()

if os.path.exists("jobs_list.xlsx"):
    with open("jobs_list.xlsx", "rb") as file:
        st.sidebar.download_button(
            label="📥 Download Excel",
            data=file,
            file_name="jobs_list.xlsx",
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )

# --- AI COACH INTEGRATION ---
try:
    from ai_service import get_ai_coach, extract_text_from_pdf
    AI_AVAILABLE = True
except ImportError:
    AI_AVAILABLE = False

if 'ai_coach' not in st.session_state and AI_AVAILABLE:
    coach = get_ai_coach()
    # Hot-fix: Ensure new methods exist
    if not hasattr(coach, 'get_available_models'):
        try:
             from ai_service import AICoach
             coach = AICoach() # Force new instance
        except Exception:
             pass 
    
    # Set Gemini Key
    gemini_key = os.getenv("Google_token")
    if gemini_key:
        coach.set_gemini_key(gemini_key)
    
    st.session_state['ai_coach'] = coach
elif 'ai_coach' in st.session_state:
    # Double check existing object has new methods
    if not hasattr(st.session_state['ai_coach'], 'get_available_models'):
         from ai_service import AICoach
         st.session_state['ai_coach'] = AICoach()
         gemini_key = os.getenv("Google_token")
         if gemini_key:
             st.session_state['ai_coach'].set_gemini_key(gemini_key)

# --- AI SETTINGS (SIDEBAR) ---
selected_model_conf = None
if AI_AVAILABLE and 'ai_coach' in st.session_state:
    coach = st.session_state['ai_coach']
    
    if 'disabled_models' not in st.session_state:
        st.session_state['disabled_models'] = set()
        
    # Get models
    all_models = coach.get_available_models()
    # Filter available
    valid_models = [m for m in all_models if m['id'] not in st.session_state['disabled_models']]
    
    if not valid_models:
        st.sidebar.error("⚠️ All AI models are disabled/failed.")
    else:
        st.sidebar.markdown("---")
        st.sidebar.header("🤖 AI Settings")
        
        # Create friendly labels
        model_options = {m['name']: m for m in valid_models}
        selected_name = st.sidebar.selectbox("Select Model", list(model_options.keys()))
        selected_model_conf = model_options[selected_name]

# Helper to run AI safely
def safe_ai_execute(func, *args, **kwargs):
    if not selected_model_conf:
        st.error("No AI Model Selected.")
        return None
        
    try:
        # Inject model_conf
        kwargs['model_conf'] = selected_model_conf
        return func(*args, **kwargs)
    except Exception as e:
        # Handle Failure
        st.error(f"Error with {selected_model_conf['name']}: {e}")
        st.warning(f"Disabling {selected_model_conf['name']}...")
        st.session_state['disabled_models'].add(selected_model_conf['id'])
        # Optional: Force rerun to refresh list
        # We return None to signal failure
        return None

# --- MAIN TABS ---
tab1, tab2, tab3, tab4, tab5, tab6 = st.tabs(["📥 Inbox", "🚀 My Applications", "📊 Analytics", "📜 History", "🗑️ Archived", "🤖 AI Career Coach"])

with tab1:
    st.subheader("Inbox (New Jobs)")
    
    # Filter Logic
    query = session.query(Job).filter(Job.status.in_([JobStatus.NEW, JobStatus.QUEUED]))
    if source_filter:
        query = query.filter(Job.source.in_(source_filter))
    if location_filter:
        query = query.filter(Job.location.ilike(f"%{location_filter}%"))
    if search_query:
        query = query.filter(
            (Job.title.ilike(f"%{search_query}%")) |
            (Job.company.ilike(f"%{search_query}%"))
        )
    
    # Apply Time Filter
    if use_time_filter and start_dt_filter and end_dt_filter:
        # Convert User's IST Input -> UTC for Querying DB
        # User selects "9:00 AM" (IST). We need to find jobs >= "3:30 AM" (UTC).
        start_utc = start_dt_filter - datetime.timedelta(hours=5, minutes=30)
        end_utc = end_dt_filter - datetime.timedelta(hours=5, minutes=30)
        
        query = query.filter(Job.posted_date >= start_utc)
        query = query.filter(Job.posted_date <= end_utc)
        st.caption(f"Showing jobs from {start_dt_filter} to {end_dt_filter} (IST)")
        
    
    jobs = query.order_by(Job.posted_date.desc()).limit(200).all()
    
    if not jobs and use_time_filter:
        # Debugging / UX Helper: Check if jobs exist *outside* that time range
        # Re-run query without time filter
        check_q = session.query(Job).filter(Job.status.in_([JobStatus.NEW, JobStatus.QUEUED]))
        if source_filter:
            check_q = check_q.filter(Job.source.in_(source_filter))
        if location_filter:
            check_q = check_q.filter(Job.location.ilike(f"%{location_filter}%"))
        if search_query:
            check_q = check_q.filter(
                (Job.title.ilike(f"%{search_query}%")) |
                (Job.company.ilike(f"%{search_query}%"))
            )
        count_exist = check_q.count()
        if count_exist > 0:
            st.warning(f"⚠️ No jobs found between **{start_t}** and **{end_t}** (IST). However, **{count_exist}** jobs match your other filters. Try widening the time range or disabling the time filter.")
        else:
            st.info("No jobs found matching filters.")
    elif not jobs:
         st.info("No jobs found matching filters.")
    
    if jobs:
        # Select All / Deselect All Logic
        if 'select_all_flag' not in st.session_state:
            st.session_state['select_all_flag'] = False
        
        c_sel1, c_sel2, _ = st.columns([1, 1, 6])
        with c_sel1:
            if st.button("✅ Select All"):
                st.session_state['select_all_flag'] = True
                st.rerun()
        with c_sel2:
            if st.button("⬜ Deselect All"):
                st.session_state['select_all_flag'] = False
                st.rerun()

        default_select = st.session_state['select_all_flag']

        with st.form("process_jobs"):
            data = []
            for j in jobs:
                # Convert UTC to IST (Naive + 5:30)
                # Assumes DB is storing UTC (which we reverted to).
                posted_ist = j.posted_date
                if posted_ist:
                     posted_ist = posted_ist + datetime.timedelta(hours=5, minutes=30)

                data.append({
                    "id": j.id,
                    "Select": default_select,
                    "Title": j.title,
                    "Company": j.company,
                    "Location": j.location,
                    "Source": j.source, 
                    "URL": j.url,
                    "Posted Date": posted_ist
                })
            
            df = pd.DataFrame(data)
            # Use dynamic key to force refresh when select all is toggled
            editor_key = f"editor_{default_select}_{len(jobs)}"
            
            edited_df = st.data_editor(df, column_config={
                "Select": st.column_config.CheckboxColumn("Select", default=default_select),
                "URL": st.column_config.LinkColumn("Link"),
                "Posted Date": st.column_config.DatetimeColumn("Posted Date (IST)", format="D MMM YYYY, h:mm a"),
                "Source": st.column_config.TextColumn("Source")
            }, disabled=["id", "Title", "Company", "Location", "Source", "URL", "Posted Date"], hide_index=True, key=editor_key)
            
            c1, c2, c3 = st.columns([1, 1, 1])
            with c1:
                apply_btn = st.form_submit_button("🚀 Mark Applied")
            with c2:
                archive_btn = st.form_submit_button("🗑️ Archive")
            with c3:
                delete_btn = st.form_submit_button("❌ Delete")
            
            if apply_btn:
                selected_rows = edited_df[edited_df["Select"] == True]
                for index, row in selected_rows.iterrows():
                    job = session.query(Job).get(row['id'])
                    if job:
                        job.status = JobStatus.APPLIED
                session.commit()
                st.success(f"Moved {len(selected_rows)} jobs to Applications!")
                st.rerun()

            if archive_btn:
                selected_rows = edited_df[edited_df["Select"] == True]
                for index, row in selected_rows.iterrows():
                    job = session.query(Job).get(row['id'])
                    if job:
                        job.status = JobStatus.ARCHIVED
                session.commit()
                st.success("Archived.")
                st.rerun()

            if delete_btn:
                selected_rows = edited_df[edited_df["Select"] == True]
                count = 0
                for index, row in selected_rows.iterrows():
                    job = session.query(Job).get(row['id'])
                    if job:
                        session.delete(job)
                        count += 1
                session.commit()
                st.success(f"Deleted {count} jobs permanently.")
                st.rerun()
    else:
        st.info("No jobs found matching filters.")

with tab2:
    st.subheader("My Application Tracker")
    apps = session.query(Job).filter(Job.status.in_([JobStatus.APPLIED, JobStatus.INTERVIEW, JobStatus.OFFER, JobStatus.REJECTED])).order_by(Job.posted_date.desc()).all()
    
    if apps:
        for job in apps:
            with st.expander(f"{job.title} @ {job.company} ({job.status.value.upper()})"):
                c1, c2 = st.columns([2, 1])
                with c1:
                    st.write(f"**Source:** {job.source}")
                    st.write(f"**Location:** {job.location}")
                    st.write(f"**Pay:** {job.pay}")
                    st.markdown(f"[Job Link]({job.url})")
                    
                    # Notes Field
                    new_note = st.text_area("My Notes", value=job.notes if job.notes else "", key=f"note_{job.id}")
                    if st.button("Save Note", key=f"savenote_{job.id}"):
                        job.notes = new_note
                        session.commit()
                        st.success("Saved!")
                
                with c2:
                    st.write("Update Status:")
                    s1, s2, s3, s4 = st.columns(4)
                    if s1.button("Applied", key=f"st_app_{job.id}"): 
                        job.status = JobStatus.APPLIED
                        session.commit()
                        st.rerun()
                    if s2.button("Interview", key=f"st_int_{job.id}"): 
                        job.status = JobStatus.INTERVIEW
                        session.commit()
                        st.rerun()
                    if s3.button("Offer", key=f"st_off_{job.id}"): 
                        job.status = JobStatus.OFFER
                        session.commit()
                        st.rerun()
                    if s4.button("Reject", key=f"st_rej_{job.id}"): 
                        job.status = JobStatus.REJECTED
                        session.commit()
                        st.rerun()
    else:
        st.info("No active applications yet. Go to Inbox and 'Mark Applied'!")

with tab3:
    st.subheader("📊 Job Market Analytics")
    
    # Analytics Queries
    df_all = pd.read_sql(session.query(Job).statement, session.bind)
    
    if not df_all.empty:
        # 1. Preprocessing
        # Convert Enum to string
        if 'status' in df_all.columns:
            df_all['status'] = df_all['status'].astype(str)
        
        # Convert UTC to IST
        df_all['posted_ist'] = pd.to_datetime(df_all['posted_date']) + pd.Timedelta(hours=5, minutes=30)
        
        # Layout: 2x2 Grid
        g1, g2 = st.columns(2)
        g3, g4 = st.columns(2)
        
        # --- G1: Jobs Over Time (Hourly Trend) ---
        with g1:
            st.markdown("#### 📈 Hourly Posting Trend (Last 24h)")
            # Filter last 24h
            last_24h = datetime.datetime.now() - datetime.timedelta(hours=24)
            df_recent = df_all[df_all['posted_ist'] >= last_24h]
            if not df_recent.empty:
                hourly_counts = df_recent.set_index('posted_ist').resample('H').size()
                st.line_chart(hourly_counts)
            else:
                st.info("Not enough data for trend.")

        # --- G2: Distribution by Source ---
        with g2:
            st.markdown("#### 📡 Jobs by Source")
            source_counts = df_all['source'].value_counts()
            st.bar_chart(source_counts)

        # --- G3: Top Companis ---
        with g3:
            st.markdown("#### 🏢 Top Hiring Companies")
            company_counts = df_all['company'].value_counts().head(10)
            st.bar_chart(company_counts, horizontal=True)

        # --- G4: Top Locations ---
        with g4:
            st.markdown("#### 📍 Top Locations")
            if 'location' in df_all.columns:
                # Basic cleaning of None
                df_all['location'] = df_all['location'].fillna("Unknown")
                loc_counts = df_all['location'].value_counts().head(10)
                st.bar_chart(loc_counts, horizontal=True)
            else:
                st.info("Location data missing.")

        # --- Deep Dive: Title Keywords ---
        st.markdown("#### 🔑 Top Keywords in Job Titles")
        all_titles = " ".join(df_all['title'].dropna().astype(str).tolist()).lower()
        # Simple stop words removal
        stop_words = set(['and', 'or', 'the', 'a', 'in', 'of', 'for', 'to', 'with', 'at', 'senior', 'junior', 'lead', 'manager', 'engineer', 'developer', 'software'])
        words = [w for w in all_titles.split() if len(w) > 3 and w not in stop_words]
        word_series = pd.Series(words).value_counts().head(15)
        st.bar_chart(word_series)

        st.markdown("---")
        
        # --- NEW: Advanced Analytics ---
        a1, a2 = st.columns(2)
        
        with a1:
            st.markdown("#### 📅 Best Days to Apply")
            # Day of Week Analysis
            df_all['day_name'] = df_all['posted_ist'].dt.day_name()
            # Sort by Monday -> Sunday
            days_order = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
            day_counts = df_all['day_name'].value_counts().reindex(days_order).fillna(0)
            st.bar_chart(day_counts)
            
        with a2:
            st.markdown("#### 🏡 Work Mode (Remote vs On-site)")
            # Simple keyword classification
            def classify_mode(loc):
                if not loc: return "Unknown"
                loc = str(loc).lower()
                if 'remote' in loc: return 'Remote'
                if 'hybrid' in loc: return 'Hybrid'
                return 'On-site'
            
            df_all['work_mode'] = df_all['location'].apply(classify_mode)
            mode_counts = df_all['work_mode'].value_counts()
            
            # Use a dataframe for better chart config if needed, or simple bar
            st.bar_chart(mode_counts)

        # --- Funnel ---
        st.markdown("#### 🏁 Recruitment Funnel")
        # Status counts
        s_counts = df_all['status'].value_counts()
        # Define funnel order
        funnel_order = ['new', 'applied', 'interview', 'offer', 'rejected']
        # Filter only existing ones
        funnel_data = s_counts.reindex([s for s in funnel_order if s in s_counts.index]).fillna(0)
        
        if not funnel_data.empty:
            st.bar_chart(funnel_data)
        else:
            st.info("Start applying to generate funnel data!")

        st.markdown("---")
        
        # --- NEW EST: Seniority & Tech Stack ---
        b1, b2 = st.columns(2)
        
        with b1:
            st.markdown("#### 👔 Job Seniority Distribution")
            def classify_seniority(title):
                t = str(title).lower()
                if 'senior' in t or 'sr.' in t or 'lead' in t or 'staff' in t or 'principal' in t: return 'Senior/Lead'
                if 'junior' in t or 'jr.' in t or 'entry' in t or 'associate' in t: return 'Junior/Entry'
                if 'intern' in t or 'internship' in t: return 'Intern'
                if 'manager' in t or 'head' in t or 'director' in t: return 'Management'
                return 'Mid-Level/Unspecified'
            
            df_all['seniority'] = df_all['title'].apply(classify_seniority)
            seniority_counts = df_all['seniority'].value_counts()
            st.bar_chart(seniority_counts)
            
        with b2:
            st.markdown("#### 💻 In-Demand Technologies")
            tech_keywords = {
                "Python": ["python", "django", "flask", "fastapi"],
                "JavaScript/TS": ["javascript", "typescript", "react", "node", "angular", "vue"],
                "Java": ["java", "spring"],
                "C++": ["c++"],
                "Cloud/DevOps": ["aws", "azure", "gcp", "docker", "kubernetes", "terraform"],
                "Data/AI": ["sql", "pandas", "pytorch", "tensorflow", "spark", "llm", "ai", "machine learning"],
                "Go": ["golang"],
                "Rust": ["rust"]
            }
            
            tech_counts = {}
            # Scan titles (and descriptions if available, but titles for speed)
            # Titles are usually "Senior Python Engineer", so title-scan is effective.
            all_text_lower = " ".join(df_all['title'].dropna().astype(str).tolist()).lower()
            
            for category, keywords in tech_keywords.items():
                count = 0
                for k in keywords:
                    count += all_text_lower.count(k)
                if count > 0:
                    tech_counts[category] = count
            
            if tech_counts:
                st.bar_chart(pd.Series(tech_counts).sort_values(ascending=False))
            else:
                st.info("No tech keywords found in titles.")

        st.markdown("---")
        
        st.markdown("---")
        
        # --- NEW: Application Activity Calculator ---
        st.markdown("#### 📅 Your Application Velocity")
        # Get applications from DB
        apps_df = df_all[df_all['status'].isin(['applied', 'interview', 'offer', 'rejected'])]
        
        if not apps_df.empty:
            # Group by Date
            apps_df['date_only'] = apps_df['posted_ist'].dt.date
            daily_apps = apps_df['date_only'].value_counts().sort_index()
            
            # Simple Line Chart
            st.bar_chart(daily_apps)
            st.caption(f"You have applied to {len(apps_df)} jobs in total.")
        else:
            st.info("Start applying to track your velocity here!")

        st.markdown("---")

        # --- NEW: Company Spotlight ---
        st.markdown("#### 🏢 Company Spotlight")
        # Dropdown for companies with > 1 job
        company_list = df_all['company'].value_counts()
        valid_companies = company_list[company_list > 1].index.tolist()
        
        if valid_companies:
            selected_company = st.selectbox("Select a Company to Analyze:", valid_companies)
            
            if selected_company:
                comp_data = df_all[df_all['company'] == selected_company]
                
                sc1, sc2, sc3 = st.columns(3)
                sc1.metric("Total Jobs", len(comp_data))
                sc2.metric("Most Common Role", comp_data['title'].mode()[0] if not comp_data['title'].empty else "N/A")
                
                # Tech Scan for this company
                comp_tech = {}
                comp_text = " ".join(comp_data['title'].fillna("").astype(str).tolist()).lower()
                for cat, kws in tech_keywords.items(): # Use existing tech_keywords from below
                    c = 0
                    for k in kws: c += comp_text.count(k)
                    if c > 0: comp_tech[cat] = c
                
                best_tech = max(comp_tech, key=comp_tech.get) if comp_tech else "Generalist"
                sc3.metric("Top Tech Focus", best_tech)
                
                st.markdown("**Recent Roles:**")
                st.dataframe(comp_data[['title', 'location', 'posted_ist']].head(5), hide_index=True)
        else:
            st.info("Not enough data for company deep dives yet.")

        st.markdown("---")
        
        # --- NEW: Source Efficiency Analysis ---
        st.markdown("#### 🎯 Source Efficiency (Interviews per Source)")
        # We need to calculate what % of apps turned into interviews per source
        # 1. Get total apps per source
        apps_only = df_all[df_all['status'].isin(['applied', 'interview', 'offer', 'rejected'])]
        
        if not apps_only.empty:
            source_apps = apps_only['source'].value_counts()
            
            # 2. Get interviews per source
            interviews_only = df_all[df_all['status'].isin(['interview', 'offer'])]
            source_interviews = interviews_only['source'].value_counts()
            
            # Combine
            eff_df = pd.DataFrame({'Applications': source_apps, 'Interviews': source_interviews}).fillna(0)
            eff_df['Conversion Rate (%)'] = (eff_df['Interviews'] / eff_df['Applications'] * 100).round(1)
            
            e1, e2 = st.columns([2,1])
            with e1:
                st.bar_chart(eff_df[['Applications', 'Interviews']])
            with e2:
                st.write("Conversion Rates:")
                st.dataframe(eff_df[['Conversion Rate (%)']].sort_values(by='Conversion Rate (%)', ascending=False))
        else:
             st.info("Apply to more jobs to see Source Efficiency!")

        st.markdown("---")

        # --- NEW: Role Category Analysis ---
        st.markdown("#### 🎭 Role Category Breakdown")
        
        def categorize_role(title):
            t = str(title).lower()
            if 'full stack' in t or 'fullstack' in t: return 'Full Stack'
            if 'back end' in t or 'backend' in t: return 'Backend'
            if 'front end' in t or 'frontend' in t or 'ui' in t: return 'Frontend'
            if 'data' in t or 'analyst' in t or 'scientist' in t: return 'Data/AI'
            if 'cloud' in t or 'devops' in t or 'sre' in t: return 'DevOps/Cloud'
            if 'product' in t or 'manager' in t: return 'Product/Mgmt'
            if 'test' in t or 'qa' in t: return 'QA/Testing'
            return 'Other/General'
            
        df_all['role_category'] = df_all['title'].apply(categorize_role)
        role_counts = df_all['role_category'].value_counts()
        
        st.bar_chart(role_counts)

        st.markdown("---")
        
        # --- NEW EST: Pay & Job Type ---
        c1, c2 = st.columns(2)
        
        with c1:
            st.markdown("#### 💰 Salary Estimation (Experimental)")
            # Try to extract numbers from 'pay' column if it exists and has content
            if 'pay' in df_all.columns:
                # Basic cleaner: look for "k" values e.g. "120k", "150000"
                # This is very rough as 'pay' is unstructured text usually.
                # We filter for values that look like annual salaries (30k - 500k)
                
                def extract_salary(val):
                    import re
                    if not val or val == "N/A": return None
                    val = str(val).lower()
                    # Find numbers
                    nums = re.findall(r'\d+', val.replace(',', '').replace('k', '000'))
                    if nums:
                        # Take the average of numbers found in string (e.g. "100k-150k")
                        avg = sum([int(n) for n in nums]) / len(nums)
                        if 30000 < avg < 500000: # Reasonable annual range filter
                            return avg
                    return None
                    
                salaries = df_all['pay'].apply(extract_salary).dropna()
                if not salaries.empty:
                    # Histogram roughly
                    # FIX: Convert IntervalIndex to string to avoid Arrow/Altair schema error
                    hist_data = pd.cut(salaries, bins=5).value_counts().sort_index()
                    hist_data.index = hist_data.index.astype(str)
                    st.bar_chart(hist_data)
                    st.caption(f"Based on {len(salaries)} jobs with parseable salary data.")
                else:
                    st.info("Not enough structured salary data available yet.")
                
                # AI Estimation Feature
                if st.button("🤖 Estimate Salaries with AI (RAG Analysis)"):
                    if 'ai_coach' in st.session_state:
                         with st.spinner("Consulting AI Market Analyst (Analyzing your DB)..."):
                             # RAG: Retrieve context from DB
                             # Pass Title, Company, Location, Pay to give full context
                             context_jobs = df_all[['title', 'company', 'location', 'pay']].head(50).to_dict('records')
                             analysis = safe_ai_execute(st.session_state['ai_coach'].estimate_market_ranges, context_jobs)
                             if analysis: st.markdown(analysis)
                             else: st.rerun()
                    else:
                        st.error("AI Coach not initialized.")

            else:
                st.info("Pay column not available.")

        with c2:
            st.markdown("#### 📜 Job Type Distribution")
            
            def classify_type(title):
                t = str(title).lower()
                if 'contract' in t or 'contractor' in t: return 'Contract'
                if 'part-time' in t or 'part time' in t: return 'Part-Time'
                if 'freelance' in t: return 'Freelance'
                if 'temp' in t or 'temporary' in t: return 'Temporary'
                # Default logic: most jobs are fulltime if not specified
                return 'Full-Time'
            
            # Use title for classification
            type_counts = df_all['title'].apply(classify_type).value_counts()
            st.bar_chart(type_counts)

        st.markdown("---")
        st.subheader("🧠 AI Market Intelligence (RAG)")
        
        rag_c1, rag_c2 = st.columns([1, 1])
        
        with rag_c1:
            st.markdown("#### 💬 Ask your Job Database")
            rag_query = st.text_input("Ask a question about the market:", placeholder="E.g., Which companies are hiring for Remote Python roles?")
            if rag_query and st.button("🔍 Analyze with AI"):
                if 'ai_coach' in st.session_state:
                    with st.spinner("Analyzing Market Data..."):
                        # Convert all jobs to dict for RAG
                        # Ensure we convert Timestamps to str to avoid serialization issues if any
                        rag_jobs = df_all.to_dict('records')
                        answer = safe_ai_execute(st.session_state['ai_coach'].market_insights_rag, rag_query, rag_jobs)
                        if answer: st.markdown(f"**Insight:**\n\n{answer}")
                        else: st.rerun()
                else:
                    st.error("AI Service not ready.")

        with rag_c2:
            st.markdown("#### 🌍 Global Skill Gap Analysis")
            st.caption("Compare your resume against the top 20 most relevant jobs in your Inbox.")
            if st.button("🧬 Identify Strategic Gaps"):
                if 'ai_coach' in st.session_state:
                     res_text = st.session_state.get('resume_text', "")
                     if len(res_text) < 50:
                         st.warning("⚠️ Please upload your resume in the 'AI Career Coach' tab first!")
                     else:
                         with st.spinner("Conducting Deep Market Analysis..."):
                             # Pass relevant jobs (New/Applied) for gap analysis
                             # We use the subset logic
                             target_jobs_df = df_all[df_all['status'].isin(['new', 'queued', 'applied'])]
                             if target_jobs_df.empty:
                                 target_jobs_df = df_all # Fallback to all
                             
                             target_jobs = target_jobs_df.to_dict('records')
                             
                             analysis = safe_ai_execute(st.session_state['ai_coach'].global_skills_gap, res_text, target_jobs)
                             if analysis: st.markdown(analysis)
                             else: st.rerun()
                else:
                    st.error("AI Service not ready.")

    else:
        st.warning("No data for analytics.")

with tab4:
    st.subheader("Notification History")
    history = session.query(Job).filter(Job.status == JobStatus.NOTIFIED).order_by(Job.posted_date.desc()).all()
    
    fdata = []
    for j in history:
        # Convert to IST
        posted_ist = j.posted_date
        if posted_ist:
                posted_ist = posted_ist + datetime.timedelta(hours=5, minutes=30)
                
        fdata.append({
            "Title": j.title,
            "Company": j.company,
            "Source": j.source,
            "Posted Date": posted_ist,
            "URL": j.url
        })
    if fdata:
        st.dataframe(fdata, column_config={
            "URL": st.column_config.LinkColumn("Link"),
            "Posted Date": st.column_config.DatetimeColumn("Posted Date (IST)", format="D MMM YYYY, h:mm a")
        }, hide_index=True)
    else:
        st.info("No history.")

with tab5:
    st.subheader("Archived Jobs")
    archived = session.query(Job).filter(Job.status == JobStatus.ARCHIVED).order_by(Job.posted_date.desc()).limit(200).all()
    
    if archived:
        # Select All / Deselect All Logic for Archive
        if 'select_all_archive_flag' not in st.session_state:
            st.session_state['select_all_archive_flag'] = False
        
        c_arc_1, c_arc_2, _ = st.columns([1, 1, 6])
        with c_arc_1:
            if st.button("✅ Select All", key="arc_sel_all"):
                st.session_state['select_all_archive_flag'] = True
                st.rerun()
        with c_arc_2:
            if st.button("⬜ Deselect All", key="arc_desel_all"):
                st.session_state['select_all_archive_flag'] = False
                st.rerun()

        default_select_arc = st.session_state['select_all_archive_flag']

        with st.form("process_archive"):
            adata = []
            for j in archived:
                # Convert UTC to IST
                posted_ist = j.posted_date
                if posted_ist:
                     posted_ist = posted_ist + datetime.timedelta(hours=5, minutes=30)
                
                adata.append({
                    "id": j.id,
                    "Select": default_select_arc,
                    "Title": j.title,
                    "Company": j.company,
                    "Source": j.source,
                    "Posted Date": posted_ist,
                    "URL": j.url
                })
            
            df_arc = pd.DataFrame(adata)
            editor_key_arc = f"editor_archive_{default_select_arc}_{len(archived)}"
            
            edited_df_arc = st.data_editor(df_arc, column_config={
                "Select": st.column_config.CheckboxColumn("Select", default=default_select_arc),
                "URL": st.column_config.LinkColumn("Link"),
                "Posted Date": st.column_config.DatetimeColumn("Posted Date (IST)", format="D MMM YYYY, h:mm a"),
            }, disabled=["id", "Title", "Company", "Source", "Posted Date", "URL"], hide_index=True, key=editor_key_arc)
            
            ac1, ac2 = st.columns(2)
            with ac1:
                restore_btn = st.form_submit_button("♻️ Restore to Inbox")
            with ac2:
                delete_perm_btn = st.form_submit_button("❌ Permanent Delete")
            
            if restore_btn:
                selected_rows = edited_df_arc[edited_df_arc["Select"] == True]
                count = 0
                for index, row in selected_rows.iterrows():
                    job = session.query(Job).get(row['id'])
                    if job:
                        job.status = JobStatus.NEW
                        count += 1
                session.commit()
                st.success(f"Restored {count} jobs to Inbox.")
                st.rerun()

            if delete_perm_btn:
                selected_rows = edited_df_arc[edited_df_arc["Select"] == True]
                count = 0
                for index, row in selected_rows.iterrows():
                    job = session.query(Job).get(row['id'])
                    if job:
                        session.delete(job)
                        count += 1
                session.commit()
                st.success(f"Permanently deleted {count} jobs.")
                st.rerun()
    else:
        st.info("Trash is empty.")

with tab6:
    st.header("🤖 AI Career Coach")
    
    if not AI_AVAILABLE:
        st.warning("AI features require additional libraries. Please install: `pip install sentence-transformers transformers torch pdfplumber`")
    else:
        coach = st.session_state.get('ai_coach')
        
        # Layout: Split Resume/Matching (Left) and Chat (Right)
        col_resume, col_chat = st.columns([1, 1])

        # --- LEFT: Resume & Matching ---
        with col_resume:
            st.subheader("📄 Resume Center")
            uploaded_file = st.file_uploader("Upload Resume (PDF)", type="pdf")
            
            if uploaded_file is not None:
                if 'resume_text' not in st.session_state:
                    with st.spinner("Parsing Resume..."):
                        text = extract_text_from_pdf(uploaded_file)
                        st.session_state['resume_text'] = text
                        st.success("Resume Parsed!")
                
                st.text_area("Resume Preview", st.session_state['resume_text'][:300] + "...", height=100)
                
                if st.button("� Rank My Jobs (RAG)"):
                    if coach:
                        with st.spinner("Analyzing Database against Resume..."):
                            # Get all open jobs
                            open_jobs = session.query(Job).filter(Job.status.in_([JobStatus.NEW, JobStatus.QUEUED, JobStatus.APPLIED])).order_by(Job.posted_date.desc()).limit(200).all()
                            
                            try:
                                scored_jobs = coach.batch_rank_jobs(st.session_state['resume_text'], open_jobs)
                                st.session_state['ai_matches'] = scored_jobs[:10]
                            except Exception as e:
                                st.error(f"Error ranking jobs: {e}")

            if 'ai_matches' in st.session_state:
                st.write("### 🎯 Best Matches")
                for job, score in st.session_state['ai_matches']:
                     # Visual score
                    st.progress(float(score), text=f"Match: {int(score*100)}%")
                    st.write(f"**{job.title}** @ {job.company}")
                    st.caption(f"{job.location} | {job.source}")
                    st.markdown(f"[Link]({job.url})")
                    if st.button("📉 Analyze Gap", key=f"gap_{job.id}"):
                         with st.spinner("Analyzing..."):
                             desc = f"{job.title} at {job.company} in {job.location}. Technologies: {job.source}"
                             advice = safe_ai_execute(coach.get_advice, st.session_state.get('resume_text',""), desc)
                             if advice: st.info(advice)
                             else: st.rerun()
                    st.divider()

        # --- RIGHT: General Chat ---
        with col_chat:
            st.subheader("� AI Buddy")
            
            user_q = st.text_input("Ask about your career:", placeholder="How can I improve my resume?")
            if user_q and st.button("Ask AI"):
                if coach:
                    # Context Building
                    ctx = ""
                    if 'resume_text' in st.session_state:
                         ctx += f"User Resume Content:\n{st.session_state['resume_text'][:3000]}\n"
                    
                    with st.spinner("Thinking..."):
                        ans = safe_ai_execute(coach.ask_coach, user_q, context=ctx)
                        if ans: st.write(ans)
                        else: st.rerun()
        
        st.markdown("---")
        
        # --- BOTTOM: Job Toolkit (The New Feature) ---
        st.subheader("🛠️ Job Application Toolkit")
        st.caption("Select a specific job from the database to generate targeted content.")
        
        # Fetch recent jobs for context
        jobs_db = session.query(Job).order_by(Job.posted_date.desc()).limit(50).all()
        job_options = {f"{j.id}: {j.title} @ {j.company}": j for j in jobs_db}
        
        selected_job_key = st.selectbox("Select Target Job:", ["-- Select a Job --"] + list(job_options.keys()))
        
        if selected_job_key != "-- Select a Job --":
            target_job = job_options[selected_job_key]
            job_details_str = f"Title: {target_job.title}, Company: {target_job.company}, Location: {target_job.location}, Source: {target_job.source}"
            if target_job.pay:
                job_details_str += f", Pay: {target_job.pay}"
            
            c_a1, c_a2, c_a3, c_a4 = st.columns(4)
            
            with c_a1:
                if st.button("📝 Draft Cover Letter"):
                    with st.spinner("Writing..."):
                        res_text = st.session_state.get('resume_text', "No resume uploaded.")
                        cl = safe_ai_execute(coach.generate_cover_letter, res_text, job_details_str)
                        if cl: st.text_area("Cover Letter", cl, height=400)
                        else: st.rerun()
            
            with c_a2:
                 if st.button("🎤 Interview Prep"):
                     with st.spinner("Preparing..."):
                         q = safe_ai_execute(coach.generate_interview_questions, job_details_str)
                         if q: st.markdown(q)
                         else: st.rerun()

            with c_a3:
                if st.button("👋 Cold Message"):
                     with st.spinner("Drafting..."):
                         msg = safe_ai_execute(coach.generate_cold_message, job_details_str)
                         if msg: st.code(msg, language='text')
                         else: st.rerun()

            with c_a4:
                if st.button("📉 Missing Skills"):
                    with st.spinner("Analyzing Gap..."):
                         res_text = st.session_state.get('resume_text', "")
                         if len(res_text) < 50:
                             st.error("Please upload a resume first!")
                         else:
                              advice = safe_ai_execute(coach.get_advice, res_text, job_details_str)
                              if advice: st.markdown(advice)
                              else: st.rerun()

# Close session
session.close()

# --- LOG VIEWER (Bottom Expander) ---
with st.expander("🛠️ System Logs & Debugging"):
    # Simple hack to show file activity if we were logging to file, 
    # for now we show connectivity status
    st.write("Database: Connected (jobs_v4.db)")
    st.write(f"Scraper Workers: 15 Threads")
    st.write(f"Total Jobs in DB: {new_count + notified_count + archived_count}")


session.close()
