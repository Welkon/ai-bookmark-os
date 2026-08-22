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

const {
  buildChangeHistoryTree,
  changeOriginLabel,
} = await importTypeScript('src/sidepanel/changeHistory.ts');

const changes = [
  {
    kind: 'moved', id: 'a', nodeKind: 'bookmark',
    before: { id: 'a', kind: 'bookmark', index: 0, title: 'API 文档' },
    after: { id: 'a', kind: 'bookmark', index: 0, title: 'API 文档' },
    beforePath: '书签栏 / 收集箱 / API 文档',
    afterPath: '书签栏 / AI 整理 / 开发 / API 文档',
  },
  {
    kind: 'moved', id: 'b', nodeKind: 'bookmark',
    before: { id: 'b', kind: 'bookmark', index: 1, title: '设计灵感' },
    after: { id: 'b', kind: 'bookmark', index: 0, title: '设计灵感' },
    beforePath: '书签栏 / 收集箱 / 设计灵感',
    afterPath: '书签栏 / AI 整理 / 设计 / 设计灵感',
  },
  {
    kind: 'removed', id: 'c', nodeKind: 'bookmark',
    before: { id: 'c', kind: 'bookmark', index: 2, title: '旧书签' },
    beforePath: '书签栏 / 收集箱 / 旧书签',
  },
];

const tree = buildChangeHistoryTree(changes);
assert.equal(tree.count, 3);
assert.deepEqual(tree.children.map((node) => node.name), ['书签栏']);
assert.equal(tree.children[0].children[0].name, 'AI 整理');
assert.equal(tree.children[0].children[0].count, 2);
assert.equal(tree.children[0].children[1].name, '收集箱');
assert.equal(tree.children[0].children[1].changes[0].id, 'c');
assert.equal(changeOriginLabel(changes[0]), '来自 书签栏 / 收集箱');

// 回归：Chrome 允许同一父目录下存在同名文件夹。两个同名目录的变更不得并进
// 同一分支（计数错乱），且树的 key 必须唯一（React key 冲突会导致渲染异常）。
const duplicateFolderChanges = [
  {
    kind: 'moved', id: 'folder-1', nodeKind: 'folder',
    before: { id: 'folder-1', kind: 'folder', index: 0, title: '项目' },
    after: { id: 'folder-1', kind: 'folder', index: 0, title: '项目' },
    beforePath: '收集箱 / 项目',
    afterPath: '书签栏 / 项目',
  },
  {
    kind: 'moved', id: 'folder-2', nodeKind: 'folder',
    before: { id: 'folder-2', kind: 'folder', index: 1, title: '项目' },
    after: { id: 'folder-2', kind: 'folder', index: 1, title: '项目' },
    beforePath: '旧目录 / 项目',
    afterPath: '书签栏 / 项目',
  },
];
const dupTree = buildChangeHistoryTree(duplicateFolderChanges);
const bar = dupTree.children[0];
assert.equal(bar.children.length, 2, 'same-named sibling folders must stay separate branches');
assert.deepEqual(bar.children.map((node) => node.name), ['项目', '项目']);
const allKeys = [bar.key, ...bar.children.map((node) => node.key)];
assert.equal(new Set(allKeys).size, allKeys.length, 'node keys must be unique');
// 旧数据（书签变更）仍按 afterPath 目录聚合，行为不回退。
const bookmarkOnly = buildChangeHistoryTree([
  {
    kind: 'moved', id: 'm1', nodeKind: 'bookmark',
    before: { id: 'm1', kind: 'bookmark', index: 0, title: 'x' },
    after: { id: 'm1', kind: 'bookmark', index: 0, title: 'x' },
    beforePath: '书签栏 / 临时 / x',
    afterPath: '书签栏 / 工作 / x',
  },
]);
assert.equal(bookmarkOnly.children[0].name, '书签栏');
assert.equal(bookmarkOnly.children[0].children.length, 1);
assert.equal(bookmarkOnly.children[0].children[0].name, '工作');

console.log('change history tree checks passed');
