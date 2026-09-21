#!/usr/bin/env node
// check_assets.mjs
//
// 公開前提リポジトリ(p98lib)向けの混入検査。
// 「docs/assets.md の“使ってよい”一覧に無い素材」「_local/ 由来のパス」
// 「生の画像/ディスク系ファイルそのもの」がコミットに入るのを機械的に止める。
//
// p98libは画像ファイル自体をコミットしない方針(docs/assets.md参照)。
// コミットしてよいのは変換済みのCバイト配列(samples/*.h, tests/*.h)だけで、
// その先頭コメントの「元データ: <ファイル名>」が docs/assets.md の
// 「使ってよい」表にある名前(またはワイルドカードパターン)と一致することを確認する。
//
// 使い方:
//   node tools/check_assets.mjs          # ステージされたファイルを検査
//   node tools/check_assets.mjs --all    # 追跡中の全ファイルを検査(公開前の一括確認用)
//
// 違反があれば理由とパス名だけを標準エラーへ出し、exit 1 する。
// ファイルの中身(素材のバイト列そのもの)は出力しない。

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);

// 画像/ディスク/サウンド系の「生素材」拡張子。p98libにはこの形では一切コミットしない。
const RAW_ASSET_EXTS = new Set([
  '.mag', '.kya', '.grp', '.kdt', '.dat', '.bmp', '.png', '.jpg', '.jpeg',
  '.pcm', '.wav', '.d88', '.fdi', '.xdf', '.hdi',
]);

const MAX_SIZE = 1024 * 1024; // 1MB。生成物のCヘッダも含め、これを超えたら要確認。

function gitFiles(mode) {
  const args = mode === 'all'
    ? ['ls-files', '-z']
    : ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'];
  const out = execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

function parseAllowList(assetsMdText) {
  // "## 使ってよい" 〜 次の "## " までの表から、バッククォートで囲まれたパスパターンを集める。
  const startMarker = '## 使ってよい';
  const start = assetsMdText.indexOf(startMarker);
  if (start === -1) throw new Error('docs/assets.md に "## 使ってよい" 節が見つからない');
  const rest = assetsMdText.slice(start + startMarker.length);
  const nextHeading = rest.indexOf('\n## ');
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

  const patterns = [];
  for (const line of section.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const backticked = line.match(/`([^`]+)`/g);
    if (!backticked) continue;
    for (const tok of backticked) {
      const pattern = tok.slice(1, -1).trim();
      if (pattern) patterns.push(pattern);
    }
  }
  return patterns;
}

function parseDenyList(assetsMdText) {
  const startMarker = '## 使わない';
  const start = assetsMdText.indexOf(startMarker);
  if (start === -1) return [];
  const rest = assetsMdText.slice(start + startMarker.length);
  const nextHeading = rest.indexOf('\n## ');
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  const names = [];
  for (const line of section.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const backticked = line.match(/`([^`]+)`/g);
    if (!backticked) continue;
    for (const tok of backticked) {
      const pattern = tok.slice(1, -1).trim();
      if (pattern) names.push(pattern);
    }
  }
  return names;
}

// パターン中の "*" だけをワイルドカードとして扱い、パスの basename 同士で比較する。
function basenameMatches(pattern, name) {
  const patBase = pattern.split('/').pop();
  const re = new RegExp('^' + patBase.split('*').map(escapeRe).join('.*') + '$', 'i');
  return re.test(name);
}
function escapeRe(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function extractSourceName(headerText) {
  const m = headerText.match(/元データ:\s*([^\s(（]+)/);
  return m ? m[1] : null;
}

function main() {
  const mode = process.argv.includes('--all') ? 'all' : 'staged';
  const assetsMdText = readFileSync(resolve(REPO_ROOT, 'docs/assets.md'), 'utf8');
  const allowPatterns = parseAllowList(assetsMdText);
  const denyNames = parseDenyList(assetsMdText);

  const violations = [];
  const files = gitFiles(mode);

  for (const relPath of files) {
    const abs = resolve(REPO_ROOT, relPath);
    const ext = extname(relPath).toLowerCase();
    const base = basename(relPath);

    // 1. _local/ 由来のパスが混ざっていないか(このrepoは_local/を追跡しない前提)。
    if (relPath.split('/').includes('_local')) {
      violations.push(`${relPath} -- _local/ 配下のパスはコミット禁止`);
      continue;
    }

    // 2. 生の画像/ディスク系拡張子はこのrepoには一切コミットしない方針。
    if (RAW_ASSET_EXTS.has(ext)) {
      violations.push(`${relPath} -- 生素材の拡張子(${ext})はコミット禁止(docs/assets.mdの方針: 変換済みの.hのみコミット)`);
      continue;
    }

    let size;
    try { size = statSync(abs).size; } catch { size = 0; }
    if (size > MAX_SIZE) {
      violations.push(`${relPath} -- サイズが1MBを超えている(${size} bytes)。生成物のはずが大きすぎないか確認`);
    }

    // 3. 素材由来のCヘッダ(samples/*.h, tests/*.h)は、コメントの「元データ:」を
    //    docs/assets.md の許可一覧と突き合わせる。
    if (ext === '.h' && (relPath.startsWith('samples/') || relPath.startsWith('tests/'))) {
      let text;
      try { text = readFileSync(abs, 'utf8'); } catch { text = ''; }
      const srcName = extractSourceName(text);
      if (srcName) {
        const denied = denyNames.find((d) => basenameMatches(d, srcName));
        if (denied) {
          violations.push(`${relPath} -- 元データ「${srcName}」は docs/assets.md の「使わない」一覧に一致(${denied})`);
          continue;
        }
        const allowed = allowPatterns.some((p) => basenameMatches(p, srcName));
        if (!allowed) {
          violations.push(`${relPath} -- 元データ「${srcName}」が docs/assets.md の「使ってよい」一覧に見つからない`);
        }
      }
    }
  }

  if (violations.length > 0) {
    process.stderr.write('check_assets: 混入検査で違反が見つかりました。コミットを中止します。\n\n');
    for (const v of violations) process.stderr.write(`違反: ${v}\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0;
}

main();
