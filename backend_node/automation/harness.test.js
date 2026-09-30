'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('./store');
const { Harness } = require('./harness');
const { createAutomation, parseResume } = require('./routes');
const { toMime } = require('./mailer');

const source = { id: 'fixture-source', name: 'Fixture Employer', provider: 'lever', board: 'fixture', url: 'https://jobs.lever.co/fixture' };
const rawJob = (id = 'one') => ({ title: 'Generative AI Engineer', company: source.name, url: `https://jobs.lever.co/fixture/${id}`, location: 'Hyderabad', description: '3 years of experience with Python, RAG, LangGraph and production GenAI.', salaryText: '30–40 LPA', verifiedAt: new Date().toISOString(), provider: 'lever', board: 'fixture' });
const exampleProfile = { firstName: 'Test', lastName: 'Applicant', email: 'applicant@example.com', phone: '+910000000000', city: 'Hyderabad', company: 'Fixture Company', experienceYears: 3, skills: ['Python', 'RAG', 'LangGraph'], noticeDays: 60 };
const resume = { buffer: Buffer.from('A truthful fixture resume.'), name: 'resume.txt', type: 'text/plain' };

async function setup(t, options = {}) {
  const store = new Store({ filename: ':memory:' }); await store.init();
  const engine = new Harness(store, { env: {}, jev: { configured: false }, qdrant: { configured: false }, ...options });
  t.after(async () => { engine.stop(); await store.close(); });
  return { store, engine };
}

async function fixtureDraft(engine) {
  await engine.saveProfile(exampleProfile, resume);
  await engine.ingest([rawJob()], source);
  const job = (await engine.matches()).jobs[0];
  return engine.createDraft({ jobId: job.id, recipient: 'careers@example.com', subject: 'Application for Generative AI Engineer', body: 'Please review my attached resume. My notice period is 60 days.' });
}

test('canonical deduplication persists exactly one job and one durable Slack event', async t => {
  const { engine, store } = await setup(t);
  await engine.saveSettings({ slackEnabled: true });
  const first = await engine.ingest([rawJob()], source);
  const again = await engine.ingest([{ ...rawJob(), url: `${rawJob().url}/apply?utm_source=alert` }], source);
  assert.equal(first.added, 1); assert.equal(again.duplicate, 1);
  assert.equal((await engine.matches()).total, 1);
  assert.equal((await store.query('SELECT * FROM automation_outbox')).rows.length, 1);
});

test('a Slack outbox failure rolls the new job back so the next run can retry atomically', async t => {
  const { engine, store } = await setup(t);
  await engine.saveSettings({ slackEnabled: true });
  await store.query("CREATE TRIGGER reject_outbox BEFORE INSERT ON automation_outbox BEGIN SELECT RAISE(ABORT, 'fixture error'); END");
  await assert.rejects(engine.ingest([rawJob()], source));
  assert.equal((await engine.matches()).total, 0);
  await store.query('DROP TRIGGER reject_outbox');
  assert.equal((await engine.ingest([rawJob()], source)).added, 1);
});

test('AA prepares truthful packets without claiming submission and default notice is 60 days', async t => {
  const { engine } = await setup(t);
  assert.equal((await engine.profile()).noticeDays, 60);
  await engine.saveSettings({ mode: 'AA' });
  await engine.saveProfile(exampleProfile, resume);
  await engine.ingest([rawJob()], source);
  const job = (await engine.matches()).jobs[0];
  assert.equal(job.state, 'ready');
  assert.equal(job.evaluation.packet.submission, 'not_submitted');
  assert.equal(job.evaluation.packet.answers.noticeDays, 60);
  await assert.rejects(engine.transition(job.id, { state: 'applied' }), /confirmation or receipt/);
  await assert.rejects(engine.saveProfile({ noticeDays: -1 }), /between/);
});

