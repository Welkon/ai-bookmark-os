import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// 移动学习抑制窗口与 onMoved 串行队列的竞态回归。
//
// 背景：手工移动书签会直接产生 accepted 学习反馈（domain→folder 自动学习）。
// 批量程序性移动（分类应用/撤销）通过"抑制窗口"排除在学习之外：
//   pauseMoveLearning() → 数百次 chrome.bookmarks.move() → resumeMoveLearning()
//
// 风险点：onMoved 事件不是同步处理的，而是被追加到 bookmarkMoveUpdateQueue 串行队列。
// 抑制状态在任务**出队执行时**读取，而不是事件**入队时**。批量应用产生的事件量远大于
// 队列消费速度（每条要 bookmarks.get + 全树 loadBookmarkFolderOptions + 镜像写入），
// 因此 resumeMoveLearning() 往往在队列尚未排空时就已执行，积压事件会以"未抑制"状态
// 出队，把分类器自己的输出误学成用户手工归档意图。
//
// 本测试走真实的 onMoved 监听器路径（而非直接调用 handleSingleBookmarkMoved），
// 这样才能覆盖"入队 → 抑制解除 → 出队"这一真实时序。

const source = readFileSync('src/timeline/background/background.js', 'utf8');

function sliceBetween(startMarker, endMarker) {
  const startIndex = source.indexOf(startMarker);
  assert.ok(startIndex >= 0, `未找到起点标记：${startMarker}`);
  const endIndex = source.indexOf(endMarker, startIndex);
  assert.ok(endIndex > startIndex, `未找到终点标记：${endMarker}`);
  return source.slice(startIndex, endIndex);
}

const recommendationHelpers = sliceBetween('function stableRecommendationId(', 'function normalizeLegacyDynamicRules(');
const moveObservation = sliceBetween('async function queueBookmarkMoveObservation(', 'async function reevaluateBookmarkRecommendations(');
const moveHandlers = sliceBetween('let bookmarkMoveUpdateQueue = Promise.resolve();', '// 从被删节点收集其下所有含 url 的书签');

const storage = new Map();
const storageQueues = new Map();
const operationResults = new Map();
const operationInflight = new Map();
const nativeBookmarks = new Map();
let mirroredBookmarks = [];

// 控制 loadBookmarkFolderOptions 的完成时机，用来稳定复现"队列积压"。
let folderOptionsGate = null;
function openFolderOptionsGate() {
  const previous = folderOptionsGate;
  folderOptionsGate = null;
  previous?.release();
}
function closeFolderOptionsGate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  folderOptionsGate = { promise, release };
}

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

const movedListeners = [];
const changedListeners = [];

const chrome = {
  runtime: { sendMessage: async () => ({ success: true }) },
  storage: {
    local: {
      async get(keys) {
        const names = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(names.filter((key) => storage.has(key)).map((key) => [key, storage.get(key)]));
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
    async getSubTree() { return []; },
    onMoved: { addListener: (fn) => movedListeners.push(fn) },
    onChanged: { addListener: (fn) => changedListeners.push(fn) },
  },
};

const normalizeTagList = (values) => [...new Map((values || [])
  .map((value) => String(typeof value === 'string' ? value : value?.tag || '').trim())
  .filter(Boolean)
  .map((value) => [value.toLowerCase(), value])).values()];
const normalizeBookmarkFolderPath = (value) => String(value || '')
  .replace(/\\/g, '/')
  .split('/')
  .map((part) => part.trim())
  .filter(Boolean)
  .join('/');

// 可控时钟：用于复现"队列积压时长超过程序性移动标记 TTL"的场景。
let clockOffsetMs = 0;
function advanceClock(ms) { clockOffsetMs += ms; }
const RealDate = Date;
class ClockDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + clockOffsetMs);
    else super(...args);
  }
  static now() { return RealDate.now() + clockOffsetMs; }
}

const context = {
  Array, Date: ClockDate, JSON, Map, Math, Number, Object, Promise, Set, String, URL,
  chrome,
  crypto: globalThis.crypto,
  extractDomain: (url) => {
    try { return new URL(url).hostname; } catch { return ''; }
  },
  getStoredBookmarks: async () => mirroredBookmarks.map((item) => ({ ...item, tags: [...(item.tags || [])] })),
  loadBookmarkFolderOptions: async () => {
    if (folderOptionsGate) await folderOptionsGate.promise;
    return folderOptions.map((item) => ({ ...item }));
  },
  mutateStoredBookmarks: async (mutation) => {
    mirroredBookmarks = await mutation(mirroredBookmarks);
    return mirroredBookmarks;
  },
  mutateStorageResource,
  normalizeBookmarkFolderPath,
  normalizeTagList,
  isBrowserBookmarkRoot: () => false,
  programmaticBookmarkMoves: new Map(),
  updateBookmark: async () => {},
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
${recommendationHelpers}
${moveObservation}
${moveHandlers}
this.raceHooks = {
  suppress: (ms) => { moveLearningSuppressedUntil = Date.now() + ms; },
  release: () => { moveLearningSuppressedUntil = 0; },
  isSuppressed: () => isMoveLearningSuppressed(),
  drainQueue: () => bookmarkMoveUpdateQueue,
  markProgrammaticMove: markProgrammaticBookmarkMove,
};
this.autolearn = {
  emptyRecommendationStore,
  getRecommendationLearningState,
};
`, context);

const hooks = context.raceHooks;
const helpers = context.autolearn;
storage.set(context.RECOMMENDATION_STORE_KEY, helpers.emptyRecommendationStore());

assert.equal(movedListeners.length, 1, 'background 必须注册 onMoved 监听器');
const fireMoved = (id, parentId) => movedListeners[0](id, { parentId });

nativeBookmarks.set('folder-ml', { id: 'folder-ml', title: '机器学习', parentId: '0' });
nativeBookmarks.set('folder-source', { id: 'folder-source', title: 'Inbox', parentId: '0' });

function seedBookmark(id, domain) {
  nativeBookmarks.set(id, { id, title: id, url: `https://${domain}/${id}`, parentId: 'folder-source' });
  mirroredBookmarks.push({
    id, title: id, url: `https://${domain}/${id}`, domain,
    parentId: 'folder-source', folderPath: 'Inbox', tags: [],
  });
}

