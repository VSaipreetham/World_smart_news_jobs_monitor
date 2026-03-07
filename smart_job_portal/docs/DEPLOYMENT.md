# Deploying Smart Job Portal

This guide provides two methods to deploy the application:
1. **Streamlit Cloud** (Easiest, free).
2. **Docker / Cloud Platform** (Robust, persistent data).

---

## Option 1: Streamlit Cloud (Recommended for Testing)

Streamlit Cloud is the easiest way to host this app for free.
*Note: Since this app uses a local SQLite database (`jobs_v4.db`), your data may reset if the app goes to sleep or restarts. For persistent production use, see Option 2.*

### Steps:
1.  **Push your code to GitHub** (You just did this!).
2.  Go to [share.streamlit.io](https://share.streamlit.io/).
3.  Login with GitHub.
4.  Click **"New app"**.
5.  Select your repository (`Smart_RAG_Job_Portal`) and branch (`main`).
6.  Main file path: `app.py`.
7.  Click **"Deploy!"**.

### **Secrets Setup (IMPORTANT)**:
For the AI features and database to work, you need to set your environment variables in Streamlit Cloud.
1.  Go to your app's dashboard on Streamlit Cloud.
2.  Click **Manage App** (bottom right menu) -> **Settings** -> **Secrets**.
3.  Add your secrets like this:
    ```toml
    Google_token = "YOUR_GEMINI_API_KEY_HERE"
    ```
4.  Save. The app will reboot and AI features will work.

---

## Option 2: Docker / Railway / Render (Production)

For a persistent app where your job history is saved permanently, use a platform that supports Docker and storage volumes.

### Deploy on Railway.app (Easiest Docker Host)
1.  Login to [Railway](https://railway.app/).
2.  Click **New Project** -> **Deploy from GitHub repo**.
3.  Select your `Smart_RAG_Job_Portal` repo.
4.  Railway will automatically detect the `Dockerfile` and start building.
5.  **Variables**: Go to the "Variables" tab and add:
    - `Google_token`: Your Gemini API Key.
6.  **Persistence (Optional)**: To keep your SQLite DB safe, you can add a Volume in Railway's settings and mount it to `/app` (or switch the code to use a hosted PostgreSQL database in `models.py`).

### Local Docker Run
If you want to run it on your own server or laptop in a container:
```bash
# Build
docker build -t job-portal .

# Run (map port 8501)
docker run -p 8501:8501 -e Google_token="your_key" job-portal
```

---

## Troubleshooting

- **Memory Issues**: The app uses `torch` and `sentence-transformers` for AI. These can be heavy.
    - If Streamlit Cloud crashes, try removing `sentence-transformers` from requirements and using a lighter model, or upgrade your resource limits on a paid platform.
- **Database Resets**: As mentioned, SQLite files are ephemeral on many cloud platforms. If you lose data on restart, this is expected behavior for file-based DBs on cloud functions. Move to a cloud database (Supabase, Neon, AWS RDS) for true production persistence.
