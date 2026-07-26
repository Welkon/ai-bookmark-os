import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const backgroundSource = readFileSync('src/timeline/background/background.js', 'utf8');
const popupSource = readFileSync('src/timeline/pages/popup/popup.js', 'utf8');
const standaloneSource = readFileSync('src/timeline/pages/standalone/standalone.js', 'utf8');
const start = backgroundSource.indexOf('const CLICK_COUNT_SOURCE_VERSION_KEY =');
const end = backgroundSource.indexOf('// ===== RSS 文章', start);
assert.ok(start >= 0 && end > start, 'click count helpers and source version should be present');

const normalizeUrl = value => String(value || '').replace(/\/+$/, '');
let storedBookmarks = [];
let storedClickCountSourceVersion = 0;
let historyItemsByUrl = new Map();
let historySearchCalls = 0;
let historyVisitCalls = 0;
let historySearchGate = null;
let mutationQueue = Promise.resolve();
let onVisitedListener = null;
let onVisitRemovedListener = null;

function setHistoryGate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  historySearchGate = { promise, release };
}

async function flushBookmarkMutations() {
  while (mutationQueue) {
    const current = mutationQueue;
    await current;
    if (current === mutationQueue) return;
  }
}

const context = {
  Array,
  Map,
  Math,
  Number,
  Object,
  Promise,
  Set,
  String,
  STORAGE_KEY: 'bookmark_timeline_data',
  syncAllInFlight: null,
  chrome: {
    history: {
      async search({ text }) {
        historySearchCalls += 1;
        const result = historyItemsByUrl.get(normalizeUrl(text)) || [];
        if (historySearchGate) await historySearchGate.promise;
        return result.map(item => ({ ...item }));
      },
      async getVisits() {
        historyVisitCalls += 1;
        return Array.from({ length: 443 }, (_, index) => ({ visitTime: index + 1 }));
      },
      onVisited: {
        addListener(listener) { onVisitedListener = listener; },
      },
      onVisitRemoved: {
        addListener(listener) { onVisitRemovedListener = listener; },
      },
    },
    storage: {
      local: {
        async get(key) {
          if (key === 'click_count_source_version') {
            return { click_count_source_version: storedClickCountSourceVersion };
          }
          return {};
        },
        async set(values) {
          if (Object.hasOwn(values, 'click_count_source_version')) {
            storedClickCountSourceVersion = values.click_count_source_version;
          }
        },
      },
    },
  },
  getStoredBookmarks: async () => storedBookmarks.map(item => ({ ...item })),
  mutateStoredBookmarks: (mutator) => {
    const operation = mutationQueue.then(async () => {
      storedBookmarks = await mutator(storedBookmarks);
      return storedBookmarks;
    });
    mutationQueue = operation.catch(() => undefined);
    return operation;
  },
  waitForStorageResourceMutations: async () => flushBookmarkMutations(),
  runWithConcurrency: async (items, _limit, worker) => Promise.all(items.map(worker)),
};
vm.createContext(context);
vm.runInContext(`${backgroundSource.slice(start, end)}; this.helpers = {
  CLICK_COUNT_SOURCE_VERSION,
  enrichClickCounts,
  applyClickCountUpdates,
  refreshStoredClickCounts,
  ensureClickCountSourceMigration
};`, context);

const listenerStart = backgroundSource.indexOf('chrome.history.onVisited.addListener');
const listenerEnd = backgroundSource.indexOf('chrome.runtime.onStartup.addListener', listenerStart);
assert.ok(listenerStart >= 0 && listenerEnd > listenerStart, 'history listeners should be present');
vm.runInContext(backgroundSource.slice(listenerStart, listenerEnd), context);

const {
  CLICK_COUNT_SOURCE_VERSION,
  enrichClickCounts,
  applyClickCountUpdates,
  refreshStoredClickCounts,
  ensureClickCountSourceMigration,
} = context.helpers;

historyItemsByUrl = new Map([
  ['https://example.test/a', [{
    id: 'history-a',
    url: 'https://example.test/a/',
    visitCount: 207,
    lastVisitTime: 200,
  }]],
  ['https://example.test/b', []],
]);
const sourceBookmarks = [
  { id: 'a', url: 'https://example.test/a', clickCount: 443, lastClickedAt: 999 },
  { id: 'b', url: 'https://example.test/b', clickCount: 9, lastClickedAt: 500 },
];
const updates = await enrichClickCounts(sourceBookmarks, 2);
assert.deepEqual(Array.from(updates, item => ({ ...item })), [
  { id: 'a', url: 'https://example.test/a', clickCount: 207, lastClickedAt: 200 },
  { id: 'b', url: 'https://example.test/b', clickCount: 0, lastClickedAt: null },
]);
assert.equal(historyVisitCalls, 0, 'bulk reconciliation must not derive visitCount from getVisits().length');
applyClickCountUpdates(sourceBookmarks, updates);
assert.equal(sourceBookmarks[0].clickCount, 207, 'bulk and live updates must use the same visitCount value');
assert.equal(sourceBookmarks[0].lastClickedAt, 200);
assert.equal(sourceBookmarks[1].clickCount, 0);
assert.equal(sourceBookmarks[1].lastClickedAt, null);

storedBookmarks = [{ id: 'a', url: 'https://example.test/a', clickCount: 443, lastClickedAt: 999 }];
storedClickCountSourceVersion = 0;
historyItemsByUrl.set('https://example.test/a', [{
  id: 'history-a',
  url: 'https://example.test/a',
  visitCount: 206,
  lastVisitTime: 200,
}]);
historySearchCalls = 0;
await ensureClickCountSourceMigration();
assert.equal(storedBookmarks[0].clickCount, 206, 'legacy inflated counts must be reconciled before first display');
assert.equal(storedClickCountSourceVersion, CLICK_COUNT_SOURCE_VERSION);
assert.equal(historySearchCalls, 1);
await ensureClickCountSourceMigration();
assert.equal(historySearchCalls, 1, 'completed source migration must not rescan History on every popup open');

