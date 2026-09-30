'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('./store');
const { hash, normalizeJob, evaluateJob, sanitizeFilters, safeUrl, canonicalUrl } = require('./policy');
const { sourceRecord, importDirectory, listDirectory, fetchBoard, seedDirectory, LIMITS } = require('./directory');
const { retrieve, Jev, answerFromEvidence } = require('./ai');
const { Qdrant, pointId, sparseVector } = require('./qdrant');

const job = overrides => normalizeJob({ title: 'Generative AI Engineer', company: 'Example employer', url: 'https://jobs.lever.co/example/req-1', location: 'Hyderabad',
  description: '3–5 years of experience. Python, RAG, LangGraph and machine learning.', postedDate: '2026-09-24', verifiedAt: '2026-09-24', ...overrides });
const db = async t => { const store = await new Store({ filename: ':memory:' }).init(); t.after(() => store.close()); return store; };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const now = Date.parse('2026-09-24T12:00:00Z');

test('job filters preserve unknown salary and parse minimum of an experience range', () => {
  const value = job();
  const evaluation = evaluateJob(value, {}, { experienceYears: 3 }, now);
  assert.equal(value.requiredYears, 3);
  assert.equal(value.salary.verified, false);
  assert.equal(value.salaryLpa, null);
  assert.equal(evaluation.eligible, true);
  assert.match(evaluation.gaps.join(' '), /Compensation unverified/);
  assert.match(evaluation.scoring, /not a hiring probability/);
  assert.equal(evaluateJob(value, { includeUnknownSalary: false }, {}, now).eligible, false);
});

test('salary filter supports published LPA ranges and never treats USD as INR', () => {
  assert.equal(evaluateJob(job({ pay: '₹20–25 LPA' }), {}, {}, now).accepted, false);
  const published = job({ salary: { min: 3000000, max: 4000000, currency: 'INR', interval: 'year' } });
  assert.deepEqual(published.salaryLpa, { min: 30, max: 40 });
  assert.equal(evaluateJob(published, {}, {}, now).eligible, true);
  assert.equal(job({ salary: { min: 300000, max: 400000, currency: 'USD', interval: 'year' } }).salary.verified, false);
  assert.equal(job({ salary: { min: 3000, max: 4000, currency: 'INR', interval: 'hour' } }).salary.verified, false);
});

test('canonical identity ignores tracking while preserving requisition parameters', () => {
  const one = canonicalUrl('https://careers.employer.com/job?id=24&utm_source=slack#top');
  assert.equal(one, canonicalUrl('https://careers.employer.com/job?id=24&ref=feed'));
  assert.notEqual(one, canonicalUrl('https://careers.employer.com/job?id=25'));
  assert.equal(safeUrl('https://admin:password@careers.employer.com/job'), null);
  assert.equal(safeUrl('https://127.0.0.1/job'), null);
  assert.equal(safeUrl('https://metadata.internal/job'), null);
  assert.equal(hash(Buffer.from('hello')), hash('hello'));
});

test('filters reject wrong city, experience gap, missing verification and stale postings', () => {
  for (const value of [job({ location: 'Pune' }), job({ requiredYears: 6 }), job({ verifiedAt: null }), job({ postedDate: '2025-09-24' })]) {
    assert.equal(evaluateJob(value, {}, {}, now).accepted, false);
  }
  assert.equal(evaluateJob(job({ title: 'Maintenance Engineer', description: 'Maintain factory machines.' }), {}, {}, now).accepted, false);
  assert.deepEqual(sanitizeFilters({ locations: [], minSalaryLpa: -5, includeUnknownSalary: 'false' }).locations, []);
  assert.equal(sanitizeFilters({ minSalaryLpa: -5 }).minSalaryLpa, 0);
});

test('re-normalizing an adapter job preserves verification, salary and external identity', () => {
  const original = job({ pay: '30–40 LPA', externalId: 'req-1' });
  const normalized = normalizeJob(original);
  assert.equal(normalized.id, original.id);
  assert.deepEqual(normalized.salaryLpa, { min: 30, max: 40 });
  assert.equal(normalized.externalId, 'req-1');
  assert.equal(normalized.requiredYears, 3);
});

test('directory imports are deduplicated and concurrent transactions remain atomic', async t => {
  const store = await db(t);
  const entries = Array.from({ length: 20 }, (_, index) => ({ name: `Company ${index}`, url: `https://company${index}.com/careers`, kind: 'company', enabled: true }));
  const results = await Promise.all([importDirectory(store, entries), importDirectory(store, entries)]);
  assert.equal(results.reduce((sum, result) => sum + result.imported, 0), 20);
  assert.equal(results.reduce((sum, result) => sum + result.duplicates, 0), 20);
  const directory = await listDirectory(store, { page: 2, limit: 7 });
  assert.equal(directory.total, 20); assert.equal(directory.rows.length, 7);
  assert.equal(directory.rows[0].enabled, 0); assert.equal(directory.rows[0].status, 'unverified');
  assert.equal((await importDirectory(store, [])).imported, 0);
});

