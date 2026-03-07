# 🌍 End-to-End Cloud Deployment Guide

Since Docker is not installed on your machine, you can simply deploy this application to **100% Free Tier Cloud Providers** (Render and Vercel) completely automatically via your GitHub repository.

## 🚀 1. Deploy the Backend APIs (Render)

Render can handle both your **Node.js API Server** and your **Streamlit Smart Job Portal**, giving them a public secure HTTPS API link.

1. Go to [Render.com](https://render.com/) and sign in with GitHub.
2. Click **New +** and select **Blueprint**.
3. Connect your GitHub repository (`VSaipreetham/World_smart_news_jobs_monitor`).
4. Render will automatically detect the `render.yaml` file I just generated for you and deploy BOTH the Node.js API and the Python Portal!
5. **CRITICAL:** Once deployed, click on the **Dashboard** for `monitor-backend`, go to **Environment**, and paste in your tokens from your `.env` file (like `DATABASE_URL` and your openrouter keys).
6. Copy the public URL of your newly launched backend API (e.g., `https://monitor-backend-xxxxx.onrender.com`).

---

## 💻 2. Deploy the Frontend (Vercel)

Vercel is the fastest way to host the 3D globe visualization UI. 

1. Go to [Vercel.com](https://vercel.com) and sign in with GitHub.
2. Click **Add New** -> **Project**.
3. Import your `World_smart_news_jobs_monitor` repository.
4. **Important Configurations**:
   - In the **Framework Preset**, select **Vite**.
   - **Root Directory**: Click "Edit" and change it to **`frontend`** (very important).
   - Expand the **Environment Variables** section and add:
     - Name: `VITE_API_BASE_URL`
     - Value: `(Paste your Render.com backend URL you copied from Step 1)`
5. Click **Deploy**.

🎉 **That's it!** The full app is now live on the internet, automatically syncing jobs every 10 minutes into Neon DB, and reading insights from the AI APIs!
