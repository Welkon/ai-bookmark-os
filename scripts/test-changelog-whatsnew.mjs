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

// 已维护版本区间：跨多版本升级累积展示（0.5.1 -> 1.0.10 应包含 1.0.7、1.0.9 与 1.0.10）。
const real = resolveWhatsNewEntries('0.5.1', '1.0.10');
assert.ok(real.length >= 3, `expected accumulated entries, got ${real.length}`);
assert.ok(real.some((entry) => entry.version === '1.0.10'));
assert.ok(real.some((entry) => entry.version === '1.0.9'));
assert.ok(real.some((entry) => entry.version === '1.0.7'));

// 版本号按段数字比较：1.0.10 必须大于 1.0.9（字符串比较会得出相反结果，
// 导致 1.0.9 -> 1.0.10 的升级弹窗永不出现）。
assert.deepEqual(
  entriesSince('1.0.9', '1.0.10').map((entry) => entry.version),
  ['1.0.10'],
  '1.0.10 必须被判定为高于 1.0.9',
);
for (const entry of real) {
  assert.ok(Array.isArray(entry.zh) && entry.zh.length > 0);
  assert.ok(Array.isArray(entry.en) && entry.en.length > 0);
}

// 未维护区间（尚未追加条目的版本区间）：只要发生升级就退回通用提示，
// 不允许静默吞掉更新弹窗（回归：0.5.1 之后长期未维护 CHANGELOG 时弹窗永不出现）。
// 注意区间要选当前 CHANGELOG 确实没有条目的范围：CHANGELOG 维护到哪个版本，
// 这里的下界就要跟着上移，否则断言的是"有条目"而非"无条目"，测试意图会反过来。
const fallback = resolveWhatsNewEntries('1.1.0', '1.2.0');
assert.equal(entriesSince('1.1.0', '1.2.0').length, 0);
assert.equal(fallback.length, 1);
assert.equal(fallback[0].version, '1.2.0');
assert.ok(fallback[0].zh.length > 0 && fallback[0].en.length > 0);

// 版本未变化（如重装/修复后 from==to）：不展示弹窗。
assert.equal(resolveWhatsNewEntries('1.0.9', '1.0.9').length, 0);

// CHANGELOG 按版本倒序维护（新版本在最前），条目版本唯一。
const versions = CHANGELOG.map((entry) => entry.version);
assert.equal(new Set(versions).size, versions.length, 'changelog versions must be unique');

console.log('changelog what\'s-new fallback checks passed');
