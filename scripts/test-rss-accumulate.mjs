import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// RSS 累积保留（maxItemsPerFeed = 0）的回归测试。
//
// 需求：订阅源抓到的文章应当累积保留，不再因为新文章到来而删除旧文章。
// 实现要点与本文件各节的对应关系：
//  §1 resolveItemLimit：0 表示不限制；不能用 `maxItems || 100` 把 0 错当成"未设置"
//  §2 累积模式下 upsertItems 不淘汰任何条目
//  §3 显式上限（50/100/200/500）仍按原样截断，且继续保护星标/已建书签条目（老功能不回归）
//  §4 设置默认值为累积；旧默认值 100 做一次性迁移，用户主动选的数值不动
//  §5 迁移必须能落盘（getSettings 与 setSettings 共用归一化，否则旧值会被写回）
//  §6 getItemsPage：分页切片、未读过滤、total/unreadTotal 口径
//  §7 分页与落盘排序同口径（publishedAt 缺失回退 fetchedAt），offset 分页不重复不漏条
//  §8 getFeedOverview：每源只回传最新 N 条 + 真实总数（负载不随历史增长）
//  §9 getStarredItems：后台完成过滤
//  §10 源码契约：UI 分页与有界查询消息接线到位

function loadFeedStore(initial = {}) {
  const values = new Map(Object.entries(structuredClone(initial)));
  const storage = {
    values,
    async get(keys) {
      if (keys == null) return Object.fromEntries(values);
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        requested.filter((k) => values.has(k)).map((k) => [k, structuredClone(values.get(k))]),
      );
    },
    async set(patch) {
      for (const [k, v] of Object.entries(patch)) values.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of (Array.isArray(keys) ? keys : [keys])) values.delete(k);
    },
  };
  const context = {
    Array, Date, JSON, Map, Math, Number, Object, Promise, Set, String, URL,
    structuredClone,
    console: { info() {}, warn() {}, error() {} },
    chrome: { storage: { local: storage }, runtime: { sendMessage: async () => undefined } },
  };
  context.self = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(readFileSync('src/timeline/shared/feed-store.js', 'utf8'), context);
  return { store: context.FeedStore, storage };
}

function makeIncoming(count, { startPublished = 1000, step = 10, prefix = 'g' } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    guid: `${prefix}${i}`,
    title: `${prefix}${i}`,
    link: `https://feed.test/${prefix}${i}`,
    publishedAt: startPublished + i * step,
  }));
}

const FEED = { id: 'f1', url: 'https://feed.test/rss', title: 'F1' };

// ── §1 resolveItemLimit 的边界语义 ──
{
  const { store } = loadFeedStore();
  const resolve = store.resolveItemLimit;
  assert.equal(resolve(0), 0, '0 必须表示"不限制"，不能被当成未设置而回退到 100');
  assert.equal(resolve('0'), 0, '设置值可能是字符串形式的 0');
  assert.equal(resolve(-5), 0, '负数按不限制处理');
  assert.equal(resolve(100), 100);
  assert.equal(resolve('200'), 200);
  assert.equal(resolve(50.7), 50, '小数向下取整');
  assert.equal(resolve(undefined), 100, '未提供时回退到兜底值');
  assert.equal(resolve(null), 100);
  assert.equal(resolve('abc'), 100, '非法值回退到兜底值');
  assert.equal(resolve(NaN), 100);
}

