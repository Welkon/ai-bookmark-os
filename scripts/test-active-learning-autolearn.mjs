import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// 主动学习自动学习链路回归：
// 1. 手工移动书签不再进入人工复核队列，而是直接落 accepted 反馈（domain→folder 规则自动学习）；
// 2. 两次不同 URL 移入同一目录后规则激活（≥2 个不同 URL 指纹）；
// 3. 手工移动会顺带清掉该书签遗留的 bookmark_recommendation 待复核项；
// 4. 移动到根目录（空路径）不产生学习；
// 5. resolveRecommendationReview 对书签已删除/已被整理的过期建议自动移除（staleDiscarded），
//    不再硬报错滞留队列；
// 6. settings.js 以友好文案展示结果，i18n 键在 en/zh_CN 均存在。

const source = readFileSync('src/timeline/background/background.js', 'utf8');
const start = source.indexOf('function stableRecommendationId(');
const end = source.indexOf('function normalizeLegacyDynamicRules(', start);
assert.ok(start >= 0 && end > start, 'recommendation helpers should be present');
const moveStart = source.indexOf('async function queueBookmarkMoveObservation(');
const moveEnd = source.indexOf('async function reevaluateBookmarkRecommendations(', moveStart);
assert.ok(moveStart >= 0 && moveEnd > moveStart, 'queueBookmarkMoveObservation should be present');
const handleStart = source.indexOf('async function handleSingleBookmarkMoved(');
const handleEnd = source.indexOf('\nchrome.bookmarks.onMoved.addListener', handleStart);
assert.ok(handleStart >= 0 && handleEnd > handleStart, 'handleSingleBookmarkMoved should be present');

const storage = new Map();
const storageQueues = new Map();
const operationResults = new Map();
const operationInflight = new Map();
const nativeBookmarks = new Map();
let mirroredBookmarks = [];

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
  { id: 'folder-ml', title: '机器学习', path: '技术/机器学习' },
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
  Array, Date, JSON, Map, Math, Number, Object, Promise, Set, String, URL,
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
  isBrowserBookmarkRoot: () => false,
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
vm.runInContext(`
${source.slice(start, end)}
${source.slice(moveStart, moveEnd)}
${source.slice(handleStart, handleEnd)}
this.autolearn = {
  emptyRecommendationStore,
  enqueueRecommendationReviewItem,
  getRecommendationLearningState,
  queueBookmarkMoveObservation,
  resolveRecommendationReview
};
this.moveHooks = {
  setSuppressed: (ms) => { moveLearningSuppressedUntil = Date.now() + ms; },
  clearSuppressed: () => { moveLearningSuppressedUntil = 0; },
  markProgrammaticMove: markProgrammaticBookmarkMove,
  handleSingleBookmarkMoved,
};
`, context);

const helpers = context.autolearn;
storage.set(context.RECOMMENDATION_STORE_KEY, helpers.emptyRecommendationStore());

function seedBookmark(id, domain) {
  nativeBookmarks.set(id, { id, title: id, url: `https://${domain}/${id}`, parentId: 'folder-ml' });
  mirroredBookmarks.push({
    id, title: id, url: `https://${domain}/${id}`, domain,
    parentId: 'folder-ml', folderPath: '技术/机器学习', tags: [],
  });
}

// ── 1. 手工移动直接产生 accepted 反馈，不进入复核队列 ──
seedBookmark('m1', 'pytorch.org');
const observed = await helpers.queueBookmarkMoveObservation(
  nativeBookmarks.get('m1'), 'Inbox', 'folder-ml', '技术/机器学习',
);
assert.equal(observed?.success, true, 'manual move must produce accepted feedback directly');
let state = await helpers.getRecommendationLearningState();
assert.equal(state.reviewQueue.length, 0, 'manual moves must NOT enqueue manual-confirmation review items');
assert.equal(state.reviewQueue.filter(item => item.type === 'move_observation').length, 0,
  'no move_observation items may be created for manual moves');
assert.equal(state.stats.accepted, 1, 'manual move must count as accepted feedback');
const moveFeedback = state.recentFeedback.find(item => item.outcome === 'accepted');
assert.ok(moveFeedback, 'manual move feedback must be recorded');
assert.equal(moveFeedback.selection.folderPath, '技术/机器学习');
const candidateRule = state.rules.find(rule => rule.kind === 'domain_folder' && rule.pattern === 'pytorch.org');
assert.ok(candidateRule, 'manual move must learn a domain→folder rule');
assert.equal(candidateRule.state, 'candidate', 'a single move must keep the rule at candidate');

