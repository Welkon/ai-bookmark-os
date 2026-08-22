import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 本文件对本轮“页面与交互闭环”修复做源码契约断言（与仓库既有静态回归测试同风格）。

const app = readFileSync('src/sidepanel/App.tsx', 'utf8');
const tree = readFileSync('src/sidepanel/Tree.tsx', 'utf8');
const i18n = readFileSync('src/core/i18n.ts', 'utf8');
const nav = readFileSync('src/bookmark-nav/BookmarkNavPage.tsx', 'utf8');
const feedView = readFileSync('src/timeline/pages/standalone/feed-view.js', 'utf8');
const popupHtml = readFileSync('src/timeline/pages/popup/popup.html', 'utf8');
const settingsHtml = readFileSync('src/timeline/pages/settings/settings.html', 'utf8');

// —— 侧边栏：搜索框只在 AI 方案视图生效，其他 Tab 必须禁用并说明原因（不再静默无效）。
assert.match(app, /disabled=\{workspaceView !== 'draft'\}/, 'search input must be disabled outside the draft view');
assert.match(app, /d\.searchDraftOnly/, 'disabled search must explain why via placeholder');
const draftOnlyCount = (i18n.match(/searchDraftOnly:/g) || []).length;
assert.equal(draftOnlyCount, 9, `searchDraftOnly must exist in all 9 languages (got ${draftOnlyCount})`);

// —— 侧边栏：搜索必须同时匹配分类（文件夹）名，命中目录保留整棵子树。
assert.match(
  app,
  /if \(n\.name\.toLowerCase\(\)\.includes\(q\)\) return n;/,
  'folder-name hits must keep the folder and its subtree',
);

// —— 侧边栏：草稿树目录行必须键盘可达（此前展开只有鼠标一条路径）。
assert.match(tree, /role="button"/, 'folder row must expose a button role');
assert.match(tree, /tabIndex=\{renaming \? -1 : 0\}/, 'folder row must be focusable outside rename mode');
assert.match(tree, /aria-expanded=\{open\}/, 'folder row must announce expanded state');
assert.match(tree, /event\.key === 'Enter' \|\| event\.key === ' '/, 'Enter/Space must toggle folders');

// —— 侧边栏：历史版本星标失败必须反馈（此前静默吞掉）。
const pinStart = app.indexOf('toggleClassificationPlanVersionPin(selectedHistoricalVersion.versionId)');
const pinFlow = app.slice(pinStart, pinStart + 700);
assert.match(pinFlow, /catch \(e\)/, 'pin toggle must catch failures');
assert.match(pinFlow, /setError\(/, 'pin toggle failures must surface to the user');

// —— 侧边栏：备份下载必须防连点并有错误反馈（此前失败是未处理 rejection、可重复下载）。
assert.match(app, /if \(backupDownloading\) return;/, 'backup download must guard against double invocation');
assert.match(app, /catch \(e\) \{[\s\S]{0,200}Backup download failed|备份下载失败/, 'backup download failures must surface');
assert.match(app, /disabled=\{backupDownloading\}/, 'backup button must be disabled while downloading');

// —— 侧边栏：分类数据导出/导入必须可以从 UI 触达（此前 transfer.ts 无任何入口，闭环缺失）。
assert.match(app, /import \{ downloadExport, importBundle \} from '\.\.\/core\/transfer';/, 'sidepanel must import transfer APIs');
assert.match(app, /await downloadExport\(\)/, 'export must be invokable from the data dialog');
assert.match(app, /await importBundle\(text\)/, 'import must be invokable from the data dialog');
assert.match(app, /INVALID_JSON|INVALID_BUNDLE/, 'import errors must map to actionable messages');
assert.match(app, /window\.location\.reload\(\)/, 'import success must reload the workspace for state consistency');

// —— 侧边栏：更新弹窗必须使用带兜底的 resolveWhatsNewEntries。
assert.match(app, /resolveWhatsNewEntries\(p\.from, p\.to\)/, 'what\'s-new must use the fallback-aware resolver');

// —— 书签导航页：并发加载必须丢弃过期响应；meta 横幅必须在新一轮加载时复位。
assert.match(nav, /loadRequestRef/, 'bookmark-nav loads must carry a request id');
assert.match(nav, /requestId !== loadRequestRef\.current\) return;/, 'stale responses must be dropped');
assert.match(nav, /setMetaUnavailable\(false\);/, 'meta-unavailable banner must reset on a fresh load');

// —— RSS：订阅源加星必须产生可见效果（置顶并持久化），不再是只存状态的死按钮。
const starFlow = feedView.slice(
  feedView.indexOf('async function toggleFeedStar'),
  feedView.indexOf('// 编辑订阅源弹窗'),
);
assert.match(starFlow, /rssReorderFeeds/, 'starring a feed must persist a top reorder');
assert.match(starFlow, /others\.filter\(\(f\) => f\.starred\), feed,/, 'starred feeds must be ordered to the top');

// —— popup 与 settings 共用导入解析器：脚本必须先于页面脚本加载。
assert.match(popupHtml, /shared\/import-parser\.js">[\s\S]{0,200}<script src="popup\.js"/, 'popup must load the shared import parser first');
assert.match(settingsHtml, /shared\/import-parser\.js">[\s\S]{0,300}<script src="settings\.js/, 'settings must load the shared import parser first');

console.log('ui polish regression checks passed');