// ── §2 累积模式：新文章到来不淘汰旧文章 ──
{
  const { store, storage } = loadFeedStore({ rss_feeds: [FEED] });

  // 分 6 批写入，每批 40 条，累计 240 条 —— 远超旧默认上限 100
  for (let batch = 0; batch < 6; batch++) {
    const incoming = makeIncoming(40, {
      startPublished: 1000 + batch * 1000,
      prefix: `b${batch}-`,
    });
    const added = await store.upsertItems(FEED.id, incoming, 0);
    assert.equal(added.length, 40, `第 ${batch} 批应全部落库并计为新增`);
  }

  const stored = storage.values.get('rss_items_f1');
  assert.equal(stored.length, 240, '累积模式下 240 条必须全部保留，不得截断');

  // 最早那批仍在
  assert.ok(stored.some((i) => i.guid === 'b0-0'), '最早写入的条目不得被新文章挤掉');
  // 顺序仍是时间倒序
  const keys = stored.map((i) => i.publishedAt);
  assert.deepEqual([...keys], [...keys].sort((a, b) => b - a), '累积模式下仍按时间倒序持久化');
}

// ── §2b 累积模式下 guid 去重仍生效（不能重复堆积同一篇） ──
{
  const { store, storage } = loadFeedStore({ rss_feeds: [FEED] });
  const incoming = makeIncoming(10);
  await store.upsertItems(FEED.id, incoming, 0);
  const addedAgain = await store.upsertItems(FEED.id, incoming, 0);
  assert.equal(addedAgain.length, 0, '同一批 guid 重复拉取不得产生新增');
  assert.equal(storage.values.get('rss_items_f1').length, 10, '重复拉取不得让条目翻倍');
}

// ── §3 显式上限仍按原样截断（老功能不回归） ──
{
  const { store, storage } = loadFeedStore({ rss_feeds: [FEED] });
  await store.upsertItems(FEED.id, makeIncoming(120), 100);
  assert.equal(storage.values.get('rss_items_f1').length, 100, '选择数值上限时必须仍然截断');

  // 上限省略时（旧调用方不传第三参）仍回退到 100
  const { store: store2, storage: storage2 } = loadFeedStore({ rss_feeds: [FEED] });
  await store2.upsertItems(FEED.id, makeIncoming(150));
  assert.equal(storage2.values.get('rss_items_f1').length, 100, '未传上限时保持旧的兜底行为');
}

// ── §3b 显式上限下，星标/已建书签条目仍受保护（第四轮修复不得回归） ──
{
  const { store, storage } = loadFeedStore({
    rss_feeds: [FEED],
    'rss_items_f1': [
      { id: 'i-star', feedId: 'f1', guid: 'old-star', title: '旧-已加星', publishedAt: 10, fetchedAt: 10, starred: true, bookmarkId: null, read: false },
      { id: 'i-bm', feedId: 'f1', guid: 'old-bm', title: '旧-已建书签', publishedAt: 9, fetchedAt: 9, starred: false, bookmarkId: 'bk1', read: false },
    ],
  });
  await store.upsertItems(FEED.id, makeIncoming(5, { startPublished: 5000 }), 3);
  const stored = storage.values.get('rss_items_f1');
  assert.ok(stored.some((i) => i.guid === 'old-star'), '星标条目不得被截断删除');
  assert.ok(stored.some((i) => i.guid === 'old-bm'), '已建书签条目不得被截断删除');
}

// ── §4 默认累积 + 旧默认值一次性迁移 ──
{
  // 4a. 全新用户：默认就是累积
  const fresh = loadFeedStore();
  const freshSettings = await fresh.store.getSettings();
  assert.equal(freshSettings.maxItemsPerFeed, 0, '新用户默认应为累积保留');
  assert.equal(freshSettings.settingsVersion, 2);

  // 4b. 老用户且保留条数正好是旧默认值 100 → 视为从未主动改过，迁移到累积
  const legacy = loadFeedStore({
    rss_settings: { pollIntervalMin: 30, maxItemsPerFeed: 100, notifyNew: true },
  });
  const migrated = await legacy.store.getSettings();
  assert.equal(migrated.maxItemsPerFeed, 0, '旧默认值 100 应迁移为累积');
  assert.equal(migrated.pollIntervalMin, 30, '迁移不得影响其他设置项');
  assert.equal(migrated.notifyNew, true);

  // 4c. 用户主动选过的数值（50/200/500）必须保持不变
  for (const chosen of [50, 200, 500]) {
    const picked = loadFeedStore({ rss_settings: { maxItemsPerFeed: chosen } });
    const settings = await picked.store.getSettings();
    assert.equal(settings.maxItemsPerFeed, chosen, `用户主动选择的 ${chosen} 不得被迁移改写`);
  }

  // 4d. 已迁移过的用户即使把值改回 100，也不得再被迁移
  const reChosen = loadFeedStore({
    rss_settings: { settingsVersion: 2, maxItemsPerFeed: 100 },
  });
  const reSettings = await reChosen.store.getSettings();
  assert.equal(reSettings.maxItemsPerFeed, 100, '已迁移后主动选 100 必须保留');
}

