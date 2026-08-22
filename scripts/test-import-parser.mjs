import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// shared/import-parser.js 是浏览器全局脚本（window.ImportParser）：直接以文本求值加载。
const source = readFileSync('src/timeline/shared/import-parser.js', 'utf8');
globalThis.window = globalThis;
new Function(source)();

const { parseImportedHTML, parseImportedJSON } = globalThis.ImportParser;

// —— 最小 DOMParser shim：只实现 import-parser 用到的 Netscape 书签文件结构 ——
// 将 <DL><DT><H3>/<A> 文档解析为 { children, tagName, textContent, getAttribute } 节点树。
function makeNode(tagName, textContent, attrs) {
  return {
    tagName,
    textContent,
    attrs: attrs || {},
    children: [],
    getAttribute(name) { return this.attrs[name] ?? null; },
  };
}
function tokenize(html) {
  const tokens = [];
  const re = /<(\/?)(dl|dt|h3|a)\b([^>]*)>([^<]*)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    tokens.push({ closing: m[1] === '/', tag: m[2].toUpperCase(), attrs: m[3] || '', text: m[4] || '' });
  }
  return tokens;
}
function attrsOf(raw) {
  const attrs = {};
  const re = /([a-z_]+)\s*=\s*"([^"]*)"/gi;
  let m;
  while ((m = re.exec(raw)) !== null) attrs[m[1].toLowerCase()] = m[2];
  return attrs;
}
function buildTree(html) {
  const root = makeNode('#root', '', {});
  // 容器栈：根 + 各个已打开的 DL。Netscape 格式里 H3/A 总是跟在某个 <DT> 之后
  // （解析器通过 directChild(DT, 'H3'/'A') 读取），DL 则作为 DT 的兄弟节点出现。
  const stack = [root];
  const attachLeaf = (node) => {
    const container = stack[stack.length - 1];
    const last = container.children[container.children.length - 1];
    if (last && last.tagName === 'DT') last.children.push(node);
    else {
      const dt = makeNode('DT', '', {});
      dt.children.push(node);
      container.children.push(dt);
    }
  };
  for (const token of tokenize(html)) {
    if (token.closing) {
      // 只有 </DL> 结束容器；</H3>、</A> 等叶子闭合标签不参与栈操作。
      if (token.tag === 'DL' && stack.length > 1) stack.pop();
      continue;
    }
    if (token.tag === 'DT') {
      stack[stack.length - 1].children.push(makeNode('DT', token.text, attrsOf(token.attrs)));
      continue;
    }
    if (token.tag === 'DL') {
      const dl = makeNode('DL', token.text, attrsOf(token.attrs));
      stack[stack.length - 1].children.push(dl);
      stack.push(dl);
      continue;
    }
    attachLeaf(makeNode(token.tag, token.text, attrsOf(token.attrs)));
  }
  return root;
}
globalThis.DOMParser = class {
  parseFromString(html) {
    const root = buildTree(String(html));
    return {
      querySelector(selector) {
        if (selector !== 'dl') throw new Error(`unsupported selector in shim: ${selector}`);
        const find = (node) => {
          for (const child of node.children) {
            if (child.tagName === 'DL') return child;
            const nested = find(child);
            if (nested) return nested;
          }
          return null;
        };
        return find(root);
      },
      querySelectorAll(selector) {
        if (selector !== 'a[href]') throw new Error(`unsupported selector in shim: ${selector}`);
        const anchors = [];
        const walk = (node) => {
          for (const child of node.children) {
            if (child.tagName === 'A' && child.attrs.href != null) anchors.push(child);
            walk(child);
          }
        };
        walk(root);
        return anchors;
      },
    };
  }
};

// —— HTML：嵌套文件夹 + 根目录名折叠 + ADD_DATE + URL 白名单 ——
const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
  <DT><H3>书签栏</H3>
  <DL><p>
    <DT><H3>开发</H3>
    <DL><p>
      <DT><A HREF="https://example.com/docs" ADD_DATE="1700000000">文档</A>
      <DT><A HREF="javascript:alert(1)">脚本</A>
      <DT><A HREF="about:blank">关于</A>
    </DL><p>
    <DT><A HREF="ftp://files.example.com/pkg" ADD_DATE="1700000001000" TAGS="工具,下载">安装包</A>
    <DT><H3>Tools / Docs</H3>
    <DL><p>
      <DT><A HREF="https://example.com/t">含斜杠目录下的书签</A>
    </DL><p>
  </DL><p>
</DL><p>`;
const parsedHtml = parseImportedHTML(html);
assert.equal(parsedHtml.items.length, 3, 'javascript:/about: entries must be dropped by the URL whitelist');
const docs = parsedHtml.items.find((item) => item.title === '文档');
assert.equal(docs.url, 'https://example.com/docs');
// 根目录名（书签栏）按解析器设计折叠为空路径，路径从其下一级开始。
assert.equal(docs.folderPath, '开发', 'nested folder path must be preserved');
assert.equal(docs.dateAdded, 1700000000 * 1000, 'ADD_DATE (seconds) must convert to ms');
const pkg = parsedHtml.items.find((item) => item.title === '安装包');
assert.equal(pkg.dateAdded, 1700000001000, 'ADD_DATE already in ms must pass through');
assert.deepEqual(pkg.tags, ['工具', '下载']);
assert.equal(pkg.folderPath, '', 'top-level bookmarks under the collapsed root keep an empty path');
// 目录名本身含 “ / ”（如 “Tools / Docs”）必须作为单段保留，不得被拆层。
assert.ok(parsedHtml.folderPaths.includes('Tools / Docs'), 'folder titles containing " / " must stay one segment');
assert.ok(!parsedHtml.folderPaths.some((p) => p === 'Tools' || p.endsWith('/Tools') || p.startsWith('Tools/')));
assert.ok(parsedHtml.folderPaths.includes('开发'));

// 空文档：回退为全量 <a> 扫描；无任何合法链接时 items 为空。
const fallbackScan = parseImportedHTML('<html><body><a href="https://x.example.com/1">x</a></body></html>');
assert.equal(fallbackScan.items.length, 1);
assert.equal(fallbackScan.items[0].url, 'https://x.example.com/1');

// —— JSON：v2 roots 结构与平铺列表 ——
const v2 = parseImportedJSON(JSON.stringify({
  version: 2,
  roots: [
    {
      type: 'folder', title: '书签栏',
      children: [
        { type: 'folder', title: '新闻', children: [{ type: 'bookmark', title: 'HN', url: 'https://news.ycombinator.com', dateAdded: 123, metadata: { tags: ['tech'] } }] },
      ],
    },
  ],
}));
assert.equal(v2.items.length, 1);
assert.equal(v2.items[0].folderPath, '新闻', 'root folder name 书签栏 must collapse to empty path');
assert.deepEqual(v2.items[0].tags, ['tech']);
assert.ok(v2.folderPaths.includes('新闻'));

const flat = parseImportedJSON(JSON.stringify([
  { title: 'a', url: 'https://a.example.com', folderPath: '工作/日报', dateAdded: 5 },
  { title: 'b', url: 'https://b.example.com' },
]));
assert.equal(flat.items.length, 2);
assert.deepEqual(flat.folderPaths, ['工作/日报']);

assert.equal(parseImportedJSON('{ not json'), null);
const emptyHtml = parseImportedHTML('<p>no bookmarks here</p>');
assert.equal(emptyHtml.items.length, 0);

console.log('import parser checks passed');
