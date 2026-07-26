import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('src/timeline/background/background.js', 'utf8');
const start = source.indexOf('function stableRecommendationId(');
const end = source.indexOf('function normalizeLegacyDynamicRules(', start);
assert.ok(start >= 0 && end > start, 'recommendation review helpers should be present');

const storage = new Map();
const storageQueues = new Map();
const operationResults = new Map();
const operationInflight = new Map();
const nativeBookmarks = new Map();
let mirroredBookmarks = [];
let moveCount = 0;

async function mutateStorageResource(key, mutation) {
  const previous = storageQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const value = await mutation(storage.get(key));
    if (value === undefined) storage.delete(key);
    else storage.set(key, value);
    return value;
  });
  storageQueues.set(key, next);
  return next.finally(() => {
    if (storageQueues.get(key) === next) storageQueues.delete(key);
  });
}

async function runIdempotentOperation(type, operationId, operation) {
  const key = `${type}:${operationId}`;
  if (operationResults.has(key)) return operationResults.get(key);
  if (operationInflight.has(key)) return operationInflight.get(key);
  const pending = Promise.resolve().then(operation).then((result) => {
    operationResults.set(key, result);
    return result;
  }).finally(() => operationInflight.delete(key));
  operationInflight.set(key, pending);
  return pending;
}

const folderOptions = [
  { id: 'folder-target', title: 'Development', path: 'Work/Development' },
  { id: 'folder-source', title: 'Inbox', path: 'Inbox' },
];

const chrome = {
  runtime: { sendMessage: async () => ({ success: true }) },
  storage: {
    local: {
      async get(keys) {
        const names = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(names.filter(key => storage.has(key)).map(key => [key, storage.get(key)]));
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) storage.set(key, value);
      },
      async remove(key) { storage.delete(key); },
    },
  },
  bookmarks: {
    async get(id) {
      const bookmark = nativeBookmarks.get(String(id));
      if (!bookmark) throw new Error('bookmark_not_found');
      return [{ ...bookmark }];
    },
    async move(id, destination) {
      const bookmark = nativeBookmarks.get(String(id));
      if (!bookmark) throw new Error('bookmark_not_found');
      moveCount += 1;
      const moved = { ...bookmark, parentId: destination.parentId || bookmark.parentId };
      nativeBookmarks.set(String(id), moved);
      return { ...moved };
    },
  },
};

const normalizeTagList = (values) => [...new Map((values || [])
  .map(value => String(typeof value === 'string' ? value : value?.tag || '').trim())
  .filter(Boolean)
  .map(value => [value.toLowerCase(), value])).values()];
const normalizeBookmarkFolderPath = (value) => String(value || '')
  .replace(/\\/g, '/')
  .split('/')
  .map(part => part.trim())
  .filter(Boolean)
  .join('/');

const context = {
  Array,
  Date,
  JSON,
  Map,
  Math,
  Number,
  Object,
  Promise,
  Set,
  String,
  URL,
  chrome,
  crypto: globalThis.crypto,
  extractDomain: url => {
    try { return new URL(url).hostname; } catch { return ''; }
  },
  getStoredBookmarks: async () => mirroredBookmarks.map(item => ({ ...item, tags: [...(item.tags || [])] })),
  loadBookmarkFolderOptions: async () => folderOptions.map(item => ({ ...item })),
  mutateStoredBookmarks: async (mutation) => {
    mirroredBookmarks = await mutation(mirroredBookmarks);
    return mirroredBookmarks;
  },
  mutateStorageResource,
  normalizeBookmarkFolderPath,
  normalizeTagList,
  programmaticBookmarkMoves: new Map(),
  RECOMMENDATION_STORE_KEY: 'bookmark_recommendation_store_v2',
  RECOMMENDATION_STORE_VERSION: 2,
  RECOMMENDATION_SNAPSHOT_TTL_MS: 7 * 24 * 60 * 60 * 1000,
  RECOMMENDATION_FEEDBACK_TTL_MS: 180 * 24 * 60 * 60 * 1000,
  RECOMMENDATION_MAX_SNAPSHOTS: 200,
  RECOMMENDATION_MAX_FEEDBACK: 5000,
  RECOMMENDATION_MAX_REVIEWS: 200,
  runIdempotentOperation,
};
context.self = context;
vm.createContext(context);
vm.runInContext(`${source.slice(start, end)}; this.review = {
  emptyRecommendationStore,
  enqueueRecommendationReviewItem,
  getRecommendationLearningState,
  normalizeRecommendationReviewItem,
  resolveRecommendationReview
};`, context);

