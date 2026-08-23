import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// 第四轮审计修复的回归测试。每一节对应一个已实测复现的缺陷：
//  §1 escapeHtml 不转义引号 → 订阅源内容可闭合 HTML 属性注入事件处理器（XSS，扩展 origin）
//  §2 decodeEntities 对越界数字实体抛 RangeError → 单个字符让订阅源永久拉取失败
//  §3 自闭合 <atom:link .../> 被当成开标签 → siteUrl / 条目链接变成垃圾串
//  §4 collectLinks 缺命名空间前缀容忍 → 带前缀的 Atom 所有链接为空
//  §5 命名空间同名标签（<itunes:title>）劫持正文字段
//  §6 upsertItems 截断不保护星标/已建书签条目 → 用户状态被静默删除
//  §7 clearAILogs 绕过写入队列 → 清空后旧日志复活
//  §8 _isPrivateOrLocalHost 用 startsWith('fc'/'fd') → 误伤公网域名
//  §9 fetchAndInit 不校验条目数 → 订阅普通网页"成功"后每轮报错
//  §10 etag 先落库、items 后落库 → 中途失败导致 304 永久锁死
//  §11 removeFeed 先删索引后删分片 → 失败时留下无法回收的孤儿分片
//  §12 discoverInTab 吞掉权限错误 → 权限缺失与"没有源"无法区分

function loadIife(path, extraContext = {}) {
  const context = {
    Array, Date, JSON, Map, Math, Number, Object, Promise, Set, String, URL,
    AbortController, clearTimeout, setTimeout, structuredClone,
    console: { info() {}, warn() {}, error() {} },
    ...extraContext,
  };
  context.self = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(path, 'utf8'), context);
  return context;
}

// ── §1 escapeHtml 必须转义引号（属性上下文安全） ──
// 这些实现都用 textContent→innerHTML，只转义 & < >。它们被用在 <img src="${esc(x)}">
// 这类属性上下文，外部内容里的裸引号会闭合属性并注入 onerror。
const ATTRIBUTE_CONTEXT_ESCAPERS = [
  'src/timeline/pages/standalone/standalone.js',
  'src/timeline/pages/popup/popup.js',
  'src/timeline/pages/settings/settings.js',
  'src/timeline/pages/checker/checker.js',
  'src/timeline/pages/standalone/mdi-manager.js',
];

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `未找到函数 ${name}`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`函数 ${name} 缺少闭合括号`);
}

