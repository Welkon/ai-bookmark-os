import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('src/timeline/pages/popup/popup.js', 'utf8');

function readFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `未找到函数 ${name}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`函数 ${name} 缺少闭合括号`);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function i18n(key, args = []) {
  if (key === 'today') return '今天';
  if (key === 'yesterday') return '昨天';
  if (key === 'pinnedGroup') return '已置顶';
  if (key === 'daysAgo') return `${args[0]}天前`;
  if (key === 'dateSameYear') return `${args[0]}${args[1]}日`;
  if (key === 'dateWithYear') return `${args[2]}年${args[0]}${args[1]}日`;
  if (key.startsWith('month')) return `${MONTHS.indexOf(key.slice(5)) + 1}月`;
  return key;
}

const timelineClasses = new Set();
const context = {
  Array, Date, Map, Math, Number, Object, String,
  i18n,
  renderQueue: [],
  renderedCount: 0,
  currentGroupLabel: '',
  currentHighlightRanges: null,
  sortMode: 'newest',
  timelineContent: {
    style: { display: '', setProperty() {} },
    classList: {
      add: (name) => timelineClasses.add(name),
      remove: (name) => timelineClasses.delete(name),
      contains: (name) => timelineClasses.has(name),
    },
    innerHTML: '',
  },
  timelineEmpty: { style: { display: '' } },
  searchEmpty: { style: { display: '' } },
  bookmarkCount: { textContent: '' },
  renderNextPage() {},
};
vm.createContext(context);
new vm.Script([
  readFunction(source, 'getDateGroupLabel'),
  readFunction(source, 'renderTimeline'),
].join('\n')).runInContext(context);

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

// 置顶书签的添加时间早于今天的书签，用于验证它不会把自己所属的日期分组顶到最前面
context.renderTimeline([
  { id: 'pinned-old', dateAdded: now - 10 * DAY, pinned: true },
  { id: 'older', dateAdded: now - 11 * DAY },
  { id: 'today-new', dateAdded: now - 60 * 1000 },
  { id: 'same-day-as-pinned', dateAdded: now - 10 * DAY },
  { id: 'today-old', dateAdded: now - 3 * 60 * 60 * 1000 },
]);

const label10 = context.getDateGroupLabel(now - 10 * DAY);
const label11 = context.getDateGroupLabel(now - 11 * DAY);

const groups = [];
for (const entry of context.renderQueue) {
  if (entry.type === 'header') groups.push({ label: entry.label, count: entry.count, ids: [] });
  else groups[groups.length - 1].ids.push(entry.data.id);
}

assert.deepEqual(
  groups.map(g => g.label),
  ['已置顶', '今天', label10, label11],
  '置顶书签的日期不得抢占日期分组顺序，今天必须排在更早的日期之前',
);
assert.deepEqual(
  groups.map(g => g.ids),
  [['pinned-old'], ['today-new', 'today-old'], ['same-day-as-pinned'], ['older']],
  '置顶项只出现在置顶分组，日期分组内部按时间倒序',
);
for (const g of groups) {
  assert.equal(g.count, g.ids.length, `分组 ${g.label} 的计数应与实际条目数一致`);
}
assert.ok(!timelineClasses.has('timeline--flat'), '时间轴模式应显示时间轴竖线');

// 搜索模式：filterBookmarks 设置的高亮范围必须保留，结果扁平展示
const searchList = [
  { id: 'hit-old', dateAdded: now - 30 * DAY },
  { id: 'hit-new', dateAdded: now - 60 * 1000 },
];
context.currentHighlightRanges = new Map([
  ['hit-old', { title: [[0, 2]] }],
  ['hit-new', { url: [[0, 3]] }],
]);
context.renderTimeline(searchList);

assert.ok(context.currentHighlightRanges, 'renderTimeline 不得清空调用方设置的搜索高亮范围');
assert.deepEqual(
  Array.from(context.renderQueue, e => e.type),
  ['item', 'item'],
  '搜索结果按相关度扁平展示，不做日期分组',
);
assert.deepEqual(
  Array.from(context.renderQueue, e => e.data.id),
  ['hit-old', 'hit-new'],
  '搜索结果应保持 smartSearch 的评分顺序',
);
assert.deepEqual(
  Array.from(context.renderQueue, e => e.ranges),
  [{ title: [[0, 2]] }, { url: [[0, 3]] }],
  '每条搜索结果都应带上自己的高亮范围',
);
assert.ok(timelineClasses.has('timeline--flat'), '搜索结果为扁平列表，应隐藏时间轴竖线');

context.currentHighlightRanges = null;
context.renderTimeline(searchList);
assert.ok(!timelineClasses.has('timeline--flat'), '退出搜索后应恢复时间轴竖线');

// 高亮状态由 filterBookmarks 统一维护，渲染函数与删除后刷新都不得绕过它
assert.doesNotMatch(
  readFunction(source, 'renderTimeline'),
  /currentHighlightRanges\s*=\s*null/,
  'renderTimeline 不得重置搜索高亮范围',
);
assert.doesNotMatch(
  readFunction(source, 'deleteBookmark'),
  /renderTimeline\(/,
  '删除书签后应通过 filterBookmarks 刷新，保留当前搜索与筛选状态',
);

console.log('popup 时间轴分组顺序: OK');
