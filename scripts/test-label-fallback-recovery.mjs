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

// anthropic 格式：extract 读 data.content（块数组）
const settings = {
  provider: 'custom',
  apiKey: 'test-key',
  baseUrl: 'https://api.anthropic.com/v1',
  model: 'claude-opus-4-8',
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

function jsonResponse(payload) {
  const body = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
  return { ok: true, status: 200, async json() { return JSON.parse(body); }, async text() { return body; } };
}

// 8 条书签。打标阶段：无论重试多少次，bm-3 始终缺失（模拟模型对某条顽固不返回，
// 补偿 + 拆半到最小粒度仍拿不到）。旧逻辑会抛 "AI 标签结果不完整" 取消整次分类；
// 新逻辑应把 bm-3 兜底为空标签，流程继续，最终 8 条都进入分配结果。
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
    // 打标：永远漏掉 bm-3
    const returned = ids.filter((id) => id !== 'bm-3');
    return jsonResponse(returned.map((id) => ({ id, summary: 's', tags: ['t'] })));
  }
  if (userMsg.includes('生成分类树')) {
    return jsonResponse([{ name: 'General' }]);
  }
  if (userMsg.includes('分配以下书签')) {
    // 分配：AI 只处理有标签的书签，bm-3 也给出分配（避免 assign 侧影响本测试焦点）
    return jsonResponse(ids.map((id) => ({ id, cat: 0 })));
  }
  return jsonResponse([]);
};

const result = await classify(settings, bookmarks, () => {}, new AbortController().signal, { mode: 'full' }, { persist: false });

// 关键断言 1：分类没有因 bm-3 漏标而作废
assert.ok(result && Array.isArray(result.tree) && result.tree.length > 0, '分类不应因个别书签漏标而取消');

// 关键断言 2：8 条书签都有标签条目（bm-3 为兜底空标签）
assert.equal(Object.keys(result.labels).length, 8, '所有书签都应有标签条目（漏标者兜底为空标签）');
assert.deepEqual(result.labels['bm-3'], { id: 'bm-3', summary: '', tags: [] }, 'bm-3 应兜底为空标签');

// 关键断言 3：8 条书签全部落入分类树（每条都有归属）
const collectIds = (nodes) => nodes.flatMap((n) => [...(n.bookmarkIds ?? []), ...collectIds(n.children ?? [])]);
const assignedIds = new Set(collectIds(result.tree));
for (const b of bookmarks) {
  assert.ok(assignedIds.has(b.id), `${b.id} 应落入分类树`);
}

console.log('label fallback recovery tests passed');