for (const path of ATTRIBUTE_CONTEXT_ESCAPERS) {
  const fnSource = extractFunction(readFileSync(path, 'utf8'), 'escapeHtml');
  // 用最小 DOM stub 复刻 textContent→innerHTML 的真实语义（只转义 & < >）。
  const context = {
    String,
    document: {
      createElement: () => ({
        _text: '',
        set textContent(value) { this._text = value == null ? '' : String(value); },
        get textContent() { return this._text; },
        get innerHTML() {
          return this._text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        },
      }),
    },
  };
  vm.createContext(context);
  vm.runInContext(`${fnSource}; this.escapeHtml = escapeHtml;`, context);

  const escaped = context.escapeHtml('https://a/i.jpg" onerror="alert(1)');
  assert.ok(!escaped.includes('"'), `${path}: escapeHtml 必须转义双引号，否则可闭合 HTML 属性`);
  assert.ok(escaped.includes('&quot;'), `${path}: 双引号应转义为 &quot;`);
  const single = context.escapeHtml("a' onerror='alert(1)");
  assert.ok(!single.includes("'"), `${path}: escapeHtml 必须转义单引号（属性也可能用单引号包裹）`);
  // 基本转义不得回退
  assert.equal(context.escapeHtml('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;', `${path}: 原有 & < > 转义必须保留`);
}

// ── §2~§5 RSS 解析器 ──
const parser = loadIife('src/timeline/shared/rss-parser.js').RssParser;

const wrapRss = (channelInner, itemInner = '<title>I</title><link>https://x/i</link>') =>
  `<rss><channel>${channelInner}<item>${itemInner}</item></channel></rss>`;

// §2 越界数字实体不得让整篇 feed 解析抛错
for (const entity of ['&#1114112;', '&#x110000;', '&#99999999;']) {
  const parsed = parser.parseFeed(wrapRss(`<title>T${entity}</title>`), 'application/xml');
  assert.ok(parsed, `越界实体 ${entity} 不得让解析返回 null`);
  assert.equal(parsed.items.length, 1, `越界实体 ${entity} 不得丢失条目`);
  assert.equal(parsed.title, 'T', `越界实体 ${entity} 应被丢弃而非抛错`);
}
// 合法增补平面字符仍须正确解码（fromCodePoint 的既有能力不得回退）
assert.equal(
  parser.parseFeed(wrapRss('<title>T&#128512;</title>'), 'application/xml').title,
  'T\u{1F600}',
  '合法增补平面字符（emoji）必须仍能正确解码',
);

// §3 自闭合 <atom:link .../> 不得吞并后面的 <link>
const selfClosing = parser.parseFeed(
  wrapRss(
    '<title>C</title><atom:link rel="self" href="https://ex.com/feed"/><link>https://ex.com/site</link>',
    '<title>P</title><atom:link rel="self" href="https://ex.com/a.xml"/><link>https://ex.com/a</link>',
  ),
  'application/xml',
);
assert.equal(selfClosing.siteUrl, 'https://ex.com/site', '自闭合 atom:link 不得吞并 channel 的 <link> 正文');
assert.equal(selfClosing.items[0].link, 'https://ex.com/a', '自闭合 atom:link 不得吞并条目的 <link> 正文');

// §4 带命名空间前缀的 Atom：siteUrl 与条目 link 都必须解析出来
const nsAtom = parser.parseFeed(
  '<atom:feed><atom:title>NS</atom:title><atom:link rel="alternate" href="https://x/site"/>'
  + '<atom:entry><atom:title>E</atom:title><atom:link rel="alternate" href="https://x/1"/>'
  + '<atom:id>id1</atom:id></atom:entry></atom:feed>',
  'application/atom+xml',
);
assert.equal(nsAtom.items.length, 1, '带前缀的 Atom 必须解析出条目');
assert.equal(nsAtom.siteUrl, 'https://x/site', '带前缀的 Atom 必须解析出 siteUrl');
assert.equal(nsAtom.items[0].link, 'https://x/1', '带前缀的 Atom 条目必须有可点击链接');

// §5 命名空间同名标签不得劫持无前缀标签
const hijack = parser.parseFeed(
  wrapRss(
    '<itunes:title>WRONG</itunes:title><title>RIGHT</title>',
    '<itunes:title>BADITEM</itunes:title><title>GOODITEM</title><link>https://x/ok</link>',
  ),
  'application/xml',
);
assert.equal(hijack.title, 'RIGHT', '<itunes:title> 不得劫持 channel 的 <title>');
assert.equal(hijack.items[0].title, 'GOODITEM', '<itunes:title> 不得劫持条目的 <title>');

// 三种主流格式的基本解析不得回归
const rss2 = parser.parseFeed(
  '<rss><channel><title>R2</title><link>https://r2/</link>'
  + '<item><title>A</title><link>https://r2/1</link><guid>g1</guid></item>'
  + '<item><title>B</title><link>https://r2/2</link><guid>g2</guid></item></channel></rss>',
  'application/xml',
);
assert.equal(rss2.title, 'R2');
assert.equal(rss2.items.length, 2);
assert.equal(rss2.items[0].link, 'https://r2/1');

const atom = parser.parseFeed(
  '<feed><title>AT</title><link rel="alternate" href="https://at/"/>'
  + '<entry><title>E1</title><link rel="alternate" href="https://at/1"/><id>a1</id></entry></feed>',
  'application/atom+xml',
);
assert.equal(atom.items.length, 1);
assert.equal(atom.items[0].link, 'https://at/1');
assert.equal(atom.siteUrl, 'https://at/');

const rdf = parser.parseFeed(
  '<rdf:RDF><channel><title>RDF</title><link>https://rdf/</link></channel>'
  + '<item><title>R1</title><link>https://rdf/1</link></item>'
  + '<item><title>R2</title><link>https://rdf/2</link></item></rdf:RDF>',
  'application/xml',
);
assert.equal(rdf.title, 'RDF');
assert.equal(rdf.items.length, 2, 'RDF 兜底解析不得回归');

// ── §6 / §11 feed-store ──
function createFeedStore(initial = {}, hooks = {}) {
  const values = new Map(Object.entries(structuredClone(initial)));
  const storage = {
    values,
    async get(keys) {
      if (keys == null) return Object.fromEntries(values);
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.filter((k) => values.has(k)).map((k) => [k, structuredClone(values.get(k))]));
    },
    async set(patch) {
      await hooks.beforeSet?.(patch);
      for (const [k, v] of Object.entries(patch)) values.set(k, structuredClone(v));
    },
    async remove(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      await hooks.beforeRemove?.(requested);
      for (const k of requested) values.delete(k);
    },
  };
  const context = loadIife('src/timeline/shared/feed-store.js', {
    chrome: { storage: { local: storage }, runtime: { sendMessage: async () => undefined } },
  });
  return { store: context.FeedStore, storage };
}

