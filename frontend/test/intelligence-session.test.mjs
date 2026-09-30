import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSession, safeSourceUrl, SESSION_ID } from '../src/intelligenceSessionModel.js';

const now = Date.parse('2026-09-27T12:00:00Z');

test('one session deduplicates source URLs, expires old items, and rejects active links', () => {
  const session = normalizeSession({
    id: 'unwanted-new-session', retentionDays: 7,
    sources: [
      { id: 'recent', title: 'Recent report', url: 'https://example.com/report', publishedAt: '2026-09-26T12:00:00Z' },
      { id: 'duplicate', title: 'Same report', url: 'https://example.com/report#section', publishedAt: '2026-09-26T12:00:00Z' },
      { id: 'old', title: 'Old report', url: 'https://example.com/old', publishedAt: '2026-09-01T12:00:00Z' },
      { id: 'old-collected', title: 'Old undated report', url: 'https://example.com/old-undated', firstSeenAt: '2026-09-01T12:00:00Z' },
      { id: 'active', title: 'Unsafe link', url: 'javascript:alert(1)' },
    ],
  }, now);
  assert.equal(session.id, SESSION_ID);
  assert.deepEqual(session.sources.map(row => row.id), ['recent']);
});

test('conversation is bounded to the last 40 distinct recent messages', () => {
  const messages = Array.from({ length: 55 }, (_, index) => ({ id: String(index), role: index % 2 ? 'assistant' : 'user', content: `Message ${index}`, createdAt: new Date(now - (55 - index) * 1000).toISOString() }));
  const session = normalizeSession({ maxMessages: 1000, messages: [...messages, messages[54], { id: 'old', role: 'assistant', content: 'Expired', createdAt: '2026-09-01T00:00:00Z' }, { id: 'system', role: 'system', content: 'Do not display this' }] }, now);
  assert.equal(session.messages.length, 40);
  assert.equal(session.messages[0].id, '15');
  assert.equal(session.messages.at(-1).id, '54');
});

test('oversized source responses remain bounded and malformed collections are safe', () => {
  const sources = Array.from({ length: 200 }, (_, index) => ({ id: String(index), title: `Report ${index}`, url: `https://example.com/report-${index}`, publishedAt: new Date(now - index * 1000).toISOString() }));
  assert.equal(normalizeSession({ sources }, now).sources.length, 80);
  assert.deepEqual(normalizeSession({ messages: 'bad', sources: null }, now).messages, []);
  assert.equal(normalizeSession(null, now).brief.summary_news, '');
  assert.equal(safeSourceUrl('https://secret:password@example.com/report'), null);
  assert.equal(safeSourceUrl('/relative-report'), null);
});
