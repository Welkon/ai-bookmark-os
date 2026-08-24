import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// 第五轮审查修复的回归测试。每一节对应一个已实测复现的缺陷：
//  §1 游标分页：未读过滤下读掉条目后翻页漏条 / 轮询新增条目后翻页重复
//  §2 重渲染塌回第一页：标记已读写 rss_items_* → 本窗口 storage.onChanged → 已翻页数全丢
//  §3 toggleStar 在概览/收藏视图拿不到按钮（data-act 不匹配）→ TypeError 被吞
//  §4 starred 视图“标记全部已读”不扣减未读计数 → 侧栏徽标停在旧数字
//  §5 saveRssSetting 丢弃 { success:false } → 后台校验失败仍提示“已保存”
//  §6 JSON Feed 缺 id/url 的条目无兜底 guid → 被静默丢弃且订阅篇数虚报
//  §7 getEffectiveDomain 对多级公共后缀取到后缀本身（co.uk / com.cn）

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

function createFeedStore(initial = {}) {
  const values = new Map(Object.entries(structuredClone(initial)));
  const storage = {
    values,
    async get(keys) {
      if (keys == null) return Object.fromEntries(values);
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.filter((k) => values.has(k)).map((k) => [k, structuredClone(values.get(k))]));
    },
    async set(patch) {
      for (const [k, v] of Object.entries(patch)) values.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of (Array.isArray(keys) ? keys : [keys])) values.delete(k);
    },
  };
  const context = loadIife('src/timeline/shared/feed-store.js', {
    chrome: { storage: { local: storage }, runtime: { sendMessage: async () => undefined } },
  });
  return { store: context.FeedStore, storage };
}

const FEED = { id: 'f1', url: 'https://f/rss', title: 'F', favicon: '' };
const makeItems = (n) => Array.from({ length: n }, (_, i) => ({
  id: `i${String(i).padStart(3, '0')}`,
  feedId: 'f1',
  guid: `g${i}`,
  title: `T${i}`,
  publishedAt: 100000 - i,
  fetchedAt: 100000 - i,
  read: false,
  starred: false,
  bookmarkId: null,
}));

// ── §1a 未读过滤下读掉条目后翻页：不得漏条 ──
// offset 分页在此处必错：未读数组整体前移 N 位，第二页仍从 offset=50 取，
// 原本位于 (50-N)..49 区间的未读条目被永久跳过。
{
  const { store, storage } = createFeedStore({ rss_feeds: [FEED], 'rss_items_f1': makeItems(120) });
  const first = await store.getItemsPage('f1', { limit: 50, unreadOnly: true });
  assert.equal(first.items.length, 50);
  assert.equal(first.total, 120);

  // 在第一页内读掉 10 篇（模拟用户边读边滚）
  const items = storage.values.get('rss_items_f1');
  for (let i = 0; i < 10; i++) items[i].read = true;
  storage.values.set('rss_items_f1', items);

  const cursor = { sortKey: first.items[49].publishedAt, id: first.items[49].id };
  const second = await store.getItemsPage('f1', { limit: 50, unreadOnly: true, cursor });
  assert.equal(second.items[0].id, 'i050', '游标分页必须严格从上一页最后一条之后继续，不得因未读数组前移而跳过条目');

  const seen = [...first.items, ...second.items].map((i) => i.id);
  assert.equal(new Set(seen).size, seen.length, '不得出现重复条目');
  // 已加载区间内不能有被跳过的未读条目
  const loadedIds = new Set(seen);
  const skipped = items
    .filter((it) => !it.read && it.id <= 'i099')
    .filter((it) => !loadedIds.has(it.id));
  assert.deepEqual([...skipped.map((i) => i.id)], [], '已加载区间内不得有被跳过的未读条目');
}