// §6 截断时必须保留用户已产生状态的条目（星标 / 已建书签）
{
  const { store, storage } = createFeedStore({
    rss_feeds: [{ id: 'f1', url: 'https://f/1', title: 'f1' }],
    'rss_items_f1': [
      { id: 'i-star', feedId: 'f1', guid: 'g-star', title: '旧-已加星', publishedAt: 1000, fetchedAt: 1000, starred: true, bookmarkId: null },
      { id: 'i-bm', feedId: 'f1', guid: 'g-bm', title: '旧-已建书签', publishedAt: 900, fetchedAt: 900, starred: false, bookmarkId: 'bk1' },
      { id: 'i-plain', feedId: 'f1', guid: 'g-plain', title: '旧-普通', publishedAt: 800, fetchedAt: 800, starred: false, bookmarkId: null },
    ],
  });
  const added = await store.upsertItems('f1', [
    { guid: 'g-new1', title: '新1', publishedAt: 9000 },
    { guid: 'g-new2', title: '新2', publishedAt: 8000 },
  ], 3);
  const items = storage.values.get('rss_items_f1');
  assert.equal(items.length, 3, '截断上限必须生效');
  assert.ok(items.some((i) => i.id === 'i-star'), '星标条目不得被截断静默删除');
  assert.ok(items.some((i) => i.id === 'i-bm'), '已建书签的条目不得被截断静默删除');
  assert.ok(!items.some((i) => i.id === 'i-plain'), '无用户状态的旧条目应让位给新条目');
  // added 只能包含真正落库的条目
  const addedIds = new Set(added.map((i) => i.guid));
  for (const item of added) {
    assert.ok(items.some((i) => i.id === item.id), `added 中的 ${item.guid} 必须真的落库`);
  }
  assert.ok(addedIds.has('g-new1'), '最新条目应作为新增返回');
}

// §6 对照：没有受保护条目时，截断行为与原来一致（纯时间序）
{
  const { store, storage } = createFeedStore({
    rss_feeds: [{ id: 'f2', url: 'https://f/2', title: 'f2' }],
    'rss_items_f2': [
      { id: 'c1', feedId: 'f2', guid: 'c1', title: 'c1', publishedAt: 100, fetchedAt: 100, starred: false, bookmarkId: null },
      { id: 'c2', feedId: 'f2', guid: 'c2', title: 'c2', publishedAt: 200, fetchedAt: 200, starred: false, bookmarkId: null },
      { id: 'c3', feedId: 'f2', guid: 'c3', title: 'c3', publishedAt: 300, fetchedAt: 300, starred: false, bookmarkId: null },
    ],
  });
  await store.upsertItems('f2', [{ guid: 'c4', title: 'c4', publishedAt: 400 }], 3);
  const titles = storage.values.get('rss_items_f2').map((i) => i.title);
  assert.deepEqual([...titles], ['c4', 'c3', 'c2'], '无受保护条目时应保持纯时间序截断');
}

// §11 removeFeed：分片删除失败时不得留下无法回收的孤儿分片
{
  const { store, storage } = createFeedStore({
    rss_feeds: [{ id: 'f3', url: 'https://f/3', title: 'f3' }, { id: 'keep', url: 'https://f/k', title: 'keep' }],
    'rss_items_f3': [{ id: 'x', feedId: 'f3', guid: 'x' }],
  }, {
    beforeRemove: (keys) => {
      if (keys.includes('rss_items_f3')) throw new Error('storage_remove_failed');
    },
  });
  const result = await store.removeFeed('f3').catch((error) => ({ success: false, error: error.message }));
  assert.equal(result.success, false, '分片删除失败必须如实上报，不能假装成功');
  const feeds = storage.values.get('rss_feeds');
  assert.ok(feeds.some((f) => f.id === 'f3'), '分片删除失败时索引必须保留，避免孤儿分片永久泄漏');
  assert.ok(feeds.some((f) => f.id === 'keep'), '其他订阅源不受影响');
}

