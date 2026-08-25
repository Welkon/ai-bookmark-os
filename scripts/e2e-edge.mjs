// Edge 兼容性冒烟测试：用本机真实 Microsoft Edge 加载 dist/ 并验证关键链路。
//
// 为什么单独一个脚本而不是扩到 e2e-extension.mjs：
//   完整 e2e 有 700+ 行、依赖大量 fixture 与注入状态，跑一遍数分钟。跨浏览器验证要回答的
//   是"这个 Chromium 分支上扩展能否加载、专有 API 是否齐备、页面是否无致命报错"，
//   与业务断言正交。分开后可独立运行，也不会让完整 e2e 的失败与浏览器兼容性混在一起。
//
// 前置：需先 npm run build 产出 dist/，且本机安装 Microsoft Edge。
// 未安装 Edge 时以退出码 0 跳过（CI 上不因缺少浏览器而失败），但会打印明确提示。

import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge',
];

function findEdge() {
  return EDGE_PATHS.find((candidate) => existsSync(candidate)) || null;
}

function copyDirectory(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source)) {
    const sourcePath = join(source, name);
    const destinationPath = join(destination, name);
    if (statSync(sourcePath).isDirectory()) copyDirectory(sourcePath, destinationPath);
    else copyFileSync(sourcePath, destinationPath);
  }
}

const edgePath = findEdge();
if (!edgePath) {
  console.log('Edge E2E skipped: Microsoft Edge not found on this machine.');
  process.exit(0);
}

const distPath = resolve('dist');
assert.ok(existsSync(join(distPath, 'manifest.json')), 'dist/manifest.json missing — run npm run build first');

const tempRoot = mkdtempSync(join(tmpdir(), 'ai-bookmark-os-edge-'));
const extensionPath = join(tempRoot, 'extension');
copyDirectory(distPath, extensionPath);
const profilePath = join(tempRoot, 'profile');
mkdirSync(profilePath, { recursive: true });

const manifest = JSON.parse(readFileSync(join(extensionPath, 'manifest.json'), 'utf8'));

