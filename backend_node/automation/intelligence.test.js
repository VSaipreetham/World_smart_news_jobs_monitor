'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('./store');
const { IntelligenceSession, SESSION_ID } = require('../intelligenceSession');

async function fixture(generate = null) {
  const store = new Store({ filename: ':memory:' });
  await store.init();
  let now = Date.parse('2026-09-27T09:00:00Z');
  const session = new IntelligenceSession({ store, generate, now: () => now });
  await session.init();
  return { store, session, advance: days => { now += days * 86400000; } };
}

test('intelligence uses one persistent session, canonical sources and bounded retention', async () => {
  const { store, session, advance } = await fixture();
  try {
    await session.syncNews([
      { title: 'Current AI report', url: 'https://example.com/ai?utm_source=digest', date: '2026-09-26T10:00:00Z' },
      { title: 'Same report', url: 'https://example.com/ai', date: '2026-09-26T10:00:00Z' },
      { title: 'Old report', url: 'https://example.com/old', date: '2026-09-10T10:00:00Z' },
      { title: 'Unsafe source', url: 'javascript:alert(1)' },
    ]);
    const first = await session.ask('What changed in AI?', 'request-first');
    assert.equal(first.id, SESSION_ID);
    assert.equal(first.sources.length, 1);
    assert.equal(first.messages.length, 2);
    const resumed = new IntelligenceSession({ store, now: session.now });
    await resumed.init();
    assert.equal((await resumed.read(true)).messages[0].content, 'What changed in AI?');
    assert.equal((await resumed.read(false)).messages.length, 0, 'public views never expose chat history');
    for (let i = 0; i < 25; i++) await session.ask(`Question ${i}`, `request-${String(i).padStart(3, '0')}`);
    assert.equal((await session.read(true)).messages.length, 40);
    advance(8);
    const expired = await session.read(true);
    assert.equal(expired.sources.length, 0);
    assert.equal(expired.messages.length, 0);
    assert.equal((await store.query('SELECT COUNT(*) AS n FROM automation_config WHERE id=?', [SESSION_ID])).rows[0].n, 1);
  } finally { await store.close(); }
});

test('retries cannot duplicate chat exchanges and fabricated citations fall back to source digest', async () => {
  let calls = 0;
  const { store, session } = await fixture(async () => { calls++; return { answer: 'An unsupported claim [99]' }; });
  try {
    await session.syncNews([{ title: 'A current headline', url: 'https://example.com/new', date: '2026-09-27T08:00:00Z' }]);
    const first = await session.ask('Explain the headline', 'same-request-id');
    assert.equal(first.messages[1].provider, 'Source digest');
    const retried = await session.ask('Explain the headline', 'same-request-id');
    assert.equal(retried.messages.length, 2);
    assert.equal(calls, 1);
    await assert.rejects(session.ask('Different question', 'same-request-id'), { status: 409 });
  } finally { await store.close(); }
});

test('compact removes older updates without creating a new conversation or restoring old snapshots', async () => {
  const { store, session } = await fixture();
  try {
    const items = Array.from({ length: 90 }, (_, i) => ({ title: `Report ${i}`, url: `https://example.com/${i}`, date: new Date(Date.parse('2026-09-27T08:00:00Z') - i * 3600000).toISOString() }));
    await session.syncNews(items);
    await session.ask('First question', 'compact-request-1');
    await session.ask('Follow-up question', 'compact-request-2');
    assert.equal((await session.read(true)).sources.length, 80);
    const before = await session.read(true);
    const compact = await session.compact();
    assert.equal(compact.id, before.id);
    assert.equal(compact.messages.length, 2);
    assert.ok(compact.sources.length <= 20);
    assert.deepEqual(compact.brief, before.brief);
    await session.syncNews(items);
    assert.ok((await session.read(true)).sources.length <= 20, 'old snapshot does not undo cleanup');
  } finally { await store.close(); }
});

test('model receives only bounded conversation and supported source headlines', async () => {
  let received;
  const { store, session } = await fixture(async prompt => { received = prompt; return { answer: 'This is supported by the headline [1].' }; });
  try {
    await session.syncNews([{ title: 'Current report', url: 'https://example.com/report', date: '2026-09-27T08:00:00Z' }]);
    for (let i = 0; i < 6; i++) await session.ask(`Question ${i}`, `bounded-request-${i}`);
    assert.ok(received.includes('Question 5'));
    assert.ok(!received.includes('Question 0'));
    assert.equal((await session.read(true)).messages.at(-1).provider, 'Evidence-backed model');
    await assert.rejects(session.ask('x'.repeat(2001)), { status: 400 });
    await assert.rejects(session.ask(''), { status: 400 });
  } finally { await store.close(); }
});
