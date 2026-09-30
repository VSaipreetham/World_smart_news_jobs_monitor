'use strict';

const { hash, text, safeUrl, normalizeJob } = require('./policy');
const { JOB_APIS, JOB_RSS_FEEDS, JOB_BOARD_SOURCES } = require('../sources');

const LIMITS = Object.freeze({ portals: 10000, companies: 100000, importBatch: 10000, pageSize: 100, jobsPerBoard: 5000, responseBytes: 5 * 1024 * 1024 });
const SUPPORTED = new Set(['greenhouse', 'lever', 'ashby']);
const BOARD_TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/;

function inferProvider(url) {
  const parsed = new URL(url);
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (['boards.greenhouse.io', 'job-boards.greenhouse.io'].includes(parsed.hostname)) return { provider: 'greenhouse', board: parts[0] };
  if (parsed.hostname === 'boards-api.greenhouse.io' && parts[0] === 'v1' && parts[1] === 'boards') return { provider: 'greenhouse', board: parts[2] };
  if (['jobs.lever.co', 'jobs.eu.lever.co'].includes(parsed.hostname)) return { provider: 'lever', board: parts[0], region: parsed.hostname.includes('.eu.') ? 'eu' : 'us' };
  if (parsed.hostname === 'jobs.ashbyhq.com') return { provider: 'ashby', board: parts[0] };
  return { provider: 'manual', board: '' };
}

function sourceRecord(input = {}) {
  const url = safeUrl(input.url || input.careerUrl || input.careersUrl);
  if (!url) throw new Error('Directory URL must be public HTTPS, without credentials');
  const name = text(input.name || input.company, 200);
  if (!name) throw new Error('Company or portal name is required');
  const inferred = inferProvider(url);
  const provider = String(input.provider || inferred.provider).toLowerCase();
  if (!['manual', ...SUPPORTED].includes(provider)) throw new Error('Unknown source adapter; use manual for unsupported portals');
  const board = text(input.board || inferred.board || '', 101);
  if (SUPPORTED.has(provider) && !BOARD_TOKEN.test(board)) throw new Error('ATS source requires a valid board token');
  // A provider declaration must agree with the visible official ATS link. This
  // prevents an imported link being presented as verified simply by its label.
  if (SUPPORTED.has(provider) && (provider !== inferred.provider || board !== inferred.board)) throw new Error('ATS provider and board must match the directory URL');
  const kind = input.kind === 'portal' ? 'portal' : input.kind === 'company' ? 'company' : (SUPPORTED.has(provider) ? 'company' : 'portal');
  return {
    id: hash(url), name, url, kind, provider, board,
    country: text(input.country || input.region || 'Unspecified', 100), sector: text(input.sector || 'Unspecified', 100),
    enabled: SUPPORTED.has(provider) && (input.enabled === true || input.enabled === 1) ? 1 : 0,
    status: 'unverified', failures: 0, due_at: 0, checked_at: null, job_count: 0, error: null,
  };
}