let context;
try {
  context = await chromium.launchPersistentContext(profilePath, {
    executablePath: edgePath,
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--disable-default-apps',
    ],
  });

  // 1) Service Worker 必须注册成功（MV3 后台在 Edge 上是否可用的最硬指标）
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(worker.url()).host;
  assert.ok(extensionId, 'Edge did not register the extension service worker');

  const browserVersion = context.browser()?.version() || 'unknown';

  // 2) manifest 声明的每个专有 API 在 Edge 的 SW 里都必须真实存在。
  //    缺任何一个都意味着该功能在 Edge 上静默失效。
  const apiAvailability = await worker.evaluate(() => ({
    bookmarks: typeof chrome.bookmarks?.getTree === 'function',
    storageLocal: typeof chrome.storage?.local?.get === 'function',
    contextMenus: typeof chrome.contextMenus?.create === 'function',
    alarms: typeof chrome.alarms?.create === 'function',
    tabs: typeof chrome.tabs?.query === 'function',
    history: typeof chrome.history?.search === 'function',
    notifications: typeof chrome.notifications?.create === 'function',
    scripting: typeof chrome.scripting?.executeScript === 'function',
    sidePanel: typeof chrome.sidePanel?.setOptions === 'function',
    windows: typeof chrome.windows?.getCurrent === 'function',
    omnibox: typeof chrome.omnibox?.setDefaultSuggestion === 'function',
    action: typeof chrome.action?.setBadgeText === 'function',
    // Promise 风格：Chromium MV3 的 chrome.* 应返回 Promise。
    // 若为 false，说明该分支仍是回调风格，429 处 await chrome.* 全部会拿到 undefined。
    returnsPromise: typeof chrome.storage.local.get({}).then === 'function',
  }));

  for (const [name, available] of Object.entries(apiAvailability)) {
    assert.equal(available, true, `Edge is missing required capability: ${name}`);
  }

  // 3) 后台模块（14 个 importScripts 加载的 IIFE）必须都挂到了全局。
  //    任一缺失说明 SW 在 Edge 上加载中断。
  const backgroundModules = await worker.evaluate(() => ({
    RssParser: typeof self.RssParser === 'object',
    FeedStore: typeof self.FeedStore === 'object',
    FeedFetcher: typeof self.FeedFetcher === 'object',
    FeedNotifier: typeof self.FeedNotifier === 'object',
    FeedDiscover: typeof self.FeedDiscover === 'object',
    BookmarkData: typeof self.BookmarkData === 'object',
  }));
  for (const [name, loaded] of Object.entries(backgroundModules)) {
    assert.equal(loaded, true, `background module not loaded on Edge: ${name}`);
  }

  // 4) 书签读写与存储往返：核心数据链路在 Edge 上必须真的能用
  const dataRoundTrip = await worker.evaluate(async () => {
    const tree = await chrome.bookmarks.getTree();
    const other = tree[0].children.find((node) => node.id === '2') || tree[0].children[0];
    const created = await chrome.bookmarks.create({
      parentId: other.id,
      title: 'Edge Smoke Bookmark',
      url: 'https://edge-smoke.example/',
    });
    const found = await chrome.bookmarks.search({ url: 'https://edge-smoke.example/' });
    await chrome.storage.local.set({ __edge_smoke__: { ok: true, at: Date.now() } });
    const readBack = (await chrome.storage.local.get('__edge_smoke__')).__edge_smoke__;
    await chrome.bookmarks.remove(created.id);
    await chrome.storage.local.remove('__edge_smoke__');
    return { createdId: created.id, foundCount: found.length, storageOk: readBack?.ok === true };
  });
  assert.ok(dataRoundTrip.createdId, 'bookmark create failed on Edge');
  assert.equal(dataRoundTrip.foundCount, 1, 'bookmark search failed on Edge');
  assert.equal(dataRoundTrip.storageOk, true, 'storage round-trip failed on Edge');

  // 5) 各扩展页面必须能打开且无致命 console 错误。
  //    _favicon/ 是 Chrome 专有端点，这里顺带验证它在 Edge 上可用（否则图标会空）。
  const pages = [
    ['popup', 'pages/popup/popup.html'],
    ['settings', 'pages/settings/settings.html'],
    ['standalone', 'pages/standalone/standalone.html'],
    ['ai-sidepanel', 'ai/sidepanel.html'],
  ];
  const pageErrors = [];
  for (const [label, relativePath] of pages) {
    const page = await context.newPage();
    const errors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    await page.goto(`chrome-extension://${extensionId}/${relativePath}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    // 忽略与浏览器兼容性无关的噪音：favicon 404、网络请求失败
    const fatal = errors.filter((text) => !/favicon|net::ERR|Failed to load resource/i.test(text));
    if (fatal.length > 0) pageErrors.push(`${label}: ${fatal.slice(0, 3).join(' | ')}`);
    await page.close();
  }
  assert.deepEqual(pageErrors, [], `extension pages reported fatal errors on Edge:\n${pageErrors.join('\n')}`);

  // 6) _favicon/ 端点（Chrome 专有权限）在 Edge 上是否真的返回图片。
  // 必须在扩展页 origin 下探测：about:blank 页无权访问 chrome-extension:// 资源，
  // 从那里 fetch 会以 "Failed to fetch" 失败，与浏览器兼容性无关。
  // 用 <img> 而非 fetch，与产品实际用法一致（Tree.tsx / BookmarkNavPage.tsx 都是 img src）。
  const faviconPage = await context.newPage();
  await faviconPage.goto(`chrome-extension://${extensionId}/pages/settings/settings.html`, { waitUntil: 'domcontentloaded' });
  const faviconStatus = await faviconPage.evaluate((id) => new Promise((done) => {
    const img = new Image();
    img.onload = () => done({ ok: true, width: img.naturalWidth });
    img.onerror = () => done({ ok: false, width: 0 });
    img.src = `chrome-extension://${id}/_favicon/?pageUrl=${encodeURIComponent('https://example.com')}&size=32`;
    setTimeout(() => done({ ok: false, width: -1 }), 5000);
  }), extensionId);
  await faviconPage.close();
  assert.equal(faviconStatus.ok, true, `_favicon endpoint unavailable on Edge (width=${faviconStatus.width})`);

  console.log(`Edge E2E passed (Edge ${browserVersion}, manifest v${manifest.version})`);
  console.log(`  APIs verified: ${Object.keys(apiAvailability).length}, background modules: ${Object.keys(backgroundModules).length}, pages: ${pages.length}`);
} finally {
  if (context) await context.close();
  rmSync(tempRoot, { recursive: true, force: true });
}
