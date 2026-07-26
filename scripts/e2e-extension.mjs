import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const extensionSourcePath = resolve('dist');
const extensionTempPath = mkdtempSync(join(tmpdir(), 'ai-bookmark-os-e2e-extension-'));
const extensionPath = join(extensionTempPath, 'extension');

function copyDirectory(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source)) {
    const sourcePath = join(source, name);
    const destinationPath = join(destination, name);
    if (statSync(sourcePath).isDirectory()) copyDirectory(sourcePath, destinationPath);
    else copyFileSync(sourcePath, destinationPath);
  }
}

copyDirectory(extensionSourcePath, extensionPath);
const e2eManifestPath = join(extensionPath, 'manifest.json');
const e2eManifest = JSON.parse(readFileSync(e2eManifestPath, 'utf8'));
e2eManifest.host_permissions = Array.from(new Set([
  ...(e2eManifest.host_permissions || []),
  '<all_urls>',
]));
e2eManifest.optional_host_permissions = (e2eManifest.optional_host_permissions || [])
  .filter((origin) => origin !== '<all_urls>');
writeFileSync(e2eManifestPath, JSON.stringify(e2eManifest, null, 2));
const artifactsPath = resolve('tmp-ui-shots');
mkdirSync(artifactsPath, { recursive: true });

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

function waitForStorage(page, predicate, timeoutMs = 8000) {
  return page.waitForFunction(predicate, undefined, { timeout: timeoutMs });
}

async function assertNoHorizontalOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.ok(dimensions.scrollWidth <= dimensions.clientWidth + 1, `${label} has horizontal overflow: ${JSON.stringify(dimensions)}`);
}

async function readBookmarkCardVisualContract(page, selectors) {
  return page.evaluate((targetSelectors) => {
    const getElement = (name) => {
      const element = document.querySelector(targetSelectors[name]);
      if (!element) throw new Error(`visual contract target not found: ${targetSelectors[name]}`);
      return element;
    };
    const read = (name, properties) => {
      const style = getComputedStyle(getElement(name));
      return Object.fromEntries(properties.map((property) => [property, style[property]]));
    };
    return {
      grid: read('grid', ['columnGap', 'rowGap']),
      card: read('card', ['backgroundColor', 'borderColor', 'borderRadius', 'boxShadow', 'padding', 'gap', 'backdropFilter']),
      favicon: read('favicon', ['width', 'height', 'borderRadius']),
      title: read('title', ['fontSize', 'fontWeight']),
      domain: read('domain', ['fontSize']),
      tag: read('tag', ['padding', 'borderRadius', 'fontSize', 'fontWeight']),
    };
  }, selectors);
}

async function openExtensionPage(context, extensionId, path, errors) {
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(`${path}: ${error.message}`));
  await page.goto(`chrome-extension://${extensionId}/${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body && document.body.innerText.trim().length > 0);
  return page;
}

const requests = { ai: 0, rss: 0, checker: 0 };
const mockServer = createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', '*');
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.url === '/feed.xml') {
    requests.rss += 1;
    response.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    response.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Mock Feed</title><link>https://example.test</link><item><guid>mock-1</guid><title>Mock article</title><link>https://example.test/article</link><pubDate>Fri, 17 Jul 2026 08:00:00 GMT</pubDate><description>Local RSS fixture</description></item></channel></rss>`);
    return;
  }
  if (request.url === '/v1/chat/completions') {
    requests.ai += 1;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({
      model: 'mock-model',
      choices: [{ message: { content: JSON.stringify({ tags: [{ tag: '前端开发', confidence: 0.96 }] }) } }],
    }));
    return;
  }
  if (request.url === '/click-count') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html><head><title>Click count fixture</title></head><body><main>Click count fixture</main></body></html>');
    return;
  }
  if (request.url === '/health-check') {
    requests.checker += 1;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(request.method === 'HEAD' ? '' : '<title>Available bookmark</title><meta name="description" content="Original metadata summary"><main>Healthy fixture</main>');
    return;
  }
  if (request.url === '/health-check-updated') {
    requests.checker += 1;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(request.method === 'HEAD' ? '' : '<title>Updated bookmark</title><meta name="description" content="Updated metadata summary"><main>Updated healthy fixture</main>');
    return;
  }
  response.writeHead(404);
  response.end('not found');
});

