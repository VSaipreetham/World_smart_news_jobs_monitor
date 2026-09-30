'use strict';

const { randomUUID } = require('node:crypto');
const { hash, text, normalizeJob, evaluateJob, sanitizeFilters, DEFAULT_FILTERS, safeUrl } = require('./policy');
const { fetchBoard, listDirectory } = require('./directory');
const { Jev, answerFromEvidence } = require('./ai');
const { Qdrant } = require('./qdrant');
const { GmailMailer, validRecipient, toMime } = require('./mailer');

const nowISO = () => new Date().toISOString();
const number = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;
const json = (value, fallback = {}) => { try { return JSON.parse(value); } catch { return fallback; } };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const DEFAULT_SETTINGS = Object.freeze({ enabled: false, mode: 'RM', intervalMinutes: 60, sourceBatchSize: 20, sourcesPerRun: 20, maxJobsPerRun: 1000, jevLimit: 12, slackEnabled: false, qdrantEnabled: false, useJev: false, useQdrant: false, filters: DEFAULT_FILTERS, emailApprovalRequired: true });
const jobEvidenceHash = job => hash({ title: job.title, description: job.description, company: job.company, location: job.location, requiredYears: job.requiredYears, salary: job.salary, workMode: job.workMode, employmentType: job.employmentType });

function cleanProfile(input, previous = {}) {
  input = { ...input };
  const aliases = { company: 'currentEmployer', sponsorship: 'sponsorshipRequired', currentSalaryLpa: 'currentCtcLpa', minimumSalaryLpa: 'minimumCtcLpa', expectedSalaryLpa: 'expectedCtcLpa' };
  for (const [from, to] of Object.entries(aliases)) if (input[from] != null && input[to] == null) input[to] = input[from];
  const value = { ...previous };
  const fields = ['name', 'firstName', 'lastName', 'email', 'phone', 'city', 'address', 'country', 'currentEmployer', 'education', 'linkedin', 'github', 'leetcode', 'portfolio', 'preferredLocation', 'joiningAvailability', 'workAuthorization', 'noticePeriod'];
  for (const key of fields) if (input[key] != null) value[key] = text(input[key], key === 'education' || key === 'address' ? 1500 : 300);
  for (const key of ['linkedin', 'github', 'leetcode', 'portfolio']) if (value[key] && !safeUrl(value[key])) throw fail(`${key} must be a public HTTPS URL.`);
  if (value.email && !validRecipient(value.email)) throw fail('Enter a valid application email address.');
  for (const key of ['experienceYears', 'currentCtcLpa', 'minimumCtcLpa', 'expectedCtcLpa', 'expectedMinLpa', 'expectedMaxLpa', 'noticeDays']) {
    if (input[key] != null && input[key] !== '') {
      const maximum = key === 'noticeDays' ? 365 : key === 'experienceYears' ? 60 : 1000;
      if (!Number.isFinite(Number(input[key])) || Number(input[key]) < 0 || Number(input[key]) > maximum) throw fail(`${key} must be between 0 and ${maximum}.`);
      value[key] = Number(input[key]);
    }
  }
  value.noticeDays = value.noticeDays ?? 60;
  value.noticePeriod = `${value.noticeDays} days${value.noticeDays === 60 ? ' (2 months)' : ''}`;
  for (const key of ['skills', 'locations', 'workModes']) {
    if (input[key] != null) value[key] = (Array.isArray(input[key]) ? input[key] : String(input[key]).split(',')).map(item => text(item, 120)).filter(Boolean).slice(0, 80);
  }
  for (const key of ['willingToRelocate', 'sponsorshipRequired', 'talentCommunity']) if (typeof input[key] === 'boolean') value[key] = input[key];
  if (input.resumeText != null) value.resumeText = String(input.resumeText).replace(/\0/g, '').slice(0, 60000);
  value.demographics = 'decline to self-identify';
  value.emailApprovalRequired = true;
  if (input.firstName != null || input.lastName != null) value.name = [value.firstName, value.lastName].filter(Boolean).join(' ');
  value.company = value.currentEmployer || '';
  value.sponsorship = value.sponsorshipRequired;
  return value;
}

function draftDigest(draft) {
  return hash({ jobId: draft.job_id, recipient: draft.recipient, subject: draft.subject, body: draft.body, resumeHash: draft.resume_hash, profileRevision: Number(draft.profile_revision) });
}

function matchRow(row) {
  if (!row) return null;
  return { ...json(row.payload), ...row, job: json(row.payload), payload: json(row.payload), evaluation: json(row.evaluation), receipt: row.receipt ? json(row.receipt, row.receipt) : null };
}

function reviewPacket(job, profile) {
  const required = ['name', 'email', 'phone', 'city', 'currentEmployer'];
  const missing = required.filter(key => !profile[key]);
  if (!profile.resumeHash) missing.push('resume');
  return {
    state: missing.length ? 'needs_input' : 'ready', preparedAt: nowISO(), profileRevision: profile.revision, jobEvidenceHash: jobEvidenceHash(job),
    jobId: job.id, employer: job.company, role: job.title, applyUrl: job.url,
    resumeHash: profile.resumeHash || null, resumeName: profile.resumeName || null,
    applicationUrl: job.url, missing, emailApprovalRequired: true, submission: 'not_submitted',
    answers: Object.fromEntries(['name', 'firstName', 'lastName', 'email', 'phone', 'city', 'country', 'company', 'currentEmployer', 'education', 'linkedin', 'github', 'leetcode', 'experienceYears', 'currentCtcLpa', 'minimumCtcLpa', 'expectedCtcLpa', 'expectedMinLpa', 'expectedMaxLpa', 'noticeDays', 'noticePeriod', 'workAuthorization', 'sponsorshipRequired', 'willingToRelocate', 'demographics'].filter(key => profile[key] != null).map(key => [key, profile[key]])),
    instructions: 'Use these factual answers on the official application form. Account login, CAPTCHA, legal attestations and final form submission require the employer workflow. This packet is not a submitted application.',
  };
}

