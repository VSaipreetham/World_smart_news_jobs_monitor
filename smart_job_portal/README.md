# 🚀 Smart Job Portal V3
[![Live Demo](https://img.shields.io/badge/Live-Streaming-brightgreen)](https://saipreethamjobportapp.streamlit.app/)

[View Live Streaming Demo](https://saipreethamjobportapp.streamlit.app/)

A powerful, AI-driven local job aggregator and career assistant. This dashboard consolidates job listings from multiple sources (LinkedIn, Naukri), manages your applications, and provides advanced AI analytics using Google Gemini.

![Architecture Diagram](architecture_diagram_v2.png)

## 🌟 Features

### 🔍 Smart Job Aggregation
- **Unified Inbox**: View jobs from LinkedIn and Naukri in a single, clean dashboard.
- **Advanced Filtering**: Filter by Source, Location, Date, and Keywords.
- **Timezone Converter**: Built-in tool to convert global meeting times to IST (including Chicago, London, Tokyo, etc.).

### 🤖 AI Career Coach (Powered by Gemini 1.5)
- **RAG Market Intelligence**: Chat with your job database! Ask questions like *"Which companies are offering remote Python roles?"* and get answers based on real data.
- **Global Skill Gap Analysis**: Analyze your resume against the top 20 relevant jobs in your inbox to identify missing skills.
- **Resume Matching**: Score your resume against specific job descriptions.
- **Application Toolkit**:
    - Draft tailored **Cover Letters**.
    - Generate **Interview Questions** based on company culture.
    - Create **Cold Outreach Messages**.

### 📊 Analytics & Insights
- **Market Trends**: Visualize top hiring companies, in-demand technologies, and salary estimates.
- **Application Tracker**: Kan-ban style tracking (Applied, Interview, Offer, Rejected).
- **Hourly Trends**: See when new jobs are posted.

### ⚙️ Automation
- **Background Scrapers**: Automatically fetches new jobs periodically.
- **Google Calendar Integration**: Auto-schedule interviews or reminders.
- **Email Notifications**: Get "Drip Feed" summaries of top jobs.

---

## 🏗️ Architecture

The system is built on a modular "Lakehouse" architecture:

- **Frontend**: Streamlit (Python-based UI).
- **Database**: SQLite (SQLAlchemy ORM) - Stores jobs, logs, and application history.
- **AI Engine**: 
    - **Embeddings**: `sentence-transformers` for semantic search.
    - **LLM**: Google Gemini API for reasoning and content generation.
- **Scrapers**: Selenium/BeautifulSoup independent workers.

---

## 🛠️ Setup & Installation

### 1. Prerequisites
- Python 3.9+ installed.
- Valid Google Gemini API Key.
- (Optional) Google Cloud Credentials for Calendar integration.

### 2. Installation
```bash
# Clone repository
git clone <repo_url>
cd smart_job_portal

# Install dependencies
pip install -r requirements.txt
```

### 3. Environment Configuration
Create a `.env` file in the root directory:
```env
Google_token=YOUR_GEMINI_API_KEY
# Optional: Email configuration for notifications
EMAIL_USER=your_email@gmail.com
EMAIL_PASS=your_app_password
```

### 4. Running the App
```bash
streamlit run app.py
```
The application will launch at `http://localhost:8501`.

---

## 📂 Project Structure

- `app.py`: Main Streamlit application entry point.
- `ai_service.py`: Core AI logic (Embeddings, RAG, Gemini Client).
- `models.py`: Database schema (SQLAlchemy).
- `scrapers/`: Folder containing scraper scripts.
- `jobs_v4.db`: Local SQLite database.

---

## 📸 Screenshots

### Application Portal
<img width="100%" alt="Application Portal" src="https://github.com/user-attachments/assets/1f474edf-a199-4f1c-bc5a-ba720187058c" />

### Filter Search
<img width="100%" alt="Filter Search" src="https://github.com/user-attachments/assets/f4699b18-786a-4c35-823e-82ec4f160d95" />

### Source Search
<img width="100%" alt="Source Search" src="https://github.com/user-attachments/assets/9a839f53-1eaf-4569-9866-dcc28fbf4cc7" />

### AI RAG Based Companion
<img width="100%" alt="AI RAG Companion" src="https://github.com/user-attachments/assets/5f416f14-2608-43e0-9cd6-60244cd222b9" />

### RAG Based Resume Upload & Skill Analysis
<img width="100%" alt="Resume Analysis" src="https://github.com/user-attachments/assets/b640955e-f0bb-472d-8dea-5540d247988d" />

---

*Built with ❤️ for generic career optimization.*