// ── §5 迁移必须能落盘：setSettings 不得把未迁移的旧值又写回 ──
{
  const { store, storage } = loadFeedStore({
    rss_settings: { maxItemsPerFeed: 100, pollIntervalMin: 30 },
  });
  // 改一个无关设置项
  await store.setSettings({ pollIntervalMin: 60 });
  const persisted = storage.values.get('rss_settings');
  assert.equal(persisted.maxItemsPerFeed, 0, '写回时旧默认值必须已迁移，否则迁移永远无法落地');
  assert.equal(persisted.settingsVersion, 2, '版本号必须落盘，避免反复迁移');
  assert.equal(persisted.pollIntervalMin, 60, '本次改动正常生效');

  // 用户随后主动选回 100，必须被尊重
  await store.setSettings({ maxItemsPerFeed: 100 });
  assert.equal(storage.values.get('rss_settings').maxItemsPerFeed, 100);
  const after = await store.getSettings();
  assert.equal(after.maxItemsPerFeed, 100, '迁移后用户的显式选择不得被再次改写');
}

// ── §6 getItemsPage：分页 / 未读过滤 / 计数口径 ──
{
  const items = Array.from({ length: 125 }, (_, i) => ({
    id: `i${i}`,
    feedId: 'f1',
    guid: `g${i}`,
    title: `t${i}`,
    publishedAt: 100000 - i,       // 已按倒序
    fetchedAt: 100000 - i,
    read: i % 5 === 0,             // 25 条已读
    starred: false,
    bookmarkId: null,
  }));
  const { store } = loadFeedStore({ rss_feeds: [FEED], 'rss_items_f1': items });

  const page1 = await store.getItemsPage('f1', { offset: 0, limit: 50 });
  assert.equal(page1.items.length, 50);
  assert.equal(page1.total, 125, 'total 必须是全量条数，供 UI 判断是否继续加载');
  assert.equal(page1.unreadTotal, 100, '未读总数口径：125 - 25');
  assert.equal(page1.items[0].id, 'i0', '第一页从最新条目开始');

  const page3 = await store.getItemsPage('f1', { offset: 100, limit: 50 });
  assert.equal(page3.items.length, 25, '末页只返回剩余条目');
  assert.equal(page3.items[0].id, 'i100');

  const beyond = await store.getItemsPage('f1', { offset: 500, limit: 50 });
  assert.equal(beyond.items.length, 0, '越界 offset 返回空页而不是报错');
  assert.equal(beyond.total, 125);

  // 未读过滤：total 与 unreadTotal 都应是过滤后的口径
  const unread = await store.getItemsPage('f1', { offset: 0, limit: 50, unreadOnly: true });
  assert.equal(unread.items.length, 50);
  assert.equal(unread.total, 100, '未读模式下 total 是未读条数');
  assert.equal(unread.unreadTotal, 100);
  assert.ok(unread.items.every((i) => !i.read), '未读模式不得混入已读条目');

  // 分页无重复无遗漏
  const seen = new Set();
  for (let offset = 0; offset < 125; offset += 50) {
    const page = await store.getItemsPage('f1', { offset, limit: 50 });
    for (const item of page.items) {
      assert.ok(!seen.has(item.id), `分页出现重复条目：${item.id}`);
      seen.add(item.id);
    }
  }
  assert.equal(seen.size, 125, '逐页翻完必须覆盖全部条目');

  // 默认 limit 兜底
  const defaulted = await store.getItemsPage('f1', {});
  assert.equal(defaulted.items.length, 50, '未指定 limit 时使用默认页大小');
  const badLimit = await store.getItemsPage('f1', { limit: 0 });
  assert.equal(badLimit.items.length, 50, 'limit=0 不得退化为空页');
  const negOffset = await store.getItemsPage('f1', { offset: -10, limit: 5 });
  assert.equal(negOffset.items[0].id, 'i0', '负 offset 归零');
}