const port = await listen(mockServer);
const profilePath = mkdtempSync(join(tmpdir(), 'ai-bookmark-os-e2e-'));
let context;
try {
  context = await chromium.launchPersistentContext(profilePath, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--disable-default-apps',
    ],
  });

  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  assert.ok(extensionId, 'extension service worker did not expose an extension id');

  await worker.evaluate(async ({ port: fixturePort }) => {
    const tree = await chrome.bookmarks.getTree();
    const bar = tree[0]?.children?.[0];
    if (!bar) throw new Error('bookmark bar unavailable');
    const folder = await chrome.bookmarks.create({ parentId: bar.id, title: 'E2E Synthetic' });
    await chrome.bookmarks.create({ parentId: folder.id, title: 'Synthetic React', url: 'https://example.test/react' });
    await chrome.bookmarks.create({ parentId: folder.id, title: 'Synthetic Design', url: 'https://example.test/design' });
    await chrome.bookmarks.create({ parentId: folder.id, title: 'Synthetic Operations', url: 'https://example.test/ops' });
    await chrome.bookmarks.create({ parentId: folder.id, title: 'Synthetic Count', url: `http://127.0.0.1:${fixturePort}/click-count` });
    await chrome.bookmarks.create({ parentId: folder.id, title: 'Synthetic Healthy Link', url: `http://127.0.0.1:${fixturePort}/health-check` });
    const reviewTargetFolder = await chrome.bookmarks.create({ parentId: bar.id, title: 'E2E Batch Target' });
    const reviewBookmarkOne = await chrome.bookmarks.create({ parentId: folder.id, title: 'Synthetic Batch One', url: 'https://batch.example/one' });
    const reviewBookmarkTwo = await chrome.bookmarks.create({ parentId: folder.id, title: 'Synthetic Batch Two', url: 'https://batch.example/two' });
    await chrome.storage.local.set({
      ai_classifier_config: {
        enabled: true,
        assistClassificationEnabled: true,
        provider: 'custom',
        apiKey: 'e2e-local-key',
        model: 'mock-model',
        timeout: 5,
        customFormat: 'openai',
        customEndpoint: `http://127.0.0.1:${fixturePort}/v1`,
        customFullUrl: false,
        allowPageContentForAi: true,
      },
      ai_tag_cache: { version: 2, entries: { old: { tags: ['cached'] } } },
      page_content_cache: { 'https://example.test/react': { textContent: 'private cached body' } },
      rss_settings: { pollIntervalMin: 30, maxItemsPerFeed: 100, proxyFallback: false },
      rss_feeds: [{
        id: 'e2e-feed',
        url: `http://127.0.0.1:${fixturePort}/feed.xml`,
        title: 'Mock Feed',
        favicon: 'data:image/png;base64,iVBORw0KGgo=',
        failCount: 0,
        lastFetched: 0,
        autoBookmark: false,
        notify: false,
      }],
    });
    await syncAllBookmarks();
    await syncAllBookmarks();
    await clearReviewQueue();
    const timeline = await chrome.storage.local.get('bookmark_timeline_data');
    const bookmarks = timeline.bookmark_timeline_data || [];
    if (!bookmarks.length) throw new Error('synthetic bookmarks were not mirrored');
    const taggedBookmarkIndex = bookmarks.findIndex((bookmark) => bookmark.title === 'Synthetic React');
    if (taggedBookmarkIndex < 0) throw new Error('synthetic tag fixture was not mirrored');
    bookmarks[taggedBookmarkIndex] = {
      ...bookmarks[taggedBookmarkIndex],
      tags: ['E2E Unified Tag'],
      tagsAuto: ['E2E Unified Tag'],
      contentText: 'private cached body',
      contentExcerpt: 'private summary',
      contentHeadings: ['Private heading'],
    };
    const now = Date.now();
    const reviewTarget = (await loadBookmarkFolderOptions()).find(item => item.id === reviewTargetFolder.id);
    if (!reviewTarget) throw new Error('batch review target folder was not indexed');
    const reviewNativeBookmarks = [reviewBookmarkOne, reviewBookmarkTwo];
    const reviewMirroredBookmarks = reviewNativeBookmarks.map((nativeBookmark) => {
      const bookmark = bookmarks.find(item => item.id === nativeBookmark.id);
      if (!bookmark) throw new Error(`batch review bookmark was not mirrored: ${nativeBookmark.id}`);
      bookmark.tags = [];
      bookmark.tagsAuto = [];
      return bookmark;
    });
    const reviewSnapshots = reviewMirroredBookmarks.map((bookmark, index) => ({
      recommendationId: `recommendation-e2e-batch-${index + 1}`,
      ruleVersion: 'bookmark-recommendation-v3',
      urlFingerprint: recommendationUrlFingerprint(bookmark.url),
      domain: 'batch.example',
      pathSegments: [index === 0 ? 'one' : 'two'],
      tags: [{ tag: 'E2E Batch Tag', support: 0.95, confidence: 'high' }],
      folders: [{ id: reviewTarget.id, folderPath: reviewTarget.path, existing: true, support: 0.95, confidence: 'high' }],
      selectedTags: ['E2E Batch Tag'],
      selectedFolderPath: reviewTarget.path,
      createdAt: now,
    }));
    const reviewQueue = reviewMirroredBookmarks.map((bookmark, index) => ({
      id: `review-e2e-batch-${index + 1}`,
      type: 'bookmark_recommendation',
      bookmarkId: bookmark.id,
      recommendationId: reviewSnapshots[index].recommendationId,
      title: bookmark.title,
      urlFingerprint: reviewSnapshots[index].urlFingerprint,
      fromFolderPath: bookmark.folderPath,
      toFolderId: reviewTarget.id,
      toFolderPath: reviewTarget.path,
      sourceParentId: bookmark.parentId,
      sourceTags: [],
      confidence: 'high',
      createdAt: now,
      updatedAt: now,
    }));
    await chrome.storage.local.set({
      bookmark_timeline_data: bookmarks,
      tag_colors: { 'E2E Unified Tag': '#123456' },
      classificationWorkspace: {
        version: 1,
        comparisons: [{
          id: 'e2e-change-history',
          scope: { mode: 'full' },
          createdAt: now,
          beforeFingerprint: 'before-e2e',
          afterFingerprint: 'after-e2e',
          summary: { added: 0, removed: 1, moved: 2, renamed: 1, reordered: 0, urlChanged: 0 },
          changes: [
            {
              kind: 'moved', id: 'history-react', nodeKind: 'bookmark',
              before: { id: 'history-react', kind: 'bookmark', index: 0, title: 'Synthetic React' },
              after: { id: 'history-react', kind: 'bookmark', index: 0, title: 'Synthetic React' },
              beforePath: 'Bookmarks Bar / Inbox / Synthetic React',
              afterPath: 'Bookmarks Bar / AI Organize / Development / Synthetic React',
            },
            {
              kind: 'moved', id: 'history-design', nodeKind: 'bookmark',
              before: { id: 'history-design', kind: 'bookmark', index: 1, title: 'Synthetic Design' },
              after: { id: 'history-design', kind: 'bookmark', index: 0, title: 'Synthetic Design' },
              beforePath: 'Bookmarks Bar / Inbox / Synthetic Design',
              afterPath: 'Bookmarks Bar / AI Organize / Design / Synthetic Design',
            },
            {
              kind: 'removed', id: 'history-old', nodeKind: 'bookmark',
              before: { id: 'history-old', kind: 'bookmark', index: 2, title: 'Old bookmark' },
              beforePath: 'Bookmarks Bar / Inbox / Old bookmark',
            },
            {
              kind: 'renamed', id: 'history-folder', nodeKind: 'folder',
              before: { id: 'history-folder', kind: 'folder', index: 0, title: 'Old category' },
              after: { id: 'history-folder', kind: 'folder', index: 0, title: 'New category' },
              beforePath: 'Bookmarks Bar / AI Organize / Old category',
              afterPath: 'Bookmarks Bar / AI Organize / New category',
            },
          ],
        }],
      },
      bookmark_recommendation_store_v2: {
        version: 2,
        migratedAt: now,
        rules: [],
        stopWords: [],
        snapshots: reviewSnapshots,
        reviewQueue,
        feedback: [
          {
            id: 'feedback-e2e-rejected',
            operationId: 'feedback-e2e-rejected',
            recommendationId: 'recommendation-e2e-rejected',
            urlFingerprint: 'fingerprint-rejected',
            outcome: 'rejected',
            changedFields: [],
            selection: { folderPath: '', tags: [] },
            snapshot: { domain: 'rejected.example' },
            createdAt: now - 1000,
          },
          {
            id: 'feedback-e2e-cancelled',
            operationId: 'feedback-e2e-cancelled',
            recommendationId: 'recommendation-e2e-cancelled',
            urlFingerprint: 'fingerprint-cancelled',
            outcome: 'cancelled',
            changedFields: [],
            selection: { folderPath: '', tags: [] },
            snapshot: { domain: 'cancelled.example' },
            createdAt: now,
          },
        ],
        stats: { total: 2, accepted: 0, modified: 0, rejected: 1, cancelled: 1, lastFeedbackAt: now },
        history: [],
      },
    });
  }, { port });

  const pageErrors = [];
  const clickCountUrl = `http://127.0.0.1:${port}/click-count`;
  const readClickCountState = () => worker.evaluate(async (targetUrl) => {
    const normalize = value => String(value || '').replace(/\/+$/, '');
    const historyItems = await chrome.history.search({ text: targetUrl, startTime: 0, maxResults: 100 });
    const historyItem = historyItems.find(item => normalize(item.url) === normalize(targetUrl));
    const visits = historyItem?.url ? await chrome.history.getVisits({ url: historyItem.url }) : [];
    const stored = await chrome.storage.local.get('bookmark_timeline_data');
    const bookmark = (stored.bookmark_timeline_data || []).find(item => item.title === 'Synthetic Count');
    return {
      historyUrl: historyItem?.url || '',
      visitCount: Number(historyItem?.visitCount) || 0,
      visitRows: visits.length,
      storedCount: Number(bookmark?.clickCount) || 0,
      storedLastClickedAt: Number(bookmark?.lastClickedAt) || 0,
    };
  }, clickCountUrl);
  const waitForClickCountState = async (predicate, label, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    let state;
    while (Date.now() < deadline) {
      state = await readClickCountState();
      if (predicate(state)) return state;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`${label}: ${JSON.stringify(state)}`);
  };

  const countFixturePage = await context.newPage();
  countFixturePage.on('pageerror', (error) => pageErrors.push(`click-count fixture: ${error.message}`));
  await countFixturePage.goto(clickCountUrl, { waitUntil: 'domcontentloaded' });
  await countFixturePage.reload({ waitUntil: 'domcontentloaded' });
  await countFixturePage.reload({ waitUntil: 'domcontentloaded' });
  const initialClickState = await waitForClickCountState(
    state => state.visitCount > 0 && state.storedCount === state.visitCount && state.visitRows > state.visitCount,
    'reload visits did not produce stable HistoryItem.visitCount semantics',
  );
  await countFixturePage.close();

  await worker.evaluate(async () => {
    const stored = await chrome.storage.local.get('bookmark_timeline_data');
    const bookmarks = stored.bookmark_timeline_data || [];
    const index = bookmarks.findIndex(item => item.title === 'Synthetic Count');
    if (index < 0) throw new Error('click count fixture bookmark was not mirrored');
    bookmarks[index] = { ...bookmarks[index], clickCount: 443, lastClickedAt: Date.now() + 1000 };
    await chrome.storage.local.set({ bookmark_timeline_data: bookmarks });
    await chrome.storage.local.remove('click_count_source_version');
  });

  const countPopup = await openExtensionPage(context, extensionId, 'pages/popup/popup.html', pageErrors);
  const countCard = countPopup.locator('.bookmark-item', { hasText: 'Synthetic Count' });
  await countCard.waitFor({ state: 'visible', timeout: 15000 });
  assert.equal(
    Number(await countCard.locator('.bookmark-heat-info').innerText()),
    initialClickState.visitCount,
    'popup first display did not migrate the legacy inflated count',
  );
  await countCard.scrollIntoViewIfNeeded();
  await countPopup.waitForFunction(() => Array.from(document.querySelectorAll('.bookmark-item')).some(item => (
    item.textContent.includes('Synthetic Count') && Number(getComputedStyle(item).opacity) >= 0.99
  )));
  await countPopup.screenshot({ path: join(artifactsPath, 'click-count-popup.png'), fullPage: true });

  const openedCountPagePromise = context.waitForEvent('page');
  await countCard.click();
  const openedCountPage = await openedCountPagePromise;
  await openedCountPage.waitForLoadState('domcontentloaded');
  const clickedState = await waitForClickCountState(
    state => state.visitCount === initialClickState.visitCount + 1 && state.storedCount === state.visitCount,
    'popup navigation did not persist the absolute visitCount',
  );
  await openedCountPage.reload({ waitUntil: 'domcontentloaded' });
  await openedCountPage.reload({ waitUntil: 'domcontentloaded' });
  const reloadedState = await waitForClickCountState(
    state => state.storedCount === state.visitCount && state.visitRows > state.visitCount,
    'reload changed the stored count away from HistoryItem.visitCount',
  );
  await worker.evaluate(() => refreshStoredClickCounts());
  const refreshedState = await readClickCountState();
  assert.equal(refreshedState.storedCount, reloadedState.visitCount, 'manual reconciliation changed the count source');
  assert.equal(refreshedState.visitCount, clickedState.visitCount, 'reload unexpectedly changed visitCount');
  await openedCountPage.close();
  await countPopup.close();

  const refreshedPopup = await openExtensionPage(context, extensionId, 'pages/popup/popup.html', pageErrors);
  const refreshedCountCard = refreshedPopup.locator('.bookmark-item', { hasText: 'Synthetic Count' });
  await refreshedCountCard.waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(Number(await refreshedCountCard.locator('.bookmark-heat-info').innerText()), reloadedState.visitCount);
  await refreshedPopup.close();

  await worker.evaluate(async (targetUrl) => {
    const normalize = value => String(value || '').replace(/\/+$/, '');
    const historyItems = await chrome.history.search({ text: targetUrl, startTime: 0, maxResults: 100 });
    const historyItem = historyItems.find(item => normalize(item.url) === normalize(targetUrl));
    if (historyItem?.url) await chrome.history.deleteUrl({ url: historyItem.url });
  }, clickCountUrl);
  await waitForClickCountState(
    state => state.visitCount === 0 && state.visitRows === 0 && state.storedCount === 0 && state.storedLastClickedAt === 0,
    'history removal did not clear the stored click count',
  );

  const settings = await openExtensionPage(context, extensionId, 'pages/settings/settings.html', pageErrors);
  await settings.locator('[data-panel="ai"]').click();
  await settings.locator('#panel-ai').waitFor({ state: 'visible' });
  assert.equal(await settings.locator('#aiPageContentToggle').isChecked(), true);
  assert.match(await settings.locator('[data-i18n="aiPrivacyNotice"]').innerText(), /AI|服务商|provider/i);

  const aiRequestsBeforeConnectionTest = requests.ai;
  await settings.locator('#aiTestBtn').click();
  await settings.locator('.toast').filter({ hasText: /连接成功|Connection successful/i }).waitFor({ timeout: 10000 });
  assert.equal(requests.ai, aiRequestsBeforeConnectionTest + 1, 'AI connection test did not reach the local mock service exactly once');

  await settings.locator('#aiPageContentToggle').evaluate((element) => element.click());
  await waitForStorage(settings, async () => {
    const state = await chrome.storage.local.get(['ai_classifier_config', 'ai_tag_cache', 'page_content_cache', 'bookmark_timeline_data']);
    return state.ai_classifier_config?.allowPageContentForAi === false
      && state.ai_tag_cache === undefined
      && state.page_content_cache?.['https://example.test/react']?.textContent === 'private cached body';
  });
  await settings.locator('#aiPageContentToggle').evaluate((element) => element.click());
  await waitForStorage(settings, async () => (await chrome.storage.local.get('ai_classifier_config')).ai_classifier_config?.allowPageContentForAi === true);

  await settings.locator('[data-panel="rss"]').click();
  await settings.locator('#panel-rss').waitFor({ state: 'visible' });
  assert.equal(await settings.getByRole('checkbox', { name: /代理回退|Proxy fallback/i }).count(), 1);
  settings.once('dialog', async (dialog) => {
    assert.match(dialog.message(), /订阅 URL|subscription URL/i);
    await dialog.dismiss();
  });
  await settings.locator('#rssProxyFallbackToggle').evaluate((element) => element.click());
  assert.equal(await settings.locator('#rssProxyFallbackToggle').isChecked(), false);

  await settings.locator('#rssRefreshAllBtn').click();
  await settings.locator('.toast').filter({ hasText: /成功 1|Succeeded 1/i }).waitFor({ timeout: 10000 });
  assert.equal(requests.rss, 1, 'RSS refresh did not reach the local mock service');
  const rssItems = await worker.evaluate(async () => (await chrome.storage.local.get('rss_items_e2e-feed'))['rss_items_e2e-feed'] || []);
  assert.equal(rssItems.length, 1);

  await settings.locator('[data-panel="ai"]').click();
  await settings.waitForFunction(() => !document.querySelector('.toast'), undefined, { timeout: 8000 });
  await settings.screenshot({ path: join(artifactsPath, 'settings-desktop.png'), fullPage: true });
  await assertNoHorizontalOverflow(settings, 'settings desktop');
  await settings.keyboard.press('Home');
  await settings.keyboard.press('Tab');
  assert.equal(await settings.evaluate(() => document.activeElement?.matches('button, input, select, textarea, a[href]')), true, 'keyboard focus did not reach an interactive control');

    const seededBatchReviewIds = await worker.evaluate(async () => {
      const now = Date.now();
      const stored = await chrome.storage.local.get('bookmark_timeline_data');
      const bookmarks = stored.bookmark_timeline_data || [];
      const batchBookmarks = ['Synthetic Batch One', 'Synthetic Batch Two'].map((title) => {
        const bookmark = bookmarks.find(item => item.title === title);
        if (!bookmark) throw new Error(`batch review bookmark was not mirrored: ${title}`);
        return bookmark;
      });
      const targetNode = (await chrome.bookmarks.search({ title: 'E2E Batch Target' })).find(node => !node.url);
      const target = (await loadBookmarkFolderOptions()).find(item => item.id === targetNode?.id);
      if (!target) throw new Error('batch review target folder was not indexed');
      const snapshots = batchBookmarks.map((bookmark, index) => ({
        recommendationId: `recommendation-e2e-batch-${index + 1}`,
        ruleVersion: 'bookmark-recommendation-v3',
        urlFingerprint: recommendationUrlFingerprint(bookmark.url),
        domain: 'batch.example',
        pathSegments: [index === 0 ? 'one' : 'two'],
        tags: [{ tag: 'E2E Batch Tag', support: 0.95, confidence: 'high' }],
        folders: [{ id: target.id, folderPath: target.path, existing: true, support: 0.95, confidence: 'high' }],
        selectedTags: ['E2E Batch Tag'],
        selectedFolderPath: target.path,
        createdAt: now,
      }));
      await mutateStorageResource(RECOMMENDATION_STORE_KEY, (current) => {
        const store = normalizeRecommendationStore(current, now);
        store.snapshots = [
          ...store.snapshots.filter(item => !item.recommendationId?.startsWith('recommendation-e2e-batch-')),
          ...snapshots,
        ];
        store.reviewQueue = [
          ...store.reviewQueue.filter(item => !item.id?.startsWith('review-e2e-batch-')),
          ...batchBookmarks.map((bookmark, index) => ({
            id: `review-e2e-batch-${index + 1}`,
            type: 'bookmark_recommendation',
            bookmarkId: bookmark.id,
            recommendationId: snapshots[index].recommendationId,
            title: bookmark.title,
            urlFingerprint: snapshots[index].urlFingerprint,
            fromFolderPath: bookmark.folderPath,
            toFolderId: target.id,
            toFolderPath: target.path,
            sourceParentId: bookmark.parentId,
            sourceTags: [],
            confidence: 'high',
            createdAt: now,
            updatedAt: now,
          })),
        ];
        return store;
      });
      return (await getRecommendationLearningState()).reviewQueue
        .filter(item => item.id.startsWith('review-e2e-batch-'))
        .map(item => item.id)
        .sort();
    });
    assert.deepEqual(seededBatchReviewIds, ['review-e2e-batch-1', 'review-e2e-batch-2']);
    await settings.evaluate(() => loadActiveLearning());
    await settings.locator('[data-panel="activelearning"]').click();
    await settings.locator('#panel-activelearning').waitFor({ state: 'visible' });
    await settings.waitForFunction(() => document.querySelectorAll('#pendingReviewsList .review-item[data-id^="review-e2e-batch-"] .pending-review-checkbox:not(:disabled)').length === 2);
    assert.equal(await settings.locator('#recommendationRuleTabs [role="tab"]').count(), 4);
    const pendingReviewCheckboxes = settings.locator('#pendingReviewsList .pending-review-checkbox:not(:disabled)');
    const batchReviewCheckboxes = settings.locator('#pendingReviewsList .review-item[data-id^="review-e2e-batch-"] .pending-review-checkbox:not(:disabled)');
    assert.equal(await batchReviewCheckboxes.count(), 2, 'batch review fixtures were not rendered as selectable');
    assert.equal(await settings.locator('#confirmSelectedReviewsBtn').isDisabled(), true);
    await batchReviewCheckboxes.first().check();
    assert.match(await settings.locator('#pendingReviewSelectionCount').innerText(), /1/);
    assert.equal(await settings.locator('#selectAllPendingReviews').evaluate(element => element.indeterminate), true);
    await settings.locator('#selectAllPendingReviews').check();
    assert.equal(await pendingReviewCheckboxes.evaluateAll(elements => elements.every(element => element.checked)), true);
    await batchReviewCheckboxes.last().uncheck();
    assert.equal(await settings.locator('#selectAllPendingReviews').evaluate(element => element.indeterminate), true);
    await settings.locator('#selectAllPendingReviews').check();
    const unrelatedReviewCheckboxes = settings.locator('#pendingReviewsList .review-item:not([data-id^="review-e2e-batch-"]) .pending-review-checkbox:not(:disabled)');
    for (let index = 0; index < await unrelatedReviewCheckboxes.count(); index++) {
      await unrelatedReviewCheckboxes.nth(index).uncheck();
    }
    assert.match(await settings.locator('#confirmSelectedReviewsBtn').innerText(), /2/);
    await settings.screenshot({ path: join(artifactsPath, 'learning-batch-selection.png'), fullPage: true });
    settings.once('dialog', dialog => dialog.accept());
    await settings.locator('#confirmSelectedReviewsBtn').click();
    await settings.locator('.toast').filter({ hasText: /已批量确认 2 条书签|2 bookmarks confirmed/i }).waitFor({ timeout: 10000 });
    await settings.locator('#pendingReviewsList .review-item[data-id^="review-e2e-batch-"]').waitFor({ state: 'detached', timeout: 10000 });
    assert.equal(await settings.locator('#pendingReviewsControls [data-role="search"]').isDisabled(), false, 'pending review search stayed disabled after batch confirmation');
    assert.equal(await settings.locator('#pendingReviewsControls [data-role="page-size"]').isDisabled(), false, 'pending review page size stayed disabled after batch confirmation');
    assert.equal(await settings.locator('#pendingReviewsControls [data-role="previous"]').isDisabled(), true, 'pending review previous page must stay disabled on the first page');
    assert.equal(await settings.locator('#pendingReviewsControls [data-role="next"]').isDisabled(), true, 'pending review next page must stay disabled on the final page');
    const batchResult = await worker.evaluate(async () => {
      const tree = await chrome.bookmarks.getTree();
      const allNodes = [];
      const walk = (nodes) => {
        for (const node of nodes || []) {
          allNodes.push(node);
          walk(node.children);
        }
      };
      walk(tree);
      const target = allNodes.find(node => !node.url && node.title === 'E2E Batch Target');
      const moved = allNodes.filter(node => ['Synthetic Batch One', 'Synthetic Batch Two'].includes(node.title));
      const stored = (await chrome.storage.local.get(['bookmark_timeline_data', 'bookmark_recommendation_store_v2']));
      const mirrored = (stored.bookmark_timeline_data || []).filter(item => ['Synthetic Batch One', 'Synthetic Batch Two'].includes(item.title));
      return {
        targetId: target?.id || '',
        movedParentIds: moved.map(item => item.parentId),
        mirrored: mirrored.map(item => ({ parentId: item.parentId, tags: item.tags || [] })),
        remainingFixtureReviewIds: (stored.bookmark_recommendation_store_v2?.reviewQueue || [])
          .filter(item => item.id.startsWith('review-e2e-batch-'))
          .map(item => item.id),
        accepted: stored.bookmark_recommendation_store_v2?.stats?.accepted,
      };
    });
    assert.ok(batchResult.targetId);
    assert.deepEqual(batchResult.movedParentIds, [batchResult.targetId, batchResult.targetId]);
    assert.equal(batchResult.mirrored.length, 2);
    assert.equal(batchResult.mirrored.every(item => item.parentId === batchResult.targetId && item.tags.includes('E2E Batch Tag')), true);
    assert.deepEqual(batchResult.remainingFixtureReviewIds, []);
    assert.equal(batchResult.accepted, 2);
    await settings.locator('#viewLearningRecordsBtn').click();
    assert.equal(await settings.locator('#learningFeedbackList .learning-feedback-item').count(), 4);
  const learningFeedbackText = await settings.locator('#learningFeedbackList').innerText();
  assert.match(learningFeedbackText, /rejected\.example[\s\S]*(拒绝|Rejected)/i);
  assert.match(learningFeedbackText, /cancelled\.example[\s\S]*(取消|Cancelled)/i);
    assert.doesNotMatch(learningFeedbackText, /https?:\/\//i, 'learning feedback details must not expose original URLs');
    await settings.evaluate(() => {
      const now = Date.now();
      recommendationRuleState = 'candidate';
      recommendationLearningState = {
        ...(recommendationLearningState || {}),
        recentFeedback: Array.from({ length: 105 }, (_, index) => ({
          id: `pagination-feedback-${index + 1}`,
          recommendationId: `pagination-recommendation-${index + 1}`,
          domain: `feedback-${String(index + 1).padStart(2, '0')}.example`,
          outcome: index % 2 === 0 ? 'accepted' : 'modified',
          changedFields: index % 2 === 0 ? ['folder'] : ['tags'],
          selection: { folderPath: `Pagination/Folder ${index + 1}`, tags: [`Pagination Tag ${index + 1}`] },
          createdAt: now - index * 1000,
        })),
        rules: Array.from({ length: 105 }, (_, index) => ({
          id: `pagination-rule-${index + 1}`,
          pattern: `pagination-rule-${String(index + 1).padStart(2, '0')}.example`,
          kind: 'domain_tag',
          target: `Pagination Tag ${index + 1}`,
          source: 'learned',
          state: 'candidate',
          positiveFingerprints: [],
          negativeFingerprints: [],
        })),
      };
      renderLearningFeedback(recommendationLearningState.recentFeedback);
      renderRecommendationRules();
      globalThis.__e2ePendingPaginationRecords = Array.from({ length: 105 }, (_, index) => ({
        id: `pagination-review-${index + 1}`,
        title: `Pagination Review ${String(index + 1).padStart(2, '0')}`,
        url: `https://pagination-review-${index + 1}.example`,
        confidence: 0.7,
        score: 70,
        reason: 'low_confidence',
        suggestedTags: [`Pagination Tag ${index + 1}`],
      }));
      renderPendingReviews(globalThis.__e2ePendingPaginationRecords);
      reevaluationItems = new Map(Array.from({ length: 105 }, (_, index) => {
        const id = `pagination-result-${index + 1}`;
        return [id, {
          id,
          title: `Pagination Result ${String(index + 1).padStart(2, '0')}`,
          reason: 'medium_confidence',
          recommendation: {
            folders: [{ folderPath: `Pagination/Folder ${index + 1}`, confidence: 'medium', exists: false }],
            tags: [{ tag: `Pagination Tag ${index + 1}`, confidence: 'medium' }],
          },
        }];
      }));
      reevaluationSelected = new Set();
      renderReevaluationResults(reevaluationItems, '评估完成，共 105 条结果');
    });

    const listScenarios = [
      ['learningFeedbackControls', '#learningFeedbackList .learning-feedback-item', 'feedback-105.example'],
      ['recommendationRulesControls', '#recommendationRulesList .recommendation-rule-item', 'pagination-rule-105.example'],
      ['pendingReviewsControls', '#pendingReviewsList .review-item', 'Pagination Review 105'],
      ['reevaluationControls', '#reevaluationResults .reevaluation-item', 'Pagination Result 105'],
    ];
    for (const [controlsId, itemSelector, searchTerm] of listScenarios) {
      const controls = settings.locator(`#${controlsId}`);
      const previousPage = controls.locator('[data-role="previous"]');
      const nextPage = controls.locator('[data-role="next"]');
      assert.equal(await controls.isVisible(), true, `${controlsId} must be visible for populated records`);
      assert.equal(await settings.locator(itemSelector).count(), 10, `${controlsId} must default to 10 records per page`);
      assert.equal(await previousPage.isDisabled(), true, `${controlsId} previous page must be disabled initially`);
      assert.equal(await nextPage.isDisabled(), false, `${controlsId} next page must be enabled initially`);
      for (const pageSize of [20, 50, 100]) {
        await controls.locator('[data-role="page-size"]').selectOption(String(pageSize));
        assert.equal(await settings.locator(itemSelector).count(), pageSize, `${controlsId} must support ${pageSize} records per page`);
        assert.equal(await previousPage.isDisabled(), true, `${controlsId} page-size changes must reset to the first page`);
      }
      await nextPage.click();
      assert.equal(await settings.locator(itemSelector).count(), 5, `${controlsId} must render the final partial page`);
      assert.equal(await previousPage.isDisabled(), false, `${controlsId} previous page must be enabled on the final page`);
      assert.equal(await nextPage.isDisabled(), true, `${controlsId} next page must be disabled on the final page`);
      await controls.locator('[data-role="search"]').fill(searchTerm);
      assert.equal(await settings.locator(itemSelector).count(), 1, `${controlsId} search must filter the complete record set`);
      assert.match(await settings.locator(itemSelector).first().innerText(), new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
      assert.equal(await previousPage.isDisabled(), true, `${controlsId} search must reset to the first page`);
      assert.equal(await nextPage.isDisabled(), true, `${controlsId} single-result search must have no next page`);
      await controls.locator('[data-role="search"]').fill('record-that-does-not-exist');
      assert.equal(await settings.locator(itemSelector).count(), 0, `${controlsId} must render an empty search result`);
      assert.match(await controls.locator('xpath=following-sibling::*[1]').innerText(), /没有匹配的记录|No matching records/i);
      await controls.locator('[data-role="search"]').fill('');
      await controls.locator('[data-role="page-size"]').selectOption('10');
    }

    const pendingControls = settings.locator('#pendingReviewsControls');
    const pendingPaginationState = await settings.evaluate(() => {
      const dispatchInput = (input, value) => {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      renderPendingReviews(globalThis.__e2ePendingPaginationRecords);
      const pageSize = pendingReviewsControls.querySelector('[data-role="page-size"]');
      pageSize.value = '10';
      pageSize.dispatchEvent(new Event('change', { bubbles: true }));

      let item = pendingReviewsList.querySelector('.review-item');
      item.querySelector('.pending-review-checkbox').click();
      dispatchInput(item.querySelector('.review-tag-input'), 'Pagination Draft Preserved');
      pendingReviewsControls.querySelector('[data-role="next"]').click();

      item = pendingReviewsList.querySelector('.review-item');
      item.querySelector('.pending-review-checkbox').click();
      dispatchInput(item.querySelector('.review-tag-input'), 'Pagination Page Two Draft');
      pendingReviewsControls.querySelector('[data-role="previous"]').click();

      item = pendingReviewsList.querySelector('.review-item');
      const firstPage = {
        checked: item.querySelector('.pending-review-checkbox').checked,
        draft: item.querySelector('.review-tag-input').value,
      };
      pendingReviewsControls.querySelector('[data-role="next"]').click();
      item = pendingReviewsList.querySelector('.review-item');
      const secondPage = {
        checked: item.querySelector('.pending-review-checkbox').checked,
        draft: item.querySelector('.review-tag-input').value,
      };
      pendingReviewsControls.querySelector('[data-role="previous"]').click();
      return { firstPage, secondPage, selectedCount: pendingReviewSelected.size };
    });
    assert.deepEqual(pendingPaginationState, {
      firstPage: { checked: true, draft: 'Pagination Draft Preserved' },
      secondPage: { checked: true, draft: 'Pagination Page Two Draft' },
      selectedCount: 2,
    });
    assert.equal(await pendingControls.locator('[data-role="previous"]').isDisabled(), true);
    await settings.screenshot({ path: join(artifactsPath, 'learning-pagination-desktop.png'), fullPage: true });
    await assertNoHorizontalOverflow(settings, 'learning pagination desktop');

    const reevaluationApplication = await settings.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({ action: 'getBookmarks' });
      const bookmark = (response?.bookmarks || []).find(item => item.title === 'Synthetic React');
      if (!bookmark) throw new Error('reevaluation application fixture was not found');
      const item = {
        ...bookmark,
        recommendation: {
          recommendationId: 'recommendation-e2e-reevaluation-apply',
          folders: [],
          tags: [{ tag: 'E2E Reevaluation Applied', confidence: 'high' }],
        },
      };
      reevaluationItems = new Map([[item.id, item]]);
      reevaluationSelected = new Set([item.id]);
      Object.assign(activeLearningListStates.reevaluation, createActiveLearningListState());
      renderReevaluationResults(reevaluationItems, 'Ready to apply');
      await applySelectedReevaluations([item.id], false);
      return { applying: reevaluationApplying, remaining: reevaluationItems.size };
    });
    assert.deepEqual(reevaluationApplication, { applying: false, remaining: 0 });
    assert.equal(await settings.locator('#reevaluationControls [data-role="search"]').isDisabled(), false, 'reevaluation search stayed disabled after applying results');
    assert.equal(await settings.locator('#reevaluationControls [data-role="page-size"]').isDisabled(), false, 'reevaluation page size stayed disabled after applying results');
    assert.equal(await settings.locator('#reevaluationControls [data-role="previous"]').isDisabled(), true, 'reevaluation previous page must stay disabled without remaining results');
    assert.equal(await settings.locator('#reevaluationControls [data-role="next"]').isDisabled(), true, 'reevaluation next page must stay disabled without remaining results');
    const appliedReevaluation = await worker.evaluate(async () => {
      const stored = await chrome.storage.local.get('bookmark_timeline_data');
      return (stored.bookmark_timeline_data || []).find(item => item.title === 'Synthetic React')?.tags || [];
    });
    assert.equal(appliedReevaluation.includes('E2E Reevaluation Applied'), true, 'reevaluation result did not update the bookmark tag');

    await settings.evaluate(async () => {
      for (const state of Object.values(activeLearningListStates)) Object.assign(state, createActiveLearningListState());
      pendingReviewSelected = new Set();
      pendingReviewTagDrafts = new Map();
      reevaluationItems = new Map();
      reevaluationSelected = new Set();
      await loadActiveLearning();
    });
    await settings.locator('[data-panel="about"]').click();
    await settings.locator('#panel-about').waitFor({ state: 'visible' });
    assert.equal(await settings.locator('#aboutVersion').innerText(), await worker.evaluate(() => chrome.runtime.getManifest().version));
    await settings.locator('[data-panel="activelearning"]').click();
    await settings.locator('#panel-activelearning').waitFor({ state: 'visible' });
    await settings.locator('#reevaluateBookmarksBtn').click();
  await settings.locator('#reevaluationResults').filter({ hasText: /评估完成|Evaluation complete/i }).waitFor({ timeout: 15000 });
  await settings.locator('.review-item--recommendation').first().waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await settings.locator('#reevaluationResults .reevaluation-select input').count(), 0, 'medium-confidence reevaluation items must not be preselected');
  const recommendationCandidates = await settings.locator('.review-item--recommendation [aria-label="标签候选"]').allInnerTexts();
  assert.doesNotMatch(recommendationCandidates.join('\n'), /E2E Synthetic/, 'folder names must not leak into tag candidates');
  await settings.screenshot({ path: join(artifactsPath, 'learning-desktop.png'), fullPage: true });
  await assertNoHorizontalOverflow(settings, 'learning desktop');

  await settings.setViewportSize({ width: 390, height: 844 });
  await settings.screenshot({ path: join(artifactsPath, 'learning-narrow.png'), fullPage: true });
  await assertNoHorizontalOverflow(settings, 'learning narrow');
  await settings.locator('[data-panel="ai"]').click();
  await settings.locator('#panel-ai').waitFor({ state: 'visible' });
  await settings.screenshot({ path: join(artifactsPath, 'settings-narrow.png') });
  await assertNoHorizontalOverflow(settings, 'settings narrow');
  const compressedRows = await settings.locator('#panel-ai .setting-row:visible .setting-main').evaluateAll((elements) => elements
    .filter((element) => element.textContent.trim().length > 6 && element.getBoundingClientRect().width < 120)
    .map((element) => ({ text: element.textContent.trim().slice(0, 60), width: element.getBoundingClientRect().width })));
  assert.deepEqual(compressedRows, [], `narrow settings text is compressed: ${JSON.stringify(compressedRows)}`);
  assert.equal(await settings.getByRole('checkbox', { name: /发送页面内容|Share page content/i }).count(), 1);

  const pages = [
    ['workspace', 'pages/standalone/standalone.html', /Synthetic|书签|Bookmark/i],
    ['bookmark navigation', 'ai/bookmark-nav.html', /Synthetic React/i],
    ['AI classification', 'ai/sidepanel.html', /AI|分类/i],
    ['health checker', 'pages/checker/checker.html', /检查|Check|书签|Bookmark/i],
    ['graph', 'pages/graph/graph.html', /图谱|Graph/i],
  ];
  let workspaceCardVisualContract;
  for (const [label, path, textPattern] of pages) {
    if (label === 'bookmark navigation') {
      await worker.evaluate(async () => {
        const state = await chrome.storage.local.get('bookmark_timeline_data');
        const bookmarks = state.bookmark_timeline_data || [];
        const bookmark = bookmarks.find((item) => item.title === 'Synthetic React');
        if (!bookmark) throw new Error('unified tag fixture was not found');
        bookmark.tags = ['E2E Unified Tag'];
        bookmark.tagsAuto = ['E2E Unified Tag'];
        await chrome.storage.local.set({
          bookmark_timeline_data: bookmarks,
          tag_colors: { 'E2E Unified Tag': '#123456' },
        });
      });
    }
    if (label === 'health checker') {
      await worker.evaluate(async () => {
        const state = await chrome.storage.local.get('bookmark_timeline_data');
        const healthyBookmark = (state.bookmark_timeline_data || [])
          .find((bookmark) => bookmark.title === 'Synthetic Healthy Link');
        if (!healthyBookmark) throw new Error('healthy checker fixture was not found');
        await chrome.storage.local.set({
          bookmark_timeline_data: [healthyBookmark],
          checkerTimeout: 4000,
          checkerConcurrency: 1,
          checkerRetries: 0,
          checkerBackoffBase: 0,
          checkerBackoffMax: 0,
        });
      });
    }
    if (label === 'workspace') {
      await worker.evaluate(() => {
        const originalRefreshStoredClickCounts = refreshStoredClickCounts;
        globalThis.__e2eWorkspaceCountRefresh = { startedAt: 0, finishedAt: 0 };
        refreshStoredClickCounts = async (...args) => {
          globalThis.__e2eWorkspaceCountRefresh.startedAt = Date.now();
          await new Promise(resolve => setTimeout(resolve, 5000));
          try {
            return await originalRefreshStoredClickCounts(...args);
          } finally {
            globalThis.__e2eWorkspaceCountRefresh.finishedAt = Date.now();
            refreshStoredClickCounts = originalRefreshStoredClickCounts;
          }
        };
      });
    }
    let page;
    if (label === 'graph') {
      const popup = await openExtensionPage(context, extensionId, 'pages/popup/popup.html', pageErrors);
      await popup.locator('#footerMenuBtn').click();
      const graphPagePromise = context.waitForEvent('page');
      await popup.locator('#menuGraphBtn').click();
      page = await graphPagePromise;
      page.on('pageerror', (error) => pageErrors.push(`${path}: ${error.message}`));
      await page.waitForFunction(() => document.body && document.body.innerText.trim().length > 0);
    } else {
      page = await openExtensionPage(context, extensionId, path, pageErrors);
    }
    await page.locator('body').filter({ hasText: textPattern }).waitFor({ timeout: 10000 });
    await assertNoHorizontalOverflow(page, label);
    if (label === 'workspace') {
      await page.locator('.sa-bookmark-item').first().waitFor({ timeout: 3000 });
      let countRefreshProbe;
      const probeDeadline = Date.now() + 1000;
      do {
        countRefreshProbe = await worker.evaluate(() => globalThis.__e2eWorkspaceCountRefresh);
        if (countRefreshProbe?.startedAt) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (Date.now() < probeDeadline);
      assert.ok(countRefreshProbe?.startedAt > 0, 'workspace did not start asynchronous count reconciliation');
      assert.equal(countRefreshProbe.finishedAt, 0, 'workspace waited for count reconciliation before rendering bookmarks');
      assert.equal(await page.locator('#saEmpty').isVisible(), false, 'workspace displayed an empty state while cached bookmarks existed');
      assert.ok(Number(await page.locator('#saBookmarkCount').innerText()) > 0, 'workspace cached bookmark count was not rendered');
      await page.locator('.sa-view-btn[data-view="grid"]').click();
      await page.locator('.sa-grid-card').first().waitFor({ timeout: 10000 });
      await page.locator('.sa-grid-card .sa-bookmark-tag').first().waitFor({ timeout: 10000 });
      workspaceCardVisualContract = await readBookmarkCardVisualContract(page, {
        grid: '.sa-view--grid',
        card: '.sa-grid-card',
        favicon: '.sa-grid-card-favicon',
        title: '.sa-grid-card-title',
        domain: '.sa-grid-card-domain',
        tag: '.sa-grid-card .sa-bookmark-tag',
      });
      await page.screenshot({ path: join(artifactsPath, 'workspace-grid-desktop.png'), fullPage: true });
      await page.waitForFunction(() => document.querySelectorAll('.sa-grid-card').length > 0);
      const refreshDeadline = Date.now() + 10000;
      while (Date.now() < refreshDeadline) {
        countRefreshProbe = await worker.evaluate(() => globalThis.__e2eWorkspaceCountRefresh);
        if (countRefreshProbe?.finishedAt) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(countRefreshProbe?.finishedAt > countRefreshProbe?.startedAt, 'workspace count reconciliation did not finish');
    }
    if (label === 'graph') {
      await page.locator('#graphLoading').waitFor({ state: 'hidden', timeout: 10000 });
      const graphCanvas = page.locator('#cy canvas').first();
      await graphCanvas.waitFor({ state: 'visible', timeout: 10000 });
      await page.waitForTimeout(1000);
      const zoomBefore = Number.parseFloat(await page.locator('#zoomLevel').innerText());
      const graphBox = await graphCanvas.boundingBox();
      assert.ok(graphBox, 'graph canvas has no interactive bounds');
      await page.mouse.move(graphBox.x + graphBox.width / 2, graphBox.y + graphBox.height / 2);
      for (let index = 0; index < 20; index += 1) {
        await page.mouse.wheel(0, -100);
      }
      await page.waitForFunction(
        (previousZoom) => Number.parseFloat(document.querySelector('#zoomLevel')?.textContent || '') > previousZoom,
        zoomBefore,
      );
      const zoomAfter = Number.parseFloat(await page.locator('#zoomLevel').innerText());
      const wheelZoomRatio = zoomAfter / zoomBefore;
      assert.ok(
        wheelZoomRatio >= 1.25 && wheelZoomRatio <= 1.8,
        `graph wheel zoom must be responsive without jumping: ${zoomBefore}% -> ${zoomAfter}%`,
      );
    }
    if (label === 'health checker') {
      const checkerRequestsBefore = requests.checker;
      await page.locator('#startCheckBtn').click();
      await page.waitForFunction(() => {
        const match = /^(\d+)\/(\d+)/.exec(document.querySelector('#progressText')?.textContent || '');
        return match && Number(match[2]) > 0 && Number(match[1]) === Number(match[2]);
      }, undefined, { timeout: 30000 });
      assert.ok(requests.checker > checkerRequestsBefore, 'link checker did not request the bookmarked URL');
      assert.ok(await page.locator('.result-item--ok').count() >= 1, 'reachable bookmark was not classified as reachable');
      const resultDetails = await page.locator('.result-status-text').allInnerTexts();
      assert.doesNotMatch(resultDetails.join('\n'), /检测响应无效|Invalid check response/i);
    }
    if (label === 'bookmark navigation') {
      const unifiedTag = page.locator('.bookmark-card__tag', { hasText: 'E2E Unified Tag' });
      await unifiedTag.waitFor({ timeout: 10000 });
      assert.equal(await unifiedTag.evaluate((element) => getComputedStyle(element).color), 'rgb(18, 52, 86)');
      await page.getByText('Original metadata summary', { exact: true }).waitFor({ timeout: 10000 });
      await worker.evaluate(async ({ port: fixturePort }) => {
        const matches = await chrome.bookmarks.search({ title: 'Synthetic Healthy Link' });
        const bookmark = matches.find((item) => item.url);
        if (!bookmark) throw new Error('metadata refresh fixture was not found');
        await chrome.bookmarks.update(bookmark.id, { url: `http://127.0.0.1:${fixturePort}/health-check-updated` });
      }, { port });
      await page.getByText('Updated metadata summary', { exact: true }).waitFor({ timeout: 10000 });
      assert.equal(await page.getByText('Original metadata summary', { exact: true }).count(), 0, 'bookmark navigation kept metadata from the previous URL');
      await worker.evaluate(async () => {
        const state = await chrome.storage.local.get('bookmark_timeline_data');
        const bookmarks = state.bookmark_timeline_data || [];
        const bookmark = bookmarks.find((item) => item.tags?.includes('E2E Unified Tag'));
        if (!bookmark) throw new Error('unified tag fixture was not found');
        bookmark.tags = ['E2E Synced Tag'];
        bookmark.tagsAuto = ['E2E Synced Tag'];
        await chrome.storage.local.set({
          bookmark_timeline_data: bookmarks,
          tag_colors: { 'E2E Synced Tag': '#654321' },
        });
      });
      const syncedTag = page.locator('.bookmark-card__tag', { hasText: 'E2E Synced Tag' });
      await syncedTag.waitFor({ timeout: 10000 });
      assert.equal(await syncedTag.evaluate((element) => getComputedStyle(element).color), 'rgb(101, 67, 33)');
      assert.equal(await page.getByText('E2E Unified Tag', { exact: true }).count(), 0, 'bookmark navigation did not refresh its shared tags');
      const navigationCardVisualContract = await readBookmarkCardVisualContract(page, {
        grid: '.bookmark-grid',
        card: '.bookmark-card',
        favicon: '.bookmark-card__favicon',
        title: '.bookmark-card__title',
        domain: '.bookmark-card__domain',
        tag: '.bookmark-card__tag',
      });
      assert.deepEqual(
        navigationCardVisualContract,
        workspaceCardVisualContract,
        `bookmark navigation card styles diverged from workspace: ${JSON.stringify({ workspaceCardVisualContract, navigationCardVisualContract })}`,
      );
      await page.screenshot({ path: join(artifactsPath, 'bookmark-navigation-desktop.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(artifactsPath, 'bookmark-navigation-narrow.png'), fullPage: true });
      await assertNoHorizontalOverflow(page, 'bookmark navigation narrow');
    }
    if (label === 'AI classification') {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.locator('.workspace-tabs [role="tab"]').nth(2).click();
      await page.locator('.comparison-record > summary').click();
      const historyTree = page.locator('.change-history-tree');
      await historyTree.waitFor({ state: 'visible', timeout: 10000 });
      assert.equal(await historyTree.locator('.change-history-tree__branch').count() > 0, true, 'change history did not render a folder tree');
      await historyTree.getByText('Development', { exact: true }).click();
      assert.match(await historyTree.innerText(), /Synthetic React[\s\S]*来自 Bookmarks Bar \/ Inbox/, 'change history lost the compact move origin');
      await page.screenshot({ path: join(artifactsPath, 'classification-history-desktop.png'), fullPage: true });
      await assertNoHorizontalOverflow(page, 'classification history desktop');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: join(artifactsPath, 'classification-history-narrow.png'), fullPage: true });
      await assertNoHorizontalOverflow(page, 'classification history narrow');
    }
    await page.close();
  }

  const mdiSource = await settings.evaluate(async () => (await fetch('../standalone/mdi-manager.js')).text());
  assert.match(mdiSource, /sandbox/);
  assert.match(mdiSource, /iframeLoadTimeout/);
  assert.match(mdiSource, /mdi-window-fallback--visible/);
  assert.match(mdiSource, /chrome\.tabs\.create/);

  assert.deepEqual(pageErrors, [], `extension pages emitted errors:\n${pageErrors.join('\n')}`);
  console.log(`Extension E2E passed; screenshots: ${artifactsPath}`);
} finally {
  if (context) await context.close();
  await closeServer(mockServer);
  rmSync(profilePath, { recursive: true, force: true });
  rmSync(extensionTempPath, { recursive: true, force: true });
}
