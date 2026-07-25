import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

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

const { classify } = await importTypeScript('src/core/classifier.ts');

const storage = {};
function makeChrome() {
  return {
    storage: {
      local: {
        async get(keys) {
          if (keys === null) return structuredClone(storage);
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.filter((n) => n in storage).map((n) => [n, structuredClone(storage[n])]));
        },
        async set(values) { Object.assign(storage, structuredClone(values)); },
        async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete storage[k]; },
      },
    },
    runtime: {
      async sendMessage(message) {
        if (message.action === 'labelCacheGet') return { success: true, cache: {} };
        if (message.action === 'labelCacheMerge') return { success: true, cache: {} };
        return { success: true };
      },
    },
    permissions: { async contains() { return false; } },
  };
}

const settings = {
  provider: 'custom',
  apiKey: 'test-key',
  baseUrl: 'https://api.example.test/v1',
  model: 'test-model',
  fontFamily: 'system',
  fontSize: 14,
  themeColor: '#0A84FF',
  language: 'zh',
  colorMode: 'light',
  customApiStyle: 'anthropic',
  customFullUrl: false,
  respectExistingFolders: false,
  useClassificationCache: false,
  usePageMetadata: false,
  allowPageContentForAi: false,
  useBuiltInClassificationRules: false,
  classifyPrompts: { label: 'L', buildTree: 'B', assign: 'A' },
  aiRetryCount: 0,
  aiRequestTimeoutSeconds: 5,
  labelBatchSize: 40,
  labelConcurrency: 1,
  assignBatchSize: 60,
};

// anthropic 格式响应：文本放在 content blocks（复现用户的 anthropic 场景）。
function jsonResponse(payload) {
  const body = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
  return { ok: true, status: 200, async json() { return JSON.parse(body); }, async text() { return body; } };
}

// 8 条书签，单批。模拟真实故障场景：分配阶段 AI
//  1) 用字符串 cat（"0" 而非 0）——放宽前会被 Number.isInteger 判死；
//  2) 漏掉最后 1 条——放宽前会让整次分类作废。
// 期望：分类成功，8 条全部有归属，漏项落入兜底“其他”。
const bookmarks = Array.from({ length: 8 }, (_, i) => ({
  id: `bm-${i}`,
  title: `Bookmark ${i}`,
  url: `https://example.test/${i}`,
  folderPath: 'Inbox',
}));

globalThis.chrome = makeChrome();
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  const userMsg = body.messages.find((m) => m.role === 'user')?.content ?? '';
  const ids = [...new Set([...userMsg.matchAll(/bm-\d+/g)].map((m) => m[0]))];
  if (userMsg.includes('分析以下书签')) {
    return jsonResponse(ids.map((id) => ({ id, summary: 's', tags: ['t'] })));
  }
  if (userMsg.includes('生成分类树')) {
    return jsonResponse([{ name: 'General' }]);
  }
  if (userMsg.includes('分配以下书签')) {
    // 字符串 cat + 漏掉最后一条
    return jsonResponse(ids.slice(0, -1).map((id) => ({ id, cat: '0' })));
  }
  return jsonResponse([]);
};

const result = await classify(settings, bookmarks, () => {}, new AbortController().signal, { mode: 'full' }, { persist: false });

// 收集树中所有 bookmarkIds
const collectIds = (nodes) =>
  nodes.reduce((acc, n) => {
    for (const id of n.bookmarkIds ?? []) acc.add(id);
    if (n.children) for (const id of collectIds(n.children)) acc.add(id);
    return acc;
  }, new Set());

const assignedIds = collectIds(result.tree);
assert.equal(assignedIds.size, 8, `字符串 cat + 漏项时仍应分配全部 8 条，实际 ${assignedIds.size} 条`);
for (const b of bookmarks) {
  assert.ok(assignedIds.has(b.id), `书签 ${b.id} 必须有归属，不得因个别漏项作废整次分类`);
}

// 漏掉的最后一条（bm-7）应落入兜底“其他”
const findNodeOf = (nodes, id, prefix = []) => {
  for (const n of nodes) {
    const path = [...prefix, n.name];
    if ((n.bookmarkIds ?? []).includes(id)) return path;
    if (n.children) {
      const hit = findNodeOf(n.children, id, path);
      if (hit) return hit;
    }
  }
  return null;
};
const fallbackPath = findNodeOf(result.tree, 'bm-7');
assert.ok(fallbackPath, 'bm-7 必须有归属节点');
assert.equal(fallbackPath[fallbackPath.length - 1], '其他', `漏掉的书签应兜底到“其他”，实际落在 ${fallbackPath.join('/')}`);

console.log('assign fallback recovery tests passed');
