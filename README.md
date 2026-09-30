# World Smart News & Jobs Monitor

A React workspace for job discovery and application preparation, alongside the original world news, jobs and research monitor.

## Start here

Use **Node.js 24+**. The active backend is `backend_node/` (Express), not the older `backend/` FastAPI prototype.

On Windows, run `scripts/start-local.ps1 -Install` from PowerShell in the repository. It installs locked dependencies, creates a local owner key if needed, starts both processes and opens the app. It never overwrites an existing `.env`. See [Windows and deployment setup](DEPLOYMENT_GUIDE.md).

Manual setup, in two terminals:

    cd backend_node
    cp .env.example .env
    # Set PORTAL_ADMIN_TOKEN to a unique random value in .env.
    npm ci
    npm start

    cd frontend
    npm ci
    npm run dev

Open http://localhost:5173. The original news monitor remains available at `?workspace=monitor`.

## Job workflow

1. Connect the owner workspace and upload a résumé.
2. Set location, role keywords, skills, excluded companies, work mode, salary, experience and freshness filters.
3. Add or import career sources. Enable supported official ATS feeds.
4. Run discovery or enable recurring discovery. Matching jobs are deduplicated and stored with evidence.
5. New matches enter the portal and, when configured, a private Slack delivery queue.
6. **AA** prepares factual application answers automatically. **RM** keeps preparation under manual review.
7. Complete employer forms and record confirmation references. Login, CAPTCHA and declarations are not bypassed. This release does not provide universal automatic form submission.
8. Application email drafts require approval of the exact recipient, message, résumé and profile version. AA never approves email. Profile or résumé changes invalidate earlier approvals.

The notice-period default is **60 days**. Private personal details and résumés are never committed to this repository.

## Sources and scale

The directory is designed for **10,000 portal records and 100,000 company records**, with server pagination and batched imports. Capacity is separate from populated coverage or company ranking. The initial directory contains existing repository sources plus selected employer career links; the UI shows actual counts and verification state.

- Automatic ingestion: public Greenhouse, Lever and Ashby job-board feeds.
- Other career pages: links requiring manual verification, not working scrapers.
- Existing monitor registry: 17 job APIs, 57 job RSS feeds, 21 job-board URLs, 252 news feeds and 15 Hacker News queries. These are configured entries, not guarantees of current availability or distinct companies.
- Import CSV or JSON with `name,url,kind,country,sector,enabled`. `kind` is company or portal. Respect source terms and rate limits.
- Source timeouts, bounded concurrency, backoff and run history make failure visible. A real 100,000-company crawl needs reliable authorized data and suitable infrastructure.

## AI and retrieval

**Local retrieval** works without a provider key and exposes evidence. **Qdrant** adds persistent namespaced sparse keyword-vector search using `QDRANT_URL` and a backend-only `QDRANT_API_KEY`. This is lexical vector retrieval, not neural semantic embeddings. SQL remains the authority for current job access and state; provider failure falls back locally.

**Jev** is an optional TypeSafe structured decision model (`TYPESAFE_API_KEY`, `JEV_MODEL=jev-latest`). It assesses skill/experience evidence and review needs. It cannot invent qualifications, override filters or approve email. The existing model router supports configured Gemini, OpenRouter, Hugging Face and Ollama backends; availability depends on actual configuration.

## Architecture

| Component | Role |
| --- | --- |
| frontend/ | React/Vite Jobs workspace and original world monitor |
| backend_node/server.js | Monitor APIs and automation integration mount |
| backend_node/automation/ | Directory, filters, durable workflow, Slack outbox, approvals and retrieval |
| PostgreSQL | Recommended hosted persistence, separate automation tables |
| Node SQLite | Local single-worker fallback, ignored backend_node/data/ |
| smart_job_portal/ | Optional legacy Streamlit app with separate schema |
| backend/ | Older FastAPI prototype |

Recurring work needs an awake backend. A sleeping free service cannot promise hourly alerts. See [architecture and operations](INSTRUCTIONS.md).

## Verification

    npm --prefix backend_node test
    npm --prefix backend_node run check
    npm --prefix frontend run build
    python -m unittest discover -s smart_job_portal/tests -p test_job_retention.py

Tests use isolated stores and mocked providers. Live Slack, Jev, Qdrant and employer submissions need separate configured integration checks. Test results are never represented as successful production actions.

## Daily World Intelligence

The World news monitor now keeps one persistent conversation rather than a growing set of daily sessions. News URLs are deduplicated, source history expires after seven days, and the session holds at most 80 sources and 40 messages. **Clear older updates** keeps the latest brief, up to 20 recent sources and the latest exchange. Refreshing the monitor does not restore cleared older snapshots. The public view exposes only the brief and source links; reading or writing the conversation requires owner access.

The brief is a digest of source headlines, not a claim that full articles were read. Optional model answers cite the supplied headlines and fall back to the source digest on invalid output or provider failure. The existing `/api/ai-insights` endpoint reads this same session rather than generating another model answer on every dashboard poll. News database retention uses publication/first-seen time, so repeatedly fetching an old story cannot keep it forever.
