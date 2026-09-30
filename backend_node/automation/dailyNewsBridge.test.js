'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const tempRoot = path.join(os.tmpdir(), `daily-news-bridge-${process.pid}`);
const previousRoot = process.env.DAILY_NEWS_UPDATER_PATH;
process.env.DAILY_NEWS_UPDATER_PATH = tempRoot;

const scraperPath = require.resolve('../linkedinScraper');
const scraperModule = require(scraperPath);
let liveScrapeCalls = 0;
require.cache[scraperPath].exports = {
  ...scraperModule,
  scrapeLinkedInArticlesViaGoogle: async () => {
    liveScrapeCalls += 1;
    return [];
  },
  getLinkedInProxyStatus: () => ({ available: true, items: 2 }),
};

const bridgePath = require.resolve('../dailyNewsBridge');
delete require.cache[bridgePath];
const bridge = require(bridgePath);

test('bridge status reads local config and does not run a live LinkedIn scrape', async () => {
  await fs.mkdir(path.join(tempRoot, 'config'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'data', 'imports'), { recursive: true });
  await fs.writeFile(path.join(tempRoot, 'config', 'sources.json'), JSON.stringify({
    feeds: [{ url: 'https://example.com/rss' }],
    mediumFeeds: [],
    googleNewsQueries: ['AI engineering'],
    arxivQueries: [],
  }));
  await fs.writeFile(path.join(tempRoot, 'data', 'imports', 'linkedin.json'), JSON.stringify([
    { title: 'Imported story', url: 'https://example.com/story', author: 'Publisher' },
  ]));

  const status = await bridge.getDailyNewsBridgeStatus();
  const imports = await bridge.getLinkedInImports();

  assert.equal(status.connected, true);
  assert.equal(status.feeds, 1);
  assert.equal(status.googleNewsQueries, 1);
  assert.equal(status.linkedInImports, 1);
  assert.equal(status.linkedinProxy.available, true);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].headline, 'Imported story');
  assert.equal(liveScrapeCalls, 0);
});

after(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.DAILY_NEWS_UPDATER_PATH;
  else process.env.DAILY_NEWS_UPDATER_PATH = previousRoot;
  delete require.cache[bridgePath];
  require.cache[scraperPath].exports = scraperModule;
});
