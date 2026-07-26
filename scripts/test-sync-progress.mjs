import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const backgroundSource = readFileSync('src/timeline/background/background.js', 'utf8');
const popupSource = readFileSync('src/timeline/pages/popup/popup.js', 'utf8');
const standaloneSource = readFileSync('src/timeline/pages/standalone/standalone.js', 'utf8');
const popupHtml = readFileSync('src/timeline/pages/popup/popup.html', 'utf8');
const standaloneHtml = readFileSync('src/timeline/pages/standalone/standalone.html', 'utf8');
const i18nSource = readFileSync('src/timeline/shared/i18n.js', 'utf8');

function getSourceBlock(source, startMarker, endMarker, description) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${description} must be present`);
  return source.slice(start, end);
}

function makeElement() {
  const attributes = new Map();
  const classes = new Set();
  return {
    hidden: true,
    textContent: '',
    max: 1,
    value: 0,
    disabled: false,
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name); },
    removeAttribute(name) { attributes.delete(name); },
  };
}

const progressHelperSource = getSourceBlock(
  backgroundSource,
  'const SYNC_PROGRESS_MAX_UPDATES =',
  'async function syncAllBookmarksOnce()',
  'sync progress helpers',
);
const sentProgressEvents = [];
const backgroundContext = {
  Date: { now: () => 1700000000000 },
  Math,
  Number,
  Promise,
  String,
  chrome: {
    runtime: {
      sendMessage(message) {
        sentProgressEvents.push({ ...message });
        return Promise.resolve();
      },
    },
  },
};
vm.createContext(backgroundContext);
vm.runInContext(`${progressHelperSource}\nthis.helpers = {
  beginSyncProgress,
  broadcastSyncProgress,
  createSyncProgressReporter,
  getSyncProgressStatus,
};`, backgroundContext);

const operationId = backgroundContext.helpers.beginSyncProgress();
assert.match(operationId, /^sync_/);
assert.deepEqual({ ...sentProgressEvents[0] }, {
  action: 'syncProgress',
  status: 'running',
  operationId,
  phase: 'reading',
  completed: 0,
  total: 0,
  error: '',
  updatedAt: 1700000000000,
  sequence: 1,
});

const reportMergeProgress = backgroundContext.helpers.createSyncProgressReporter(operationId, 'merging', 100);
reportMergeProgress(1);
assert.equal(sentProgressEvents.length, 1, 'batched progress must not broadcast every bookmark');
reportMergeProgress(5);
assert.equal(sentProgressEvents.length, 2);
assert.deepEqual({ ...sentProgressEvents[1] }, {
  action: 'syncProgress',
  status: 'running',
  operationId,
  phase: 'merging',
  completed: 5,
  total: 100,
  error: '',
  updatedAt: 1700000000000,
  sequence: 2,
});
reportMergeProgress(100);
assert.equal(sentProgressEvents.at(-1).completed, 100, 'the final item must always be reported');

const progressSnapshot = backgroundContext.helpers.getSyncProgressStatus();
progressSnapshot.phase = 'changed-locally';
assert.equal(backgroundContext.helpers.getSyncProgressStatus().phase, 'merging', 'status reads must return a copy');
await backgroundContext.helpers.broadcastSyncProgress({
  operationId,
  status: 'complete',
  phase: 'complete',
  completed: 100,
  total: 100,
}, true);
assert.equal(sentProgressEvents.at(-1).status, 'complete');

const syncOnceSource = getSourceBlock(
  backgroundSource,
  'async function syncAllBookmarksOnce()',
  'let syncAllInFlight',
  'full bookmark sync',
);
assert.match(syncOnceSource, /const operationId = beginSyncProgress\(\)/);
for (const phase of ['merging', 'tagging', 'clickCounts', 'saving']) {
  assert.match(syncOnceSource, new RegExp(`phase:\\s*['\"]${phase}['\"]`), `sync must report the ${phase} phase`);
}
assert.match(syncOnceSource, /status:\s*['\"]complete['\"]/);
assert.match(syncOnceSource, /status:\s*['\"]failed['\"]/);
assert.match(syncOnceSource, /createSyncProgressReporter\(operationId, ['\"]tagging['\"]/);
assert.match(syncOnceSource, /createSyncProgressReporter\(operationId, ['\"]clickCounts['\"]/);
assert.equal(
  (syncOnceSource.match(/await mutateStoredBookmarks\(/g) || []).length,
  1,
  'sync must keep bookmark mirror writes atomic instead of committing partial batches',
);
const snapshotCommitIndex = syncOnceSource.indexOf('await mutateStoredBookmarks(');
const completeProgressIndex = syncOnceSource.lastIndexOf("status: 'complete'");
assert.ok(snapshotCommitIndex > syncOnceSource.indexOf("phase: 'saving'"), 'saving progress must precede the single snapshot commit');
assert.ok(completeProgressIndex > snapshotCommitIndex, 'complete progress must only be published after the snapshot commit');

const sharedSyncSource = getSourceBlock(
  backgroundSource,
  'let syncAllInFlight = null;',
  'const pendingQuickBookmarks = new Map();',
  'shared sync request guard',
);
assert.match(sharedSyncSource, /if \(!syncAllInFlight\)/);
assert.match(sharedSyncSource, /syncAllInFlight = syncAllBookmarksOnce\(\)\.finally/);

const enrichSource = getSourceBlock(
  backgroundSource,
  'async function enrichClickCounts(',
  'function applyClickCountUpdates(',
  'click count progress enrichment',
);
assert.match(enrichSource, /onProgress\s*=\s*null/);
assert.match(enrichSource, /onProgress\(completed, totalItems\)/);

const runtimeHandlerSource = getSourceBlock(
  backgroundSource,
  "case 'syncAll':",
  "case 'getBookmarks':",
  'sync runtime handlers',
);
assert.match(runtimeHandlerSource, /case ['\"]getSyncStatus['\"]:/);
assert.match(runtimeHandlerSource, /getSyncProgressStatus\(\)/);

for (const [name, source, html, progressId, textId, barId, buttonId] of [
  ['popup', popupSource, popupHtml, 'syncProgress', 'syncProgressText', 'syncProgressBar', 'syncBtn'],
  ['workspace', standaloneSource, standaloneHtml, 'saSyncProgress', 'saSyncProgressText', 'saSyncProgressBar', 'saSyncBtn'],
]) {
  for (const id of [progressId, textId, barId]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `${name} must provide the ${id} progress element`);
  }
  assert.match(html, new RegExp(`id=["']${progressId}["'][^>]*role=["']status["']`), `${name} progress must announce status changes`);
  assert.match(source, /action:\s*['\"]getSyncStatus['\"]/);
  assert.match(source, /action\s*===\s*['\"]syncProgress['\"]/);
  assert.match(source, /handleSyncProgress\(/);
  assert.match(source, /syncProgressRefreshPromise/);
  assert.match(
    source,
    buttonId === 'syncBtn' ? /syncBtn\.disabled\s*=\s*isBusy/ : /saSyncBtn\.disabled\s*=\s*isBusy/,
    `${name} must prevent duplicate manual sync requests`,
  );
  assert.match(source, /if \(status !== ['\"]complete['\"] \|\| hasFinished\) return syncProgressRefreshPromise \|\| Promise\.resolve\(\);/);
}

function getRuntimeListenerProgressBranch(source, parameterName) {
  const listenerStart = source.lastIndexOf('chrome.runtime.onMessage.addListener');
  const progressStart = source.indexOf(`if (${parameterName}.action === 'syncProgress')`, listenerStart);
  const nextBranch = source.indexOf('} else if', progressStart);
  assert.ok(listenerStart >= 0 && progressStart > listenerStart && nextBranch > progressStart, 'progress listener branch must be present');
  return source.slice(progressStart, nextBranch);
}

const popupProgressBranch = getRuntimeListenerProgressBranch(popupSource, 'message');
assert.match(popupProgressBranch, /handleSyncProgress\(message\)/);
assert.doesNotMatch(popupProgressBranch, /loadBookmarks|getBookmarks|refreshBookmarksAfterSync/, 'popup must not reload partial data for progress messages');
const workspaceProgressBranch = getRuntimeListenerProgressBranch(standaloneSource, 'msg');
assert.match(workspaceProgressBranch, /handleSyncProgress\(msg\)/);
assert.doesNotMatch(workspaceProgressBranch, /refreshBookmarkData|fetchBookmarks/, 'workspace must not reload partial data for progress messages');

const popupProgressUiSource = getSourceBlock(
  popupSource,
  'function getSyncProgressPayload(',
  'function extractDomain(url)',
  'popup progress UI helpers',
);
const popupSyncBtn = makeElement();
const popupProgress = makeElement();
const popupProgressText = makeElement();
const popupProgressBar = makeElement();
const popupMessages = [];
const popupContext = {
  Promise,
  Number,
  String,
  Math,
  Set,
  console: { error() {}, debug() {} },
  syncBtn: popupSyncBtn,
  syncProgress: popupProgress,
  syncProgressText: popupProgressText,
  syncProgressBar: popupProgressBar,
  searchInput: { value: '' },
  allBookmarks: [],
  duplicateIds: new Set(),
  syncProgressActive: false,
  syncProgressOperationId: null,
  syncProgressLastUpdatedAt: 0,
  syncProgressLastSequence: 0,
  syncProgressLastFinishedOperationId: null,
  syncProgressRequestInFlight: false,
  syncProgressRefreshPromise: null,
  i18n(key, values = []) { return `${key}:${values.join('/')}`; },
  showToast() {},
  computeDuplicates() { return new Set(); },
  async collectAllTags() {},
  renderTagBar() {},
  filterBookmarks() {},
  chrome: {
    runtime: {
      async sendMessage(message) {
        popupMessages.push(message);
        if (message.action === 'getBookmarks') return { success: true, bookmarks: [{ id: 'bookmark-1' }] };
        if (message.action === 'getSyncStatus') return { success: true, status: { status: 'idle' } };
        return { success: false };
      },
    },
  },
};
vm.createContext(popupContext);
vm.runInContext(`${popupProgressUiSource}\nthis.helpers = {
  getSyncProgressPayload,
  handleSyncProgress,
  finishSyncProgress,
};`, popupContext);

assert.deepEqual(
  { ...popupContext.helpers.getSyncProgressPayload({ success: true, status: { status: 'running', operationId: 'sync-1' } }) },
  { status: 'running', operationId: 'sync-1' },
  'getSyncStatus responses must be usable by a page opened during sync',
);
popupContext.helpers.handleSyncProgress({
  action: 'syncProgress',
  status: 'running',
  operationId: 'sync-1',
  phase: 'merging',
  completed: 12,
  total: 30,
  updatedAt: 100,
  sequence: 10,
});
assert.equal(popupProgress.hidden, false);
assert.equal(popupProgressText.textContent, 'syncProgressMerging:12/30');
assert.equal(popupProgressBar.value, 12);
assert.equal(popupProgressBar.max, 30);
assert.equal(popupSyncBtn.disabled, true);
popupContext.helpers.handleSyncProgress({
  action: 'syncProgress',
  status: 'running',
  operationId: 'sync-1',
  phase: 'merging',
  completed: 2,
  total: 30,
  updatedAt: 100,
  sequence: 9,
});
assert.equal(popupProgressBar.value, 12, 'out-of-order progress must not move the UI backwards');
await popupContext.helpers.finishSyncProgress({ status: 'complete', operationId: 'sync-1' });
assert.equal(popupProgress.hidden, true);
assert.equal(popupSyncBtn.disabled, false);
assert.equal(popupMessages.filter(item => item.action === 'getBookmarks').length, 1, 'completed sync must refresh the complete snapshot once');
await popupContext.helpers.finishSyncProgress({ status: 'complete', operationId: 'sync-1' });
assert.equal(popupMessages.filter(item => item.action === 'getBookmarks').length, 1, 'duplicate completion events must not refresh twice');

for (const key of [
  'syncProgressStarting',
  'syncProgressReading',
  'syncProgressMerging',
  'syncProgressTagging',
  'syncProgressClickCounts',
  'syncProgressSaving',
  'syncProgressRunning',
]) {
  assert.equal((i18nSource.match(new RegExp(`${key}:`, 'g')) || []).length, 2, `${key} must be localized in English and Chinese`);
}

console.log('sync progress tests passed');