// ── 2. 同域名第二个不同 URL 移入同一目录 → 规则激活 ──
seedBookmark('m2', 'pytorch.org');
await helpers.queueBookmarkMoveObservation(
  nativeBookmarks.get('m2'), 'Inbox', 'folder-ml', '技术/机器学习',
);
state = await helpers.getRecommendationLearningState();
const activatedRule = state.rules.find(rule => rule.kind === 'domain_folder' && rule.pattern === 'pytorch.org');
assert.equal(activatedRule.state, 'active', 'two distinct URLs filed manually must activate the learned rule');
assert.equal(activatedRule.positiveFingerprints.length, 2, 'rule evidence must be deduplicated by URL fingerprint');

// ── 3. 手工移动顺带清掉该书签遗留的 bookmark_recommendation 待复核项 ──
seedBookmark('m3', 'huggingface.co');
const store = storage.get(context.RECOMMENDATION_STORE_KEY);
store.snapshots.push({
  recommendationId: 'rec-m3-suggestion',
  ruleVersion: 'bookmark-recommendation-v2',
  urlFingerprint: context.recommendationUrlFingerprint('https://huggingface.co/m3'),
  domain: 'huggingface.co',
  pathSegments: ['m3'],
  tags: [{ tag: '机器学习', support: 0.9, confidence: 'high' }],
  folders: [],
  selectedTags: ['机器学习'],
  selectedFolderPath: '',
  createdAt: Date.now(),
});
storage.set(context.RECOMMENDATION_STORE_KEY, store);
await helpers.enqueueRecommendationReviewItem({
  id: 'review-m3-suggestion',
  type: 'bookmark_recommendation',
  bookmarkId: 'm3',
  recommendationId: 'rec-m3-suggestion',
  title: 'm3',
  urlFingerprint: context.recommendationUrlFingerprint('https://huggingface.co/m3'),
  sourceParentId: 'folder-source',
  sourceTags: [],
  confidence: 'high',
  createdAt: Date.now(),
});
state = await helpers.getRecommendationLearningState();
assert.equal(state.reviewQueue.length, 1, 'suggestion review should be pending before the manual move');
await helpers.queueBookmarkMoveObservation(
  nativeBookmarks.get('m3'), 'Inbox', 'folder-ml', '技术/机器学习',
);
state = await helpers.getRecommendationLearningState();
assert.equal(state.reviewQueue.length, 0,
  'manually filing a bookmark must clear its pending suggestion review (user decision supersedes)');

// ── 4. 移动到根目录（空路径）不产生学习 ──
seedBookmark('m4', 'root-move.test');
const rootMove = await helpers.queueBookmarkMoveObservation(
  nativeBookmarks.get('m4'), '技术/机器学习', '1', '',
);
assert.equal(rootMove, null, 'moves to the bookmark root must not learn anything');
state = await helpers.getRecommendationLearningState();
assert.ok(!state.rules.some(rule => rule.pattern === 'root-move.test'),
  'no rule may be learned from root moves');

// ── 5. 过期建议自动移除（staleDiscarded），不再硬报错 ──
// 5a. 书签已被用户移动（sourceParentId 过期）→ 采用首选 = 过期移除。
seedBookmark('s1', 'stale-accept.test');
const staleStore = storage.get(context.RECOMMENDATION_STORE_KEY);
staleStore.snapshots.push({
  recommendationId: 'rec-s1',
  ruleVersion: 'bookmark-recommendation-v2',
  urlFingerprint: context.recommendationUrlFingerprint('https://stale-accept.test/s1'),
  domain: 'stale-accept.test',
  pathSegments: ['s1'],
  tags: [{ tag: '机器学习', support: 0.9, confidence: 'high' }],
  folders: [],
  selectedTags: ['机器学习'],
  selectedFolderPath: '',
  createdAt: Date.now(),
});
storage.set(context.RECOMMENDATION_STORE_KEY, staleStore);
await helpers.enqueueRecommendationReviewItem({
  id: 'review-s1',
  type: 'bookmark_recommendation',
  bookmarkId: 's1',
  recommendationId: 'rec-s1',
  title: 's1',
  urlFingerprint: context.recommendationUrlFingerprint('https://stale-accept.test/s1'),
  sourceParentId: 'folder-source',
  sourceTags: [],
  confidence: 'high',
  createdAt: Date.now(),
});
const feedbackBefore = (await helpers.getRecommendationLearningState()).recentFeedback.length;
const staleAccept = await helpers.resolveRecommendationReview({ operationId: 'accept-s1', reviewId: 'review-s1', decision: 'accept' });
assert.deepEqual({ ...staleAccept }, { success: true, decision: 'accept', staleDiscarded: true },
  'accepting a suggestion whose bookmark was already re-filed must discard as stale');
