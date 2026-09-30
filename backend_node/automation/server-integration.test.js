'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

test('integrated server protects mutations and exposes the real directory without a hosted database', { timeout: 30000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'world-jobs-test-'));
  const reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), DATABASE_URL: '', DISABLE_BACKGROUND_JOBS: 'true', PORTAL_ADMIN_TOKEN: 'isolated-test-owner',
      AUTOMATION_DB_PATH: path.join(temp, 'automation.sqlite'), SLACK_BOT_TOKEN: '', SLACK_CHANNEL_ID: '', QDRANT_URL: '', QDRANT_API_KEY: '', TYPESAFE_API_KEY: '', GMAIL_ACCESS_TOKEN: '' },
  });
  let exited = false; child.on('exit', () => { exited = true; });
  child.stdout.resume(); child.stderr.resume();
  const base = `http://127.0.0.1:${port}`;
  const owner = { Authorization: 'Bearer isolated-test-owner' };
  try {
    let ready;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (exited) throw new Error('Backend exited during startup');
      try { const response = await fetch(`${base}/api/automation/summary`); if (response.ok) { ready = await response.json(); break; } } catch { /* startup */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'automation initialized');
    assert.equal(ready.capacity.companies, 100000);
    assert.ok(ready.directory.reduce((n, row) => n + Number(row.n), 0) > 90);
    assert.equal((await fetch(`${base}/api/automation/profile`)).status, 401);
    assert.equal((await fetch(`${base}/api/jobs/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/api/portal-export.csv`)).status, 401);
    const unavailable = await fetch(`${base}/api/portal-jobs`, { headers: owner });
    assert.equal(unavailable.status, 503, 'database failures are not empty successes');
    const profile = await (await fetch(`${base}/api/automation/profile`, { headers: owner })).json();
    assert.equal(profile.noticeDays, 60);
    const directory = await (await fetch(`${base}/api/automation/directory?limit=3&page=1`)).json();
    assert.equal(directory.rows.length, 3);
    assert.ok(directory.total > 90);
    const error = await fetch(`${base}/api/automation/profile`, { method: 'PUT', headers: { ...owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ noticeDays: -10 }) });
    assert.ok(error.status >= 400);
    const intelligence = await (await fetch(`${base}/api/intelligence/session`)).json();
    assert.equal(intelligence.id, 'daily-world-intelligence');
    assert.equal(intelligence.ownerRequired, true);
    assert.equal((await fetch(`${base}/api/intelligence/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Unauthorized question' }) })).status, 401);
    const answer = await (await fetch(`${base}/api/intelligence/messages`, { method: 'POST', headers: { ...owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'What is new?', requestId: 'http-request-one' }) })).json();
    assert.equal(answer.messages.length, 2);
    const resumed = await (await fetch(`${base}/api/intelligence/session`, { headers: owner })).json();
    assert.equal(resumed.messages[0].content, 'What is new?');
    assert.equal((await (await fetch(`${base}/api/intelligence/session`)).json()).messages.length, 0);
    const retry = await (await fetch(`${base}/api/intelligence/messages`, { method: 'POST', headers: { ...owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'What is new?', requestId: 'http-request-one' }) })).json();
    assert.equal(retry.messages.length, 2);
    assert.equal((await fetch(`${base}/api/intelligence/cleanup`, { method: 'POST', headers: owner })).status, 200);
  } finally {
    if (!exited) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    await rm(temp, { recursive: true, force: true });
  }
});