const helpers = context.review;
const store = helpers.emptyRecommendationStore();
const makeSnapshot = (id, bookmarkId, domain = 'example.test') => ({
  recommendationId: id,
  ruleVersion: 'bookmark-recommendation-v2',
  urlFingerprint: context.recommendationUrlFingerprint(`https://${domain}/${bookmarkId}`),
  domain,
  pathSegments: [bookmarkId],
  tags: [{ tag: 'Development', support: 0.9, confidence: 'high' }],
  folders: [{ id: 'folder-target', folderPath: 'Work/Development', existing: true, support: 0.9, confidence: 'high' }],
  selectedTags: ['Development'],
  selectedFolderPath: 'Work/Development',
  createdAt: Date.now(),
});
const makeReview = (id, bookmarkId, recommendationId, type = 'bookmark_recommendation') => ({
  id,
  type,
  bookmarkId,
  recommendationId,
  title: bookmarkId,
  urlFingerprint: context.recommendationUrlFingerprint(`https://example.test/${bookmarkId}`),
  fromFolderPath: 'Inbox',
  toFolderId: 'folder-target',
  toFolderPath: 'Work/Development',
  confidence: 'high',
  createdAt: Date.now(),
});

for (const id of ['b1', 'b2']) {
  nativeBookmarks.set(id, { id, title: id, url: `https://example.test/${id}`, parentId: 'folder-source' });
  mirroredBookmarks.push({ id, title: id, url: `https://example.test/${id}`, domain: 'example.test', parentId: 'folder-source', folderPath: 'Inbox', tags: [] });
  store.snapshots.push(makeSnapshot(`rec-${id}`, id));
}
storage.set(context.RECOMMENDATION_STORE_KEY, store);

await Promise.all([
  helpers.enqueueRecommendationReviewItem(makeReview('review-b1', 'b1', 'rec-b1')),
  helpers.enqueueRecommendationReviewItem(makeReview('review-b2', 'b2', 'rec-b2')),
]);
let state = await helpers.getRecommendationLearningState();
assert.equal(state.reviewQueue.length, 2, 'concurrent review enqueue must not lose items');
assert.equal(state.reviewQueue[0].recommendation.folders[0].folderPath, 'Work/Development');

const [first, replay] = await Promise.all([
  helpers.resolveRecommendationReview({ operationId: 'apply-b1', reviewId: 'review-b1', decision: 'accept' }),
  helpers.resolveRecommendationReview({ operationId: 'apply-b1', reviewId: 'review-b1', decision: 'accept' }),
]);
assert.equal(first.success, true);
assert.equal(replay.success, true);
assert.equal(moveCount, 1, 'duplicate operationId must move only once');
assert.deepEqual(mirroredBookmarks.find(item => item.id === 'b1').tags, ['Development']);

await helpers.resolveRecommendationReview({ operationId: 'apply-b2', reviewId: 'review-b2', decision: 'accept' });
state = await helpers.getRecommendationLearningState();
assert.equal(state.reviewQueue.length, 0);
assert.equal(state.recentFeedback.length, 2);
assert.equal(state.rules.find(rule => rule.kind === 'domain_folder' && rule.pattern === 'example.test').state, 'active');
assert.equal(state.rules.find(rule => rule.kind === 'domain_tag' && rule.pattern === 'example.test').state, 'active');