// §11 对照：正常删除必须同时清掉索引与分片
{
  const { store, storage } = createFeedStore({
    rss_feeds: [{ id: 'f4', url: 'https://f/4', title: 'f4' }],
    'rss_items_f4': [{ id: 'y', feedId: 'f4', guid: 'y' }],
  });
  const result = await store.removeFeed('f4');
  assert.equal(result.success, true);
  assert.equal(storage.values.has('rss_items_f4'), false, '正常删除必须清掉条目分片');
  assert.deepEqual([...storage.values.get('rss_feeds')], [], '正常删除必须清掉索引项');
}

// ── §7 ai-logger：clearAILogs 必须走同一条写入队列 ──
{
  const values = new Map();
  let releaseSet;
  const setGate = new Promise((resolve) => { releaseSet = resolve; });
  let gateArmed = true;
  const context = {
    Date, Math, Object, Promise, String, Number, Array, JSON,
    console: { warn() {}, error() {} },
    chrome: {
      runtime: { sendMessage: async () => undefined },
      storage: {
        local: {
          async get(key) { return values.has(key) ? { [key]: values.get(key) } : {}; },
          async set(patch) {
            if (gateArmed) { gateArmed = false; await setGate; }
            for (const [k, v] of Object.entries(patch)) values.set(k, v);
          },
          async remove(key) { values.delete(key); },
        },
      },
    },
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(readFileSync('src/timeline/shared/ai-logger.js', 'utf8'), context);
  vm.runInContext('this.api = { logAIEvent, clearAILogs, getAILogs };', context);

  values.set('ai_classifier_logs', Array.from({ length: 3 }, (_, i) => ({ id: `old${i}`, type: 'trigger' })));
  // 一次写入卡在 set 上（已读到 3 条旧日志），此刻用户点"清空"
  const writing = context.api.logAIEvent({ type: 'trigger' });
  const clearing = context.api.clearAILogs();
  releaseSet();
  await Promise.all([writing, clearing]);
  assert.deepEqual([...(values.get('ai_classifier_logs') ?? [])], [], '清空必须排在在飞写入之后，旧日志不得复活');

  // 清空后新日志照常写入
  await context.api.logAIEvent({ type: 'classify_success' });
  assert.deepEqual([...(values.get('ai_classifier_logs') || [])].map((l) => l.type), ['classify_success']);
}

// ── §8~§10 feed-fetcher ──
function createFetcher(options = {}) {
  const values = new Map(Object.entries(structuredClone(options.initial || {})));
  const storage = {
    values,
    async get(keys) {
      if (keys == null) return Object.fromEntries(values);
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.filter((k) => values.has(k)).map((k) => [k, structuredClone(values.get(k))]));
    },
    async set(patch) { for (const [k, v] of Object.entries(patch)) values.set(k, structuredClone(v)); },
    async remove(keys) {
      for (const k of (Array.isArray(keys) ? keys : [keys])) values.delete(k);
    },
  };
  const context = {
    Array, Date, JSON, Map, Math, Number, Object, Promise, Set, String, URL,
    AbortController, clearTimeout, setTimeout, structuredClone,
    console: { info() {}, warn() {}, error() {} },
    fetch: options.fetch || (async () => { throw new Error('offline'); }),
    chrome: {
      storage: { local: storage },
      runtime: { sendMessage: async () => undefined },
      alarms: { create: async () => undefined, clear: async () => true },
    },
    RssParser: options.rssParser || parser,
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(readFileSync('src/timeline/shared/feed-store.js', 'utf8'), context);
  vm.runInContext(readFileSync('src/timeline/background/feed-fetcher.js', 'utf8'), context);
  return { context, storage };
}

// §8 源码契约：IPv6 ULA/链路本地的前缀判断必须限定在 IPv6 字面量内。
// fc00::/7 与 fe80::/10 的前缀匹配一旦作用于任意主机名，就会误伤 fcbarcelona.com /
// fdroid.org / fc2.com 这类公网域名。真正的语义由下一节的行为级断言守护，
// 这里只锁住"前缀判断被 IPv6 守卫包裹"这一结构，防止守卫在后续重构中被去掉。
{
  const source = readFileSync('src/timeline/background/feed-fetcher.js', 'utf8');
  const fnSource = extractFunction(source, '_isPrivateOrLocalHost');
  const guardIndex = fnSource.indexOf("host.includes(':')");
  assert.ok(guardIndex >= 0, 'IPv6 ULA 前缀判断必须置于 IPv6 字面量守卫（host 含冒号）之内');
  for (const prefix of ['fc', 'fd', 'fe80:']) {
    const at = fnSource.indexOf(`host.startsWith('${prefix}')`);
    assert.ok(at > guardIndex, `${prefix} 前缀判断必须位于 IPv6 守卫之后，不得对任意主机名生效`);
  }
}

// §8 行为级：私有/公网判定的实际结果
{
  const source = readFileSync('src/timeline/background/feed-fetcher.js', 'utf8');
  const fnSource = extractFunction(source, '_isPrivateOrLocalHost');
  const ctx = { String, Number };
  vm.createContext(ctx);
  vm.runInContext(`${fnSource}; this.isPrivate = _isPrivateOrLocalHost;`, ctx);

  for (const host of ['fcbarcelona.com', 'fdroid.org', 'fc2.com', 'fedoraproject.org', 'fdn.fr', 'example.com', '1.1.1.1', '172.15.0.1', '172.32.0.1']) {
    assert.equal(ctx.isPrivate(host), false, `${host} 是公网地址，不得判为私有`);
  }
  for (const host of ['localhost', 'a.localhost', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', '127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '169.254.1.1', '0.0.0.0']) {
    assert.equal(ctx.isPrivate(host), true, `${host} 是私有/本地地址，必须拦截`);
  }
}

// §9 订阅普通网页必须失败（而不是"成功"后每轮报 empty_feed）
{
  const htmlPage = '<html><head><title>Just A Web Page</title></head><body>hi</body></html>';
  const { context } = createFetcher({
    fetch: async () => ({
      ok: true,
      status: 200,
      url: 'https://site/page',
      headers: { get: (name) => (name === 'content-type' ? 'text/html' : null) },
      text: async () => htmlPage,
    }),
  });
  const result = await context.FeedFetcher.fetchAndInit('https://site/page');
  assert.equal(result.success, false, '普通 HTML 页不得被当成有效订阅源接受');
  assert.equal(result.error, 'empty_feed', '应以 empty_feed 明确拒绝');
}

// §9 对照：真正的 feed 仍能订阅成功
{
  const feedXml = '<rss><channel><title>Real</title><link>https://real/</link>'
    + '<item><title>A</title><link>https://real/1</link><guid>g1</guid></item></channel></rss>';
  const { context } = createFetcher({
    fetch: async () => ({
      ok: true,
      status: 200,
      url: 'https://real/feed',
      headers: { get: (name) => (name === 'content-type' ? 'application/rss+xml' : null) },
      text: async () => feedXml,
    }),
  });
  const result = await context.FeedFetcher.fetchAndInit('https://real/feed');
  assert.equal(result.success, true, '真实 feed 必须能订阅成功');
  assert.equal(result.itemCount, 1);
}

// §10 items 必须先落库再提交 etag（否则 upsertItems 失败会导致 304 永久锁死）
{
  const source = readFileSync('src/timeline/background/feed-fetcher.js', 'utf8');
  const fetchOne = source.slice(source.indexOf('async function fetchOne('), source.indexOf('async function pollAll('));
  const upsertAt = fetchOne.indexOf('upsertItems(feed.id, parsed.items');
  const updateAt = fetchOne.indexOf('updateFeed(feed.id, patch)');
  assert.ok(upsertAt > 0 && updateAt > 0, 'fetchOne 的直连成功分支必须同时写条目与元信息');
  assert.ok(
    upsertAt < updateAt,
    'upsertItems 必须早于 updateFeed(patch)：反序会留下"已记 etag 但条目没落库"的半写状态，下一轮 304 直接返回成功，这批文章永远丢失',
  );
}

// §10 行为级：upsertItems 失败时不得提交 etag
{
  const feedXml = '<rss><channel><title>F</title><link>https://f/</link>'
    + '<item><title>A</title><link>https://f/1</link><guid>g1</guid></item></channel></rss>';
  const { context, storage } = createFetcher({
    initial: {
      rss_feeds: [{ id: 'f1', url: 'https://f/feed', title: 'F', failCount: 0, lastFetched: 0, favicon: 'x' }],
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      url: 'https://f/feed',
      headers: { get: (name) => (name === 'etag' ? 'W/"abc"' : name === 'content-type' ? 'application/rss+xml' : null) },
      text: async () => feedXml,
    }),
  });
  // 让条目写入失败
  const originalUpsert = context.FeedStore.upsertItems;
  context.FeedStore.upsertItems = async () => { throw new Error('storage_write_failed'); };
  const [targetFeed] = await context.FeedStore.getAllFeeds();
  await context.FeedFetcher.fetchOne(targetFeed);
  context.FeedStore.upsertItems = originalUpsert;

  const feed = storage.values.get('rss_feeds')[0];
  assert.ok(!feed.etag, '条目写入失败时不得持久化 etag，否则下一轮 304 会永久跳过这批文章');
  assert.equal(feed.lastStatus, 'failed', '条目写入失败必须记为失败状态');
}

