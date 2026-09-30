'use strict';
// Synthetic records live only in an isolated in-memory benchmark store.
const { performance } = require('node:perf_hooks');
const { Store } = require('./store');
const { importDirectory, listDirectory } = require('./directory');
(async () => {
  const store = new Store({ filename: ':memory:' });
  await store.init();
  const started = performance.now();
  for (let offset = 0; offset < 100000; offset += 5000) {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ name: `Synthetic benchmark ${String(offset + i).padStart(6, '0')}`, url: `https://example.com/benchmark/${offset + i}`, kind: 'company' }));
    await importDirectory(store, rows);
  }
  const importedMs = performance.now() - started;
  const queryStart = performance.now();
  const page = await listDirectory(store, { kind: 'company', page: 1000, limit: 100 });
  if (page.total !== 100000 || page.rows.length !== 100) throw new Error('Directory pagination failed at capacity');
  const report = { records: page.total, returned: page.rows.length, page: page.page, importedMs: Math.round(importedMs), lastPageMs: Math.round(performance.now() - queryStart), storage: 'isolated in-memory SQLite', note: 'Synthetic directory records only; does not benchmark network crawling or production PostgreSQL' };
  await store.close();
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
})().catch(() => { process.stderr.write('Directory capacity benchmark failed\n'); process.exitCode = 1; });