storedBookmarks = [{ id: 'a', url: 'https://example.test/a', clickCount: 206, lastClickedAt: 200 }];
historyItemsByUrl.set('https://example.test/a', [{
  id: 'history-a',
  url: 'https://example.test/a',
  visitCount: 206,
  lastVisitTime: 200,
}]);
historySearchCalls = 0;
setHistoryGate();
const staleRefresh = refreshStoredClickCounts();
const duplicateRefresh = refreshStoredClickCounts();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(historySearchCalls, 1, 'concurrent refresh requests must share one History scan');
assert.ok(onVisitedListener, 'onVisited listener should be registered');
await onVisitedListener({
  id: 'history-a',
  url: 'https://example.test/a',
  visitCount: 207,
  lastVisitTime: 300,
});
await flushBookmarkMutations();
historySearchGate.release();
historySearchGate = null;
await Promise.all([staleRefresh, duplicateRefresh]);
assert.equal(storedBookmarks[0].clickCount, 207, 'a stale refresh must not overwrite a newer onVisited event');
assert.equal(storedBookmarks[0].lastClickedAt, 300);

storedBookmarks = [
  { id: 'a', url: 'https://example.test/a', clickCount: 207, lastClickedAt: 300 },
  { id: 'b', url: 'https://example.test/b', clickCount: 9, lastClickedAt: 250 },
];
assert.ok(onVisitRemovedListener, 'onVisitRemoved listener should be registered');
await onVisitRemovedListener({ allHistory: true, urls: [] });
await flushBookmarkMutations();
assert.deepEqual(storedBookmarks.map(item => [item.clickCount, item.lastClickedAt]), [[0, null], [0, null]]);

storedBookmarks = [
  { id: 'a', url: 'https://example.test/a', clickCount: 7, lastClickedAt: 300 },
  { id: 'b', url: 'https://example.test/b', clickCount: 9, lastClickedAt: 250 },
];
historyItemsByUrl.set('https://example.test/a', [{
  id: 'history-a',
  url: 'https://example.test/a',
  visitCount: 2,
  lastVisitTime: 150,
}]);
await onVisitRemovedListener({ allHistory: false, urls: ['https://example.test/a'] });
await flushBookmarkMutations();
assert.equal(storedBookmarks[0].clickCount, 2, 'partial history removal must re-read the remaining visitCount');
assert.equal(storedBookmarks[0].lastClickedAt, 150);
assert.equal(storedBookmarks[1].clickCount, 9);

const recordClickStart = backgroundSource.indexOf("case 'recordClick':");
const recordClickEnd = backgroundSource.indexOf("case 'refreshClickCounts':", recordClickStart);
const recordClickBlock = backgroundSource.slice(recordClickStart, recordClickEnd);
assert.match(recordClickBlock, /deprecated: true/);
assert.doesNotMatch(recordClickBlock, /clickCount|mutateStoredBookmarks|\+\s*1/, 'legacy recordClick must not increment counts');
assert.doesNotMatch(popupSource, /recordClick/);
assert.doesNotMatch(standaloneSource, /recordClick/);

const tabUpdatedListeners = backgroundSource.match(/chrome\.tabs\.onUpdated\.addListener/g) || [];
assert.equal(tabUpdatedListeners.length, 1, 'global tab navigation must not maintain click counts');
const renderedFetchStart = backgroundSource.indexOf('async function fetchRenderedPageContent(');
const renderedFetchEnd = backgroundSource.indexOf('async function fetchBookmarkContent(', renderedFetchStart);
assert.match(backgroundSource.slice(renderedFetchStart, renderedFetchEnd), /chrome\.tabs\.onUpdated\.addListener/, 'the remaining tab listener is only for rendered content fetches');

const historyListener = backgroundSource.slice(listenerStart, listenerEnd);
assert.match(historyListener, /historyItem\.visitCount/);
assert.match(historyListener, /historyItem\.lastVisitTime/);
assert.match(historyListener, /chrome\.history\.onVisitRemoved\.addListener/);
assert.doesNotMatch(historyListener, /clickCount\s*\+|\+\s*1/, 'History listeners must write absolute values');

const getBookmarksStart = backgroundSource.indexOf("case 'getBookmarks':");
const getBookmarksEnd = backgroundSource.indexOf("case 'deleteBookmark':", getBookmarksStart);
assert.match(
  backgroundSource.slice(getBookmarksStart, getBookmarksEnd),
  /await ensureClickCountSourceMigration\(\)/,
  'the first bookmark read must complete the one-time source migration',
);

const syncStart = backgroundSource.indexOf('async function syncAllBookmarksOnce()');
const syncEnd = backgroundSource.indexOf('let syncAllInFlight', syncStart);
const syncSource = backgroundSource.slice(syncStart, syncEnd);
assert.match(syncSource, /const clickCountUpdates = await enrichClickCounts\(merged, 10\)/);
assert.match(syncSource, /applyClickCountUpdates\(merged, clickCountUpdates, clickCountRefreshGuard\)/, 'full sync must protect live visit updates');
assert.match(syncSource, /clickCountChangedDuringRefresh\(item\.url, clickCountRefreshGuard\)/, 'full sync must preserve current counts changed during its query');
assert.match(syncSource, /getLatestClickCountDuringRefresh\(item\.url, clickCountRefreshGuard\)/, 'full sync must retain a live count for newly mirrored bookmarks');

console.log('click counting tests passed');
