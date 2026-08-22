import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

// 本文件覆盖“遗留问题第二轮修复”的回归：LLM JSON 修复不篡改字符串值、
// 死链检测公共后缀分组、RSS RDF/命名空间解析、AI 日志并发串行化、
// smart-tagger 串行化与标签颜色批量写、以及若干 UI 行为的源码契约。

async function importTypeScript(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

// ============ 1. LLM JSON 修复不篡改字符串值 ============
{
  const { extractJson } = await importTypeScript('src/core/llm.ts');

  // 值内的全角冒号必须保留（此前被全局替换成半角，摘要被永久改写）。
  const kept = extractJson(
    '[{"id":"1","summary":"教程：入门：指南"}]',
  );
  assert.equal(kept[0].summary, '教程：入门：指南', 'full-width colon inside string values must survive');

  // 结构位置的全角冒号/括号仍要修复（这是修复逻辑的本职）。
  const structural = extractJson(
    '［｛"id"："1"｝］',
  );
  assert.equal(structural[0].id, '1', 'full-width structural characters must still be repaired');

  // 值内的英文撇号必须保留（此前 ' 被全局换成 " 产出非法/被改写的 JSON）。
  const apostrophe = extractJson(
    '[{"id":"2","summary":"it\'s fine"}]',
  );
  assert.equal(apostrophe[0].summary, "it's fine", 'apostrophes inside double-quoted values must survive');

  // 单引号作为定界符（结构位置）仍要被修复成双引号。
  const singleQuoted = extractJson(
    "{'id':'3','summary':'ok'}",
  );
  assert.equal(singleQuoted.id, '3');
  assert.equal(singleQuoted.summary, 'ok', 'delimiter-position single quotes must still be repaired');

  // 单引号包裹、内含撇号的值：定界符修复但撇号保留。
  const mixed = extractJson(
    "{'summary':'don't panic'}",
  );
  assert.equal(mixed.summary, "don't panic", 'delimiter quotes repaired without touching inner apostrophe');

  // 尾逗号移除不得影响字符串值内的 “, }” 文本。
  const trailing = extractJson(
    '{"summary":"a, } b",}',
  );
  assert.equal(trailing.summary, 'a, } b', 'trailing-comma repair must not touch string values');

  console.log('1. llm json repair checks passed');
}

// ============ 2. 死链检测公共后缀分组 ============
{
  const { rootDomain } = await importTypeScript('src/core/health.ts');
  assert.equal(rootDomain('https://github.io/a/b'), 'github.io', 'bare suffix host keeps two parts');
  assert.equal(rootDomain('https://user.github.io/x'), 'user.github.io', 'PaaS subdomains must not share one slot');
  assert.equal(rootDomain('https://a.co.uk/page'), 'a.co.uk', 'co.uk sites must not all share one slot');
  assert.equal(rootDomain('https://www.google.com/'), 'google.com', 'regular domains unchanged');
  assert.equal(rootDomain('https://blog.example.co.uk/'), 'example.co.uk', 'four-part hosts keep the registered domain (last three)');
  assert.equal(rootDomain('not a url'), 'not a url', 'invalid url falls back to raw string');
  console.log('2. root domain suffix checks passed');
}

// ============ 3. RSS：RDF 与命名空间 Atom ============
{
  const source = readFileSync('src/timeline/shared/rss-parser.js', 'utf8');
  const vm = await import('node:vm');
  const context = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    TextDecoder: class { decode() { return ''; } },
  };
  context.self = context;
  vm.runInNewContext(source, context);
  const { parseFeed } = context.RssParser;

  // RSS 1.0 (RDF)：item 是 channel 的兄弟节点。
  const rdfFeed = await parseFeed(`<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
  <channel>
    <title>RDF Site</title>
    <link>https://rdf.example.com</link>
    <description>rdf feed</description>
  </channel>
  <item>
    <title>RDF Item A</title>
    <link>https://rdf.example.com/a</link>
  </item>
  <item>
    <title>RDF Item B</title>
    <link>https://rdf.example.com/b</link>
  </item>
</rdf:RDF>`, 'https://rdf.example.com');
  assert.equal(rdfFeed.errorCode, undefined, `rdf parse must succeed, got ${rdfFeed.errorCode}`);
  assert.equal(rdfFeed.title, 'RDF Site');
  assert.equal(rdfFeed.items.length, 2, 'rdf items are siblings of channel and must be found');
  assert.equal(rdfFeed.items[0].title, 'RDF Item A');

  // 带命名空间前缀的 Atom。
  const atomFeed = await parseFeed(`<?xml version="1.0"?>
<atom:feed xmlns:atom="http://www.w3.org/2005/Atom">
  <atom:title>Namespaced Atom</atom:title>
  <atom:entry>
    <atom:title>Entry 1</atom:title>
    <atom:link href="https://atom.example.com/1"/>
  </atom:entry>
  <atom:entry>
    <atom:title>Entry 2</atom:title>
    <atom:link href="https://atom.example.com/2"/>
  </atom:entry>
</atom:feed>`, 'https://atom.example.com');
  assert.equal(atomFeed.errorCode, undefined, `namespaced atom must parse, got ${atomFeed.errorCode}`);
  assert.equal(atomFeed.items.length, 2, 'atom:entry blocks must be extracted');
  assert.equal(atomFeed.items[0].title, 'Entry 1');

  // 普通 RSS 2.0 不回归。
  const rss2 = await parseFeed(`<?xml version="1.0"?>
  <rss version="2.0"><channel>
    <title>RSS2</title><link>https://r2.example.com</link><description>d</description>
    <item><title>T</title><link>https://r2.example.com/t</link></item>
  </channel></rss>`, 'https://r2.example.com');
  assert.equal(rss2.items.length, 1);
  assert.equal(rss2.items[0].title, 'T');
  console.log('3. rss rdf/namespace checks passed');
}

