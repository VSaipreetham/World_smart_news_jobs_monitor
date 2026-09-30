import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { automationApi, getOwnerKey, hasOwnerKey, setOwnerKey } from '../src/automationApi.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete globalThis.__WORLD_JOBS_PREVIEW__;
  setOwnerKey('');
});

test('private requests carry the in-memory key; locking removes it', async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return Response.json({ ok: true });
  };
  setOwnerKey('  unit-test-owner-key  ');
  assert.equal(hasOwnerKey(), true);
  assert.equal(getOwnerKey(), 'unit-test-owner-key');
  await automationApi('/settings', { method: 'PUT', body: { mode: 'AA' } });
  assert.equal(requests[0].options.headers.Authorization, 'Bearer unit-test-owner-key');
  assert.deepEqual(JSON.parse(requests[0].options.body), { mode: 'AA' });
  setOwnerKey('');
  await automationApi('/summary');
  assert.equal(requests[1].options.headers.Authorization, undefined);
});

test('writes are not retried after an uncertain network failure', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Connection dropped after request'); };
  await assert.rejects(automationApi('/drafts/example/send', { method: 'POST', body: { digest: 'reviewed' } }), /Connection dropped/);
  assert.equal(calls, 1);
});

test('authorization errors preserve status and the server message', async () => {
  globalThis.fetch = async () => Response.json({ error: 'Owner access is required.' }, { status: 401 });
  await assert.rejects(automationApi('/profile'), error => error.status === 401 && error.message === 'Owner access is required.');
});

test('resume uploads let the browser set the multipart content type', async () => {
  const body = new FormData(); body.append('file', new Blob(['resume evidence']), 'resume.txt');
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.body, body);
    assert.equal(options.headers['Content-Type'], undefined);
    return Response.json({ resumeName: 'resume.txt' });
  };
  assert.equal((await automationApi('/resume', { method: 'POST', body })).resumeName, 'resume.txt');
});

test('read-only preview filters real supplied rows without network access or writes', async () => {
  globalThis.fetch = async () => { throw new Error('Preview must not contact external services'); };
  globalThis.__WORLD_JOBS_PREVIEW__ = { rows: [
    { id: '1', name: 'First company', kind: 'company', provider: 'lever', url: 'https://example.com/first' },
    { id: '2', name: 'Second portal', kind: 'portal', provider: 'manual', url: 'https://example.com/second' },
  ] };
  const summary = await automationApi('/summary');
  assert.equal(summary.counts.directory, 2);
  assert.equal(summary.counts.jobs, 0);
  assert.equal(summary.capacity.companies, 100000);
  const result = await automationApi('/directory?search=first&kind=company&page=1&limit=20');
  assert.equal(result.total, 1);
  assert.equal(result.rows[0].id, '1');
  await assert.rejects(automationApi('/run', { method: 'POST' }), /read-only preview/);
  await assert.rejects(automationApi('/profile'), /Private data/);
});
