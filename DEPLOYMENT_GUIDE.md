# Windows setup and deployment

## Your local checkout

    C:\Users\wwwsa\OneDrive\Desktop\Projects\World_smart_news_jobs_monitor

Install Node.js 24+ and Git. Keep .env and private runtime data out of shared folders. The following commands do not overwrite unrelated edits:

    Set-Location 'C:\Users\wwwsa\OneDrive\Desktop\Projects\World_smart_news_jobs_monitor'
    git status --short
    git switch -c feat/job-automation-harness
    git apply --check "$env:USERPROFILE\Downloads\world-smart-jobs.patch"
    git apply "$env:USERPROFILE\Downloads\world-smart-jobs.patch"
    .\scripts\start-local.ps1 -Install

If the branch exists, switch to it. If the patch check fails, reconcile changes instead of resetting work. The launcher creates backend_node/.env only if absent, generates a local owner key and opens http://localhost:5173. Copy PORTAL_ADMIN_TOKEN from that file privately into Connect workspace. No key is printed. The browser holds it in memory for this session only.

## Integration setup

Edit backend_node/.env or hosting secret settings, then restart the backend. The Node service reads its own environment only; it does not import credentials from the legacy backend or Streamlit app.

| Service | Backend variables | Setup |
| --- | --- | --- |
| Owner | PORTAL_ADMIN_TOKEN | Unique random secret; never your Gmail password |
| Database | DATABASE_URL | Persistent PostgreSQL recommended for hosting |
| Slack | SLACK_BOT_TOKEN, SLACK_CHANNEL_ID | Invite bot to private channel; grant private-channel metadata and chat writing access |
| Qdrant | QDRANT_URL, QDRANT_API_KEY | HTTPS cluster origin and newly rotated key; collection/index permissions |
| Jev | TYPESAFE_API_KEY, JEV_MODEL | TypeSafe account; default jev-latest |
| Generative model | Existing Gemini/OpenRouter/Ollama/Hugging Face variables | Configure chosen providers |
| Email | GMAIL_ACCESS_TOKEN | OAuth send permission; no passwords; expired tokens need replacement |

Qdrant's key alone is insufficient; provide its cluster URL. No secrets belong in VITE_* variables, which become public browser code.

Upload your résumé, confirm 60-day notice, set filters and enable a supported source. Run discovery once before enabling the recurring worker and Slack. AA prepares answers; employer form completion is tracked separately. Every outgoing email requires explicit approval.

## Hosting

Frontend: build frontend/ with npm ci and npm run build. Set VITE_API_BASE_URL to the backend HTTPS origin before building, or proxy /api to it.

Backend: Node 24, persistent PostgreSQL and an awake service/worker. Set PORTAL_ADMIN_TOKEN, DATABASE_URL, CORS_ORIGINS and desired integrations. A sleeping free service cannot promise hourly alerts. Ephemeral SQLite loses state.

Existing Render and Vercel configuration remains available. Source changes are not automatically a deployed service. Configure credentials, databases, hosting plans and environment settings on the provider.

Docker: docker compose up --build frontend backend. The optional Streamlit service uses the legacy profile and needs its own database and .env.

## Verification

    npm --prefix backend_node test
    npm --prefix backend_node run check
    npm --prefix frontend run build

Keep the original résumé and genuine employer confirmation receipts.

## Continue from the delivered patch

The patch is based on upstream main commit `0b678365e021e377ae6e18fe2acdefe283ed4c6b`. In your existing Windows checkout, first commit or stash unrelated edits, then run:

```powershell
git switch -c feat/job-automation-intelligence-session
git apply --check "$HOME\Downloads\world-smart-jobs.patch"
git apply "$HOME\Downloads\world-smart-jobs.patch"
powershell -ExecutionPolicy Bypass -File .\scripts\start-local.ps1 -Install
```

Run `npm --prefix backend_node test`, `npm --prefix frontend test`, and `npm --prefix frontend run build` before publishing. Once satisfied, use `git add .`, `git commit -m "Add job automation and persistent world intelligence"`, and `git push -u origin feat/job-automation-intelligence-session`. Do not stage `.env`, uploaded resumes, or private database files.

Daily World Intelligence uses the same durable automation store as the job workspace. Its fixed session survives backend restarts; seven-day retention is applied when read or updated. Owner access is required for chat history, questions, and cleanup. Local test coverage uses an actual temporary HTTP server/database and mocked external providers. Real Slack, Gmail, Qdrant and Jev need separately configured credentials; passing local tests does not confirm those external integrations.
