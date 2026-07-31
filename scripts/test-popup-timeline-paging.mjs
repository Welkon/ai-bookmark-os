import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

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

// 极简 DOM stub：只实现 renderNextPage 用到的节点操作
function hasClass(el, name) {
  return String(el.className || '').split(/\s+/).includes(name);
}

function collect(el, selector) {
  const name = selector.replace(/^\./, '');
  const found = [];
  for (const child of el.children) {
    if (hasClass(child, name)) found.push(child);
    found.push(...collect(child, selector));
  }
  return found;
}

function makeElement() {
  const classes = new Set();
  const el = {
    className: '',
    dataset: {},
    innerHTML: '',
    children: [],
    parent: null,
    style: { setProperty() {} },
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    appendChild(child) {
      if (child.isFragment) {
        for (const sub of child.children) {
          sub.parent = el;
          el.children.push(sub);
        }
        child.children = [];
        return child;
      }
      child.parent = el;
      el.children.push(child);
      return child;
    },
    remove() {
      if (!el.parent) return;
      el.parent.children = el.parent.children.filter((c) => c !== el);
      el.parent = null;
    },
    querySelector: (selector) => collect(el, selector)[0] || null,
    querySelectorAll: (selector) => collect(el, selector),
  };
  return el;
}

// PAGE_SIZE = 2：第 2 页从「今天」分组中间开始，必须续接到已渲染的分组容器
function renderAllPages({ file, viewVar, itemFactory }) {
  const view = makeElement();
  const context = {
    Array, Math, Number, Object, String,
    PAGE_SIZE: 2,
    [viewVar]: view,
    renderQueue: [
      { type: 'header', label: '今天', count: 3 },
      { type: 'item', data: { id: 'a1' } },
      { type: 'item', data: { id: 'a2' } },
      { type: 'item', data: { id: 'a3' } },
      { type: 'header', label: '昨天', count: 1 },
      { type: 'item', data: { id: 'b1' } },
    ],
    renderedCount: 0,
    currentGroupLabel: '',
    isLoadingMore: false,
    SVG_PIN_FILL: '',
    escapeHtml: (str) => String(str || ''),
    i18n: (key, args = []) => (key === 'bookmarkCount' ? String(args[0]) : key),
    document: {
      createElement: () => makeElement(),
      createDocumentFragment: () => {
        const fragment = makeElement();
        fragment.isFragment = true;
        return fragment;
      },
    },
    [itemFactory]: (item) => {
      const el = makeElement();
      el.className = 'bookmark-item';
      el.dataset.id = item.id;
      return el;
    },
  };
  vm.createContext(context);
  new vm.Script(readFunction(readFileSync(file, 'utf8'), 'renderNextPage')).runInContext(context);
  context.renderNextPage();
  context.renderNextPage();
  context.renderNextPage();
  return { view, context };
}

const targets = [
  {
    label: 'popup',
    file: 'src/timeline/pages/popup/popup.js',
    viewVar: 'timelineContent',
    itemFactory: 'createBookmarkElement',
    groupClass: '.date-group',
    sentinelClass: '.load-more-sentinel',
  },
  {
    label: 'standalone',
    file: 'src/timeline/pages/standalone/standalone.js',
    viewVar: 'saTimelineView',
    itemFactory: 'createTimelineBookmarkElement',
    groupClass: '.sa-date-group',
    sentinelClass: '.sa-load-more-sentinel',
  },
];

for (const target of targets) {
  const { view, context } = renderAllPages(target);
  assert.equal(context.renderedCount, 6, `${target.label}: 三页应渲染完整个队列`);

  const groups = view.querySelectorAll(target.groupClass);
  assert.deepEqual(
    groups.map((g) => g.dataset.label),
    ['今天', '昨天'],
    `${target.label}: 日期分组容器只应由 header 创建，且顺序与队列一致`,
  );
  assert.deepEqual(
    groups.map((g) => g.children.map((c) => c.dataset.id)),
    [['a1', 'a2', 'a3'], ['b1']],
    `${target.label}: 跨页加载的书签必须留在自己的日期分组容器内`,
  );
  assert.deepEqual(
    view.children.filter((c) => hasClass(c, 'bookmark-item')).map((c) => c.dataset.id),
    [],
    `${target.label}: 书签不应脱离日期分组直接挂在时间轴容器下`,
  );
  assert.equal(
    view.querySelectorAll(target.sentinelClass).length,
    0,
    `${target.label}: 渲染完成后应移除加载哨兵`,
  );
}

console.log('popup/standalone 时间轴分页续接: OK');
