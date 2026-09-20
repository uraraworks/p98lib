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
//
// ビルド方式(2026-09、unityビルド廃止。経緯はdocs/design.md参照):
// WorkbenchNP2 の compile-core.mjs に追加された
//   - compileToObjectWithFactories: Cソース1本をリンクせずELFオブジェクトへ
//   - compileWithFactories の opts.extraLinkInputs: 追加の.o/.aをリンク段で束ねる
// を使い、「p98.c(ライブラリ)を先にオブジェクト化 → ユーザーのCをコンパイルする
// 際にそのオブジェクトと手書きNASM(p98_asm.asm)をextraLinkInputsとしてリンクする」
// という、CとNASMが別ファイルのまま完結する経路にした。文字列連結によるunity
// ビルドはもう行わない。

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
  const { compileWithFactories, compileToObjectWithFactories } = await import(join(WORKBENCH_TOOLCHAIN, 'compile-core.mjs'));
  const { assemble } = await import(join(WORKBENCH_TOOLCHAIN, 'assemble.mjs'));
  const { loadDefaultHeaders } = await import(join(WORKBENCH_TOOLCHAIN, 'compile.mjs'));
  const { makeFd } = await import(join(WORKBENCH_TOOLCHAIN, 'makefd.mjs'));
  const createSmlrpp = require(join(WORKBENCH_TOOLCHAIN, 'smlrc-wasm', 'smlrpp.js'));
  const createSmlrc = require(join(WORKBENCH_TOOLCHAIN, 'smlrc-wasm', 'smlrc.js'));
  const createSmlrl = require(join(WORKBENCH_TOOLCHAIN, 'smlrc-wasm', 'smlrl.js'));
  return {
    compileWithFactories, compileToObjectWithFactories, assemble, loadDefaultHeaders, makeFd,
    createSmlrpp, createSmlrc, createSmlrl,
  };
}

function stageErrors(stage, errors) {
  return errors.map((error) => ({ ...error, stage: error.stage ?? stage }));
}

/**
 * p98.c (ライブラリ本体、または libPath で差し替えた故障注入版)をオブジェクトへ、
 * src/p98_asm.asm を別途ELFオブジェクトへ変換し、ユーザーの.cをコンパイルする際に
 * その2つをextraLinkInputsとしてリンクする。p98libは huge model 固定
 * (ユーザー決定済み)。small で組もうとした場合は例外で止める。
 *
 * @param {string} userSourcePath ユーザーの main() を含む .c ファイル
 * @param {{libPath?: string, model?: string}} [opts] libPath: 差し替えたいp98.c(故障注入版など)。省略時は src/p98.c
 * @returns {Promise<{ok:true, output:Uint8Array, assembly:Uint8Array, linkerMap:string} | {ok:false, errors:any[]}>}
 */
export async function buildProgram(userSourcePath, opts = {}) {
  if (opts.model !== undefined && opts.model !== 'huge') {
    throw new Error(`p98libはhuge model固定です。opts.model='${opts.model}'は許可されていません`);
  }
  const tools = await loadWorkbenchTools();
  const libPath = opts.libPath ?? join(REPO_ROOT, 'src', 'p98.c');
  const asmPath = join(REPO_ROOT, 'src', 'p98_asm.asm');

  const [libSource, userSource, asmSource, library, includeFiles] = await Promise.all([
    readFile(libPath),
    readFile(userSourcePath),
    readFile(asmPath),
    readFile(join(WORKBENCH_TOOLCHAIN, 'smlrc-wasm', 'lcdh.a')),
    tools.loadDefaultHeaders(),
  ]);
  const p98Header = await readFile(join(REPO_ROOT, 'include', 'p98.h'));
  includeFiles['p98.h'] = new Uint8Array(p98Header);

  // ユーザーの.cと同じディレクトリ、および samples/(共有アセットヘッダの置き場。
  // 例: samples/kya_assets.h。tests/配下のプローブからも#includeするため)に
  // ある.hを includeFiles へ足す(2026-09後半、KYA変換デモ向け追加)。
  const { readdir } = await import('node:fs/promises');
  async function addHeadersFrom(dir) {
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (entry.endsWith('.h') && includeFiles[entry] === undefined) {
          includeFiles[entry] = new Uint8Array(await readFile(join(dir, entry)));
        }
      }
    } catch { /* ディレクトリが読めない場合は何もしない */ }
  }
  await addHeadersFrom(dirname(userSourcePath));
  await addHeadersFrom(join(REPO_ROOT, 'samples'));

  // 1. ライブラリ(p98.c、または故障注入版)を単独でオブジェクト化する。
  const libObject = await tools.compileToObjectWithFactories(new Uint8Array(libSource), {
    includeFiles, model: 'huge',
  }, { createSmlrpp: tools.createSmlrpp, createSmlrc: tools.createSmlrc, assemble: tools.assemble });
  if (!libObject.ok) {
    return { ok: false, errors: stageErrors('p98lib', libObject.errors) };
  }

  // 2. p98_asm.asm を別途ELFオブジェクトへアセンブルする(NASMでの手書き実装)。
  const asmObject = await tools.assemble(new Uint8Array(asmSource), { format: 'elf', listing: true });
  if (!asmObject.ok) {
    return { ok: false, errors: stageErrors('nasm', asmObject.errors) };
  }

  // 3. ユーザーのCをコンパイルし、1.と2.のオブジェクトをリンク段で束ねる。
  const result = await tools.compileWithFactories(new Uint8Array(userSource), {
    library: new Uint8Array(library), includeFiles, model: 'huge',
    extraLinkInputs: [
      { name: 'p98lib.o', bytes: libObject.object },
      { name: 'p98asm.o', bytes: asmObject.output },
    ],
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