class Harness {
  constructor(store, { fetchImpl = fetch, boardReader = fetchBoard, jev, qdrant, generate = null, mailer, env = process.env } = {}) {
    this.store = store; this.fetch = fetchImpl; this.boardReader = boardReader; this.env = env;
    this.jev = jev || new Jev({ env, fetchImpl }); this.qdrant = qdrant || new Qdrant({ env, fetchImpl });
    this.generate = generate; this.mailer = mailer === undefined ? new GmailMailer({ env, fetchImpl }) : mailer;
    this.owner = randomUUID(); this.running = false; this.queued = false; this.activeRunId = null; this.timer = null; this.alertChannelChecked = 0;
  }

  async settings() { return { ...DEFAULT_SETTINGS, ...await this.store.getConfig('settings', {}), emailApprovalRequired: true }; }
  async profile() { const profile = await this.store.getConfig('profile', { revision: 0, noticeDays: 60, noticePeriod: '2 months (60 days)', skills: [] }); return { ...profile, hasResume: Boolean(profile.resumeHash) }; }

  async saveSettings(input = {}) {
    input = { ...input };
    if (input.sourcesPerRun != null) input.sourceBatchSize = input.sourcesPerRun;
    if (input.useQdrant != null) input.qdrantEnabled = input.useQdrant;
    const previous = await this.settings();
    const value = {
      ...previous, enabled: typeof input.enabled === 'boolean' ? input.enabled : previous.enabled,
      mode: input.mode === 'AA' || input.mode === 'RM' ? input.mode : previous.mode,
      intervalMinutes: number(input.intervalMinutes ?? previous.intervalMinutes, 60, 15, 1440),
      sourceBatchSize: Math.floor(number(input.sourceBatchSize ?? previous.sourceBatchSize, 20, 1, 200)),
      maxJobsPerRun: Math.floor(number(input.maxJobsPerRun ?? previous.maxJobsPerRun, 1000, 1, 5000)),
      jevLimit: Math.floor(number(input.jevLimit ?? previous.jevLimit, 12, 0, 30)),
      filters: sanitizeFilters({ ...previous.filters, ...(input.filters || {}) }),
      emailApprovalRequired: true,
    };
    for (const key of ['slackEnabled', 'qdrantEnabled', 'useJev']) if (typeof input[key] === 'boolean') value[key] = input[key];
    value.sourcesPerRun = value.sourceBatchSize;
    value.useQdrant = value.qdrantEnabled;
    await this.store.setConfig('settings', value);
    return value;
  }