test('all email sends require exact approval and edits revoke approval', async t => {
  let sends = 0;
  const { engine } = await setup(t, { mailer: { configured: true, send: async () => { sends++; return { id: 'fixture-mail-1' }; } } });
  const draft = await fixtureDraft(engine);
  await assert.rejects(engine.sendDraft(draft.id, draft.digest), /Explicit approval/);
  await assert.rejects(engine.approveDraft(draft.id, 'not-this-digest'), /changed/);
  await engine.approveDraft(draft.id, draft.digest);
  const edited = await engine.editDraft(draft.id, { recipient: 'other@example.com' });
  assert.notEqual(edited.digest, draft.digest);
  await assert.rejects(engine.sendDraft(draft.id, draft.digest), /Explicit approval/);
  await engine.approveDraft(edited.id, edited.digest);
  const sent = await engine.sendDraft(edited.id, edited.digest);
  assert.equal(sent.state, 'sent');
  assert.equal((await engine.sendDraft(edited.id, edited.digest)).duplicatePrevented, true);
  assert.equal(sends, 1);
});

test('profile and resume revisions revoke pending approvals', async t => {
  const { engine } = await setup(t, { mailer: { configured: true, send: async () => ({ id: 'should-not-send' }) } });
  const draft = await fixtureDraft(engine);
  await engine.approveDraft(draft.id, draft.digest);
  await engine.saveProfile({ noticeDays: 90 });
  assert.equal((await engine.draft(draft.id)).state, 'stale');
  await assert.rejects(engine.sendDraft(draft.id, draft.digest), /Explicit approval/);
  const refreshed = await engine.editDraft(draft.id, { body: 'Notice period now 90 days.' });
  await engine.approveDraft(refreshed.id, refreshed.digest);
  await engine.saveProfile({}, { ...resume, buffer: Buffer.from('A newly revised truthful resume') });
  await assert.rejects(engine.sendDraft(refreshed.id, refreshed.digest), /Explicit approval/);
});

test('concurrent delivery is claimed once and profile writes cannot race an in-flight send', async t => {
  let start, finish, sends = 0;
  const started = new Promise(resolve => { start = resolve; });
  const finished = new Promise(resolve => { finish = resolve; });
  const { engine } = await setup(t, { mailer: { configured: true, send: async () => { sends++; start(); await finished; return { id: 'single-send' }; } } });
  const draft = await fixtureDraft(engine);
  await engine.approveDraft(draft.id, draft.digest);
  const first = engine.sendDraft(draft.id, draft.digest); await started;
  await assert.rejects(engine.sendDraft(draft.id, draft.digest), /Explicit approval/);
  await assert.rejects(engine.saveProfile({ noticeDays: 90 }), /being delivered/);
  finish(); await first;
  assert.equal(sends, 1);
});

test('uncertain delivery is never automatically retried or reset on initialization', async t => {
  let sends = 0;
  const { engine, store } = await setup(t, { mailer: { configured: true, send: async () => { sends++; throw new Error('Timeout after possible acceptance'); } } });
  const draft = await fixtureDraft(engine); await engine.approveDraft(draft.id, draft.digest);
  await assert.rejects(engine.sendDraft(draft.id, draft.digest), /not be retried automatically/);
  assert.equal((await engine.draft(draft.id)).state, 'needs_verification');
  await store.init(); await engine.recoverExpired();
  await assert.rejects(engine.sendDraft(draft.id, draft.digest), /Explicit approval/);
  assert.equal(sends, 1);
});

test('Slack transport verifies its private channel and sends one receipt for two discoveries', async t => {
  let posts = 0;
  const { engine, store } = await setup(t, { env: { SLACK_BOT_TOKEN: 'fixture-slack-token', SLACK_CHANNEL_ID: 'C123ABC' }, fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error');
    if (url.includes('conversations.info')) return Response.json({ ok: true, channel: { id: 'C123ABC', is_private: true, is_member: true } });
    posts++; const message = JSON.parse(options.body);
    assert.equal(message.channel, 'C123ABC'); assert.ok(!message.text.includes('applicant@example.com'));
    return Response.json({ ok: true, ts: '1.000001' });
  } });
  await engine.saveSettings({ slackEnabled: true });
  await engine.ingest([rawJob(), rawJob()], source);
  await engine.flushAlerts(); await engine.flushAlerts();
  assert.equal(posts, 1);
  assert.equal((await store.query('SELECT state FROM automation_outbox')).rows[0].state, 'sent');
});

