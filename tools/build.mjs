#!/usr/bin/env node
// p98lib のCプログラムを、WorkbenchNP2 の SmallerC(huge model)+NASM(wasm)経由で
// MZ EXE(と、実行用フロッピーイメージ .xdf)へビルドする。
//
// 参照の仕方について(docs/design.md にも記載):
// WorkbenchNP2 の toolchain/*.mjs と smlrc-wasm/*.{js,wasm} を「相対パスでそのまま
// require/import」する。ビルド済み成果物をp98lib側へコピーする方式にはしなかった。
// 理由:
//   - huge model対応は2026-09時点でWorkbenchNP2 masterに入ったばかりで今後も
//     更新される見込みが高く、コピーすると鮮度が失われる(feedback_stale_artifacts_lie)
//   - wasm本体を含めてコピーすると数MB〜十数MBの重複バイナリを別リポジトリに
//     抱えることになる
//   - WorkbenchNP2側を書き換えないので、依存が壊れたときの原因切り分けがしやすい
// 欠点として、WorkbenchNP2チェックアウトがp98libの隣(../WorkbenchNP2)に無いと
// ビルドできない。開発機はこの前提を満たしている。

import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const WORKBENCH_ROOT = resolve(REPO_ROOT, '../WorkbenchNP2');
const WORKBENCH_TOOLCHAIN = join(WORKBENCH_ROOT, 'toolchain');

const require = createRequire(import.meta.url);

async function loadWorkbenchTools() {
  const { compileWithFactories } = await import(join(WORKBENCH_TOOLCHAIN, 'compile-core.mjs'));
  const { assemble } = await import(join(WORKBENCH_TOOLCHAIN, 'assemble.mjs'));
  const { loadDefaultHeaders } = await import(join(WORKBENCH_TOOLCHAIN, 'compile.mjs'));
  const { makeFd } = await import(join(WORKBENCH_TOOLCHAIN, 'makefd.mjs'));
  const createSmlrpp = require(join(WORKBENCH_TOOLCHAIN, 'smlrc-wasm', 'smlrpp.js'));
  const createSmlrc = require(join(WORKBENCH_TOOLCHAIN, 'smlrc-wasm', 'smlrc.js'));
  const createSmlrl = require(join(WORKBENCH_TOOLCHAIN, 'smlrc-wasm', 'smlrl.js'));
  return { compileWithFactories, assemble, loadDefaultHeaders, makeFd, createSmlrpp, createSmlrc, createSmlrl };
}

/**
 * p98.c (ライブラリ本体)とユーザーのCソースを1つの翻訳単位として結合してビルドする
 * (unity build)。WorkbenchNP2 の compile-core.mjs は1回のコンパイルにつき
 * C ソース1本だけを受け取り、複数.oのリンクは提供していないため。
 *
 * @param {string} userSourcePath ユーザーの main() を含む .c ファイル
 * @param {{libPath?: string}} [opts] libPath: 差し替えたいp98.c(故障注入版など)。省略時は src/p98.c
 * @returns {Promise<{ok:true, output:Uint8Array, assembly:Uint8Array, linkerMap:string} | {ok:false, errors:any[]}>}
 */
export async function buildProgram(userSourcePath, opts = {}) {
  const tools = await loadWorkbenchTools();
  const libPath = opts.libPath ?? join(REPO_ROOT, 'src', 'p98.c');
  const [libSource, userSource, library, includeFiles] = await Promise.all([
    readFile(libPath, 'utf8'),
    readFile(userSourcePath, 'utf8'),
    readFile(join(WORKBENCH_TOOLCHAIN, 'smlrc-wasm', 'lcdh.a')),
    tools.loadDefaultHeaders(),
  ]);
  const p98Header = await readFile(join(REPO_ROOT, 'include', 'p98.h'));
  includeFiles['p98.h'] = new Uint8Array(p98Header);

  // p98.c 自身も #include "p98.h" するので、includeFilesにヘッダを積んだうえで
  // 「p98.c本文 + ユーザーソース」を1本のCソースとして渡す。
  const combined = `${libSource}\n/* ---- ここから ${userSourcePath} ---- */\n${userSource}\n`;

  const result = await tools.compileWithFactories(new TextEncoder().encode(combined), {
    library: new Uint8Array(library), includeFiles, model: 'huge',
  }, {
    createSmlrpp: tools.createSmlrpp, createSmlrc: tools.createSmlrc,
    createSmlrl: tools.createSmlrl, assemble: tools.assemble,
  });
  return { ...result, makeFd: tools.makeFd };
}

function dosBaseName(name) {
  const stem = name.toUpperCase().replace(/[^A-Z0-9!#$%&'()\-@^_`{}~]/g, '_').slice(0, 8);
  if (!stem) throw new Error('cannot derive an 8.3 name');
  return stem;
}

async function main() {
  const [, , inputPath, outDirArg] = process.argv;
  if (!inputPath) {
    console.error('Usage: node tools/build.mjs <program.c> [outDir]');
    process.exitCode = 2;
    return;
  }
  const outDir = outDirArg ? resolve(outDirArg) : join(REPO_ROOT, 'build');
  await mkdir(outDir, { recursive: true });

  const libPath = process.env.P98_LIB_OVERRIDE ? resolve(process.env.P98_LIB_OVERRIDE) : undefined;
  const result = await buildProgram(resolve(inputPath), { libPath });
  if (!result.ok) {
    for (const error of result.errors) {
      console.error(`[${error.stage}] line ${error.line}: ${error.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const stem = dosBaseName(inputPath.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, ''));
  const exePath = join(outDir, `${stem}.EXE`);
  const fdPath = join(outDir, `${stem}.xdf`);
  const image = result.makeFd([{ name: stem, ext: 'EXE', data: result.output }]);
  await Promise.all([
    writeFile(exePath, result.output),
    writeFile(fdPath, image),
  ]);
  console.log(`wrote ${exePath} (${result.output.byteLength} bytes) and ${fdPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