async function importDirectory(store, input) {
  const supplied = Array.isArray(input) ? input : input?.rows;
  if (!Array.isArray(supplied)) throw new Error('Import requires an array of source records');
  if (supplied.length > LIMITS.importBatch) throw new Error(`Import at most ${LIMITS.importBatch} records per request`);
  const unique = new Map();
  for (let index = 0; index < supplied.length; index++) {
    try { const record = sourceRecord(supplied[index]); unique.set(record.url, record); }
    catch (error) { throw new Error(`Import row ${index + 1}: ${error.message}`); }
  }
  if (typeof store.transaction !== 'function') throw new Error('Directory imports require transactional storage');
  return store.transaction(async tx => {
    // A shared row lock serializes capacity checks in Postgres; SQLite's write
    // transaction provides the same guarantee. A count outside the transaction
    // would allow simultaneous imports to exceed the configured capacities.
    await tx.query('INSERT INTO automation_config(id,body) VALUES(?,?) ON CONFLICT(id) DO NOTHING', ['directory-capacity-lock', '{}']);
    await tx.query('UPDATE automation_config SET body=body WHERE id=?', ['directory-capacity-lock']);
    const counts = { portals: 0, companies: 0 };
    const counted = await tx.query('SELECT kind,COUNT(*) AS count FROM automation_directory GROUP BY kind');
    for (const row of counted.rows) counts[row.kind === 'company' ? 'companies' : 'portals'] = Number(row.count);
    const records = [...unique.values()], newRecords = [];
    for (let offset = 0; offset < records.length; offset += 200) {
      const batch = records.slice(offset, offset + 200);
      const existing = await tx.query(`SELECT url FROM automation_directory WHERE url IN (${batch.map(() => '?').join(',')})`, batch.map(record => record.url));
      const urls = new Set(existing.rows.map(row => row.url));
      newRecords.push(...batch.filter(record => !urls.has(record.url)));
    }
    for (const record of newRecords) counts[record.kind === 'company' ? 'companies' : 'portals']++;
    if (counts.portals > LIMITS.portals || counts.companies > LIMITS.companies) throw new Error('Directory capacity exceeded: 10,000 portals and 100,000 company records');
    for (let offset = 0; offset < newRecords.length; offset += 200) {
      const batch = newRecords.slice(offset, offset + 200);
      const values = batch.flatMap(record => [record.id, record.name, record.url, record.kind, record.provider, record.board, record.country, record.sector, record.enabled]);
      await tx.query(`INSERT INTO automation_directory(id,name,url,kind,provider,board,country,sector,enabled) VALUES ${batch.map(() => '(?,?,?,?,?,?,?,?,?)').join(',')}`, values);
    }
    return { imported: newRecords.length, duplicates: supplied.length - newRecords.length, capacity: { portals: LIMITS.portals, companies: LIMITS.companies }, counts };
  });
}

