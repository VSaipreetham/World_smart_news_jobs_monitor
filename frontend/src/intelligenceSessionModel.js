const DAY = 24 * 60 * 60 * 1000;
export const SESSION_ID = 'daily-world-intelligence';

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function safeSourceUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

// The server owns retention. These display bounds also protect against stale or
// oversized responses while an older backend is being upgraded.
export function normalizeSession(value, now = Date.now()) {
  const data = value && typeof value === 'object' ? value : {};
  const retentionDays = Math.min(30, Math.max(1, Number(data.retentionDays) || 7));
  const maxMessages = Math.min(40, Math.max(2, Number(data.maxMessages) || 40));
  const cutoff = now - retentionDays * DAY;
  const seenSources = new Set();
  const sources = (Array.isArray(data.sources) ? data.sources : [])
    .map(source => ({ ...source, url: safeSourceUrl(source.url) }))
    .filter(source => {
      const sourceTime = timestamp(source.publishedAt || source.firstSeenAt);
      if (!source.url || !source.title || (sourceTime !== null && sourceTime < cutoff)) return false;
      const key = source.url.replace(/\/$/, '');
      if (seenSources.has(key)) return false;
      seenSources.add(key);
      return true;
    })
    .sort((a, b) => (timestamp(b.publishedAt || b.firstSeenAt) || 0) - (timestamp(a.publishedAt || a.firstSeenAt) || 0))
    .slice(0, 80);
  const seenMessages = new Set();
  const messages = (Array.isArray(data.messages) ? data.messages : [])
    .filter(message => {
      if (!message.id || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || !message.content.trim()) return false;
      if (seenMessages.has(message.id)) return false;
      if (timestamp(message.createdAt) !== null && timestamp(message.createdAt) < cutoff) return false;
      seenMessages.add(message.id);
      return true;
    })
    .sort((a, b) => (timestamp(a.createdAt) || 0) - (timestamp(b.createdAt) || 0))
    .slice(-maxMessages);
  return {
    ...data, id: SESSION_ID, retentionDays, maxMessages, sources, messages,
    brief: { summary_news: '', summary_jobs: '', ...data.brief },
  };
}

export function sessionTime(value) {
  if (timestamp(value) === null) return 'Not updated yet';
  return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