// ── §7 分页与落盘排序同口径：publishedAt 缺失回退 fetchedAt ──
{
  // 存储顺序刻意打乱，且混入 publishedAt=0 的条目
  const { store } = loadFeedStore({
    rss_feeds: [FEED],
    'rss_items_f1': [
      { id: 'a', feedId: 'f1', guid: 'a', publishedAt: 0, fetchedAt: 500, read: false },
      { id: 'b', feedId: 'f1', guid: 'b', publishedAt: 900, fetchedAt: 100, read: false },
      { id: 'c', feedId: 'f1', guid: 'c', publishedAt: 0, fetchedAt: 700, read: false },
      { id: 'd', feedId: 'f1', guid: 'd', publishedAt: 300, fetchedAt: 100, read: false },
    ],
  });
  const page = await store.getItemsPage('f1', { offset: 0, limit: 10 });
  assert.deepEqual(
    [...page.items.map((i) => i.id)],
    ['b', 'c', 'a', 'd'],
    '排序键必须与落盘一致（publishedAt || fetchedAt），无日期条目按抓取时间插入而非堆到末尾',
  );

  // 跨页读取时顺序稳定（不能因为每页重排导致条目错位）
  const first = await store.getItemsPage('f1', { offset: 0, limit: 2 });
  const second = await store.getItemsPage('f1', { offset: 2, limit: 2 });
  assert.deepEqual(
    [...first.items.map((i) => i.id), ...second.items.map((i) => i.id)],
    ['b', 'c', 'a', 'd'],
    '分页拼接结果必须与整体排序一致',
  );
}

// ── §8 getFeedOverview：负载有界 + 总数真实 ──
{
  const feedA = { id: 'fa', url: 'https://a/rss', title: 'A', favicon: 'https://a/ico' };
  const feedB = { id: 'fb', url: 'https://b/rss', title: 'B', favicon: '' };
  const mk = (feedId, n) => Array.from({ length: n }, (_, i) => ({
    id: `${feedId}-${i}`, feedId, guid: `${feedId}-${i}`, title: `${feedId}-${i}`,
    publishedAt: 10000 - i, fetchedAt: 10000 - i, read: i % 2 === 0, starred: false, bookmarkId: null,
  }));
  const { store } = loadFeedStore({
    rss_feeds: [feedA, feedB],
    'rss_items_fa': mk('fa', 800),
    'rss_items_fb': mk('fb', 3),
  });

  const overview = await store.getFeedOverview(5);
  assert.equal(overview.length, 2, '每个源一条概览');

  const a = overview.find((e) => e.feedId === 'fa');
  assert.equal(a.items.length, 5, '概览每源只回传预览条目，负载不随历史增长');
  assert.equal(a.total, 800, '总数必须是源的真实条数，而不是预览条目数');
  assert.equal(a.unread, 400, '未读数按全量统计');
  assert.equal(a.items[0].id, 'fa-0', '预览取最新的若干条');
  assert.equal(a.items[0].feedTitle, 'A', '概览条目需附带源标题供 UI 渲染');
  assert.equal(a.items[0].feedFavicon, 'https://a/ico');

  const b = overview.find((e) => e.feedId === 'fb');
  assert.equal(b.items.length, 3, '条目少于预览数时返回全部');
  assert.equal(b.total, 3);

  // 空源与无源
  const emptyFeed = await store.getFeedOverview(5);
  assert.ok(Array.isArray(emptyFeed));
  const { store: noFeeds } = loadFeedStore();
  assert.deepEqual([...await noFeeds.getFeedOverview(5)], [], '没有订阅源时返回空数组');
}

