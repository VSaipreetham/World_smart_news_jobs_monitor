'use strict';

const { timingSafeEqual } = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { Store } = require('./store');
const { Harness, fail } = require('./harness');
const { listDirectory, importDirectory, seedDirectory } = require('./directory');

function isOwner(req, env = process.env) {
  const expected = env.PORTAL_ADMIN_TOKEN;
  const supplied = req.get?.('Authorization') || req.headers?.authorization || '';
  if (!expected || !supplied.startsWith('Bearer ')) return false;
  const left = Buffer.from(supplied.slice(7)), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requireOwner(req, res, next) {
  if (!isOwner(req)) return res.status(401).json({ error: 'Owner access is required. Configure PORTAL_ADMIN_TOKEN on the server and unlock this workspace.' });
  res.set('Cache-Control', 'no-store');
  next();
}

async function parseResume(file, { PDFParse, mammoth } = {}) {
  if (!file?.buffer || !file.buffer.length || file.buffer.length > 8 * 1024 * 1024) throw fail('Upload a PDF, DOCX or TXT resume up to 8 MB.');
  const name = String(file.originalname || file.name || '').toLowerCase();
  if (name.endsWith('.pdf')) {
    if (file.buffer.subarray(0, 5).toString() !== '%PDF-') throw fail('The file is not a valid PDF.');
    const Parser = PDFParse || require('pdf-parse').PDFParse;
    const parser = new Parser({ data: file.buffer });
    try {
      const result = await parser.getText();
      if (!result.text?.trim()) throw fail('This PDF has no extractable text. Upload a text-based PDF or DOCX.');
      return { text: result.text.slice(0, 60000), type: 'application/pdf' };
    } finally { await parser.destroy(); }
  }
  if (name.endsWith('.docx')) {
    if (file.buffer.subarray(0, 2).toString() !== 'PK') throw fail('The file is not a valid DOCX.');
    const reader = mammoth || require('mammoth');
    const result = await reader.extractRawText({ buffer: file.buffer });
    if (!result.value?.trim()) throw fail('This DOCX contains no readable text.');
    return { text: result.value.slice(0, 60000), type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
  if (name.endsWith('.txt')) {
    const value = file.buffer.toString('utf8');
    if (!value.trim() || value.includes('\0')) throw fail('This text file is empty or binary.');
    return { text: value.slice(0, 60000), type: 'text/plain' };
  }
  throw fail('Supported resume formats are PDF, DOCX and TXT.');
}

function createAutomation({ pool = null, generate = null, store, harness, env = process.env } = {}) {
  const database = store || new Store({ pool });
  const engine = harness || new Harness(database, { generate, env });
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
  let ready = false;
  const asyncRoute = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  const owner = (req, res, next) => {
    if (!isOwner(req, env)) return res.status(401).json({ error: 'Owner access is required. Unlock the workspace with the server owner key.' });
    res.set('Cache-Control', 'no-store'); next();
  };
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!ready) return res.status(503).json({ error: 'Job automation is starting. Please retry shortly.' });
    next();
  });
  const summary = async () => {
    const status = await engine.status();
    return { directory: status.directory, capacity: status.capacity, ownerConfigured: Boolean(env.PORTAL_ADMIN_TOKEN), integrations: status.integrations, counts: status.counts };
  };
  router.get('/summary', asyncRoute(async (_req, res) => res.json(await summary())));
  router.get('/directory', asyncRoute(async (req, res) => res.json(await listDirectory(database, req.query))));
  router.get('/status', asyncRoute(async (req, res) => {
    if (!isOwner(req, env)) return res.json(await summary());
    res.json(await engine.status());
  }));
  router.use(owner);
  router.get('/settings', asyncRoute(async (_req, res) => res.json(await engine.settings())));
  router.put('/settings', asyncRoute(async (req, res) => res.json(await engine.saveSettings(req.body))));
  router.patch('/settings', asyncRoute(async (req, res) => res.json(await engine.saveSettings(req.body))));
  router.get('/filters', asyncRoute(async (_req, res) => res.json((await engine.settings()).filters)));
  router.put('/filters', asyncRoute(async (req, res) => res.json((await engine.saveSettings({ filters: req.body.filters || req.body })).filters)));
  router.get('/profile', asyncRoute(async (_req, res) => res.json(await engine.profile())));
  router.put('/profile', asyncRoute(async (req, res) => res.json(await engine.saveProfile(req.body))));
  router.patch('/profile', asyncRoute(async (req, res) => res.json(await engine.saveProfile(req.body))));
  router.post('/resume', upload.fields([{ name: 'resume', maxCount: 1 }, { name: 'file', maxCount: 1 }]), asyncRoute(async (req, res) => {
    const file = req.files?.resume?.[0] || req.files?.file?.[0];
    const parsed = await parseResume(file);
    const profile = await engine.saveProfile({ resumeText: parsed.text }, { buffer: file.buffer, name: file.originalname, type: parsed.type });
    res.json({ ...profile, profile, resumeName: profile.resumeName, message: 'Resume saved. Existing email approvals were revoked.' });
  }));
  router.get('/resume', asyncRoute(async (_req, res) => {
    const resume = await database.getConfig('resume', null);
    if (!resume) throw fail('No resume uploaded.', 404);
    res.set('Content-Type', resume.type).set('Content-Disposition', `attachment; filename="${String(resume.name).replace(/[^a-zA-Z0-9._-]/g, '_')}"`).send(Buffer.from(resume.base64, 'base64'));
  }));
  router.get('/jobs', asyncRoute(async (req, res) => res.json(await engine.matches(req.query))));
  router.get('/jobs/:id', asyncRoute(async (req, res) => res.json(await engine.getMatch(req.params.id))));
  router.post('/jobs/:id/prepare', asyncRoute(async (req, res) => res.json(await engine.prepare(req.params.id))));
  router.patch('/jobs/:id', asyncRoute(async (req, res) => res.json(await engine.transition(req.params.id, req.body))));
  router.post('/run', asyncRoute(async (_req, res) => {
    const run = await engine.queueCycle();
    res.status(run.state === 'queued' ? 202 : 200).json(run);
  }));
  router.get('/runs', asyncRoute(async (_req, res) => {
    const rows = (await database.query('SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT 50')).rows;
    res.json({ rows: rows.map(row => ({ ...row, body: JSON.parse(row.body) })) });
  }));
  router.get('/runs/:id', asyncRoute(async (req, res) => {
    const row = (await database.query('SELECT * FROM automation_runs WHERE id=?', [req.params.id])).rows[0];
    if (!row) throw fail('Discovery run not found.', 404);
    res.json({ ...row, body: JSON.parse(row.body) });
  }));
  router.post('/directory/import', asyncRoute(async (req, res) => res.json(await importDirectory(database, req.body.rows || req.body.entries || req.body))));
  router.patch('/directory/:id', asyncRoute(async (req, res) => {
    if (typeof req.body.enabled !== 'boolean') throw fail('Provide enabled: true or false.');
    const source = (await database.query('SELECT * FROM automation_directory WHERE id=?', [req.params.id])).rows[0];
    if (!source) throw fail('Source not found.', 404);
    if (req.body.enabled && !['greenhouse', 'lever', 'ashby'].includes(source.provider)) throw fail('This career page is a directory link. Automatic collection requires a supported ATS adapter.');
    await database.query('UPDATE automation_directory SET enabled=?,due_at=0 WHERE id=?', [req.body.enabled ? 1 : 0, req.params.id]);
    res.json({ ...source, enabled: req.body.enabled ? 1 : 0 });
  }));
  router.post('/ask', asyncRoute(async (req, res) => res.json(await engine.ask(req.body.question))));
  router.post('/reindex', asyncRoute(async (_req, res) => res.json(await engine.reindex())));
  router.post('/alerts/flush', asyncRoute(async (_req, res) => res.json(await engine.flushAlerts())));
  router.get('/alerts', asyncRoute(async (_req, res) => res.json({ rows: (await database.query('SELECT * FROM automation_outbox ORDER BY due_at DESC LIMIT 100')).rows.map(row => ({ ...row, body: JSON.parse(row.body) })) })));
  router.get('/drafts', asyncRoute(async (_req, res) => {
    const rows = (await database.query('SELECT * FROM automation_drafts ORDER BY created_at DESC LIMIT 100')).rows;
    res.json({ rows, drafts: rows, items: rows });
  }));
  router.post('/drafts', asyncRoute(async (req, res) => res.status(201).json(await engine.createDraft(req.body))));
  router.get('/drafts/:id', asyncRoute(async (req, res) => res.json(await engine.draft(req.params.id))));
  router.patch('/drafts/:id', asyncRoute(async (req, res) => res.json(await engine.editDraft(req.params.id, req.body))));
  router.post('/drafts/:id/approve', asyncRoute(async (req, res) => { const draft = await engine.approveDraft(req.params.id, req.body.digest); res.json({ ...draft, draft }); }));
  router.post('/drafts/:id/send', asyncRoute(async (req, res) => res.json(await engine.sendDraft(req.params.id, req.body.digest))));
  router.get('/drafts/:id/download', asyncRoute(async (req, res) => res.type('message/rfc822').attachment('application-draft.eml').send(await engine.downloadDraft(req.params.id))));
  router.use((error, _req, res, _next) => {
    const status = error instanceof multer.MulterError ? 400 : Number(error.status) || 500;
    const message = error instanceof multer.MulterError ? 'Upload one resume up to 8 MB.' : error.status ? error.message : 'The operation could not be completed. Saved records are retained; check the integration configuration.';
    res.status(status).json({ error: message });
  });
  return { router, store: database, engine, init: async () => { await database.init(); await seedDirectory(database); ready = true; } };
}

module.exports = { createAutomation, requireOwner, isOwner, parseResume };