test('worker lease prevents concurrent runs and source cursors prevent budget starvation', async t => {
  const { engine, store } = await setup(t, { boardReader: async () => [rawJob('one'), rawJob('two'), rawJob('three')] });
  await store.query('INSERT INTO automation_directory(id,name,url,kind,provider,board,enabled) VALUES(?,?,?,?,?,?,1)', [source.id, source.name, source.url, 'company', source.provider, source.board]);
  await engine.saveSettings({ maxJobsPerRun: 1 });
  assert.equal(await store.acquire('other-worker'), true);
  assert.equal((await engine.cycle()).state, 'busy');
  await store.release('other-worker');
  await engine.cycle(); await engine.cycle(); await engine.cycle();
  assert.equal((await engine.matches()).total, 3);
});

test('Jev decisions retry provider failures and invalidate changed job evidence', async t => {
  let decisions = 0;
  const { engine } = await setup(t, { jev: { configured: true, evaluate: async () => {
    decisions++;
    return decisions === 1 ? { status: 'unavailable', review: true } : { status: 'evaluated', review: false, confidence: 0.95 };
  } } });
  await engine.saveProfile(exampleProfile, resume);
  const settings = await engine.saveSettings({ useJev: true, mode: 'AA' });
  const context = () => ({ settings, profile: null, jevUsed: 0 });
  const ingest = async raw => { const value = context(); value.profile = await engine.profile(); return engine.ingest([raw], source, value); };
  assert.equal((await ingest(rawJob())).prepared, 0);
  const first = (await engine.matches()).jobs[0];
  const manual = await engine.prepare(first.id);
  assert.equal(manual.state, 'needs_input');
  assert.match(manual.missing.join(' '), /Jev decision/);
  assert.equal((await ingest(rawJob())).prepared, 1);
  await ingest(rawJob()); assert.equal(decisions, 2);
  await ingest({ ...rawJob(), description: `${rawJob().description} Additional evaluation and deployment ownership.` });
  assert.equal(decisions, 3);
});

test('discovery preserves reviewed state and current manual preparation in RM', async t => {
  const { engine } = await setup(t);
  await engine.saveProfile(exampleProfile, resume);
  await engine.ingest([rawJob()], source);
  const job = (await engine.matches()).jobs[0];
  const prepared = await engine.prepare(job.id);
  assert.equal(prepared.state, 'ready');
  await engine.ingest([rawJob()], source);
  assert.equal((await engine.getMatch(job.id)).state, 'ready');
  await engine.transition(job.id, { state: 'review', note: 'Review the employer form before applying.' });
  await engine.ingest([rawJob()], source);
  assert.equal((await engine.getMatch(job.id)).state, 'review');
});

test('incomplete board snapshots do not close saved jobs and reports count only ready packets', async t => {
  const incomplete = []; incomplete.complete = false;
  let data = [rawJob()];
  const { engine, store } = await setup(t, { boardReader: async () => data });
  await store.query('INSERT INTO automation_directory(id,name,url,kind,provider,board,enabled) VALUES(?,?,?,?,?,?,1)', [source.id, source.name, source.url, 'company', source.provider, source.board]);
  await engine.saveSettings({ mode: 'AA' });
  const result = await engine.cycle();
  assert.equal(result.added, 1); assert.equal(result.prepared, 0);
  const job = (await engine.matches()).jobs[0];
  assert.equal(job.state, 'needs_input');
  data = incomplete; await store.query('UPDATE automation_directory SET due_at=0');
  await engine.cycle(); assert.equal((await engine.getMatch(job.id)).state, 'needs_input');
  data = []; await store.query('UPDATE automation_directory SET due_at=0');
  await engine.cycle(); assert.equal((await engine.getMatch(job.id)).state, 'closed');
});

