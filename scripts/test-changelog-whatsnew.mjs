import assert from 'node:assert/strict';
import { build } from 'esbuild';

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

const { CHANGELOG, entriesSince, resolveWhatsNewEntries } = await importTypeScript('src/core/changelog.ts');

// 已维护版本区间：跨多版本升级累积展示（0.5.1 -> 1.0.9 应包含 1.0.7 与 1.0.9）。
const real = resolveWhatsNewEntries('0.5.1', '1.0.9');
assert.ok(real.length >= 2, `expected accumulated entries, got ${real.length}`);
assert.ok(real.some((entry) => entry.version === '1.0.9'));
assert.ok(real.some((entry) => entry.version === '1.0.7'));
for (const entry of real) {
  assert.ok(Array.isArray(entry.zh) && entry.zh.length > 0);
  assert.ok(Array.isArray(entry.en) && entry.en.length > 0);
}

// 未维护区间（如 1.0.9 -> 1.1.0 且尚未追加条目）：只要发生升级就退回通用提示，
// 不允许静默吞掉更新弹窗（回归：0.5.1 之后长期未维护 CHANGELOG 时弹窗永不出现）。
const fallback = resolveWhatsNewEntries('1.0.9', '1.1.0');
assert.equal(entriesSince('1.0.9', '1.1.0').length, 0);
assert.equal(fallback.length, 1);
assert.equal(fallback[0].version, '1.1.0');
assert.ok(fallback[0].zh.length > 0 && fallback[0].en.length > 0);

// 版本未变化（如重装/修复后 from==to）：不展示弹窗。
assert.equal(resolveWhatsNewEntries('1.0.9', '1.0.9').length, 0);

// CHANGELOG 按版本倒序维护（新版本在最前），条目版本唯一。
const versions = CHANGELOG.map((entry) => entry.version);
assert.equal(new Set(versions).size, versions.length, 'changelog versions must be unique');

console.log('changelog what\'s-new fallback checks passed');