state = await helpers.getRecommendationLearningState();
assert.ok(!state.reviewQueue.some(item => item.id === 'review-s1'), 'stale suggestion must be auto-removed');
assert.equal(state.recentFeedback.length, feedbackBefore,
  'discarding a stale suggestion must not fabricate learning feedback');

// 5b. 书签已删除 → 采用首选 = 过期移除。
seedBookmark('s2', 'stale-deleted.test');
const deletedStore = storage.get(context.RECOMMENDATION_STORE_KEY);
deletedStore.snapshots.push({
  recommendationId: 'rec-s2',
  ruleVersion: 'bookmark-recommendation-v2',
  urlFingerprint: context.recommendationUrlFingerprint('https://stale-deleted.test/s2'),
  domain: 'stale-deleted.test',
  pathSegments: ['s2'],
  tags: [{ tag: '机器学习', support: 0.9, confidence: 'high' }],
  folders: [],
  selectedTags: ['机器学习'],
  selectedFolderPath: '',
  createdAt: Date.now(),
});
storage.set(context.RECOMMENDATION_STORE_KEY, deletedStore);
await helpers.enqueueRecommendationReviewItem({
  id: 'review-s2',
  type: 'bookmark_recommendation',
  bookmarkId: 's2',
  recommendationId: 'rec-s2',
  title: 's2',
  urlFingerprint: context.recommendationUrlFingerprint('https://stale-deleted.test/s2'),
  sourceParentId: 'folder-ml',
  sourceTags: [],
  confidence: 'high',
  createdAt: Date.now(),
});
nativeBookmarks.delete('s2');
const staleDeleted = await helpers.resolveRecommendationReview({ operationId: 'accept-s2', reviewId: 'review-s2', decision: 'accept' });
assert.deepEqual({ ...staleDeleted }, { success: true, decision: 'accept', staleDiscarded: true },
  'accepting a suggestion whose bookmark was deleted must discard as stale');
state = await helpers.getRecommendationLearningState();
assert.ok(!state.reviewQueue.some(item => item.id === 'review-s2'), 'deleted-bookmark suggestion must be auto-removed');

// ── 7. 批量程序性移动（分类应用/撤销）必须抑制自动学习 ──
const hooks = context.moveHooks;
nativeBookmarks.set('folder-ml', { id: 'folder-ml', title: '机器学习', parentId: '0' });
nativeBookmarks.set('folder-source', { id: 'folder-source', title: 'Inbox', parentId: '0' });

function seedInboxBookmark(id, domain) {
  nativeBookmarks.set(id, { id, title: id, url: `https://${domain}/${id}`, parentId: 'folder-source' });
  mirroredBookmarks.push({
    id, title: id, url: `https://${domain}/${id}`, domain,
    parentId: 'folder-source', folderPath: 'Inbox', tags: [],
  });
}

// 7a. 抑制窗口内：镜像照常更新，但不产生任何学习反馈/规则。
seedInboxBookmark('sup1', 'suppressed.test');
const beforeSuppress = await helpers.getRecommendationLearningState();
hooks.setSuppressed(60 * 1000);
await hooks.handleSingleBookmarkMoved('sup1', nativeBookmarks.get('sup1'), { parentId: 'folder-ml' });
let afterSuppress = await helpers.getRecommendationLearningState();
assert.equal(afterSuppress.recentFeedback.length, beforeSuppress.recentFeedback.length,
  'suppressed bulk moves must not create learning feedback');
assert.equal(afterSuppress.rules.length, beforeSuppress.rules.length,
  'suppressed bulk moves must not learn rules');
assert.equal(mirroredBookmarks.find(item => item.id === 'sup1').folderPath, '技术/机器学习',
  'mirror must still be updated during suppression');

