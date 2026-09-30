'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Small SQL boundary shared by the local SQLite worker and a hosted PostgreSQL worker. */
class Store {
  constructor({ pool = null, filename = process.env.AUTOMATION_DB_PATH || path.join(__dirname, '..', 'data', 'automation.sqlite') } = {}) {
    this.pool = pool;
    this.filename = filename;
    this.queue = Promise.resolve();
    if (!pool) {
      const { DatabaseSync } = require('node:sqlite');
      if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      this.db = new DatabaseSync(filename);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      if (filename !== ':memory:') fs.chmodSync(filename, 0o600);
    }
  }

  _serialize(fn) {
    const promise = this.queue.then(fn, fn);
    this.queue = promise.catch(() => {});
    return promise;
  }

  _query(connection, sql, values = []) {
    if (this.pool) {
      let index = 0;
      return connection.query(sql.replace(/\?/g, () => `$${++index}`), values);
    }
    const statement = connection.prepare(sql);
    if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
      const rows = statement.all(...values);
      return { rows, rowCount: rows.length };
    }
    const result = statement.run(...values);
    return { rows: [], rowCount: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }

  async query(sql, values = []) {
    if (this.pool) return this._query(this.pool, sql, values);
    return this._serialize(() => this._query(this.db, sql, values));
  }

  async transaction(fn) {
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const value = await fn(this._transactionView(client));
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    }
    return this._serialize(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const value = await fn(this._transactionView(this.db));
        this.db.exec('COMMIT');
        return value;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  _transactionView(connection) {
    return {
      query: async (sql, values = []) => this._query(connection, sql, values),
      // Serializes profile updates and email claim/approval across all PostgreSQL workers.
      lockProfile: async () => {
        if (this.pool) await connection.query("SELECT id FROM automation_config WHERE id = 'profile' FOR UPDATE");
      },
      getConfig: async (id, fallback = null) => {
        const result = await this._query(connection, 'SELECT body FROM automation_config WHERE id = ?', [id]);
        return result.rows[0] ? JSON.parse(result.rows[0].body) : fallback;
      },
      setConfig: async (id, value) => this._query(connection,
        'INSERT INTO automation_config (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body', [id, JSON.stringify(value)]),
    };
  }

  async init() {
    const statements = [
      'CREATE TABLE IF NOT EXISTS automation_config (id TEXT PRIMARY KEY, body TEXT NOT NULL)',
      `CREATE TABLE IF NOT EXISTS automation_directory (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'portal',
        provider TEXT NOT NULL DEFAULT 'manual', board TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', sector TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'unverified', failures INTEGER NOT NULL DEFAULT 0,
        due_at BIGINT NOT NULL DEFAULT 0, checked_at TEXT, job_count INTEGER NOT NULL DEFAULT 0, error TEXT)`,
      'CREATE INDEX IF NOT EXISTS automation_directory_due ON automation_directory (enabled,due_at)',
      'CREATE INDEX IF NOT EXISTS automation_directory_kind ON automation_directory (kind,provider,country)',
      'CREATE INDEX IF NOT EXISTS automation_directory_name ON automation_directory (name)',
      `CREATE TABLE IF NOT EXISTS automation_matches (
        id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, company TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'matched', score INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL, evaluation TEXT NOT NULL,
        first_seen TEXT NOT NULL, updated_at TEXT NOT NULL, profile_revision INTEGER NOT NULL DEFAULT 0,
        receipt TEXT, note TEXT NOT NULL DEFAULT '')`,
      'CREATE INDEX IF NOT EXISTS automation_matches_state ON automation_matches (state,score,updated_at)',
      `CREATE TABLE IF NOT EXISTS automation_outbox (
        id TEXT PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, due_at BIGINT NOT NULL DEFAULT 0, receipt TEXT, error TEXT)`,
      'CREATE INDEX IF NOT EXISTS automation_outbox_due ON automation_outbox (state,due_at)',
      `CREATE TABLE IF NOT EXISTS automation_drafts (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
        resume_hash TEXT NOT NULL, profile_revision INTEGER NOT NULL, digest TEXT NOT NULL, approved_digest TEXT,
        state TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, receipt TEXT)`,
      'CREATE INDEX IF NOT EXISTS automation_drafts_state ON automation_drafts (state,updated_at)',
      'CREATE TABLE IF NOT EXISTS automation_runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, state TEXT NOT NULL, body TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS automation_leases (id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at BIGINT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS automation_decisions (id TEXT PRIMARY KEY, body TEXT NOT NULL, expires_at BIGINT NOT NULL)',
    ];
    for (const sql of statements) await this.query(sql);
    // Never reset another process\'s active operations during startup.
    await this.query('INSERT INTO automation_config(id,body) VALUES (?,?) ON CONFLICT(id) DO NOTHING', ['profile', JSON.stringify({ revision: 0, noticeDays: 60, noticePeriod: '2 months (60 days)', skills: [] })]);
    return this;
  }

  async getConfig(id, fallback = null) {
    const { rows } = await this.query('SELECT body FROM automation_config WHERE id = ?', [id]);
    return rows[0] ? JSON.parse(rows[0].body) : fallback;
  }

  async setConfig(id, value) {
    await this.query('INSERT INTO automation_config(id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body', [id, JSON.stringify(value)]);
  }

  async acquire(owner, ttl = 20 * 60 * 1000, id = 'worker') {
    const now = Date.now();
    const { rows } = await this.query(`INSERT INTO automation_leases(id,owner,expires_at) VALUES (?,?,?)
      ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
      WHERE automation_leases.expires_at < ? OR automation_leases.owner = ? RETURNING owner`, [id, owner, now + ttl, now, owner]);
    return rows[0]?.owner === owner;
  }

  async release(owner, id = 'worker') {
    await this.query('DELETE FROM automation_leases WHERE id = ? AND owner = ?', [id, owner]);
  }

  async close() { if (this.db) { await this.queue; this.db.close(); } }
}

module.exports = { Store };