// ── §9 getStarredItems：后台过滤 ──
{
  const feedA = { id: 'fa', url: 'https://a/rss', title: 'A', favicon: '' };
  const { store } = loadFeedStore({
    rss_feeds: [feedA],
    'rss_items_fa': [
      { id: 's1', feedId: 'fa', guid: 's1', starred: true, read: false, publishedAt: 300, fetchedAt: 300 },
      { id: 'n1', feedId: 'fa', guid: 'n1', starred: false, read: false, publishedAt: 200, fetchedAt: 200 },
      { id: 's2', feedId: 'fa', guid: 's2', starred: true, read: true, publishedAt: 100, fetchedAt: 100 },
    ],
  });
  const starred = await store.getStarredItems();
  assert.deepEqual([...starred.map((i) => i.id)], ['s1', 's2'], '只回传星标条目');
  assert.equal(starred[0].feedTitle, 'A', '星标条目需附带源标题');

  const { store: noFeeds } = loadFeedStore();
  assert.deepEqual([...await noFeeds.getStarredItems()], [], '没有订阅源时返回空数组');
}

// ── §10 源码契约：UI 与后台接线到位 ──
{
  const feedView = readFileSync('src/timeline/pages/standalone/feed-view.js', 'utf8');
  // 单 feed 视图必须走分页查询，不得再一次性拉全量
  assert.match(feedView, /rssGetItemsPage/, '单 feed 视图必须使用分页查询');
  assert.match(feedView, /rssGetFeedOverview/, '全部订阅视图必须使用有界概览查询');
  assert.match(feedView, /rssGetStarredItems/, '已加星视图必须使用后台过滤查询');
  assert.doesNotMatch(
    feedView,
    /send\('rssGetItems',\s*\{\s*feedId/,
    '单 feed 视图不得再全量拉取该源的所有条目',
  );
  assert.match(feedView, /sa-load-more-sentinel/, '分页需复用项目既有的哨兵惯例');
  assert.match(feedView, /ARTICLE_PAGE_SIZE/, '分页页大小需可见');

  const background = readFileSync('src/timeline/background/background.js', 'utf8');
  for (const action of ['rssGetItemsPage', 'rssGetFeedOverview', 'rssGetStarredItems', 'rssGetUnreadCount']) {
    assert.match(background, new RegExp(`case '${action}'`), `后台需提供 ${action} 消息`);
  }
  // 旧消息保留，避免破坏导出等既有调用方
  assert.match(background, /case 'rssGetItems'/, 'rssGetItems 必须保留，导出等场景仍需全量');

  const settingsHtml = readFileSync('src/timeline/pages/settings/settings.html', 'utf8');
  assert.match(settingsHtml, /value="0"[^>]*data-i18n="rssMaxItemsUnlimited"/, '设置页需提供"不限制"选项');

  const i18n = readFileSync('src/timeline/shared/i18n.js', 'utf8');
  assert.match(i18n, /rssMaxItemsUnlimited: "Unlimited \(accumulate\)"/, 'en 需有累积选项文案');
  assert.match(i18n, /rssMaxItemsUnlimited: "不限制（累积保留）"/, 'zh_CN 需有累积选项文案');

  // 设置页徽标不得为了算一个未读数而拉全量条目
  const settingsJs = readFileSync('src/timeline/pages/settings/settings.js', 'utf8');
  assert.match(settingsJs, /rssGetUnreadCount/, '设置页未读徽标应使用计数消息');
}

console.log('RSS 累积保留回归: OK');