// ── §1b 翻页期间源新增条目：不得重复渲染 ──
// offset 分页在此处必错：新条目插到数组头部，原 offset 50 的条目下移，
// 第二页取回的是已渲染过的末 N 条。
{
  const { store, storage } = createFeedStore({ rss_feeds: [FEED], 'rss_items_f1': makeItems(120) });
  const first = await store.getItemsPage('f1', { limit: 50 });
  const cursor = { sortKey: first.items[49].publishedAt, id: first.items[49].id };

  // 轮询写入 10 篇更新的文章（排在数组头部）
  const fresh = Array.from({ length: 10 }, (_, i) => ({
    id: `new${i}`, feedId: 'f1', guid: `ng${i}`, title: `N${i}`,
    publishedAt: 200000 + i, fetchedAt: 200000 + i, read: false, starred: false, bookmarkId: null,
  }));
  storage.values.set('rss_items_f1', [...fresh, ...storage.values.get('rss_items_f1')]);

  const second = await store.getItemsPage('f1', { limit: 50, cursor });
  const seen = [...first.items, ...second.items].map((i) => i.id);
  assert.equal(new Set(seen).size, seen.length, '游标分页不得因头部插入新条目而重复回传已渲染条目');
  assert.equal(second.items[0].id, 'i050', '第二页必须紧接第一页末条之后');
  assert.equal(second.total, 130, 'total 必须反映最新总数');
}

// ── §1c 游标条目自身已被读掉：仍能正确定位 ──
// 不能靠 findIndex(id) 定位游标——该条目可能已从未读数组中消失。
{
  const { store, storage } = createFeedStore({ rss_feeds: [FEED], 'rss_items_f1': makeItems(60) });
  const items = storage.values.get('rss_items_f1');
  const anchor = items[49];
  items[49].read = true; // 游标条目自身被读掉
  storage.values.set('rss_items_f1', items);

  const page = await store.getItemsPage('f1', {
    limit: 5,
    unreadOnly: true,
    cursor: { sortKey: anchor.publishedAt, id: anchor.id },
  });
  assert.equal(page.items[0].id, 'i050', '游标条目自身消失时，仍须从其后一条继续');
}

// ── §1d offset 分支保留：兼容首屏与旧调用方 ──
{
  const { store } = createFeedStore({ rss_feeds: [FEED], 'rss_items_f1': makeItems(20) });
  const page = await store.getItemsPage('f1', { offset: 3, limit: 4 });
  assert.deepEqual(page.items.map((i) => i.id), ['i003', 'i004', 'i005', 'i006'], '未传游标时仍按 offset 取');
  assert.equal(page.offset, 3);
}

// ── §1e 排序全序：时间相同时用 id 兜底，游标才能稳定定位 ──
{
  const { store } = createFeedStore({
    rss_feeds: [FEED],
    'rss_items_f1': [
      { id: 'b', feedId: 'f1', guid: 'b', publishedAt: 500, fetchedAt: 500, read: false },
      { id: 'a', feedId: 'f1', guid: 'a', publishedAt: 500, fetchedAt: 500, read: false },
      { id: 'c', feedId: 'f1', guid: 'c', publishedAt: 500, fetchedAt: 500, read: false },
    ],
  });
  const page = await store.getItemsPage('f1', { limit: 10 });
  const order = page.items.map((i) => i.id);
  const again = (await store.getItemsPage('f1', { limit: 10 })).items.map((i) => i.id);
  assert.deepEqual([...order], [...again], '同时间戳条目的相对次序必须稳定（全序），否则游标无法定位');
  // 逐页游标遍历必须覆盖全部条目且不重复
  const collected = [];
  let cursor = null;
  for (let guard = 0; guard < 5; guard++) {
    const p = await store.getItemsPage('f1', { limit: 1, cursor });
    if (p.items.length === 0) break;
    collected.push(p.items[0].id);
    cursor = { sortKey: p.items[0].publishedAt, id: p.items[0].id };
  }
  assert.deepEqual([...collected], [...order], '游标逐页遍历必须完整覆盖且不重复');
}