async function listDirectory(store, params = {}) {
  const page = Math.max(1, Math.min(100000, Math.floor(Number(params.page) || 1)));
  const limit = Math.max(1, Math.min(LIMITS.pageSize, Math.floor(Number(params.limit) || 25)));
  const conditions = [], values = [];
  const query = text(params.q || params.search || '', 200).toLowerCase();
  if (query) { conditions.push("(LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(url) LIKE ? ESCAPE '\\')"); const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`; values.push(pattern, pattern); }
  for (const key of ['kind', 'provider', 'country', 'sector', 'status']) {
    if (params[key] && params[key] !== 'all') { conditions.push(`${key}=?`); values.push(text(params[key], 100)); }
  }
  if (params.enabled === true || params.enabled === 'true' || params.enabled === '1') conditions.push('enabled=1');
  else if (params.enabled === false || params.enabled === 'false' || params.enabled === '0') conditions.push('enabled=0');
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const total = Number((await store.query(`SELECT COUNT(*) AS total FROM automation_directory${where}`, values)).rows[0]?.total || 0);
  const result = await store.query(`SELECT * FROM automation_directory${where} ORDER BY LOWER(name),id LIMIT ? OFFSET ?`, [...values, limit, (page - 1) * limit]);
  return { rows: result.rows, total, page, limit, capacity: { portals: LIMITS.portals, companies: LIMITS.companies } };
}

async function boundedJson(response, maxBytes = LIMITS.responseBytes) {
  if (!response.ok) throw new Error(`Official source returned HTTP ${response.status}`);
  const declared = Number(response.headers?.get?.('content-length'));
  if (declared > maxBytes) throw new Error('Source response exceeds the size budget');
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maxBytes) { await reader.cancel(); throw new Error('Source response exceeds the size budget'); }
        chunks.push(Buffer.from(part.value));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { reader.releaseLock(); }
  }
  const body = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json());
  if (Buffer.byteLength(body) > maxBytes) throw new Error('Source response exceeds the size budget');
  return JSON.parse(body);
}

async function fetchBoard(source, options = {}) {
  const { fetchImpl = fetch, now = Date.now() } = typeof options === 'function' ? { fetchImpl: options } : options;
  const record = sourceRecord(source);
  if (!SUPPORTED.has(record.provider)) throw new Error('Manual career link: no supported fetch adapter is configured');
  const board = encodeURIComponent(record.board);
  const region = new URL(record.url).hostname === 'jobs.eu.lever.co' ? 'api.eu.lever.co' : 'api.lever.co';
  const endpoints = {
    greenhouse: `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`,
    lever: `https://${region}/v0/postings/${board}?mode=json`,
    ashby: `https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true`,
  };
  const response = await fetchImpl(endpoints[record.provider], { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json', 'User-Agent': 'WorldSmartMonitor/2.0 CareerDirectory' } });
  const data = await boundedJson(response);
  const rows = record.provider === 'lever' ? data : data.jobs;
  if (!Array.isArray(rows)) throw new Error('Official source returned an unexpected response schema');
  if (rows.length > LIMITS.jobsPerBoard) throw new Error('Board exceeded the job budget; use a paginated adapter before enabling it');
  const verifiedAt = new Date(now).toISOString();
  const jobs = [];
  let malformed = 0;
  for (const row of rows) {
    if (row.isListed === false) continue;
    try {
      let raw;
      if (record.provider === 'greenhouse') {
        raw = { externalId: row.id, title: row.title, url: row.absolute_url, location: row.location?.name,
          description: row.content, postedDate: row.first_published, verifiedAt,
          pay: row.metadata?.filter(field => /salary|compensation/i.test(field.name || '')).map(field => text(field.value)).join(' ') };
      } else if (record.provider === 'lever') {
        raw = { externalId: row.id, title: row.text, url: row.hostedUrl, location: row.categories?.location,
          description: [row.descriptionPlain || row.description, ...(row.lists || []).map(item => `${item.text} ${item.content}`), row.additionalPlain || row.additional].filter(Boolean).join('\n'),
          createdAt: row.createdAt, workplaceType: row.workplaceType, employmentType: row.categories?.commitment,
          salary: row.salaryRange, verifiedAt };
      } else {
        raw = { externalId: row.id, title: row.title, url: row.jobUrl, location: [row.location, ...(row.secondaryLocations || []).map(item => typeof item === 'string' ? item : item.location)].filter(Boolean).join('; '),
          description: row.descriptionPlain || row.descriptionHtml, publishedAt: row.publishedAt,
          isRemote: row.isRemote, workplaceType: row.workplaceType, employmentType: row.employmentType,
          salaryText: row.compensation?.compensationTierSummary || '', verifiedAt };
      }
      jobs.push(normalizeJob(raw, record));
    } catch { malformed++; }
  }
  // Valid postings can still be ingested, but an incomplete response must never
  // be used to infer that an older saved opening has closed.
  jobs.complete = malformed === 0;
  jobs.malformed = malformed;
  return jobs;
}

const CAREER_SEEDS = [
  ['CRED', 'https://jobs.lever.co/cred', true], ['GHX', 'https://job-boards.greenhouse.io/globalhealthcareexchangeinc', true],
  ['Truveta', 'https://job-boards.greenhouse.io/truveta', true], ['Cenna Systems', 'https://jobs.lever.co/cenna-systems', true],
  ['Google', 'https://www.google.com/about/careers/applications/jobs/results/'],
  ['Microsoft', 'https://careers.microsoft.com/'], ['Amazon', 'https://www.amazon.jobs/'], ['Apple', 'https://jobs.apple.com/'],
  ['NVIDIA', 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite'], ['JPMorganChase', 'https://careers.jpmorgan.com/'],
  ['Goldman Sachs', 'https://higher.gs.com/'], ['Amgen', 'https://careers.amgen.com/'],
  ['Optum', 'https://careers.unitedhealthgroup.com/'], ['Carrier', 'https://jobs.carrier.com/'],
  ['ADP', 'https://jobs.adp.com/'], ['Micron', 'https://careers.micron.com/'], ['Novartis', 'https://www.novartis.com/careers/career-search'],
  ['Oracle', 'https://careers.oracle.com/'], ['Salesforce', 'https://careers.salesforce.com/'],
  ['ServiceNow', 'https://careers.servicenow.com/'], ['Accenture', 'https://www.accenture.com/in-en/careers'],
  ['Teradata', 'https://careers.teradata.com/'],
];

async function seedDirectory(store) {
  const rows = [
    ...JOB_APIS.map(source => ({ name: source.name, url: source.url, kind: 'portal' })),
    ...JOB_RSS_FEEDS.map((url, index) => ({ name: `${new URL(url).hostname} feed ${index + 1}`, url, kind: 'portal' })),
    ...JOB_BOARD_SOURCES.map(source => ({ name: source.name, url: source.url, kind: 'portal', country: source.region })),
    ...CAREER_SEEDS.map(([name, url, enabled = false]) => ({ name, url, enabled, kind: 'company', country: 'Global', sector: 'Technology and services' })),
  ];
  return importDirectory(store, rows);
}

module.exports = { LIMITS, sourceRecord, importDirectory, listDirectory, fetchBoard, seedDirectory, boundedJson };
