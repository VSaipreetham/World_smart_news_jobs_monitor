# Architecture and operations

Two React views share the Express backend: Jobs and the original world monitor. The job workflow is part of this repository and preserves the news pipeline.

    React owner workspace -> protected API -> profile and résumé
    Official ATS feeds -> normalize -> filters -> persistent dedupe -> matches
    Matches -> AA preparation or RM review -> employer form completion
    Matches -> durable Slack outbox -> configured private channel
    Matches -> Qdrant/local evidence retrieval -> cited research answers
    Candidate evidence -> optional Jev assessment -> review requirements
    Email draft -> explicit content-bound approval -> configured transport

## Trust boundaries

Public directory records contain career URLs. Profiles, résumés, preferences, matches, applications, drafts and mutations require the owner key. This is a single-owner application, not multi-user SaaS authentication. Do not share the owner key with untrusted users.

External job descriptions are evidence, never instructions. ATS URLs are constructed from supported providers with timeouts and budgets. Neither Jev nor AA grants email permission. Keys stay on the backend, never in React, browser storage, public source records or Slack messages.

## Recovery and lifecycle

Canonical URLs identify jobs. Source refreshes preserve application progress. A worker lease prevents overlapping cycles. Slack uses a durable outbox and stable message identifiers; ambiguous delivery requires careful recovery and does not imply exactly-once third-party delivery.

Email approval binds recipient, subject, body, résumé hash and profile revision. An uncertain send is not retried automatically. Verify the sent folder first. Ready means a packet is prepared, not submitted; an employer confirmation reference is required to record applied.

Qdrant is an index, not the source of truth. Results must be checked against current authorized SQL job records. Local retrieval remains available during provider failure. Jev output is validated and cannot weaken rules.

Directory capacity is not a verified ranking of the top 100,000 companies. Import licensed records with official career URLs. There are no generated placeholder companies to fill counts.

## Hosting

- Scheduling requires an awake process. Source interval is a minimum cadence; backlog and failure affect latency.
- Use PostgreSQL for hosted persistence. SQLite requires a persistent volume and one worker.
- The optional Streamlit ORM has different status/timestamp types; use a separate database until a reviewed migration exists.
- Retention preserves application history, notes, follow-ups and notification logs.
- Rotate keys shared in chat before production. Never commit .env, local databases, credentials or résumés.
- Set CORS_ORIGINS to your frontend origin. DISABLE_BACKGROUND_JOBS=true disables recurring work for tests.

## Release validation

Run tests and the production build. Then verify the private Slack destination and an explicitly authorized alert, configured Jev responses, and Qdrant index/query operations against the actual cluster. Verify email only with a reviewed and approved draft. The app must never report success from merely starting an HTTP request.