// ── §2/§3/§4 feed-view 源码契约 ──
{
  const src = readFileSync('src/timeline/pages/standalone/feed-view.js', 'utf8');

  // §2 重渲染保留已加载范围与滚动位置
  assert.match(src, /articleViewKey/, '必须记录分页状态所属视图，才能区分"视图切换"与"同视图重渲染"');
  // 精确断言表达式本身：只检查变量名出现过是不够的（改成常量 0 也能通过），
  // 而"保留已加载条数"的全部语义就在这个三元表达式里。
  assert.match(
    src,
    /const preservedCount = sameView \? articleLoadedCount : 0;/,
    '同视图重渲染必须按已加载条数取回（视图切换时才归零），否则读一篇文章列表就塌回第一页',
  );
  assert.match(
    src,
    /const preservedScrollTop = sameView && previousList \? previousList\.scrollTop : 0;/,
    '同视图重渲染必须恢复原滚动位置',
  );
  assert.match(
    src,
    /Math\.max\(ARTICLE_PAGE_SIZE,\s*preservedCount\)/,
    '重渲染需按已加载条数取回（不足一页则按一页）',
  );

  // §1 前端必须传游标而不是 offset 翻页
  assert.match(src, /articleCursor/, '翻页必须使用游标');
  assert.match(src, /cursor:\s*articleCursor/, '下一页请求必须携带游标');
  // offset 仅作为"游标缺失"时的兜底，必须排在 cursor 之后（游标优先）。
  // 单纯禁止 offset 会误伤这条合法兜底，故断言两者的相对顺序。
  const nextPageCall = src.slice(src.indexOf('async function loadNextArticlePage'));
  const cursorAt = nextPageCall.indexOf('cursor: articleCursor');
  const offsetAt = nextPageCall.indexOf('offset: articleLoadedCount');
  assert.ok(cursorAt >= 0, '下一页请求必须携带游标');
  assert.ok(
    offsetAt < 0 || cursorAt < offsetAt,
    'offset 只能作为无游标时的兜底，游标必须优先——否则数据集变化时会漏条/重复',
  );
  // 去重兜底
  assert.match(src, /renderedArticleIds/, '需保留已渲染 id 集合作为重复渲染的兜底');

  // §3 星标按钮选择器必须覆盖两种卡片形态
  assert.match(
    src,
    /\[data-act="star"\],\s*\[data-act="star-item"\]/,
    '概览/收藏卡片的星标按钮是 star-item，属性选择器为精确匹配，必须同时列出两者',
  );

  // §4 starred 视图标记全部已读必须扣减未读计数
  const markAllStart = src.indexOf('async function markAllRead(');
  const markAllEnd = src.indexOf('async function refreshAll(', markAllStart);
  assert.ok(markAllStart > 0 && markAllEnd > markAllStart);
  const markAll = src.slice(markAllStart, markAllEnd);
  assert.match(
    markAll,
    /feedUnreadCounts\.set\(item\.feedId/,
    'starred 视图跨多源，必须按实际标记成功的条目逐源扣减未读计数',
  );
}

// ── §5 设置页保存失败必须提示失败 ──
{
  const src = readFileSync('src/timeline/pages/settings/settings.js', 'utf8');
  const fnStart = src.indexOf('async function saveRssSetting(');
  const fnEnd = src.indexOf('function rssSettingErrorText(', fnStart);
  assert.ok(fnStart > 0 && fnEnd > fnStart);
  const fn = src.slice(fnStart, fnEnd);
  assert.match(
    fn,
    /result\.success === false/,
    'sendMessage 不会 reject，必须显式检查 success —— 否则后台校验失败仍会提示"已保存"',
  );
  assert.match(fn, /throw new Error/, '失败必须抛出，才能激活调用方（proxyFallback 开关）已有的回滚 catch');
  assert.match(src, /saveRssSettingWithFeedback/, '需有统一的保存反馈助手');
  assert.match(src, /rssProxyTemplateInvalid/, '需把 proxy_template_invalid 映射为可行动文案');

  // 所有 RSS 设置控件都必须走带反馈的保存。只统计传对象字面量的调用点
  // （包装函数 saveRssSettingWithFeedback 内部传的是 patch 变量，不计入）：
  // 唯一允许的裸调用是 proxyFallback 开关，它有自己的回滚 catch。
  const bareCalls = [...src.matchAll(/await saveRssSetting\(\{/g)];
  assert.equal(bareCalls.length, 1, '除 proxyFallback（自带回滚 catch）外，不得有裸调用 saveRssSetting');
  assert.match(
    src,
    /await saveRssSetting\(\{ proxyFallback/,
    '唯一的裸调用必须是 proxyFallback（其 catch 负责回滚开关状态）',
  );

  const i18n = readFileSync('src/timeline/shared/i18n.js', 'utf8');
  assert.match(i18n, /rssProxyTemplateInvalid: "Invalid proxy URL/, 'en 需有该文案');
  assert.match(i18n, /rssProxyTemplateInvalid: "代理地址无效/, 'zh_CN 需有该文案');
}

// ── §6 JSON Feed 缺 id/url 时必须有兜底 guid ──
{
  const parser = loadIife('src/timeline/shared/rss-parser.js').RssParser;
  const json = JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: 'JF',
    items: [
      { title: '文章A', content_text: 'a' },              // 无 id 无 url
      { title: '文章B', content_text: 'b' },              // 无 id 无 url
      { id: 'x3', title: '文章C', url: 'https://f/c' },
    ],
  });
  const parsed = parser.parseFeed(json, 'application/feed+json');
  assert.equal(parsed.items.length, 3);
  const guids = parsed.items.map((i) => i.guid);
  assert.ok(guids.every((g) => !!g), '每个条目都必须有 guid，否则会被 upsertItems 静默丢弃');
  assert.equal(new Set(guids).size, 3, 'guid 必须互不相同');

  // 兜底 guid 必须稳定：否则每轮拉取都判为新文章，重复入库并轰炸通知
  const again = parser.parseFeed(json, 'application/feed+json').items.map((i) => i.guid);
  assert.deepEqual([...guids], [...again], '兜底 guid 必须跨轮稳定');

  // 端到端：全部条目都能落库
  const { store } = createFeedStore({ rss_feeds: [FEED] });
  const added = await store.upsertItems('f1', parsed.items, 0);
  assert.equal(added.length, 3, '有标题的条目都应落库，不得因缺 guid 被丢弃');

  // 订阅提示的篇数必须是真实落库数，而非解析条数
  const bg = readFileSync('src/timeline/background/background.js', 'utf8');
  assert.match(bg, /storedCount/, '订阅成功提示必须报真实落库条数');
}

// ── §7 getEffectiveDomain 需处理多级公共后缀 ──
{
  const src = readFileSync('src/timeline/shared/smart-tagger.js', 'utf8');
  const start = src.indexOf('function getEffectiveDomain(');
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert.ok(start > 0 && end > start);

  // 连同后缀表一起提取
  const suffixStart = src.indexOf('const MULTIPART_PUBLIC_SUFFIXES');
  assert.ok(suffixStart > 0, '需有多级公共后缀表');
  const suffixEnd = src.indexOf(']);', suffixStart) + 3;
  const ctx = { String, Set };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(suffixStart, suffixEnd)}\n${src.slice(start, end)}\nthis.fn = getEffectiveDomain;`, ctx);

  const cases = [
    ['a.b.co.uk', 'b.co.uk'],
    ['a.b.c.com.cn', 'c.com.cn'],
    ['blog.example.co.jp', 'example.co.jp'],
    ['www.github.com', 'github.com'],
    ['github.com', 'github.com'],
    ['a.b.example.com', 'example.com'],
    ['', ''],
    ['localhost', 'localhost'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(ctx.fn(input), expected, `getEffectiveDomain("${input}") 应为 "${expected}"`);
  }
}

console.log('第五轮审查修复回归: OK');
