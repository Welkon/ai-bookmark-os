// 生成发布资产：可直接加载的扩展包 + 源码快照。
//
// 为什么不用 PowerShell 的 Compress-Archive：它在 Windows 上把条目名写成反斜杠
// （`ai\sidepanel.html`），违反 ZIP 规范（APPNOTE 4.4.17.1 要求 '/'）。这样的包解压后
// 目录结构会退化成字面文件名，扩展无法加载——v1.0.10 发布时已实际踩中并修正。
// 这里显式用 .NET ZipArchive 逐条写入正斜杠条目名，并在写完后校验。
//
// 用法：node scripts/package-release.mjs
// 产出：release/ai-bookmark-os-v<version>-chromium-extension.zip
//       release/ai-bookmark-os-v<version>-source.zip

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const distDir = join(repoRoot, 'dist');
const releaseDir = join(repoRoot, 'release');

const pkgVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
const distManifestPath = join(distDir, 'manifest.json');
if (!existsSync(distManifestPath)) {
  throw new Error('dist/manifest.json 不存在，请先执行 npm run build');
}
const distVersion = JSON.parse(readFileSync(distManifestPath, 'utf8')).version;
if (distVersion !== pkgVersion) {
  throw new Error(`dist 版本(${distVersion}) 与 package.json(${pkgVersion}) 不一致，请重新构建`);
}

mkdirSync(releaseDir, { recursive: true });
const extZip = join(releaseDir, `ai-bookmark-os-v${pkgVersion}-chromium-extension.zip`);
const srcZip = join(releaseDir, `ai-bookmark-os-v${pkgVersion}-source.zip`);

// PowerShell 脚本保持纯 ASCII：无 BOM 的 .ps1 会被 PowerShell 5.1 按系统代码页读取，
// 非 ASCII 注释被错解后可能产生引号类字符并吞掉后续行。
// 路径也不经命令行传递（仓库路径可能含非 ASCII），改为脚本内写死后由此处生成。
const psScript = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [System.IO.File]::ReadAllText($env:AIBK_SRC_FILE, [System.Text.Encoding]::UTF8)
$zipPath = [System.IO.File]::ReadAllText($env:AIBK_ZIP_FILE, [System.Text.Encoding]::UTF8)
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
$rootPath = (Resolve-Path $root).Path.TrimEnd('\\')
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
  $files = Get-ChildItem -Path $rootPath -Recurse -File | Sort-Object FullName
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($rootPath.Length + 1).Replace('\\', '/')
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal)
  }
  Write-Output $files.Count
} finally {
  $zip.Dispose()
}
`;

function zipDirectoryWithForwardSlashes(sourceDir, zipPath) {
  if (process.platform !== 'win32') {
    // Unix 的 zip 原生写正斜杠
    execFileSync('zip', ['-r', '-q', zipPath, '.'], { cwd: sourceDir });
    return;
  }
  const tmpPs = join(releaseDir, '.package-release.ps1');
  const tmpSrc = join(releaseDir, '.src-path.txt');
  const tmpZip = join(releaseDir, '.zip-path.txt');
  writeFileSync(tmpPs, psScript, 'ascii');
  writeFileSync(tmpSrc, sourceDir, 'utf8');
  writeFileSync(tmpZip, zipPath, 'utf8');
  try {
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpPs], {
      env: { ...process.env, AIBK_SRC_FILE: tmpSrc, AIBK_ZIP_FILE: tmpZip },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    for (const f of [tmpPs, tmpSrc, tmpZip]) rmSync(f, { force: true });
  }
}

function listZipEntries(zipPath) {
  if (process.platform !== 'win32') {
    return execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).split('\n').filter(Boolean);
  }
  const tmpPs = join(releaseDir, '.list-zip.ps1');
  const tmpZip = join(releaseDir, '.zip-path.txt');
  writeFileSync(tmpPs, `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipPath = [System.IO.File]::ReadAllText($env:AIBK_ZIP_FILE, [System.Text.Encoding]::UTF8)
$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try { $zip.Entries | ForEach-Object { $_.FullName } } finally { $zip.Dispose() }
`, 'ascii');
  writeFileSync(tmpZip, zipPath, 'utf8');
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpPs], {
      env: { ...process.env, AIBK_ZIP_FILE: tmpZip },
      encoding: 'utf8',
    });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } finally {
    for (const f of [tmpPs, tmpZip]) rmSync(f, { force: true });
  }
}

// 1) 扩展包：压 dist 的内容，manifest.json 必须落在压缩包根层
rmSync(extZip, { force: true });
zipDirectoryWithForwardSlashes(distDir, extZip);

// 2) 源码包：git archive 原生输出正斜杠，且自动排除 .gitignore 的内容
rmSync(srcZip, { force: true });
execFileSync('git', ['archive', '--format=zip', '-o', srcZip, 'HEAD'], { cwd: repoRoot });

// 3) 校验两个包：正斜杠、manifest 在根层、版本一致
for (const [label, zipPath] of [['extension', extZip], ['source', srcZip]]) {
  const entries = listZipEntries(zipPath);
  if (entries.length === 0) throw new Error(`${label} 包为空`);
  const backslash = entries.filter((e) => e.includes('\\'));
  if (backslash.length > 0) {
    throw new Error(`${label} 包含反斜杠条目名（违反 ZIP 规范，解压后目录结构会损坏）：${backslash.slice(0, 3).join(', ')}`);
  }
  console.log(`${label}: ${entries.length} entries, no backslash separators`);
  if (label === 'extension' && !entries.includes('manifest.json')) {
    throw new Error('扩展包根层缺少 manifest.json：用户加载时会直接失败');
  }
}

console.log(`Release assets ready for v${pkgVersion}:`);
console.log(`  ${extZip}`);
console.log(`  ${srcZip}`);