nativeBookmarks.set('provenance', { id: 'provenance', title: 'provenance', url: 'https://provenance.test/provenance', parentId: 'folder-source' });
mirroredBookmarks.push({
  id: 'provenance',
  title: 'provenance',
  url: 'https://provenance.test/provenance',
  domain: 'provenance.test',
  parentId: 'folder-source',
  folderPath: 'Inbox',
  tags: ['Manual', 'Existing Auto'],
  tagsAuto: ['Existing Auto', 'Orphan Auto'],
});
const provenanceStore = storage.get(context.RECOMMENDATION_STORE_KEY);
provenanceStore.snapshots.push(makeSnapshot('rec-provenance', 'provenance', 'provenance.test'));
storage.set(context.RECOMMENDATION_STORE_KEY, provenanceStore);
await helpers.enqueueRecommendationReviewItem({
  ...makeReview('review-provenance', 'provenance', 'rec-provenance'),
  sourceParentId: 'folder-source',
  sourceTags: ['Manual', 'Existing Auto'],
});
const provenance = await helpers.resolveRecommendationReview({ operationId: 'apply-provenance', reviewId: 'review-provenance', decision: 'accept' });
assert.equal(provenance.success, true);
assert.deepEqual(mirroredBookmarks.find(item => item.id === 'provenance').tags, ['Manual', 'Existing Auto', 'Development']);
assert.deepEqual(
  mirroredBookmarks.find(item => item.id === 'provenance').tagsAuto,
  ['Existing Auto', 'Development'],
  'accepted recommendations must not reclassify manual or orphaned tags as automatic',
);

nativeBookmarks.set('manual-match', { id: 'manual-match', title: 'manual match', url: 'https://manual-match.test/manual-match', parentId: 'folder-source' });
mirroredBookmarks.push({ id: 'manual-match', title: 'manual match', url: 'https://manual-match.test/manual-match', domain: 'manual-match.test', parentId: 'folder-source', folderPath: 'Inbox', tags: ['Development'], tagsAuto: [] });
const manualMatchStore = storage.get(context.RECOMMENDATION_STORE_KEY);
manualMatchStore.snapshots.push({
  ...makeSnapshot('rec-manual-match', 'manual-match', 'manual-match.test'),
  selectedTags: ['Development'],
});
storage.set(context.RECOMMENDATION_STORE_KEY, manualMatchStore);
await helpers.enqueueRecommendationReviewItem({
  ...makeReview('review-manual-match', 'manual-match', 'rec-manual-match'),
  sourceParentId: 'folder-source',
  sourceTags: ['Development'],
});
const manualMatch = await helpers.resolveRecommendationReview({ operationId: 'apply-manual-match', reviewId: 'review-manual-match', decision: 'accept' });
assert.equal(manualMatch.success, true);
assert.deepEqual(
  mirroredBookmarks.find(item => item.id === 'manual-match').tagsAuto,
  [],
  'a recommendation that already exists as a manual tag must remain manual',
);

nativeBookmarks.set('m1', { id: 'm1', title: 'm1', url: 'https://move.test/m1', parentId: 'folder-target' });
mirroredBookmarks.push({ id: 'm1', title: 'm1', url: 'https://move.test/m1', domain: 'move.test', parentId: 'folder-target', folderPath: 'Work/Development', tags: [] });
const moveStore = storage.get(context.RECOMMENDATION_STORE_KEY);
moveStore.snapshots.push({
  ...makeSnapshot('rec-m1', 'm1', 'move.test'),
  tags: [],
  selectedTags: [],
});
storage.set(context.RECOMMENDATION_STORE_KEY, moveStore);
await helpers.enqueueRecommendationReviewItem(makeReview('review-m1', 'm1', 'rec-m1', 'move_observation'));
const confirmedMove = await helpers.resolveRecommendationReview({ operationId: 'confirm-m1', reviewId: 'review-m1', decision: 'accept' });
assert.equal(confirmedMove.success, true);
state = await helpers.getRecommendationLearningState();
assert.equal(state.rules.find(rule => rule.kind === 'domain_folder' && rule.pattern === 'move.test').state, 'candidate');