test('directory capacity failure rolls the whole import back', async t => {
  const store = await db(t);
  const entries = Array.from({ length: LIMITS.portals }, (_, index) => ({ name: `Portal ${index}`, url: `https://portal${index}.com/jobs`, kind: 'portal' }));
  await importDirectory(store, entries);
  await assert.rejects(importDirectory(store, [{ name: 'Extra portal', url: 'https://extra-portal.com/jobs' }]), /capacity exceeded/);
  assert.equal((await listDirectory(store)).total, LIMITS.portals);
});

test('seed inventory is honest: 117 records, four enabled adapters, no asserted verification', async t => {
  const store = await db(t);
  const result = await seedDirectory(store);
  assert.equal(result.imported, 117);
  const rows = await listDirectory(store, { enabled: true });
  assert.equal(rows.total, 4);
  assert.ok(rows.rows.every(row => row.status === 'unverified'));
  assert.equal((await seedDirectory(store)).imported, 0);
});

test('directory rejects spoofed providers and escapes LIKE wildcards', async t => {
  assert.throws(() => sourceRecord({ name: 'Spoof', url: 'https://evil.com/jobs', provider: 'greenhouse', board: 'real' }), /must match/);
  assert.throws(() => sourceRecord({ name: 'Spoof', url: 'https://jobs.lever.co/name', board: '../other' }), /valid board token/);
  const store = await db(t);
  await importDirectory(store, [{ name: '100% Systems', url: 'https://systems-careers.com/jobs' }, { name: 'Other', url: 'https://another-career.com/jobs' }]);
  assert.equal((await listDirectory(store, { q: '%' })).total, 1);
});

test('official Lever fetch uses fixed endpoint and honors published time and salary', async () => {
  let called;
  const jobs = await fetchBoard({ name: 'Employer', url: 'https://jobs.lever.co/employer', enabled: 1 }, async (url, init) => {
    called = { url, init };
    return response([{ id: 'req', text: 'AI Engineer', hostedUrl: 'https://jobs.lever.co/employer/req', categories: { location: 'Hyderabad', commitment: 'Full-time' },
      descriptionPlain: 'Python. 3+ years of experience.', createdAt: now, salaryRange: { min: 3000000, max: 4000000, currency: 'INR', interval: 'year' } }]);
  });
  assert.equal(called.url, 'https://api.lever.co/v0/postings/employer?mode=json');
  assert.equal(called.init.redirect, 'error');
  assert.equal(jobs[0].postedDate, new Date(now).toISOString());
  assert.equal(jobs[0].salaryLpa.min, 30);
  assert.ok(jobs[0].verifiedAt);
});

test('Greenhouse missing publication date stays unknown and response limits are enforced', async () => {
  const source = { name: 'Employer', url: 'https://job-boards.greenhouse.io/employer' };
  const jobs = await fetchBoard(source, async () => response({ jobs: [{ id: 1, title: 'AI Engineer', absolute_url: 'https://job-boards.greenhouse.io/employer/jobs/1', location: { name: 'Hyderabad' }, updated_at: '2026-09-24', content: 'Python RAG' }] }));
  assert.equal(jobs[0].postedDate, null);
  await assert.rejects(fetchBoard(source, async () => new Response('{}', { headers: { 'content-length': String(LIMITS.responseBytes + 1) } })), /size budget/);
  await assert.rejects(fetchBoard(source, async () => response({ wrong: [] })), /unexpected response schema/);
  await assert.rejects(fetchBoard({ name: 'Manual', url: 'https://careers.manualcompany.com/' }, async () => { throw new Error('must not call'); }), /no supported fetch/);
});

test('a malformed posting marks the board snapshot incomplete without discarding valid postings', async () => {
  const jobs = await fetchBoard({ name: 'Employer', url: 'https://job-boards.greenhouse.io/employer' }, async () => response({ jobs: [
    { id: 1, title: 'AI Engineer', absolute_url: 'https://job-boards.greenhouse.io/employer/jobs/1', location: { name: 'Hyderabad' }, content: 'Python RAG' },
    { id: 2, title: 'Unavailable URL', absolute_url: null },
  ] }));
  assert.equal(jobs.length, 1);
  assert.equal(jobs.complete, false);
  assert.equal(jobs.malformed, 1);
});