// ── §12 discoverInTab 必须区分权限缺失与"没有源" ──
{
  const context = loadIife('src/timeline/background/feed-discover.js', {
    chrome: {
      tabs: { get: async () => ({ url: 'https://site/page' }) },
      scripting: {
        executeScript: async () => { throw new Error('Cannot access contents of the page at "https://site/page". Extension manifest must request permission to access this host.'); },
      },
    },
  });
  await assert.rejects(
    () => context.FeedDiscover.discoverInTab(1),
    /rss_discover_permission_denied/,
    '权限缺失必须上抛可识别错误，不能吞成"未发现订阅源"',
  );
}

// §12 对照：真正没有源时仍返回空数组（不得变成报错）
{
  const context = loadIife('src/timeline/background/feed-discover.js', {
    chrome: {
      tabs: { get: async () => ({ url: 'https://site/page' }) },
      scripting: { executeScript: async () => [{ result: [] }] },
    },
  });
  assert.deepEqual([...await context.FeedDiscover.discoverInTab(1)], [], '页面确实没有订阅源时应返回空数组');
}

// §12 对照：不可注入的页面（chrome:// 等）仍静默返回空数组
{
  const context = loadIife('src/timeline/background/feed-discover.js', {
    chrome: {
      tabs: { get: async () => ({ url: 'chrome://extensions' }) },
      scripting: { executeScript: async () => { throw new Error('should not be called'); } },
    },
  });
  assert.deepEqual([...await context.FeedDiscover.discoverInTab(1)], [], '不可注入页面应静默返回空数组');
}

