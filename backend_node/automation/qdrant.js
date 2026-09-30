'use strict';

const { hash, tokens, text, safeUrl } = require('./policy');
const { boundedJson } = require('./directory');

// Stable UUID-shaped IDs are accepted by Qdrant; application IDs remain in
// payload.doc_id and must be checked against the current SQL documents on read.
function pointId(value, namespace = 'jobs') {
  const digest = hash(`${namespace}\0${value}`);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** Hashed lexical features; these are sparse keyword vectors, not neural embeddings. */
function sparseVector(value) {
  const frequencies = new Map();
  for (const token of tokens(value).slice(0, 10000)) {
    if (token.length < 2) continue;
    const index = Number.parseInt(hash(token).slice(0, 8), 16);
    frequencies.set(index, (frequencies.get(index) || 0) + 1);
  }
  const entries = [...frequencies.entries()].sort((a, b) => a[0] - b[0]);
  const denominator = Math.sqrt(entries.reduce((sum, [, count]) => sum + (1 + Math.log(count)) ** 2, 0)) || 1;
  return { indices: entries.map(([index]) => index), values: entries.map(([, count]) => (1 + Math.log(count)) / denominator) };
}

class Qdrant {
  constructor({ env = process.env, fetchImpl = fetch } = {}) {
    this.key = env.QDRANT_API_KEY || '';
    this.url = null;
    try {
      const url = new URL(env.QDRANT_URL || '');
      const local = env.QDRANT_ALLOW_LOCAL === 'true' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if ((safeUrl(url.toString()) || local) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/') this.url = url.origin;
    } catch { /* A key alone cannot identify a cluster. Configuration stays off. */ }
    this.collection = /^[a-zA-Z0-9_-]{1,100}$/.test(env.QDRANT_COLLECTION || '') ? env.QDRANT_COLLECTION : 'world_smart_jobs';
    this.tenant = /^[a-zA-Z0-9_-]{1,100}$/.test(env.QDRANT_NAMESPACE || '') ? env.QDRANT_NAMESPACE : 'world-smart-monitor';
    this.fetchImpl = fetchImpl;
    this.ready = false;
    this.initializing = null;
  }
  get configured() { return Boolean(this.url && this.key); }
  get status() { return { configured: this.configured, ready: this.ready, mode: 'sparse keyword vectors', collection: this.collection }; }

  async request(path, method = 'GET', body) {
    if (!this.configured) throw new Error('Set the server QDRANT_URL and QDRANT_API_KEY');
    const response = await this.fetchImpl(`${this.url}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'api-key': this.key, 'Content-Type': 'application/json' }, ...(body == null ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) { const error = new Error(`Qdrant request failed (${response.status})`); error.status = response.status; throw error; }
    return boundedJson(response);
  }

  async ensureCollection() {
    if (!this.configured) return false;
    if (this.ready) return true;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      const path = `/collections/${encodeURIComponent(this.collection)}`;
      try {
        const details = await this.request(path);
        if (!details?.result?.config?.params?.sparse_vectors?.keywords) throw new Error('Qdrant collection has no keywords sparse vector; select a dedicated collection');
      } catch (error) {
        if (error.status !== 404) throw error;
        try { await this.request(path, 'PUT', { vectors: {}, sparse_vectors: { keywords: { modifier: 'idf' } } }); }
        catch (creationError) {
          // Two workers may race to create the same dedicated collection.
          if (![409, 400].includes(creationError.status)) throw creationError;
          const details = await this.request(path);
          if (!details?.result?.config?.params?.sparse_vectors?.keywords) throw creationError;
        }
      }
      // Payload indexes make namespace filters usable on large collections and
      // on Qdrant Cloud's strict-mode collections. Fail closed if setup fails.
      await this.request(`${path}/index?wait=true`, 'PUT', { field_name: 'tenant', field_schema: 'keyword' });
      await this.request(`${path}/index?wait=true`, 'PUT', { field_name: 'namespace', field_schema: 'keyword' });
      this.ready = true;
      return true;
    })();
    try { return await this.initializing; }
    finally { this.initializing = null; }
  }

  async upsert(documents, options = {}) {
    if (!this.configured) return { indexed: 0, status: 'not_configured', mode: 'sparse keyword vectors' };
    if (!Array.isArray(documents)) throw new Error('Qdrant indexing requires documents');
    await this.ensureCollection();
    const namespace = options.namespace || 'jobs';
    if (namespace !== 'jobs') throw new Error('Only public job documents may be indexed');
    let indexed = 0;
    const unique = new Map();
    for (const doc of documents) {
      if (!doc?.id || (doc.namespace && doc.namespace !== namespace) || !safeUrl(doc.url)) continue;
      unique.set(String(doc.id), doc);
    }
    const rows = [...unique.values()];
    for (let offset = 0; offset < rows.length; offset += 100) {
      const points = rows.slice(offset, offset + 100).map(doc => {
        const body = text(doc.text || doc.description, 24000);
        return { id: pointId(doc.id, `${this.tenant}:${namespace}`), vector: { keywords: sparseVector(`${doc.title || ''} ${body}`) },
          payload: { doc_id: String(doc.id), title: text(doc.title, 250), text: body, url: safeUrl(doc.url), namespace, tenant: this.tenant, content_hash: hash(body) } };
      }).filter(point => point.vector.keywords.indices.length);
      if (!points.length) continue;
      await this.request(`/collections/${encodeURIComponent(this.collection)}/points?wait=true`, 'PUT', { points });
      indexed += points.length;
    }
    return { indexed, status: 'indexed', mode: 'sparse keyword vectors' };
  }

  async search(query, options = {}) {
    if (!this.configured) return [];
    const { limit = 8, namespace = 'jobs' } = typeof options === 'number' ? { limit: options } : options;
    if (namespace !== 'jobs') throw new Error('Only public job documents may be retrieved');
    const vector = sparseVector(text(query, 3000));
    if (!vector.indices.length) return [];
    await this.ensureCollection();
    const data = await this.request(`/collections/${encodeURIComponent(this.collection)}/points/query`, 'POST', {
      query: vector, using: 'keywords', limit: Math.max(1, Math.min(30, Math.floor(Number(limit) || 8))), with_payload: true, with_vector: false,
      filter: { must: [{ key: 'tenant', match: { value: this.tenant } }, { key: 'namespace', match: { value: namespace } }] },
    });
    const points = data?.result?.points;
    if (!Array.isArray(points)) throw new Error('Qdrant returned an unexpected search schema');
    return points.filter(point => point.payload?.tenant === this.tenant && point.payload?.namespace === namespace && point.payload?.doc_id && Number.isFinite(point.score))
      .map(point => ({ id: String(point.payload.doc_id), title: text(point.payload.title, 250), text: text(point.payload.text, 24000),
        url: safeUrl(point.payload.url), namespace, score: point.score }));
  }
}

module.exports = { Qdrant, pointId, sparseVector };