nativeBookmarks.set('renamed-move', { id: 'renamed-move', title: 'renamed move', url: 'https://renamed-move.test/renamed-move', parentId: 'folder-target' });
mirroredBookmarks.push({ id: 'renamed-move', title: 'renamed move', url: 'https://renamed-move.test/renamed-move', domain: 'renamed-move.test', parentId: 'folder-target', folderPath: 'Work/Development', tags: [] });
const renamedMoveStore = storage.get(context.RECOMMENDATION_STORE_KEY);
renamedMoveStore.snapshots.push({
  ...makeSnapshot('rec-renamed-move', 'renamed-move', 'renamed-move.test'),
  tags: [],
  selectedTags: [],
});
storage.set(context.RECOMMENDATION_STORE_KEY, renamedMoveStore);
await helpers.enqueueRecommendationReviewItem(makeReview('review-renamed-move', 'renamed-move', 'rec-renamed-move', 'move_observation'));
const targetFolder = folderOptions.find(item => item.id === 'folder-target');
const originalTargetPath = targetFolder.path;
targetFolder.path = 'Work/Renamed Development';
const renamedMove = await helpers.resolveRecommendationReview({ operationId: 'confirm-renamed-move', reviewId: 'review-renamed-move', decision: 'accept' });
targetFolder.path = originalTargetPath;
assert.equal(renamedMove.success, true);
state = await helpers.getRecommendationLearningState();
assert.equal(
  state.recentFeedback.find(item => item.operationId === 'confirm-renamed-move:feedback').selection.folderPath,
  'Work/Renamed Development',
  'move observations must learn the target folder current path after a rename',
);

nativeBookmarks.set('stale-move', { id: 'stale-move', title: 'stale move', url: 'https://stale-move.test/stale-move', parentId: 'folder-target' });
mirroredBookmarks.push({ id: 'stale-move', title: 'stale move', url: 'https://stale-move.test/stale-move', domain: 'stale-move.test', parentId: 'folder-target', folderPath: 'Work/Development', tags: [] });
const staleMoveStore = storage.get(context.RECOMMENDATION_STORE_KEY);
staleMoveStore.snapshots.push({
  ...makeSnapshot('rec-stale-move', 'stale-move', 'stale-move.test'),
  tags: [],
  selectedTags: [],
});
storage.set(context.RECOMMENDATION_STORE_KEY, staleMoveStore);
await helpers.enqueueRecommendationReviewItem(makeReview('review-stale-move', 'stale-move', 'rec-stale-move', 'move_observation'));
nativeBookmarks.set('stale-move', { ...nativeBookmarks.get('stale-move'), parentId: 'folder-source' });
const stateBeforeStaleMove = await helpers.getRecommendationLearningState();
const staleMove = await helpers.resolveRecommendationReview({ operationId: 'confirm-stale-move', reviewId: 'review-stale-move', decision: 'accept' });
assert.deepEqual({ ...staleMove }, { success: false, error: 'bookmark_changed' });
state = await helpers.getRecommendationLearningState();
assert.equal(state.recentFeedback.length, stateBeforeStaleMove.recentFeedback.length, 'stale move observations must not create learning feedback');
assert.deepEqual({ ...state.stats }, { ...stateBeforeStaleMove.stats }, 'stale move observations must not change learning stats');
assert.equal(state.rules.length, stateBeforeStaleMove.rules.length, 'stale move observations must not change learned rules');
assert.ok(state.reviewQueue.some(item => item.id === 'review-stale-move'), 'stale move observations must remain available for explicit removal');

nativeBookmarks.set('stale-url', { id: 'stale-url', title: 'stale', url: 'https://changed.test/page', parentId: 'folder-source' });
mirroredBookmarks.push({ id: 'stale-url', title: 'stale', url: 'https://changed.test/page', parentId: 'folder-source', folderPath: 'Inbox', tags: [] });
const conflictStore = storage.get(context.RECOMMENDATION_STORE_KEY);
conflictStore.snapshots.push(makeSnapshot('rec-stale-url', 'stale-url'));
storage.set(context.RECOMMENDATION_STORE_KEY, conflictStore);
await helpers.enqueueRecommendationReviewItem(makeReview('review-stale-url', 'stale-url', 'rec-stale-url'));
const staleReject = await helpers.resolveRecommendationReview({ operationId: 'reject-stale-url', reviewId: 'review-stale-url', decision: 'reject' });
assert.deepEqual({ ...staleReject }, { success: false, error: 'bookmark_changed' });
state = await helpers.getRecommendationLearningState();
assert.ok(state.reviewQueue.some(item => item.id === 'review-stale-url'), 'stale review must remain available for explicit removal');

const stale = helpers.normalizeRecommendationReviewItem({
  ...makeReview('stale', 'b1', 'rec-b1'),
  createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
});
assert.equal(stale, null, 'review items must expire with their seven-day snapshots');

console.log('recommendation review tests passed');