// 等待串行队列彻底排空（队列在处理过程中会不断把自身向后延长）。
async function drainMoveQueue() {
  for (let i = 0; i < 200; i++) {
    const current = hooks.drainQueue();
    await current;
    if (hooks.drainQueue() === current) return;
  }
  assert.fail('移动事件队列未能排空');
}

// ── 批量程序性移动：抑制期间入队的事件，即使在抑制解除后才出队，也不得产生学习 ──
//
// 真实时序：applyToBookmarks 先 pause，随后大量 move 触发 onMoved 全部入队；
// 队列消费慢（每条都要读全树目录），apply 结束时 finally 里 resume，
// 此时队列仍有积压 —— 这些事件必须仍被视为"程序性移动"。
closeFolderOptionsGate();
hooks.suppress(60 * 1000);

const bulkIds = ['bulk1', 'bulk2', 'bulk3'];
for (const [index, id] of bulkIds.entries()) {
  seedBookmark(id, `bulk-apply-${index}.test`);
  fireMoved(id, 'folder-ml');
}

// 事件已入队但尚未处理完（目录读取被闸门挡住）——此刻 apply 结束并解除抑制。
hooks.release();
assert.equal(hooks.isSuppressed(), false, '抑制窗口已解除');

openFolderOptionsGate();
await drainMoveQueue();

const afterBulk = await helpers.getRecommendationLearningState();
const leakedRules = afterBulk.rules.filter((rule) => String(rule.pattern || '').startsWith('bulk-apply-'));
assert.equal(
  leakedRules.length,
  0,
  `抑制期间入队的程序性移动，即使在抑制解除后才出队，也不得学成 domain→folder 规则；`
  + `实际泄漏：${leakedRules.map((rule) => rule.pattern).join(', ')}`,
);
assert.equal(
  afterBulk.recentFeedback.length,
  0,
  '抑制期间入队的程序性移动不得产生任何学习反馈',
);

// 镜像仍必须更新：抑制只影响学习，不影响数据同步。
for (const id of bulkIds) {
  assert.equal(
    mirroredBookmarks.find((item) => item.id === id)?.folderPath,
    '技术/机器学习',
    '抑制期间镜像仍需正常更新',
  );
}

// ── 对照：抑制窗口之外的真实手工移动照常学习 ──
seedBookmark('manual1', 'manual-move.test');
fireMoved('manual1', 'folder-ml');
await drainMoveQueue();

const afterManual = await helpers.getRecommendationLearningState();
assert.ok(
  afterManual.rules.some((rule) => rule.kind === 'domain_folder' && rule.pattern === 'manual-move.test'),
  '未被抑制的手工移动必须照常学习 domain→folder 规则',
);

// ── 单条程序性标记：TTL 必须以"事件到达"为基准，而不是"出队处理"为基准 ──
//
// 真实场景：设置页"应用建议"逐条 markProgrammaticMove + bookmarks.move。
// 标记有 30 秒有效期，而 onMoved 事件同样要排在串行队列里等待。若某一条的
// 出队处理晚于标记有效期（大批量应用 + 每条都要读全树目录时完全可能），
// 标记会被判定为过期失效，这条程序性移动就会被误学成用户手工归档。
closeFolderOptionsGate();
seedBookmark('marked1', 'marked-programmatic.test');
hooks.markProgrammaticMove('marked1', 'folder-ml');
fireMoved('marked1', 'folder-ml');

// 事件已入队但被闸门挡住；此时超过标记的 30 秒有效期才放行。
advanceClock(31 * 1000);
openFolderOptionsGate();
await drainMoveQueue();

const afterMarked = await helpers.getRecommendationLearningState();
assert.equal(
  afterMarked.rules.filter((rule) => String(rule.pattern || '') === 'marked-programmatic.test').length,
  0,
  '程序性标记的移动即使出队晚于标记有效期，也不得被误学成手工归档',
);

console.log('移动学习抑制与事件队列竞态: OK');