// 7b. 恢复后：同样路径的手工移动正常学习。
hooks.clearSuppressed();
seedInboxBookmark('sup2', 'resumed.test');
await hooks.handleSingleBookmarkMoved('sup2', nativeBookmarks.get('sup2'), { parentId: 'folder-ml' });
afterSuppress = await helpers.getRecommendationLearningState();
assert.ok(afterSuppress.rules.some(rule => rule.kind === 'domain_folder' && rule.pattern === 'resumed.test'),
  'manual moves must resume learning after the suppression window ends');

// 7c. 单条程序性标记（如“应用建议”触发的移动）同样不学习。
seedInboxBookmark('sup3', 'programmatic.test');
hooks.markProgrammaticMove('sup3', 'folder-ml');
await hooks.handleSingleBookmarkMoved('sup3', nativeBookmarks.get('sup3'), { parentId: 'folder-ml' });
afterSuppress = await helpers.getRecommendationLearningState();
assert.ok(!afterSuppress.rules.some(rule => rule.pattern === 'programmatic.test'),
  'programmatically marked moves must not be learned as manual filing');

// ── 8. 源码契约 ──
const moveSource = source.slice(moveStart, moveEnd);
assert.match(moveSource, /submitRecommendationFeedback\(/, 'manual moves must submit feedback directly');
assert.doesNotMatch(moveSource, /enqueueRecommendationReviewItem\(/,
  'manual moves must not enqueue review items anymore');
assert.match(moveSource, /outcome: 'accepted'/, 'manual-move feedback must be accepted');

const settingsSource = readFileSync('src/timeline/pages/settings/settings.js', 'utf8');
assert.match(settingsSource, /staleDiscarded/, 'settings UI must handle staleDiscarded results');
assert.match(settingsSource, /reviewStaleDiscarded/, 'settings UI must use the localized stale message');
assert.match(settingsSource, /recommendationResolveErrorText/, 'settings UI must map error codes to friendly text');
assert.match(settingsSource, /review_item_not_found/, 'review_item_not_found must be mapped to a friendly message');

const i18nSource = readFileSync('src/timeline/shared/i18n.js', 'utf8');
assert.match(i18nSource, /reviewStaleDiscarded: "Bookmark changed/, 'en dictionary must define reviewStaleDiscarded');
assert.match(i18nSource, /reviewStaleDiscarded: "书签已变动/, 'zh_CN dictionary must define reviewStaleDiscarded');
assert.match(i18nSource, /reviewItemMissing: "This item was already resolved/, 'en dictionary must define reviewItemMissing');
assert.match(i18nSource, /reviewItemMissing: "该项已被处理或移除"/, 'zh_CN dictionary must define reviewItemMissing');

// 批量程序性移动抑制契约
const handleSource = source.slice(handleStart, handleEnd);
assert.match(handleSource, /isMoveLearningSuppressed\(\)/,
  'move handling must check the suppression window before learning');
const coreSource = readFileSync('src/core/bookmarks.ts', 'utf8');
for (const entry of ['applyToBookmarks', 'applyPartialToBookmarks', 'undoApply', 'undoLatestApply']) {
  assert.match(coreSource, new RegExp(`async function ${entry}Internal\\(`), `${entry} must have an internal implementation`);
  assert.match(coreSource, new RegExp(`export async function ${entry}\\(`), `${entry} must stay exported`);
  const wrapperPattern = new RegExp(
    `export async function ${entry}\\([\\s\\S]*?await pauseMoveLearning\\(\\);[\\s\\S]*?try \\{[\\s\\S]*?return await ${entry}Internal\\([\\s\\S]*?\\} finally \\{[\\s\\S]*?await resumeMoveLearning\\(\\);`,
  );
  assert.match(coreSource, wrapperPattern, `${entry} wrapper must pause/resume move learning with finally-resume`);
}
assert.match(source, /case 'setMoveLearningSuppression'/, 'background must expose the suppression message');
assert.match(source, /case 'markProgrammaticMove'/, 'background must expose the single programmatic-move message');
assert.match(source, /MOVE_LEARNING_SUPPRESSION_MAX_MS = 10 \* 60 \* 1000/,
  'suppression window must have a hard cap');
const settingsSource2 = readFileSync('src/timeline/pages/settings/settings.js', 'utf8');
assert.match(settingsSource2, /action: 'markProgrammaticMove'/,
  'reevaluation applies must mark their move as programmatic to avoid double learning');

console.log('active learning autolearn tests passed');
