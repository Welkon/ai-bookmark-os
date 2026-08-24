// shared/feed-store.js
// RSS 订阅存储层：feeds / items / settings 的 CRUD
// items 按 feedId 分片存储（rss_items_<feedId>），避免单 key 过大
//
// 依赖：chrome.storage.local

(function (global) {
  'use strict';

  const FEEDS_KEY = 'rss_feeds';
  const SETTINGS_KEY = 'rss_settings';
  const ITEMS_KEY_PREFIX = 'rss_items_'; // rss_items_<feedId>

  // 设置结构版本：用于一次性迁移旧默认值（见 normalizeSettings）
  const SETTINGS_VERSION = 2;
  // 旧版本的"单 feed 保留条数"默认值。v2 起默认改为累积保留（0）。
  const LEGACY_DEFAULT_MAX_ITEMS = 100;
  // 未指定保留上限时的兜底值：仅在设置值非法（非数字/负数）时使用
  const FALLBACK_MAX_ITEMS = 100;

  const DEFAULT_SETTINGS = {
    settingsVersion: SETTINGS_VERSION,
    pollIntervalMin: 30,        // 拉取间隔（分钟）：15 / 30 / 60
    autoDiscover: true,         // 自动嗅探当前页 RSS
    notifyNew: true,            // 新文章桌面通知
    // 单 feed 最多保留条数。0 = 不限制（累积保留全部历史文章）。
    // 累积是默认行为：抓到的文章不再因为新文章到来而被删除。
    maxItemsPerFeed: 0,
    defaultFolderId: null,      // 新订阅默认挂载的书签文件夹
    proxyFallback: false,       // 仅在用户明确同意后才将订阅 URL 发送给公共代理
    // 代理 URL 模板，{url} 为源 URL 占位符（经 encodeURIComponent 编码）
    // rss2json 类型（返回 JSON）与 raw 类型（返回原始 XML）均可，自动识别
    proxyUrl: 'https://api.rss2json.com/v1/api.json?rss_url={url}'
  };

  // 解析保留上限：0（或负数）表示不限制，返回 0；非数字回退到兜底值。
  // 注意不能用 `maxItems || FALLBACK`，那会把"0 = 不限制"错当成未设置。
  function resolveItemLimit(maxItems) {
    if (maxItems === undefined || maxItems === null) return FALLBACK_MAX_ITEMS;
    const parsed = Number(maxItems);
    if (!Number.isFinite(parsed)) return FALLBACK_MAX_ITEMS;
    return parsed > 0 ? Math.floor(parsed) : 0;
  }

  // 把存储中的设置补齐为当前结构，并做一次性迁移。
  // 迁移规则：老用户没有 settingsVersion 且保留条数正好是旧默认值 100 时，视为"从未主动改过"，
  // 迁到累积模式（0）；若是 50/200/500 则只可能是用户主动选择，保持不变。
  // getSettings 与 setSettings 共用本函数，保证读到的与写回的一致（否则会把旧值又存回去）。
  function normalizeSettings(stored) {
    const raw = stored || {};
    const next = { ...DEFAULT_SETTINGS, ...raw };
    if (!(Number(raw.settingsVersion) >= 2) && Number(raw.maxItemsPerFeed) === LEGACY_DEFAULT_MAX_ITEMS) {
      next.maxItemsPerFeed = 0;
    }
    next.settingsVersion = SETTINGS_VERSION;
    return next;
  }

  // chrome.storage 不提供 compare-and-swap；同一 key 的读改写必须顺序执行。
  const mutationQueues = new Map();
  function mutateStorage(key, updater) {
    const previous = mutationQueues.get(key) || Promise.resolve();
    const mutation = previous.catch(() => {}).then(async () => {
      const stored = await chrome.storage.local.get(key);
      const next = await updater(stored[key]);
      if (next === undefined) await chrome.storage.local.remove(key);
      else await chrome.storage.local.set({ [key]: next });
      return next;
    });
    mutationQueues.set(key, mutation);
    mutation.finally(() => { if (mutationQueues.get(key) === mutation) mutationQueues.delete(key); }).catch(() => {});
    return mutation;
  }
  function isValidProxyTemplate(template) {
    if (typeof template !== 'string' || template.length > 2048 || (template.match(/\{url\}/g) || []).length !== 1) return false;
    try { const url = new URL(template.replace('{url}', 'https%3A%2F%2Fexample.invalid%2Ffeed.xml')); return url.protocol === 'https:' && !!url.hostname; } catch { return false; }
  }

  // ===== Settings =====
  async function getSettings() {
    const r = await chrome.storage.local.get(SETTINGS_KEY);
    return normalizeSettings(r[SETTINGS_KEY]);
  }

  async function setSettings(patch) {
    return mutateStorage(SETTINGS_KEY, (stored) => {
      // 先把存量设置归一化（含旧默认值迁移），再叠加本次改动：
      // 否则未迁移的旧值会随 stored 展开又被写回，迁移永远无法落地。
      const next = { ...normalizeSettings(stored), ...patch };
      if (next.proxyFallback && !isValidProxyTemplate(next.proxyUrl)) throw new Error('proxy_template_invalid');
      return next;
    });
  }

  // ===== Feeds =====
  async function getAllFeeds() {
    const r = await chrome.storage.local.get(FEEDS_KEY);
    return r[FEEDS_KEY] || [];
  }

  async function getFeed(id) {
    const feeds = await getAllFeeds();
    return feeds.find(f => f.id === id) || null;
  }

  async function getFeedByUrl(url) {
    const feeds = await getAllFeeds();
    const norm = (url || '').trim();
    return feeds.find(f => f.url === norm) || null;
  }

  async function addFeed(data) {
    let outcome;
    await mutateStorage(FEEDS_KEY, (stored) => {
      const feeds = stored || [];
      if (feeds.some(f => f.url === data.url)) { outcome = { success: false, error: 'duplicate' }; return feeds; }
      const feed = { id: 'feed_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), url: data.url, title: data.title || data.url, siteUrl: data.siteUrl || '', favicon: data.favicon || '', folderId: data.folderId || null, autoBookmark: !!data.autoBookmark, notify: data.notify !== false, lastFetched: 0, etag: null, lastModified: null, failCount: 0, lastStatus: 'pending', lastError: '', nextRetryAt: 0, createdAt: Date.now() };
      outcome = { success: true, feed };
      return [...feeds, feed];
    });
    return outcome;
  }

  async function updateFeed(id, patch) {
    let outcome;
    await mutateStorage(FEEDS_KEY, (stored) => {
      const feeds = stored || []; const index = feeds.findIndex(f => f.id === id);
      if (index < 0) { outcome = { success: false, error: 'not_found' }; return feeds; }
      const next = feeds.slice(); next[index] = { ...next[index], ...patch }; outcome = { success: true, feed: next[index] }; return next;
    });
    return outcome;
  }

  async function removeFeed(id) {
    // 先删条目分片再摘除 feed：两次写入无法原子化，只能挑失败后可恢复的顺序。
    // 反序（先摘 feed）一旦第二步失败或 SW 在两步之间被回收，rss_items_<id> 就成为孤儿：
    // 后续所有遍历都以 getAllFeeds() 为起点，没有任何路径能再发现或清理它。
    // 本序失败只会留下"条目为空但仍在列表里的 feed"，下一轮拉取即可自行补齐。
    await mutateStorage(ITEMS_KEY_PREFIX + id, () => undefined);
    await mutateStorage(FEEDS_KEY, (stored) => (stored || []).filter(f => f.id !== id));
    return { success: true };
  }

  // 按给定 id 序列重排订阅源顺序（数组顺序即持久化顺序）
  // 未出现在 orderedIds 中的 feed 追加到末尾，保持原有相对顺序
  async function reorderFeeds(orderedIds) {
    let next;
    await mutateStorage(FEEDS_KEY, (stored) => {
      const feeds = stored || []; const idSet = new Set(orderedIds || []); const idxMap = new Map((orderedIds || []).map((id, i) => [id, i]));
      const present = feeds.filter(f => idSet.has(f.id)); const rest = feeds.filter(f => !idSet.has(f.id));
      present.sort((a, b) => (idxMap.get(a.id) ?? 0) - (idxMap.get(b.id) ?? 0)); next = [...present, ...rest]; return next;
    });
    return { success: true, feeds: next };
  }

  // ===== Items =====
  async function getItems(feedId) {
    const r = await chrome.storage.local.get(ITEMS_KEY_PREFIX + feedId);
    return r[ITEMS_KEY_PREFIX + feedId] || [];
  }

  async function getAllItems() {
    const feeds = await getAllFeeds();
    if (feeds.length === 0) return [];
    const keys = feeds.map(f => ITEMS_KEY_PREFIX + f.id);
    const r = await chrome.storage.local.get(keys);
    const all = [];
    for (const f of feeds) {
      const items = r[ITEMS_KEY_PREFIX + f.id] || [];
      for (const it of items) {
        all.push({ ...it, feedTitle: f.title, feedFavicon: f.favicon });
      }
    }
    return all;
  }

  // 条目排序键：与 upsertItems 落盘时一致（publishedAt 缺失时回退 fetchedAt），
  // 保证"分页读取"与"存储顺序"用同一口径，offset 分页不会重复或漏条。
  function itemSortKey(item) {
    return (item && (item.publishedAt || item.fetchedAt)) || 0;
  }

  // 按时间倒序返回副本。分片本已按该顺序持久化（upsertItems 每次写入都排序，
  // _patchItem/markAllRead 都是原位替换不改顺序），这里再排一次是为了让分页的
  // 正确性不依赖存量数据的历史状态（如更早版本写入的分片）。
  // 时间相同时用 id 兜底：游标分页要求全序，否则同一时间戳的多条条目相对次序不定，
  // 游标无法稳定定位"上次读到哪一条"。
  function compareByNewest(a, b) {
    const diff = itemSortKey(b) - itemSortKey(a);
    if (diff !== 0) return diff;
    return String(b && b.id || '').localeCompare(String(a && a.id || ''));
  }

  function sortedByNewest(items) {
    return (Array.isArray(items) ? items.slice() : []).sort(compareByNewest);
  }

  function newestSlice(items, limit) {
    const sorted = sortedByNewest(items);
    return limit > 0 ? sorted.slice(0, limit) : sorted;
  }

  // 单 feed 分页读取。累积模式下一个源可能有数千条，全量经 sendMessage 结构化克隆开销很大；
  // 这里只回传当前页 + total，UI 据 total 决定是否继续加载。
  // storage 的读取粒度是整个 key，无法只读一页——但跨进程传输的体积由此受控。
  //
  // 优先使用游标（options.cursor = 上一页最后一条的 { sortKey, id }）而非 offset：
  // offset 是位置基准，数据集在翻页期间变化就会错位——
  //   · 开着"仅未读"时读掉一篇，未读数组整体前移一位 → 下一页跳过一条（永远看不到）
  //   · 轮询写入 N 篇新文章插到数组头部 → 下一页重复回传已渲染的 N 条
  // 游标是内容基准，只取"排在该条之后"的条目，两种情况都不会漏或重。
  // offset 分支保留：兼容未传游标的首屏与旧调用方。
  async function getItemsPage(feedId, options = {}) {
    const items = await getItems(feedId);
    const unreadOnly = options.unreadOnly === true;
    const ordered = sortedByNewest(items);
    const source = unreadOnly ? ordered.filter(item => !item.read) : ordered;
    const rawLimit = Number(options.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 50;

    const cursor = options.cursor;
    if (cursor && cursor.id !== undefined) {
      const anchor = { id: String(cursor.id), publishedAt: Number(cursor.sortKey) || 0, fetchedAt: 0 };
      // 找到游标之后的第一条：严格"排在游标之后"（compareByNewest > 0）。
      // 游标条目自身可能已被读掉而从 source 中消失，因此不能靠 findIndex(id) 定位。
      let start = source.length;
      for (let i = 0; i < source.length; i++) {
        if (compareByNewest(anchor, source[i]) < 0) { start = i; break; }
      }
      return {
        items: source.slice(start, start + limit),
        total: source.length,
        unreadTotal: unreadOnly ? source.length : items.filter(item => !item.read).length,
        offset: start,
        limit,
      };
    }

    const offset = Math.max(0, Number(options.offset) || 0);
    return {
      items: source.slice(offset, offset + limit),
      total: source.length,
      unreadTotal: unreadOnly ? source.length : items.filter(item => !item.read).length,
      offset,
      limit,
    };
  }

  // "全部订阅"概览：每个源只回传最新 limitPerFeed 条 + 总数。
  // 原实现走 getAllItems() 把所有源的全部条目一次性回传，只为显示每源前 5 条；
  // 累积模式下这会让消息负载随历史无上限增长。
  async function getFeedOverview(limitPerFeed = 5) {
    const feeds = await getAllFeeds();
    if (feeds.length === 0) return [];
    const keys = feeds.map(f => ITEMS_KEY_PREFIX + f.id);
    const r = await chrome.storage.local.get(keys);
    return feeds.map((f) => {
      const items = r[ITEMS_KEY_PREFIX + f.id] || [];
      return {
        feedId: f.id,
        total: items.length,
        unread: items.reduce((count, item) => count + (item.read ? 0 : 1), 0),
        items: newestSlice(items, limitPerFeed)
          .map(it => ({ ...it, feedTitle: f.title, feedFavicon: f.favicon })),
      };
    });
  }

  // 已加星条目：在后台完成过滤，避免把全部历史条目传到前台再筛。
  async function getStarredItems() {
    const feeds = await getAllFeeds();
    if (feeds.length === 0) return [];
    const keys = feeds.map(f => ITEMS_KEY_PREFIX + f.id);
    const r = await chrome.storage.local.get(keys);
    const starred = [];
    for (const f of feeds) {
      for (const it of (r[ITEMS_KEY_PREFIX + f.id] || [])) {
        if (it.starred) starred.push({ ...it, feedTitle: f.title, feedFavicon: f.favicon });
      }
    }
    return starred;
  }

  // 增量写入：按 guid 去重，返回新增的条目数组
  async function upsertItems(feedId, newItems, maxItems) {
    let added = [];
    await mutateStorage(ITEMS_KEY_PREFIX + feedId, async (stored) => {
      if (!await getFeed(feedId)) return undefined;
      const existing = (stored || []).slice(); const guidSet = new Set(existing.map(i => i.guid)); added = [];
      for (const it of newItems) {
        if (!it.guid || guidSet.has(it.guid)) continue;
        const item = { id: 'item_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), feedId, guid: it.guid, title: it.title || '', link: it.link || '', author: it.author || '', publishedAt: it.publishedAt || 0, summary: it.summary || '', contentSnippet: it.contentSnippet || '', imageUrl: it.imageUrl || '', read: false, starred: false, bookmarkId: null, savedAt: null, fetchedAt: Date.now() };
        existing.push(item); guidSet.add(it.guid); added.push(item);
      }
      // 日期解析失败的条目 publishedAt 为 0；若直接按 publishedAt 排序，新抓到的无日期条目
      // 与已有的无日期条目比较结果为 0，稳定排序会把新条目留在后面，达上限后永久被截断丢弃。
      // 回退到 fetchedAt 可让新条目排在旧的无日期条目之前。
      // 复用 itemSortKey：落盘顺序必须与分页读取（getItemsPage）用同一口径，否则 offset 分页会重复/漏条。
      existing.sort((a, b) => itemSortKey(b) - itemSortKey(a));
      // 截断时保护用户已产生状态的条目：加星、已建书签的条目一旦被挤出就永久丢失
      // （星标视图直接读同一分片，且这些状态没有任何别处备份）。
      // 先按上限取普通条目，再把受保护条目并回，最终仍按时间序输出。
      // limit === 0 表示"累积保留"：不做任何淘汰。
      const limit = resolveItemLimit(maxItems);
      if (limit > 0 && existing.length > limit) {
        const isProtected = (item) => !!item.starred || item.bookmarkId != null;
        const kept = new Set();
        for (const item of existing) if (isProtected(item)) kept.add(item.id);
        for (const item of existing) {
          if (kept.size >= limit && !isProtected(item)) continue;
          kept.add(item.id);
        }
        const next = existing.filter(i => kept.has(i.id));
        existing.length = 0;
        existing.push(...next);
      }
      // 只把截断后仍留存的条目视为"新增"：否则达上限时收到的旧日期(publishedAt=0)新条目
      // 会被排序挤出存储却仍返回给调用方，导致对永不落库的条目反复通知/建书签。
      const survivingIds = new Set(existing.map(i => i.id));
      added = added.filter(i => survivingIds.has(i.id));
      return existing;
    });
    return added;
  }

  async function _patchItem(feedId, itemId, patch) {
    let outcome;
    await mutateStorage(ITEMS_KEY_PREFIX + feedId, (stored) => {
      const items = (stored || []).slice(); const index = items.findIndex(i => i.id === itemId);
      if (index < 0) { outcome = { success: false, error: 'not_found' }; return items; }
      const item = { ...items[index], ...patch }; items[index] = item; outcome = { success: true, item }; return items;
    });
    return outcome;
  }

  async function setItemRead(itemId, feedId, read) {
    return _patchItem(feedId, itemId, { read: !!read });
  }

  async function markAllRead(feedId) {
    await mutateStorage(ITEMS_KEY_PREFIX + feedId, (stored) => (stored || []).map(item => ({ ...item, read: true })));
    return { success: true };
  }

  async function markAllFeedsRead() {
    const feeds = await getAllFeeds();
    for (const f of feeds) {
      await markAllRead(f.id);
    }
    return { success: true };
  }

  async function setItemStarred(itemId, feedId, starred) {
    return _patchItem(feedId, itemId, { starred: !!starred });
  }

  async function setItemBookmark(itemId, feedId, bookmarkId) {
    return _patchItem(feedId, itemId, {
      bookmarkId: bookmarkId || null,
      savedAt: bookmarkId ? Date.now() : null
    });
  }

  async function getUnreadCount(feedId) {
    const items = await getItems(feedId);
    return items.filter(i => !i.read).length;
  }

  async function getTotalUnreadCount() {
    const feeds = await getAllFeeds();
    if (feeds.length === 0) return 0;
    const keys = feeds.map(f => ITEMS_KEY_PREFIX + f.id);
    const r = await chrome.storage.local.get(keys);
    let total = 0;
    for (const f of feeds) {
      const items = r[ITEMS_KEY_PREFIX + f.id] || [];
      for (const it of items) if (!it.read) total++;
    }
    return total;
  }

  // 广播数据变化（供 UI 刷新）
  function _broadcast(action, payload) {
    try {
      chrome.runtime.sendMessage({ action, ...payload }).catch(() => {});
    } catch { /* 静默 */ }
  }

  global.FeedStore = {
    KEYS: { FEEDS_KEY, SETTINGS_KEY, ITEMS_KEY_PREFIX },
    DEFAULT_SETTINGS, mutateStorage, isValidProxyTemplate, resolveItemLimit,
    getSettings, setSettings,
    getAllFeeds, getFeed, getFeedByUrl, addFeed, updateFeed, removeFeed, reorderFeeds,
    getItems, getAllItems, getItemsPage, getFeedOverview, getStarredItems, upsertItems,
    setItemRead, markAllRead, markAllFeedsRead,
    setItemStarred, setItemBookmark,
    getUnreadCount, getTotalUnreadCount,
    _broadcast
  };
})(typeof self !== 'undefined' ? self : this);
