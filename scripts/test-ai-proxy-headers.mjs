import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// 回归：调用方传 'content-type'，SW 代理再补 'Content-Type' 时，两个同名头会被 Fetch
// 合并成 "application/json, application/json"，严格校验该头的服务端（DeepSeek）会返回
// 415 "Expected request with `Content-Type: application/json`"。

function createFetchStub(calls) {
  return async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => '{"choices":[{"message":{"content":"OK"}}]}',
    };
  };
}

function loadBackgroundFetch() {
  const source = readFileSync('src/timeline/background/background.js', 'utf8');
  const start = source.indexOf('function isSafeExternalUrl(');
  const end = source.indexOf('function hasValidStringList(', start);
  assert.ok(start >= 0 && end > start, 'background.js should expose the AI proxy fetch path');

  const calls = [];
  const context = {
    AbortController,
    Boolean,
    Error,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    String,
    URL,
    clearTimeout,
    setTimeout,
    fetch: createFetchStub(calls),
  };
  vm.createContext(context);
  vm.runInContext(
    `${source.slice(start, end)}; this.proxy = { aiProxyFetch };`,
    context,
  );
  return { calls, aiProxyFetch: context.proxy.aiProxyFetch };
}

function loadTaggerFetch() {
  const source = readFileSync('src/timeline/shared/ai-tagger.js', 'utf8');
  const start = source.indexOf('function normalizeAiRequestHeaders(');
  const end = source.indexOf('function _isRetryableAIStatus(', start);
  assert.ok(start >= 0 && end > start, 'ai-tagger.js should expose the normalized fetch helper');

  const calls = [];
  const context = {
    AbortController,
    Error,
    JSON,
    Number,
    Object,
    Promise,
    String,
    clearTimeout,
    setTimeout,
    fetch: createFetchStub(calls),
  };
  vm.createContext(context);
  vm.runInContext(`${source.slice(start, end)}; this.tagger = { _doFetch };`, context);
  return { calls, doFetch: context.tagger._doFetch };
}

const body = JSON.stringify({ model: 'deepseek-flash', messages: [] });

// 1) SW 代理路径：页面传小写 content-type，最终只能出现一份
{
  const { calls, aiProxyFetch } = loadBackgroundFetch();
  const result = await aiProxyFetch({
    url: 'https://api.deepseek.com/v1/chat/completions',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer sk-test' },
    body,
    timeoutMs: 5000,
  });
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  const sent = new Headers(calls[0].init.headers);
  assert.equal(sent.get('content-type'), 'application/json', 'content-type 不得被拼成 "application/json, application/json"');
  assert.equal(sent.get('authorization'), 'Bearer sk-test');
  assert.deepEqual([...sent.keys()].filter((k) => k === 'content-type'), ['content-type']);
}

// 2) 调用方不带头时，代理仍要补上 JSON 头
{
  const { calls, aiProxyFetch } = loadBackgroundFetch();
  await aiProxyFetch({ url: 'https://api.deepseek.com/v1/chat/completions', headers: {}, body, timeoutMs: 5000 });
  const sent = new Headers(calls[0].init.headers);
  assert.equal(sent.get('content-type'), 'application/json');
}

// 3) 调用方给的首字母大写 + 非字符串值也要归一
{
  const { calls, aiProxyFetch } = loadBackgroundFetch();
  await aiProxyFetch({
    url: 'https://api.deepseek.com/v1/chat/completions',
    headers: { 'Content-Type': 'application/json', 'X-Trace': 42, 'X-Skip': null },
    body,
    timeoutMs: 5000,
  });
  const sent = new Headers(calls[0].init.headers);
  assert.equal(sent.get('content-type'), 'application/json');
  assert.equal(sent.get('x-trace'), '42');
  assert.equal(sent.get('x-skip'), null);
}

// 4) 分类链路（ai-tagger）同样只能有一份 content-type
{
  const { calls, doFetch } = loadTaggerFetch();
  await doFetch(
    'https://api.deepseek.com/v1/chat/completions',
    { 'content-type': 'application/json', Authorization: 'Bearer sk-test' },
    { model: 'deepseek-flash', messages: [] },
    5000,
  );
  const sent = new Headers(calls[0].init.headers);
  assert.equal(sent.get('content-type'), 'application/json');
  assert.equal(sent.get('authorization'), 'Bearer sk-test');
}

console.log('ai proxy header tests passed');