// ============ 4. AI 日志并发串行化 ============
{
  const source = readFileSync('src/timeline/shared/ai-logger.js', 'utf8');
  const values = new Map();
  // 故意在 set 前插入延迟，放大旧实现 get→push→set 的交错窗口。
  const storage = {
    local: {
      get: async (key) => ({ [key]: structuredClone(values.get(key) ?? []) }),
      set: async (patch) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        for (const [key, value] of Object.entries(patch)) values.set(key, structuredClone(value));
      },
      remove: async (key) => values.delete(key),
    },
  };
  const vm = await import('node:vm');
  const context = { console, setTimeout, clearTimeout, chrome: { storage, runtime: { sendMessage: async () => {} } } };
  vm.runInNewContext(source, context);
  const { logAIEvent, getAILogs } = context;

  await Promise.all(Array.from({ length: 25 }, (_, index) =>
    logAIEvent({ type: 'classify_success', duration: index })));
  const logs = await getAILogs(500);
  assert.equal(logs.length, 25, `concurrent log writes must not lose entries (got ${logs.length})`);
  console.log('4. ai-logger serialization checks passed');
}

// ============ 5. smart-tagger：串行化 + 标签颜色批量写 ============
{
  const source = readFileSync('src/timeline/shared/smart-tagger.js', 'utf8');
  const values = new Map();
  let colorWriteCount = 0;
  const storage = {
    local: {
      get: async (key) => {
        if (key === null) return Object.fromEntries(values);
        if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, values.get(item)]));
        return { [key]: structuredClone(values.get(key)) };
      },
      set: async (patch) => {
        await new Promise((resolve) => setTimeout(resolve, 3));
        for (const [key, value] of Object.entries(patch)) values.set(key, structuredClone(value));
        if (Object.prototype.hasOwnProperty.call(patch, 'tag_colors')) colorWriteCount += 1;
      },
      remove: async () => {},
    },
  };
  const vm = await import('node:vm');
  const context = {
    console, setTimeout, clearTimeout, URL, TextEncoder,
    chrome: { storage, runtime: { sendMessage: async () => {} } },
  };
  vm.runInNewContext(source, context);

  // 5a. 颜色：确定性计算 + 批量持久化（不再逐标签一次全量写）。
  const first = await context.getTagColor('never-seen-tag');
  const second = await context.getTagColor('never-seen-tag');
  assert.equal(first, second, 'generated colors must be deterministic');
  assert.equal(colorWriteCount, 0, 'rule/hash colors must not be eagerly persisted');

  // 5b. 并发语料更新不丢计数。
  await Promise.all(Array.from({ length: 20 }, (_, index) =>
    context.updateTagCorpus(`document text about topic ${index % 4}`, ['tech'])));
  const corpus = (await storage.local.get('tag_bayesian_corpus'))['tag_bayesian_corpus'];
  const tokenCount = Object.values(corpus.tagFreq.tech ?? {}).reduce((sum, count) => sum + count, 0);
  assert.ok(tokenCount >= 20, `concurrent corpus updates must all be counted (got ${tokenCount})`);
  console.log('5. smart-tagger serialization checks passed');
}

// ============ 6. UI/主题等源码契约 ============
{
  const standalone = readFileSync('src/timeline/pages/standalone/standalone.js', 'utf8');
  assert.doesNotMatch(standalone, /theme = data\.theme \|\| 'light'/, 'standalone must default to system, matching popup/checker');
  assert.doesNotMatch(standalone, /matchMedia\('\(prefers-color-scheme: dark\)'\)\.matches \? 'dark' : 'light'\s*;\s*\}\s*applyTheme/, 'system must not be eagerly resolved to a fixed theme');

  const graph = readFileSync('src/timeline/pages/graph/graph.js', 'utf8');
  assert.doesNotMatch(graph, /await rebuild\(\);\s*zoomLevelEl\.textContent = '100%'/, 'initial graph zoom label must reflect the real zoom');

  const app = readFileSync('src/sidepanel/App.tsx', 'utf8');
  assert.match(app, /setNotice\(''\), 8000/, 'notice banners must auto-dismiss');
  assert.match(app, new RegExp("setError\\(''\\);\\s*\\n\\s*setNotice\\(''\\);\\s*\\n\\s*\\}, \\[workspaceView\\]\\);"), 'view switches must clear stale banners');
  assert.match(app, /t\(uiSettingsRef\.current\.language\)\.classifyFailed/, 'incremental failures must read the live language');
  assert.match(app, /UNPIN_WOULD_EVICT_VERSION/, 'unpin eviction must be explained to the user');
  assert.match(app, /deleteClassificationPlanVersion\(/, 'historical versions must be deletable from the UI');
  assert.match(app, /savingDraft\s*\?\s*<div className="edit-hint">/, 'draft saves must be visible while in progress');

  const llmSource = readFileSync('src/core/llm.ts', 'utf8');
  assert.match(llmSource, /mapOutsideDoubleQuotedStrings/, 'llm repair must be string-literal aware');
  assert.doesNotMatch(llmSource, /\.replace\(\/：\/g/, 'global full-width colon replacement must be gone');

  console.log('6. source contract checks passed');
}

console.log('residual fixes regression checks passed');