  async saveProfile(input = {}, resume = null) {
    return this.store.transaction(async tx => {
      await tx.lockProfile();
      const sending = await tx.query("SELECT id FROM automation_drafts WHERE state='sending' LIMIT 1");
      if (sending.rows.length) throw fail('An email is being delivered. Wait for its result before changing your profile or resume.', 409);
      const previous = await tx.getConfig('profile', {});
      const value = cleanProfile(input, previous);
      if (resume) {
        const buffer = resume.buffer;
        if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 8 * 1024 * 1024) throw fail('Resume must be between 1 byte and 8 MB.');
        value.resumeHash = hash(buffer.toString('base64'));
        value.resumeName = text(resume.name, 150);
        await tx.setConfig('resume', { base64: buffer.toString('base64'), name: value.resumeName, type: resume.type, hash: value.resumeHash });
      }
      value.revision = Number(previous.revision || 0) + 1;
      value.updatedAt = nowISO();
      await tx.setConfig('profile', value);
      await tx.query("UPDATE automation_drafts SET state='stale',approved_digest=NULL,updated_at=? WHERE state IN ('draft','approved','stale')", [value.updatedAt]);
      // Prepared packets contain a snapshot of private data. Mark them stale instead of silently using an old notice period.
      await tx.query("UPDATE automation_matches SET state='matched',updated_at=? WHERE state IN ('ready','prepared','needs_input')", [value.updatedAt]);
      return value;
    });
  }

  async status() {
    const settings = await this.settings();
    const counts = (await this.store.query('SELECT kind,provider,status,enabled,COUNT(*) AS n FROM automation_directory GROUP BY kind,provider,status,enabled')).rows;
    const jobs = (await this.store.query('SELECT state,COUNT(*) AS n FROM automation_matches GROUP BY state')).rows;
    const alerts = (await this.store.query('SELECT state,COUNT(*) AS n FROM automation_outbox GROUP BY state')).rows;
    const lastRun = (await this.store.query('SELECT id,started_at,finished_at,state,body FROM automation_runs ORDER BY started_at DESC LIMIT 1')).rows[0];
    const total = counts.reduce((sum, row) => sum + Number(row.n), 0);
    const states = Object.fromEntries(jobs.map(row => [row.state, Number(row.n)]));
    const alertStates = Object.fromEntries(alerts.map(row => [row.state, Number(row.n)]));
    const runs = (await this.store.query('SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT 10')).rows.map(row => ({ ...row, body: json(row.body) }));
    return {
      enabled: settings.enabled, mode: settings.mode, running: this.running || this.queued, activeRunId: this.activeRunId, intervalMinutes: settings.intervalMinutes,
      storage: this.store.pool ? 'postgresql' : 'sqlite', counts: { ...states, directory: total, companies: counts.filter(row => row.kind === 'company').reduce((n, r) => n + Number(r.n), 0), portals: counts.filter(row => row.kind === 'portal').reduce((n, r) => n + Number(r.n), 0), activeSources: counts.filter(row => Number(row.enabled)).reduce((n, r) => n + Number(r.n), 0), jobs: jobs.reduce((n, r) => n + Number(r.n), 0) },
      directory: counts, jobs, alerts: alertStates, runs, settings, filters: settings.filters, profile: await this.profile(), capacity: { companies: 100000, portals: 10000 },
      integrations: { slack: Boolean(this.env.SLACK_BOT_TOKEN && this.env.SLACK_CHANNEL_ID), qdrant: Boolean(this.qdrant.configured), jev: Boolean(this.jev.configured), email: Boolean(this.mailer?.configured), database: { configured: true, type: this.store.pool ? 'postgresql' : 'sqlite' } },
      emailApprovalRequired: true, lastRun: lastRun ? { ...lastRun, body: json(lastRun.body) } : null,
      capabilities: { autoDiscover: true, autoPrepare: true, formSubmission: false, emailRequiresApproval: true },
    };
  }

  async matches(query = {}) {
    const page = Math.floor(number(query.page || 1, 1, 1, 100000));
    const limit = Math.floor(number(query.limit || 20, 20, 1, 100));
    const conditions = [], values = [];
    if (query.state === 'applications') conditions.push("state IN ('ready','prepared','needs_input','applied','interview','offer')");
    else if (query.state && query.state !== 'all') { conditions.push('state=?'); values.push(text(query.state, 40)); }
    if (query.q || query.search) { conditions.push('(LOWER(title) LIKE ? OR LOWER(company) LIKE ? OR LOWER(location) LIKE ?)'); const q = `%${text(query.q || query.search, 200).toLowerCase()}%`; values.push(q, q, q); }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const total = Number((await this.store.query(`SELECT COUNT(*) AS n FROM automation_matches${where}`, values)).rows[0].n);
    const { rows } = await this.store.query(`SELECT * FROM automation_matches${where} ORDER BY score DESC,updated_at DESC LIMIT ? OFFSET ?`, [...values, limit, (page - 1) * limit]);
    const jobs = rows.map(matchRow);
    return { rows: jobs, jobs, items: jobs, total, page, limit };
  }

  async getMatch(id) {
    const row = (await this.store.query('SELECT * FROM automation_matches WHERE id=?', [id])).rows[0];
    if (!row) throw fail('Job not found.', 404);
    return matchRow(row);
  }

  async prepare(id) {
    return this.store.transaction(async tx => {
      await tx.lockProfile();
      const row = (await tx.query('SELECT * FROM automation_matches WHERE id=?', [id])).rows[0];
      if (!row) throw fail('Job not found.', 404);
      if (['applied', 'interview', 'offer', 'rejected', 'archived', 'closed'].includes(row.state)) throw fail('This job is already completed, closed or archived.', 409);
      const profile = await tx.getConfig('profile', {});
      const job = json(row.payload), evaluation = json(row.evaluation);
      const settings = { ...DEFAULT_SETTINGS, ...await tx.getConfig('settings', {}) };
      const current = evaluateJob(job, settings.filters, profile);
      Object.assign(evaluation, current);
      evaluation.packet = reviewPacket(job, profile);
      const verifiedTime = Date.parse(job.verifiedAt);
      if (!Number.isFinite(verifiedTime) || Date.now() - verifiedTime > 86400000 || verifiedTime > Date.now() + 60000) { evaluation.packet.state = 'needs_input'; evaluation.packet.missing.push('Fresh verification from the official source'); }
      if (!current.accepted) { evaluation.packet.state = 'needs_input'; evaluation.packet.missing.push(...(current.failures || ['Job no longer meets your saved filters'])); }
      if (settings.useJev && (evaluation.jev?.status !== 'evaluated' || evaluation.jev.review || evaluation.jev.evidenceHash !== jobEvidenceHash(job) || Number(row.profile_revision) !== Number(profile.revision))) {
        evaluation.packet.state = 'needs_input'; evaluation.packet.missing.push('Review the current Jev decision and job evidence before applying');
      }
      await tx.query('UPDATE automation_matches SET state=?,evaluation=?,profile_revision=?,updated_at=? WHERE id=?', [evaluation.packet.state, JSON.stringify(evaluation), profile.revision || 0, nowISO(), id]);
      return { ...job, ...evaluation.packet, state: evaluation.packet.state, evaluation, packet: evaluation.packet, package: evaluation.packet };
    });
  }

  async transition(id, input = {}) {
    const allowed = ['matched', 'review', 'archived', 'applied', 'interview', 'offer'];
    if (input.state && !allowed.includes(input.state)) throw fail('Use Prepare to create a packet; select review, matched, archived or applied for tracking.');
    return this.store.transaction(async tx => {
      const row = (await tx.query('SELECT * FROM automation_matches WHERE id=?', [id])).rows[0];
      if (!row) throw fail('Job not found.', 404);
      const state = input.state || row.state;
      const receipt = input.receipt ? { kind: 'user-confirmed', reference: text(typeof input.receipt === 'string' ? input.receipt : input.receipt.reference, 1000), recordedAt: nowISO() } : null;
      if (state === 'applied' && !receipt?.reference && !row.receipt) throw fail('Record the employer confirmation or receipt before marking this application submitted.');
      await tx.query('UPDATE automation_matches SET state=?,note=?,receipt=?,updated_at=? WHERE id=?', [state, input.note == null ? row.note : text(input.note, 4000), receipt ? JSON.stringify(receipt) : row.receipt, nowISO(), id]);
      return { id, state };
    });
  }

  async ingest(rawJobs, source, context) {
    const settings = context?.settings || await this.settings(), profile = context?.profile || await this.profile();
    const stats = { inspected: 0, matched: 0, added: 0, duplicate: 0, rejected: 0, prepared: 0 };
    for (const raw of rawJobs.slice(0, settings.maxJobsPerRun)) {
      stats.inspected++;
      let job;
      try { job = normalizeJob(raw, source); } catch { stats.rejected++; continue; }
      const evaluation = evaluateJob(job, settings.filters, profile);
      if (!evaluation.accepted) {
        stats.rejected++;
        await this.store.query("UPDATE automation_matches SET payload=?,evaluation=?,score=?,state='needs_input',updated_at=? WHERE id=? AND state IN ('matched','review','ready','prepared','needs_input')", [JSON.stringify(job), JSON.stringify(evaluation), evaluation.score, nowISO(), job.id]);
        continue;
      }
      stats.matched++;
      const existing = (await this.store.query('SELECT id,evaluation,profile_revision FROM automation_matches WHERE id=?', [job.id])).rows[0];
      if (settings.useJev) {
        const previousDecision = existing && Number(existing.profile_revision) === Number(profile.revision) ? json(existing.evaluation).jev : null;
        evaluation.jev = previousDecision?.status === 'evaluated' && previousDecision.evidenceHash === jobEvidenceHash(job)
          ? previousDecision : { status: this.jev.configured ? 'budget_pending' : 'not_configured', review: true, confidence: 0 };
      }
      if (context && settings.useJev && evaluation.jev.status !== 'evaluated' && context.jevUsed < settings.jevLimit && this.jev.configured) {
        context.jevUsed++;
        evaluation.jev = { ...await this.jev.evaluate(job, profile, this.store), evidenceHash: jobEvidenceHash(job) };
      }
      let state = 'matched', builtPacket = false;
      if (settings.mode === 'AA' && (!evaluation.jev || !evaluation.jev.review)) {
        evaluation.packet = reviewPacket(job, profile); state = evaluation.packet.state; builtPacket = true;
      }
      const created = await this.store.transaction(async tx => {
        await tx.lockProfile();
        const currentProfile = await tx.getConfig('profile', {});
        if (Number(currentProfile.revision) !== Number(profile.revision)) {
          Object.assign(evaluation, evaluateJob(job, settings.filters, currentProfile));
          if (!evaluation.accepted) return null;
          if (settings.useJev) evaluation.jev = { status: 'profile_changed', review: true, confidence: 0 };
          if (settings.mode === 'AA') { evaluation.packet = reviewPacket(job, currentProfile); state = evaluation.packet.state; builtPacket = true; }
          if (evaluation.jev?.review) { delete evaluation.packet; state = 'matched'; }
        }
        // The unique canonical URL, not a title or scrape timestamp, owns deduplication.
        const insert = await tx.query(`INSERT INTO automation_matches(id,url,title,company,location,source,state,score,payload,evaluation,first_seen,updated_at,profile_revision)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING RETURNING id`, [job.id, job.url, job.title, job.company, job.location, job.source, state, evaluation.score, JSON.stringify(job), JSON.stringify(evaluation), nowISO(), nowISO(), currentProfile.revision || 0]);
        if (insert.rows.length && settings.slackEnabled) await this.enqueueAlert(job, evaluation, tx);
        if (!insert.rows.length) {
          const previous = (await tx.query('SELECT state,profile_revision,evaluation FROM automation_matches WHERE id=?', [job.id])).rows[0];
          const previousEvaluation = json(previous.evaluation);
          const managed = ['matched', 'ready', 'prepared', 'needs_input', 'closed'].includes(previous.state);
          const currentPacket = Number(previous.profile_revision) === Number(currentProfile.revision) && previousEvaluation.packet?.jobEvidenceHash === jobEvidenceHash(job);
          if (currentPacket && ((!managed) || (settings.mode === 'RM' && ['ready', 'prepared', 'needs_input'].includes(previous.state)))) {
            evaluation.packet = previousEvaluation.packet;
            if (managed) state = previous.state;
          }
          if (!managed) state = previous.state;
          await tx.query('UPDATE automation_matches SET payload=?,score=?,evaluation=?,state=?,profile_revision=?,updated_at=? WHERE id=?', [JSON.stringify(job), evaluation.score, JSON.stringify(evaluation), state, currentProfile.revision || 0, nowISO(), job.id]);
        }
        return insert.rows.length > 0;
      });
      if (created === null) { stats.matched--; stats.rejected++; }
      else if (created) stats.added++; else stats.duplicate++;
      if (created !== null && builtPacket && evaluation.packet?.state === 'ready' && state === 'ready') stats.prepared++;
    }
    return stats;
  }

  async enqueueAlert(job, evaluation, connection = this.store) {
    const id = hash(`new-job:${job.id}`);
    const body = { jobId: job.id, title: job.title, company: job.company, location: job.location, url: job.url, score: evaluation.score, matchedSkills: evaluation.matchedSkills, warnings: evaluation.warnings, salary: job.salary, requiredYears: job.requiredYears };
    await connection.query('INSERT INTO automation_outbox(id,event_key,body,state,attempts,due_at) VALUES(?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING', [id, `new-job:${job.id}`, JSON.stringify(body), 'pending', 0, Date.now()]);
  }

  async recoverExpired() {
    const cutoff = new Date(Date.now() - 120000).toISOString();
    // A delivery could have succeeded before a crash. Never automatically retry an uncertain send.
    await this.store.query("UPDATE automation_drafts SET state='needs_verification',updated_at=? WHERE state='sending' AND updated_at<?", [nowISO(), cutoff]);
    await this.store.query("UPDATE automation_outbox SET state='needs_verification',error='Delivery interrupted; verify the Slack channel before retrying.' WHERE state='sending' AND due_at<?", [Date.now() - 120000]);
    await this.store.query("UPDATE automation_runs SET state='interrupted',finished_at=? WHERE state IN ('queued','running') AND started_at<?", [nowISO(), new Date(Date.now() - 25 * 60000).toISOString()]);
  }

  async queueCycle() {
    if (this.running || this.queued) return { id: this.activeRunId, state: 'busy', message: 'A discovery run is already active.' };
    this.queued = true;
    try {
      if (!await this.store.acquire(this.owner)) { this.queued = false; return { state: 'busy', message: 'Another discovery worker is active.' }; }
      const id = randomUUID(); this.activeRunId = id;
      await this.store.query('INSERT INTO automation_runs(id,started_at,state,body) VALUES(?,?,?,?)', [id, nowISO(), 'queued', '{}']);
      setImmediate(() => { this.cycle({ id, leaseHeld: true }).catch(() => {}); });
      return { id, state: 'queued', message: 'Discovery started. Progress will update here; you can leave this page while the worker continues.' };
    } catch (error) {
      this.queued = false; this.activeRunId = null;
      await this.store.release(this.owner);
      throw error;
    }
  }

  async cycle({ id = randomUUID(), leaseHeld = false } = {}) {
    if (this.running || (!leaseHeld && (this.queued || !await this.store.acquire(this.owner)))) return { id: this.activeRunId, state: 'busy', message: 'Another discovery run is active.' };
    this.queued = false; this.activeRunId = id;
    this.running = true;
    const started = nowISO();
    const report = { sources: 0, inspected: 0, matched: 0, added: 0, duplicate: 0, rejected: 0, prepared: 0, errors: [], stages: [] };
    try {
      await this.recoverExpired();
      await this.store.query("INSERT INTO automation_runs(id,started_at,state,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state='running',body=excluded.body", [id, started, 'running', JSON.stringify(report)]);
      const settings = await this.settings(), profile = await this.profile();
      const context = { settings, profile, jevUsed: 0 };
      const due = (await this.store.query("SELECT * FROM automation_directory WHERE enabled=1 AND provider IN ('greenhouse','lever','ashby') AND due_at<=? ORDER BY due_at ASC,id ASC LIMIT ?", [Date.now(), settings.sourceBatchSize])).rows;
      report.stages.push({ stage: 'discover', sources: due.length, concurrency: 4 });
      let remaining = settings.maxJobsPerRun;
      for (let offset = 0; offset < due.length; offset += 4) {
        if (!await this.store.acquire(this.owner)) throw fail('Worker lease was lost.', 409);
        const batch = due.slice(offset, offset + 4);
        const results = await Promise.allSettled(batch.map(source => this.boardReader(source, { fetchImpl: this.fetch })));
        for (let index = 0; index < results.length; index++) {
          const source = batch[index], result = results[index]; report.sources++;
          if (result.status === 'rejected') {
            const failures = Number(source.failures || 0) + 1;
            report.errors.push({ source: source.name, error: 'Source fetch failed; retry scheduled.' });
            await this.store.query("UPDATE automation_directory SET status='error',failures=?,checked_at=?,due_at=?,error=? WHERE id=?", [failures, nowISO(), Date.now() + Math.min(24 * 3600000, settings.intervalMinutes * 60000 * 2 ** Math.min(failures, 5)), 'Source unavailable or returned invalid data.', source.id]);
            continue;
          }
          const raw = Array.isArray(result.value) ? result.value : result.value?.jobs || [];
          // A successfully fetched whole board may close old listings, while
          // application history and uncertain source failures remain untouched.
          const activeIds = new Set(raw.map(job => { try { return normalizeJob(job, source).id; } catch { return null; } }).filter(Boolean));
          const previous = (await this.store.query("SELECT id,payload FROM automation_matches WHERE source=? AND state IN ('matched','review','ready','prepared','needs_input')", [source.name])).rows;
          for (const match of (raw.complete === false ? [] : previous)) {
            const saved = json(match.payload);
            if (saved.provider === source.provider && saved.board === source.board && !activeIds.has(match.id)) await this.store.query("UPDATE automation_matches SET state='closed',updated_at=? WHERE id=? AND state IN ('matched','review','ready','prepared','needs_input')", [nowISO(), match.id]);
          }
          if (remaining <= 0) continue;
          const cursorKey = `source-cursor:${source.id}`;
          const cursor = Number(await this.store.getConfig(cursorKey, 0));
          const start = cursor >= raw.length ? 0 : cursor;
          const selected = raw.slice(start, start + Math.max(0, remaining));
          const counts = await this.ingest(selected, source, context);
          remaining -= counts.inspected;
          for (const key of ['inspected', 'matched', 'added', 'duplicate', 'rejected', 'prepared']) report[key] += counts[key];
          const nextCursor = start + counts.inspected < raw.length ? start + counts.inspected : 0;
          await this.store.setConfig(cursorKey, nextCursor);
          // Advance within a large board across runs; later postings cannot be starved by the first page.
          await this.store.query("UPDATE automation_directory SET status='healthy',failures=0,checked_at=?,due_at=?,job_count=?,error=NULL WHERE id=?", [nowISO(), nextCursor ? Date.now() : Date.now() + settings.intervalMinutes * 60000, raw.length, source.id]);
        }
        if (remaining <= 0) break;
      }
      report.stages.push({ stage: 'filter-and-deduplicate', matched: report.matched, new: report.added }, { stage: 'prepare', mode: settings.mode, submissions: 0 }, { stage: 'jev', evaluated: context.jevUsed });
      if (settings.qdrantEnabled && this.qdrant.configured) {
        try { report.vector = await this.reindex(); } catch { report.vector = { status: 'unavailable', fallback: 'local evidence retrieval' }; }
      }
      if (settings.slackEnabled) report.slack = await this.flushAlerts();
      report.stages.push({ stage: 'complete', durationMs: Date.now() - Date.parse(started) });
      Object.assign(report, { fetched: report.inspected, duplicates: report.duplicate, failed: report.errors.length, indexed: report.vector?.indexed || 0 });
      await this.store.query('UPDATE automation_runs SET state=?,finished_at=?,body=? WHERE id=?', ['completed', nowISO(), JSON.stringify(report), id]);
      return { id, state: 'completed', ...report };
    } catch {
      report.errors.push({ error: 'Run could not complete. Saved jobs and delivery records have been retained.' });
      await this.store.query('UPDATE automation_runs SET state=?,finished_at=?,body=? WHERE id=?', ['failed', nowISO(), JSON.stringify(report), id]);
      return { id, state: 'failed', ...report };
    } finally { this.running = false; this.activeRunId = null; await this.store.release(this.owner); }
  }

  async flushAlerts() {
    const settings = await this.settings();
    if (!settings.slackEnabled || !this.env.SLACK_BOT_TOKEN || !/^C[A-Z0-9]+$|^G[A-Z0-9]+$/.test(this.env.SLACK_CHANNEL_ID || '')) return { state: 'not_configured', sent: 0 };
    if (!await this.store.acquire(this.owner, 120000, 'slack')) return { state: 'busy', sent: 0 };
    let sent = 0;
    try {
      if (Date.now() - this.alertChannelChecked > 5 * 60000) {
        const info = await this.fetch(`https://slack.com/api/conversations.info?channel=${encodeURIComponent(this.env.SLACK_CHANNEL_ID)}`, { redirect: 'error', headers: { Authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}` }, signal: AbortSignal.timeout(10000) });
        const data = await info.json();
        if (!data.ok || data.channel?.id !== this.env.SLACK_CHANNEL_ID || data.channel.is_archived || data.channel.is_member === false || (!data.channel.is_private && this.env.SLACK_ALLOW_PUBLIC_ALERTS !== 'true')) return { state: 'channel_verification_required', sent: 0 };
        this.alertChannelChecked = Date.now();
      }
      const rows = (await this.store.query("SELECT * FROM automation_outbox WHERE state='pending' AND due_at<=? ORDER BY due_at LIMIT 20", [Date.now()])).rows;
      for (const row of rows) {
        if (!await this.store.acquire(this.owner, 120000, 'slack')) break;
        const claim = await this.store.query("UPDATE automation_outbox SET state='sending',attempts=attempts+1,due_at=? WHERE id=? AND state='pending' RETURNING id", [Date.now(), row.id]);
        if (!claim.rows.length) continue;
        const alert = json(row.body), escape = value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/@/g, '＠');
        const salary = alert.salary?.verified ? `Employer range: ₹${alert.salary.minLpa}–${alert.salary.maxLpa} LPA` : 'Compensation unverified';
        const message = `*New job: ${escape(alert.title)}*\n${escape(alert.company)} · ${escape(alert.location)}\nEvidence match: ${alert.score}/100 · ${salary}\n${escape((alert.matchedSkills || []).join(', '))}\n${escape((alert.warnings || []).join('; '))}\n<${alert.url}|Official application>\nOpen CareerOps to review or prepare. No application has been submitted.`;
        try {
          const response = await this.fetch('https://slack.com/api/chat.postMessage', { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: this.env.SLACK_CHANNEL_ID, text: message, unfurl_links: false, unfurl_media: false, client_msg_id: row.id.slice(0, 8) + '-' + row.id.slice(8, 12) + '-4' + row.id.slice(13, 16) + '-a' + row.id.slice(17, 20) + '-' + row.id.slice(20, 32) }), signal: AbortSignal.timeout(12000) });
          if (response.status === 429) {
            const delay = Math.max(60, Number(response.headers.get('retry-after')) || 60) * 1000;
            await this.store.query("UPDATE automation_outbox SET state='pending',due_at=?,error='Slack rate limited this request.' WHERE id=?", [Date.now() + delay, row.id]); continue;
          }
          const data = await response.json();
          if (response.ok && data.ok && data.ts) {
            await this.store.query("UPDATE automation_outbox SET state='sent',receipt=?,error=NULL WHERE id=?", [JSON.stringify({ channel: this.env.SLACK_CHANNEL_ID, ts: data.ts }), row.id]); sent++;
          } else if (response.ok && data.ok === false) {
            const retry = ['ratelimited', 'service_unavailable'].includes(data.error) && Number(row.attempts) < 5;
            await this.store.query('UPDATE automation_outbox SET state=?,due_at=?,error=? WHERE id=?', [retry ? 'pending' : 'failed', Date.now() + 60000 * 2 ** Math.min(Number(row.attempts), 6), retry ? 'Slack rejected the request; retry scheduled.' : 'Slack rejected the request. Check integration permissions.', row.id]);
          } else throw new Error('Delivery uncertain');
        } catch { await this.store.query("UPDATE automation_outbox SET state='needs_verification',error='Delivery not confirmed. Check Slack before retrying.' WHERE id=?", [row.id]); }
      }
      return { state: 'complete', sent };
    } catch { return { state: 'unavailable', sent }; }
    finally { await this.store.release(this.owner, 'slack'); }
  }

  async documents() {
    const rows = (await this.store.query('SELECT id,title,company,url,payload FROM automation_matches ORDER BY updated_at DESC LIMIT 2000')).rows;
    return rows.map(row => { const job = json(row.payload); return { id: row.id, title: `${row.company} — ${row.title}`, text: `${job.location}\n${job.description}\n${job.salary?.verified ? `Published range ${job.salary.minLpa}–${job.salary.maxLpa} LPA.` : 'Salary unverified.'}`, url: row.url, namespace: 'jobs' }; });
  }

  async ask(question) {
    const query = text(question, 1000); if (!query) throw fail('Enter a question.');
    let documents = await this.documents(), retrieval = 'local lexical evidence';
    const profile = await this.profile();
    const resumeDocument = profile.resumeText ? { id: `resume-${profile.revision}`, title: 'Your uploaded resume', text: profile.resumeText, namespace: 'private-resume', url: null } : null;
    const settings = await this.settings();
    if (settings.qdrantEnabled && this.qdrant.configured) {
      try { const results = await this.qdrant.search(query, { limit: 8, namespace: 'jobs' }); if (results.length) { const current = new Map(documents.map(doc => [doc.id, doc])); const retrieved = results.filter(doc => doc.namespace === 'jobs' && current.has(doc.id)).map(doc => current.get(doc.id)); if (retrieved.length) { documents = retrieved; retrieval = 'Qdrant sparse keyword retrieval'; } } } catch { /* Retrieval remains available locally. */ }
    }
    if (resumeDocument) documents.push(resumeDocument);
    const response = await answerFromEvidence(query, documents, this.generate);
    return { ...response, retrieval };
  }

  async reindex() {
    if (!this.qdrant.configured) return { status: 'not_configured', indexed: 0 };
    return this.qdrant.upsert(await this.documents());
  }

  async createDraft(input) {
    const job = await this.getMatch(input.jobId || input.job_id);
    if (!validRecipient(input.recipient)) throw fail('Enter one verified recipient email address; recipients are never inferred.');
    const subject = String(input.subject || `Application for ${job.title}`).replace(/[\r\n]/g, ' ').trim().slice(0, 300);
    const body = String(input.body || '').replace(/\0/g, '').trim().slice(0, 20000);
    if (!body) throw fail('Write or review the application email before creating a draft.');
    return this.store.transaction(async tx => {
      await tx.lockProfile();
      const profile = await tx.getConfig('profile', {});
      if (!profile.resumeHash || !profile.email) throw fail('Upload a resume and save your email address first.');
      const draft = { id: randomUUID(), job_id: job.id, recipient: input.recipient.trim(), subject, body, resume_hash: profile.resumeHash, profile_revision: profile.revision, state: 'draft', created_at: nowISO(), updated_at: nowISO(), approved_digest: null };
      draft.digest = draftDigest(draft);
      await tx.query('INSERT INTO automation_drafts(id,job_id,recipient,subject,body,resume_hash,profile_revision,digest,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [draft.id, draft.job_id, draft.recipient, draft.subject, draft.body, draft.resume_hash, draft.profile_revision, draft.digest, draft.state, draft.created_at, draft.updated_at]);
      return draft;
    });
  }

  async draft(id) {
    const value = (await this.store.query('SELECT * FROM automation_drafts WHERE id=?', [id])).rows[0];
    if (!value) throw fail('Draft not found.', 404);
    return value;
  }

  async editDraft(id, input) {
    return this.store.transaction(async tx => {
      await tx.lockProfile();
      const row = (await tx.query('SELECT * FROM automation_drafts WHERE id=?', [id])).rows[0];
      if (!row) throw fail('Draft not found.', 404);
      if (['sending', 'sent', 'needs_verification'].includes(row.state)) throw fail('This draft has been sent or delivery requires verification; it cannot be edited.', 409);
      const profile = await tx.getConfig('profile', {});
      const next = { ...row, recipient: String(input.recipient ?? row.recipient).trim(), subject: String(input.subject ?? row.subject).replace(/[\r\n]/g, ' ').trim().slice(0, 300), body: String(input.body ?? row.body).replace(/\0/g, '').trim().slice(0, 20000), resume_hash: profile.resumeHash, profile_revision: profile.revision, state: 'draft', approved_digest: null, updated_at: nowISO() };
      if (!validRecipient(next.recipient) || !next.subject || !next.body || !next.resume_hash) throw fail('A recipient, subject, body and current resume are required.');
      next.digest = draftDigest(next);
      await tx.query('UPDATE automation_drafts SET recipient=?,subject=?,body=?,resume_hash=?,profile_revision=?,digest=?,approved_digest=NULL,state=?,updated_at=? WHERE id=?', [next.recipient, next.subject, next.body, next.resume_hash, next.profile_revision, next.digest, next.state, next.updated_at, id]);
      return next;
    });
  }

  async approveDraft(id, digest) {
    return this.store.transaction(async tx => {
      await tx.lockProfile();
      const draft = (await tx.query('SELECT * FROM automation_drafts WHERE id=?', [id])).rows[0];
      const profile = await tx.getConfig('profile', {});
      if (!draft) throw fail('Draft not found.', 404);
      if (!['draft', 'approved'].includes(draft.state) || digest !== draft.digest || draftDigest(draft) !== digest || Number(draft.profile_revision) !== Number(profile.revision) || draft.resume_hash !== profile.resumeHash) throw fail('This draft changed or uses an older profile. Review the current draft and approve it again.', 409);
      await tx.query("UPDATE automation_drafts SET approved_digest=?,state='approved',updated_at=? WHERE id=?", [digest, nowISO(), id]);
      return { ...draft, state: 'approved', approved_digest: digest };
    });
  }

  async sendDraft(id, digest) {
    if (!this.mailer?.configured) throw fail('Email delivery is not configured. You can download an approved draft.', 503);
    const snapshot = await this.profile();
    // Preflight does not send. Approval and profile are rechecked atomically afterward.
    await this.mailer.preflight?.(snapshot);
    const claimed = await this.store.transaction(async tx => {
      await tx.lockProfile();
      const draft = (await tx.query('SELECT * FROM automation_drafts WHERE id=?', [id])).rows[0];
      const profile = await tx.getConfig('profile', {}), resume = await tx.getConfig('resume', null);
      if (!draft) throw fail('Draft not found.', 404);
      if (draft.state === 'sent') return { alreadySent: true, draft };
      if (draft.state !== 'approved' || !digest || digest !== draft.digest || draft.approved_digest !== digest || draftDigest(draft) !== digest || draft.resume_hash !== profile.resumeHash || resume?.hash !== draft.resume_hash || Number(draft.profile_revision) !== Number(profile.revision) || snapshot.email !== profile.email) throw fail('Explicit approval of the current recipient, content, resume and profile is required.', 409);
      const result = await tx.query("UPDATE automation_drafts SET state='sending',updated_at=? WHERE id=? AND state='approved' AND approved_digest=? RETURNING id", [nowISO(), id, digest]);
      if (!result.rows.length) throw fail('This draft is already being delivered.', 409);
      return { draft, profile, resume };
    });
    if (claimed.alreadySent) return { id, state: 'sent', receipt: json(claimed.draft.receipt), duplicatePrevented: true };
    try {
      const receipt = await this.mailer.send(claimed.draft, claimed.profile, claimed.resume);
      if (!receipt?.id) throw new Error('Missing receipt');
      await this.store.query("UPDATE automation_drafts SET state='sent',receipt=?,updated_at=? WHERE id=? AND state='sending'", [JSON.stringify(receipt), nowISO(), id]);
      return { id, state: 'sent', receipt };
    } catch {
      await this.store.query("UPDATE automation_drafts SET state='needs_verification',updated_at=? WHERE id=? AND state='sending'", [nowISO(), id]);
      throw fail('Email delivery was not confirmed. Check Gmail; this message will not be retried automatically.', 502);
    }
  }

  async downloadDraft(id) {
    return this.store.transaction(async tx => {
      await tx.lockProfile();
      const draft = (await tx.query('SELECT * FROM automation_drafts WHERE id=?', [id])).rows[0];
      if (!draft) throw fail('Draft not found.', 404);
      const profile = await tx.getConfig('profile', {}), resume = await tx.getConfig('resume', null);
      if (Number(draft.profile_revision) !== Number(profile.revision) || draft.resume_hash !== resume?.hash) throw fail('The draft uses an older profile or resume. Edit and review it first.', 409);
      return toMime(draft, profile, resume);
    });
  }

  start() {
    if (this.timer || this.env.DISABLE_BACKGROUND_JOBS === 'true') return;
    this.timer = setInterval(async () => {
      try {
        const settings = await this.settings();
        if (!settings.enabled || this.running) return;
        const last = (await this.store.query('SELECT started_at FROM automation_runs ORDER BY started_at DESC LIMIT 1')).rows[0];
        if (!last || Date.now() - Date.parse(last.started_at) >= settings.intervalMinutes * 60000) await this.cycle();
        else if (settings.slackEnabled) await this.flushAlerts();
      } catch { /* The next scheduler tick can recover; private error details stay out of logs. */ }
    }, 60000);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

module.exports = { Harness, DEFAULT_SETTINGS, cleanProfile, draftDigest, reviewPacket, fail };