// ── §13 pollAll 必须 await onFeedPollComplete（异步回调） ──
// 回调是 async 函数：不 await 时同步 try 抓不到它返回的 rejected promise，
// 内部 storage 读失败会变成 unhandled rejection，且回调后半段的 badge 更新不再执行。
{
  const { context } = createFetcher({
    initial: {
      rss_feeds: [{ id: 'p1', url: 'https://p/feed', title: 'P', failCount: 0, lastFetched: 0, favicon: 'x' }],
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      url: 'https://p/feed',
      headers: { get: (name) => (name === 'content-type' ? 'application/rss+xml' : null) },
      text: async () => '<rss><channel><title>P</title>'
        + '<item><title>A</title><link>https://p/1</link><guid>pg1</guid></item></channel></rss>',
    }),
  });

  // 回调在 await 之后才置位：只有 pollAll 真正等待回调完成，返回时才能观察到 true。
  let notifierFinished = false;
  context.onFeedPollComplete = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    notifierFinished = true;
  };
  await context.FeedFetcher.pollAll();
  assert.equal(
    notifierFinished,
    true,
    'pollAll 必须 await onFeedPollComplete：否则回调内的 badge 更新等后续步骤会在拉取返回后才执行（失败时更会静默丢失）',
  );
}

// §13 对照：回调抛错必须被 pollAll 吞掉，不能让拉取流程失败
{
  const { context } = createFetcher({
    initial: {
      rss_feeds: [{ id: 'p2', url: 'https://p/feed2', title: 'P2', failCount: 0, lastFetched: 0, favicon: 'x' }],
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      url: 'https://p/feed2',
      headers: { get: (name) => (name === 'content-type' ? 'application/rss+xml' : null) },
      text: async () => '<rss><channel><title>P2</title>'
        + '<item><title>B</title><link>https://p/2</link><guid>pg2</guid></item></channel></rss>',
    }),
  });
  context.onFeedPollComplete = async () => { throw new Error('notifier_failed'); };
  const result = await context.FeedFetcher.pollAll();
  assert.equal(result.summary.succeeded, 1, '通知回调失败不得影响拉取结果');
}

console.log('第四轮审计修复回归: OK');
