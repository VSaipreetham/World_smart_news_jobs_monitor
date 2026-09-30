# Validation — 27 September 2026

- Backend: 38 Node tests pass, including a real temporary HTTP server and SQLite database.
- Frontend: 8 tests pass; Vite production build succeeds.
- Optional Streamlit: 7 retention and notification-approval tests pass using mocked services.
- Patch applies cleanly to upstream snapshot `0b678365e021e377ae6e18fe2acdefe283ed4c6b`.
- Added-line scan found no supplied personal contact details, address, Slack token or JWT key.

Verified behavior includes a persistent intelligence session, private chat history, source deduplication, seven-day retention, bounded context, cleanup that does not restore old snapshots, request idempotency, asynchronous discovery, application preservation, and exact-content email approval.

External provider tests use mocks. No real email, application or Slack message was sent during testing. Live Qdrant/Jev/Slack/Gmail connections are not certified by these tests. The UI has not passed a browser-rendered visual test in this environment: the test-browser download returned an invalid archive. The optional globe is still a large lazy-loaded bundle; the job workspace loads separately.

GitHub publishing was attempted and rejected with HTTP 403, “Resource not accessible by integration.” No remote commit, branch or deployment was created. The local patch and setup guide contain the complete changes. The read-only preview uses the real component and 117 seed directory entries; it blocks external network connections and contains no personal profile or live jobs.