test('POST run returns promptly and status follows the asynchronous worker', async t => {
  const express = require('express');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { engine, store } = await setup(t, { boardReader: async () => { await gate; return [rawJob()]; } });
  const automation = createAutomation({ store, harness: engine, env: { PORTAL_ADMIN_TOKEN: 'fixture-owner-key' } });
  await automation.init();
  const app = express(); app.use(express.json()); app.use('/api/automation', automation.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/automation`;
  const headers = { Authorization: 'Bearer fixture-owner-key' };
  const response = await fetch(`${url}/run`, { method: 'POST', headers });
  assert.equal(response.status, 202);
  const run = await response.json(); assert.equal(run.state, 'queued'); assert.ok(run.id);
  const second = await (await fetch(`${url}/run`, { method: 'POST', headers })).json();
  assert.equal(second.state, 'busy'); assert.equal(second.id, run.id);
  assert.equal((await (await fetch(`${url}/status`, { headers })).json()).running, true);
  release();
  let state;
  for (let attempts = 0; attempts < 100; attempts++) {
    state = await (await fetch(`${url}/runs/${run.id}`, { headers })).json();
    if (!['queued', 'running'].includes(state.state)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(state.state, 'completed'); assert.equal(state.body.added, 1);
  assert.equal((await fetch(`${url}/runs/${run.id}`)).status, 401);
});

test('Qdrant failures fall back to local evidence and stale vector payloads are not trusted', async t => {
  const { engine } = await setup(t, { qdrant: { configured: true, search: async () => { throw new Error('Cluster offline'); } } });
  await engine.saveSettings({ useQdrant: true });
  await engine.ingest([rawJob()], source);
  const fallback = await engine.ask('Python RAG');
  assert.equal(fallback.retrieval, 'local lexical evidence');
  assert.equal(fallback.citations.length, 1);
  const id = (await engine.matches()).jobs[0].id;
  engine.qdrant.search = async () => [{ id, namespace: 'jobs', text: 'Forged stale salary of 9999 LPA', title: 'Forged' }];
  const result = await engine.ask('Python RAG');
  assert.equal(result.retrieval, 'Qdrant sparse keyword retrieval');
  assert.ok(!result.answer.includes('9999'));
});

test('owner guard protects profile and mutations while the directory remains public', async t => {
  const express = require('express');
  const { engine, store } = await setup(t);
  const automation = createAutomation({ store, harness: engine, env: { PORTAL_ADMIN_TOKEN: 'fixture-owner-key' } });
  await automation.init();
  const app = express(); app.use(express.json()); app.use('/api/automation', automation.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/automation`;
  assert.equal((await fetch(`${url}/profile`)).status, 401);
  assert.equal((await fetch(`${url}/run`, { method: 'POST' })).status, 401);
  const summary = await (await fetch(`${url}/summary`)).json();
  assert.equal(summary.capacity.companies, 100000); assert.equal(summary.profile, undefined);
  assert.equal((await fetch(`${url}/directory`)).status, 200);
  const profile = await (await fetch(`${url}/profile`, { headers: { Authorization: 'Bearer fixture-owner-key' } })).json();
  assert.equal(profile.noticeDays, 60);
});

test('PDFParse v2 is constructed, read and destroyed even when extraction fails', async () => {
  const file = { buffer: Buffer.from('%PDF-fixture'), originalname: 'resume.pdf' };
  let destroyed = 0;
  class Parser { constructor(options) { assert.equal(options.data, file.buffer); } async getText() { return { text: 'Resume fixture text' }; } async destroy() { destroyed++; } }
  assert.equal((await parseResume(file, { PDFParse: Parser })).text, 'Resume fixture text');
  class Broken extends Parser { async getText() { throw new Error('Corrupt fixture'); } }
  await assert.rejects(parseResume(file, { PDFParse: Broken }));
  assert.equal(destroyed, 2);
});

test('email MIME preserves the approved body and TXT attachment type', () => {
  const message = toMime({ id: 'fixture', digest: 'fixture-digest', recipient: 'careers@example.com', subject: 'Test\r\nBcc: bad@example.com', body: 'Approved body' }, { email: 'applicant@example.com' }, { name: 'resume.txt', type: 'text/plain', base64: resume.buffer.toString('base64') });
  assert.match(message, /Content-Type: text\/plain; name="resume.txt"/);
  assert.ok(!message.includes('\r\nBcc:'));
  assert.ok(message.includes(Buffer.from('Approved body').toString('base64')));
});