test('local RAG retrieves matching evidence and rejects fabricated citations', async () => {
  const docs = [
    { id: 'job-ai', title: 'Python AI Engineer', text: 'Hyderabad RAG LangGraph; compensation unverified.', url: 'https://employer.com/ai' },
    { id: 'job-sales', title: 'Sales Manager', text: 'Pune customer acquisition.', url: 'https://employer.com/sales' },
  ];
  assert.equal(retrieve('Python RAG', docs)[0].id, 'job-ai');
  assert.equal(retrieve('unrelatedzebra', docs).length, 0);
  const result = await answerFromEvidence('Python', docs, async () => JSON.stringify({ answer: 'Guaranteed ₹40 LPA [invented]', citations: ['invented'] }));
  assert.equal(result.mode, 'extractive'); assert.equal(result.citations[0].id, 'job-ai');
  assert.match(result.answer, /compensation unverified/);
  const accepted = await answerFromEvidence('Python', docs, async () => ({ answer: 'The role mentions Python [job-ai].', citations: ['job-ai'] }));
  assert.equal(accepted.mode, 'generated');
});

test('Jev decision uses minimal candidate data, validates output and caches by evidence', async t => {
  const store = await db(t); let calls = 0, body;
  const jev = new Jev({ env: { TYPESAFE_API_KEY: 'test-server-key' }, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); calls++; body = JSON.parse(options.body);
    return response({ answers: { skillFit: { type: 'score', score: 2.95, confidence: 0.95 }, experience: { type: 'choice', choice: 'meets', confidence: 0.91 }, needsReview: { type: 'noul', noul: 0.1 } } });
  } });
  const profile = { name: 'Private Person', email: 'private@person.com', address: 'Private Street', resumeText: 'Private Person 1234567890', skills: ['Python', 'LangGraph'], experienceYears: 3 };
  assert.equal((await jev.evaluate(job(), profile, store)).review, false);
  assert.equal((await jev.evaluate(job(), profile, store)).cached, true);
  assert.equal(calls, 1); assert.deepEqual(body.state.candidate, { skills: ['Python', 'LangGraph'], experienceYears: 3 });
  assert.doesNotMatch(JSON.stringify(body), /Private|private@|1234567890/);
  const broken = new Jev({ env: { TYPESAFE_API_KEY: 'key' }, fetchImpl: async () => response({ answers: {} }) });
  assert.equal((await broken.evaluate(job(), profile)).review, true);
  assert.equal((await new Jev({ env: {} }).evaluate(job(), profile)).status, 'not_configured');
});

test('Qdrant requires both cluster URL and key and uses deterministic sparse keyword vectors', async () => {
  const incomplete = new Qdrant({ env: { QDRANT_API_KEY: 'key-only' } });
  assert.equal(incomplete.configured, false);
  assert.equal((await incomplete.upsert([])).status, 'not_configured');
  assert.equal(new Qdrant({ env: { QDRANT_URL: 'https://user:pass@cloud.qdrant.io', QDRANT_API_KEY: 'x' } }).configured, false);
  assert.equal(new Qdrant({ env: { QDRANT_URL: 'https://cloud.qdrant.io?api_key=secret', QDRANT_API_KEY: 'x' } }).configured, false);
  const first = sparseVector('Python RAG Python');
  assert.deepEqual(first, sparseVector('python RAG python'));
  assert.ok(first.indices.every((value, index) => index === 0 || first.indices[index - 1] < value));
  assert.match(pointId('id'), /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.notEqual(pointId('id', 'a'), pointId('id', 'b'));
});

test('Qdrant isolates tenant/namespace, uses official query endpoint and refuses private documents', async () => {
  const calls = [];
  const qdrant = new Qdrant({ env: { QDRANT_URL: 'https://cluster.cloud.qdrant.io', QDRANT_API_KEY: 'server-secret', QDRANT_NAMESPACE: 'tenant-one' }, fetchImpl: async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null; calls.push({ url, options, body });
    if (url.endsWith('/points/query')) return response({ result: { points: [
      { score: 0.9, payload: { doc_id: 'current', title: 'Python', text: 'RAG', url: 'https://employer.com/job', namespace: 'jobs', tenant: 'tenant-one' } },
      { score: 0.8, payload: { doc_id: 'other-tenant', namespace: 'jobs', tenant: 'tenant-two' } },
    ] } });
    return response({ result: { config: { params: { sparse_vectors: { keywords: {} } } } } });
  } });
  const indexed = await qdrant.upsert([{ id: 'current', title: 'Python', text: 'RAG', url: 'https://employer.com/job', namespace: 'jobs' }, { id: 'private', title: 'Resume', text: 'secret', url: 'https://employer.com/resume', namespace: 'resume' }]);
  assert.equal(indexed.indexed, 1);
  const results = await qdrant.search('Python', 5);
  assert.deepEqual(results.map(value => value.id), ['current']);
  const search = calls.find(call => call.url.endsWith('/points/query'));
  assert.equal(search.body.using, 'keywords');
  assert.deepEqual(search.body.filter.must, [{ key: 'tenant', match: { value: 'tenant-one' } }, { key: 'namespace', match: { value: 'jobs' } }]);
  assert.ok(calls.every(call => call.options.redirect === 'error'));
  await assert.rejects(qdrant.search('secret', { namespace: 'resume' }), /Only public job/);
});
