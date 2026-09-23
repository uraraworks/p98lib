#!/usr/bin/env node
// p98lib の実行時検証。WebNP2(NP2kai)+FreeDOS(98)上で実際にプローブプログラムを
// 走らせ、結果をVRAM/メモリの実バイトで確認する。
// WorkbenchNP2 の ide/verify-huge-model.mjs と同じ枠組み(puppeteer + ローカルHTTP
// サーバでWorkbenchNP2/ide配下を配信し、window越しにengine APIを叩く)を流用する。

import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProgram } from './build.mjs';
import { buildAssetSetFromMag, extractRectFromMag } from './mag_convert.mjs';
import { computeMask } from './kya_convert.mjs';
import { compareKyaMag } from './compare_kya_mag.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const WORKBENCH_ROOT = resolve(REPO_ROOT, '../WorkbenchNP2');
const PORT = 5311;
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const require = createRequire(import.meta.url);

async function loadPuppeteer() {
  try { return (await import('puppeteer-core')).default; }
  catch { return createRequire(resolve(REPO_ROOT, '../WebNP2/package.json'))('puppeteer-core'); }
}

const { makeFd } = await import(join(WORKBENCH_ROOT, 'toolchain', 'makefd.mjs'));

async function buildOrThrow(sourcePath, opts) {
  const result = await buildProgram(resolve(REPO_ROOT, sourcePath), opts);
  if (!result.ok) {
    throw new Error(`${sourcePath}のビルドに失敗:\n${result.errors.map((e) => `[${e.stage}] line ${e.line}: ${e.message}`).join('\n')}`);
  }
  return result.output;
}

function programFdFor(exeBytes, stem) {
  return makeFd([{ name: stem, ext: 'EXE', data: exeBytes }]);
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm', '.xdf': 'application/octet-stream',
};

function startServer(programFdsByName) {
  const harness = `<!doctype html>
<html><body><canvas id="screen" width="640" height="400"></canvas>
<script type="module">
import { createWebNP2 } from './vendor/webnp2/webnp2-embed.js';
import { bootFreeDos, waitForCurrentDosPrompt } from './freedos-session.mjs';

const engine = createWebNP2(document.querySelector('#screen'));
engine.persistNow = async () => {};

window.p98probe = {
  engine,
  boot: async (programUrl) => {
    const [bootResponse, fdResponse] = await Promise.all([
      fetch('./freedos/fd98_2hd.xdf'),
      fetch(programUrl),
    ]);
    if (!bootResponse.ok) throw new Error('FreeDOS FD fetch failed');
    if (!fdResponse.ok) throw new Error('program FD fetch failed');
    await bootFreeDos(engine, {
      freeDos: new Uint8Array(await bootResponse.arrayBuffer()), freeDosKey: 'p98probe:freedos',
      programFd: new Uint8Array(await fdResponse.arrayBuffer()), programName: 'program.xdf', programKey: 'p98probe:program',
      timeout: 30000,
    });
  },
  run: async (stem, { waitMs, waitForExit } = {}) => {
    const baseline = engine.getScreenText().text;
    await engine.pasteText(\`B:\\r\`);
    await waitForCurrentDosPrompt(engine, { baseline, timeout: 15000 });
    const baseline2 = engine.getScreenText().text;
    await engine.pasteText(\`\${stem}\\r\`);
    if (waitForExit) {
      const screen = await waitForCurrentDosPrompt(engine, { baseline: baseline2, timeout: 20000 });
      return screen.text;
    }
    await new Promise((r) => setTimeout(r, waitMs ?? 3000));
    return engine.getScreenText().text;
  },
  runProgram: async (programUrl, stem, opts) => {
    await window.p98probe.boot(programUrl);
    return window.p98probe.run(stem, opts);
  },
  // スプライト速度計測専用: "stemを打ってからプロンプトへ戻るまで" だけを
  // ホスト側のDate.now()で計る(tools/verify.mjsのコメント・docs/design.md参照。
  // ゲスト側のBIOSティックは実時間と安定して対応しないことが実測で分かったため)。
  runTimed: async (stem, timeoutMs) => {
    const baseline = engine.getScreenText().text;
    await engine.pasteText(\`B:\\r\`);
    await waitForCurrentDosPrompt(engine, { baseline, timeout: 15000 });
    const baseline2 = engine.getScreenText().text;
    const t0 = performance.now();
    await engine.pasteText(\`\${stem}\\r\`);
    await waitForCurrentDosPrompt(engine, { baseline: baseline2, timeout: timeoutMs ?? 30000 });
    const t1 = performance.now();
    return t1 - t0;
  },
  runProgramTimed: async (programUrl, stem, timeoutMs) => {
    await window.p98probe.boot(programUrl);
    return window.p98probe.runTimed(stem, timeoutMs);
  },
  readMemory: (addr, len) => {
    const { base64 } = engine.readMemoryBase64(addr, len);
    const binary = atob(base64);
    return Array.from(binary, (c) => c.charCodeAt(0));
  },
  sendKey: (code, down) => engine.sendKey(code, down),
  runNoWait: async (stem) => {
    const baseline = engine.getScreenText().text;
    await engine.pasteText(\`B:\\r\`);
    await waitForCurrentDosPrompt(engine, { baseline, timeout: 15000 });
    const baseline2 = engine.getScreenText().text;
    await engine.pasteText(\`\${stem}\\r\`);
    return baseline2;
  },
  waitPrompt: async (baseline, timeoutMs) => {
    const screen = await waitForCurrentDosPrompt(engine, { baseline, timeout: timeoutMs ?? 20000 });
    return screen.text;
  },
  runDosCommand: async (cmd) => {
    const baseline = engine.getScreenText().text;
    await engine.pasteText(\`\${cmd}\\r\`);
    const screen = await waitForCurrentDosPrompt(engine, { baseline, timeout: 15000 });
    return screen.text;
  },
};
</script></body></html>`;

  return new Promise((resolveStart, reject) => {
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (url.pathname === '/ide/p98-probe.html') {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(harness);
          return;
        }
        const programMatch = url.pathname.match(/^\/program\/(.+)\.xdf$/);
        if (programMatch && programFdsByName[programMatch[1]]) {
          response.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(programFdsByName[programMatch[1]]);
          return;
        }
        let pathname = decodeURIComponent(url.pathname);
        if (pathname.endsWith('/')) pathname += 'index.html';
        const file = resolve(WORKBENCH_ROOT, `.${pathname}`);
        if (file !== WORKBENCH_ROOT && !file.startsWith(`${WORKBENCH_ROOT}${sep}`)) { response.writeHead(403).end('forbidden'); return; }
        const body = await readFile(file);
        response.writeHead(200, { 'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream' });
        response.end(body);
      } catch { response.writeHead(404).end('not found'); }
    });
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolveStart(server));
  });
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

function assertEqual(label, actual, expected, results) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ label, ok, actual, expected });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : ` actual=[${bytesToHex(actual)}] expected=[${bytesToHex(expected)}]`}`);
  return ok;
}

const PLANE = { B: 0xA8000, R: 0xB0000, G: 0xB8000, I: 0xE0000 };
const ROW = 80;

// 矩形(x,y,w,h。x/wはバイト境界=8の倍数)ぶんのVRAMを4プレーンとも読み、
// tools/kya_convert.mjs の buildAssetSet() が返す rect.planes と同じ形
// (プレーンごとに Buffer、1行=wBytesバイトを詰めて並べた配列)で返す。
// KYA変換結果の実値検証・walk2デモの検証で共通に使う。
async function readVramRect(page, x, y, w, h) {
  const wBytes = w / 8;
  const addrs = [];
  for (const key of ['B', 'R', 'G', 'I']) {
    for (let row = 0; row < h; row++) {
      addrs.push([PLANE[key] + (y + row) * ROW + x / 8, wBytes]);
    }
  }
  const flat = await page.evaluate((list) => list.map(([addr, len]) => window.p98probe.readMemory(addr, len)), addrs);
  const planes = [];
  for (let p = 0; p < 4; p++) {
    const buf = Buffer.alloc(wBytes * h);
    for (let row = 0; row < h; row++) {
      const bytes = flat[p * h + row];
      for (let i = 0; i < wBytes; i++) buf[row * wBytes + i] = bytes[i];
    }
    planes.push(buf);
  }
  return { w, h, wBytes, planes };
}

function rectPlanesEqual(a, b) {
  for (let p = 0; p < 4; p++) if (!a.planes[p].equals(b.planes[p])) return false;
  return true;
}

// canvasの1点のRGBを読む(パレット回帰検査専用)。VRAMの生バイトではなく
// 「実際に画面へどう表示されているか」を見るための唯一の手段
// (パレット破壊はVRAMバイトには一切現れず、見た目にしか出ないため。
// docs/design.md「パレット」節参照)。canvasはWebGL(preserveDrawingBuffer)
// で描かれているため、そのまま2回getContext('2d')できない。ここでは
// いったんオフスクリーンcanvasへdrawImage()でコピーしてから読む。
async function readCanvasPixel(page, x, y) {
  return page.evaluate(({ x, y }) => {
    const src = document.querySelector('#screen');
    const off = document.createElement('canvas');
    off.width = src.width; off.height = src.height;
    const ctx = off.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(x, y, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, { x, y });
}

// 固定sleepでcanvasを読むと、FreeDOS初回起動時のディスクキャッシュの
// 有無等で「まだ描画前」「もう次のプログラムに戻った後」のどちらに
// 当たるか実行のたびにばらつき、実測で不安定だと分かった(tools/verify.mjs
// 作成時の使い捨て検証スクリプトで、修正後の実装なのに2回目だけ黒
// (=DOSプロンプトへ戻った後のテキスト画面)を誤検出した)。そこで
// tools/verify.mjs内の他の非同期処理(readManyStable、walk.c節参照)と
// 同じ考え方で、同じ値が連続するまでポーリングして安定した値を採る。
//
// 【2回連続一致では不十分だった】最初は「2回連続で同じ値」を安定判定に
// 使ったところ、フルスイート実行時(他の重い検査の直後でホストが混んで
// いる状態)に、プログラム起動直後のまだ何も描いていない黒画面が
// たまたま2回連続で読めてしまい、それを「安定した値」と誤認する
// (実際に描画された色を待たずに確定してしまう)ことがあった。
// 連続一致に要する回数を3回(streak)に増やし、誤認の確率を下げた。
async function pollStablePixel(page, x, y, { tries = 40, gapMs = 200, streak = 3 } = {}) {
  let run = [];
  for (let i = 0; i < tries; i++) {
    const cur = await readCanvasPixel(page, x, y);
    if (run.length && run[run.length - 1].every((v, j) => v === cur[j])) {
      run.push(cur);
      if (run.length >= streak) return cur;
    } else {
      run = [cur];
    }
    await sleep(gapMs);
  }
  return run[run.length - 1] ?? null;
}

function pixelsClose(a, b, tol = 4) {
  return a.every((v, i) => Math.abs(v - b[i]) <= tol);
}

async function withPage(browser, url, fn) {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()); });
  page.on('requestfailed', (req) => pageErrors.push(`requestfailed: ${req.url()} ${req.failure()?.errorText}`));
  page.on('response', (res) => { if (res.status() >= 400) pageErrors.push(`http${res.status()}: ${res.url()}`); });
  await page.goto(url, { waitUntil: 'load' });
  try {
    return await fn(page, pageErrors);
  } finally {
    await page.close();
  }
}

// 公開デモの素材はORIGINAL/KYARA-03.MAG(docs/assets.md参照。MITEI2.KYAと
// 同じ配置だが、背景タイルの描き込みが多くキャラの色数も多い「色付き完全版」)。
const MAG_PATH = resolve(REPO_ROOT, '../_local/legacy-a-games/ORIGINAL/KYARA-03.MAG');

// 素材(元のMAG/KYAファイル)は作者の環境にしかない(docs/assets.md参照)。
// 素材が無い環境でも、素材を必要としない項目はそのまま実行できるように、
// 「元データが読めるか」をここで一度だけ確認し、以降は素材が必要な項目だけを
// スキップする(README.mdの「検証の回し方」参照)。
let magAssetSet = null;
let assetsAvailable = false;
let assetsUnavailableReason = '';
// walk2検証用の「右向き」期待値: tools/mag_convert.mjsの反転ロジックを経由せず、
// 原物MAGのcol6/col7を直接切り出して作る(素材変換と検証の期待値が同じ
// 思い込みを共有していたために左右逆コマの不具合をすり抜けた反省から、
// 物差しを変換ロジックから独立させてある)。mag_convert.mjs側はleftFrames=
// [col4,col5]を反転してrightFrames=[mirror(col4),mirror(col5)]を作っており、
// 実測でmirror(col4)==col7、mirror(col5)==col6と分かっているので、
// 対応する添字はcol7→[0]、col6→[1]。
let independentRightFrames = null;
const MAG_CHAR_ROW = 0; // mag_convert.mjsのCHAR_ROWと同じ値(コメントで明示)

async function main() {
  const results = [];
  const skipped = [];
  console.log('--- ビルド ---');
  try {
    magAssetSet = await buildAssetSetFromMag(MAG_PATH); // キャラ・タイルともKYARA-03.MAG由来
    independentRightFrames = [7, 6].map((col) => {
      const rect = extractRectFromMag(magAssetSet.decoded, col * 32, MAG_CHAR_ROW * 32, 32, 32);
      const mask = computeMask(rect, 0);
      return { rect, mask };
    });
    assetsAvailable = true;
  } catch (err) {
    assetsAvailable = false;
    assetsUnavailableReason = err && err.code === 'ENOENT'
      ? `元データが見つかりません(${MAG_PATH})`
      : `元データの読み込みに失敗しました(${err && err.message})`;
    console.log(`\n[注意] ${assetsUnavailableReason}`);
    console.log('       素材を必要とする項目は「素材が無いため実行できません」として報告し、SKIP扱い(合格扱いにはしません)。');
  }

  // ---- KYA経由とMAG経由の突き合わせ ----
  // 「同じ名前のKYAとMAGは同じ絵のはず」という前提で両方を変換し、
  // バイト列(パレット・全画素のパレット番号)が一致するかを機械的に確認する。
  // 実測した結果、パレットは完全一致するが、画素の内容は一致しなかった
  // (詳細はdocs/design.md「MAG形式対応」節・docs/verify-log.md参照)。
  // 「一致しない場合はVRAMに出して実値で確かめる」を実行した結果:
  //   - 作者が1996年当時に書いたCローダー(コンパイル済みのMAGL.EXE)を
  //     本物のFreeDOS(98)+WebNP2で実行し、MITEI2.MAGを読み込ませてVRAMを
  //     直接ダンプしたところ、B/R/G/Iの4プレーンが常に同一の値になる
  //     (=白黒2色しか使っていない)ことを確認した。
  //   - つまりtools/mag_decode.mjs(mag.tsの移植)のデコード結果は
  //     **実機相当のローダーと一致しており、デコーダのバグではない**。
  //     MITEI2.MAGというファイル自体が、MITEI2.KYAと違って白黒2色しか
  //     持っていない(理由は不明。当時の保存時の事情と思われる)。
  //   - 逆にMITEI3の組は、KYA側が白黒2色、MAG側が多色という**逆の**
  //     組み合わせだった(こちらもMAGL.EXE実行と目視で確認)。
  // この非対称な結果から、「同じ名前のKYA/MAGは常に同じ画素を持つ」という
  // 前提そのものが誤りだったと判断した(直すべきコードの問題ではない)。
  console.log('\n--- KYA経由とMAG経由の突き合わせ(MITEI2/MITEI3、実測結果をそのまま記録) ---');
  for (const [label, kyaName, magName] of [
    ['MITEI2', 'MITEI2.KYA', 'MITEI2.MAG'],
    ['MITEI3', 'MITEI3.KYA', 'MITEI3.MAG'],
  ]) {
    const kyaPath = resolve(REPO_ROOT, '../_local/legacy-a-games/C-GAMES/SAKA', kyaName);
    const magPath = resolve(REPO_ROOT, '../_local/legacy-a-games/C-GAMES/SAKA', magName);
    let report;
    try {
      report = await compareKyaMag(kyaPath, magPath);
    } catch (err) {
      const entry = { label: `[KYA/MAG突き合わせ] ${label}: パレット16色が完全一致`, skip: true, reason: '素材が無いため実行できません' };
      results.push(entry);
      skipped.push(entry);
      console.log(`SKIP [KYA/MAG突き合わせ] ${label}: 素材が無いため実行できません`);
      continue;
    }
    const paletteOk = report.paletteMismatch === 0;
    results.push({
      label: `[KYA/MAG突き合わせ] ${label}: パレット16色が完全一致`,
      ok: paletteOk, actual: `${report.paletteMismatch}/16不一致`, expected: '0/16不一致',
    });
    console.log(`${paletteOk ? 'OK  ' : 'FAIL'} [KYA/MAG突き合わせ] ${label} パレット一致 (${report.paletteMismatch}/16不一致)`);
    console.log(`      ${label} 画素の一致: ${report.totalPixels - report.pixelMismatch}/${report.totalPixels}` +
      `(不一致${report.pixelMismatch}件。既知の相違、MAGL.EXE実機相当で確認済み。docs/design.md参照。バグではないため合否判定には使わない)`);
  }

  const [
    fillExe, flipExe, stateExe, fillBrokenExe, keyExe, keyBrokenExe,
    spriteExe, spriteNoMaskExe, spriteNoClipExe, spriteBenchExe, spriteBench0Exe,
    spriteEgcExe, spriteEgcBrokenExe, spriteBenchEgcExe,
    spriteVramExe, spriteVramBrokenExe, spriteBenchVramExe,
    vramUploadBytesExe,
    vramUploadBenchExe,
    walkExe, walkBrokenExe,
    bgpageExe, bgpageBrokenExe, bgpageBenchFullExe, bgpageBenchDiffExe, bgpageBench0BgExe,
    walk2AssetsExe, walk2AssetsBrokenExe, walk2Exe,
    walk2BenchFullExe, walk2BenchDiffExe, walk2Bench0BgExe,
    tilebgBenchCpuExe, tilebgBenchVramExe, tilebgBench0Exe,
    stateCursorBrokenExe, cursorExe, cursorBrokenExe,
    fkeyExe, fkeyBrokenExe,
    bgcopyExe, bgcopyBrokenExe, bgcopyBench2xExe, bgcopyBenchCopyExe, bgcopyBench0Exe,
    paletteRegressExe, paletteRegressBrokenExe,
  ] = await Promise.all([
    buildOrThrow('tests/probe_fill.c'),
    buildOrThrow('tests/probe_flip.c'),
    buildOrThrow('tests/probe_state.c'),
    buildOrThrow('tests/probe_fill.c', { libPath: join(REPO_ROOT, 'tests', 'p98_broken_noclip.c') }),
    buildOrThrow('tests/probe_key.c'),
    buildOrThrow('tests/probe_key.c', { libPath: join(REPO_ROOT, 'tests', 'p98_broken_nodiff.c') }),
    buildOrThrow('tests/probe_sprite.c'),
    buildOrThrow('tests/probe_sprite.c', { libPath: join(REPO_ROOT, 'tests', 'p98_broken_spritenomask.c') }),
    buildOrThrow('tests/probe_sprite.c', { libPath: join(REPO_ROOT, 'tests', 'p98_broken_spritenoclip.c') }),
    buildOrThrow('tests/probe_sprite_bench.c'),
    buildOrThrow('tests/probe_sprite_bench0.c'),
    buildOrThrow('tests/probe_sprite_egc.c'),
    buildOrThrow('tests/probe_sprite_egc.c', { libPath: join(REPO_ROOT, 'tests', 'p98_broken_egc_noplane.c') }),
    buildOrThrow('tests/probe_sprite_bench_egc.c'),
    buildOrThrow('tests/probe_sprite_vram.c'),
    buildOrThrow('tests/probe_sprite_vram.c', { libPath: join(REPO_ROOT, 'tests', 'p98_broken_vram_noand.c') }),
    buildOrThrow('tests/probe_sprite_bench_vram.c'),
    buildOrThrow('tests/probe_vram_upload_bytes.c'),
    buildOrThrow('tests/probe_vram_upload_bench.c'),
    buildOrThrow('samples/walk.c'),
    buildOrThrow('tests/walk_broken_nobg.c'),
    buildOrThrow('tests/probe_bgpage.c'),
    buildOrThrow('tests/probe_bgpage.c', { libPath: join(REPO_ROOT, 'tests', 'p98_broken_bgpage_shrink.c') }),
    buildOrThrow('tests/probe_bgpage_bench_full.c'),
    buildOrThrow('tests/probe_bgpage_bench_diff.c'),
    buildOrThrow('tests/probe_bgpage_bench0_bg.c'),
    buildOrThrow('tests/probe_walk2_assets.c'),
    buildOrThrow('tests/probe_walk2_assets_broken.c'),
    buildOrThrow('samples/walk2.c'),
    buildOrThrow('tests/probe_walk2_bench_full.c'),
    buildOrThrow('tests/probe_walk2_bench_diff.c'),
    buildOrThrow('tests/probe_walk2_bench0_bg.c'),
    buildOrThrow('tests/probe_tilebg_bench_cpu.c'),
    buildOrThrow('tests/probe_tilebg_bench_vram.c'),
    buildOrThrow('tests/probe_tilebg_bench0.c'),
    buildOrThrow('tests/probe_state.c', { libPath: join(REPO_ROOT, 'tests', 'p98_broken_cursor_noshow.c') }),
    buildOrThrow('tests/probe_cursor.c'),
    buildOrThrow('tests/probe_cursor.c', { libPath: join(REPO_ROOT, 'tests', 'p98_broken_cursor_noshow.c') }),
    buildOrThrow('tests/probe_fkey.c'),
    buildOrThrow('tests/probe_fkey.c', { libPath: join(REPO_ROOT, 'tests', 'p98_broken_fkey_noshow.c') }),
    buildOrThrow('tests/probe_bgcopy.c'),
    buildOrThrow('tests/probe_bgcopy.c', { libPath: join(REPO_ROOT, 'tests', 'p98_broken_bgcopy_short.c') }),
    buildOrThrow('tests/probe_bgcopy_bench_2x.c'),
    buildOrThrow('tests/probe_bgcopy_bench_copy.c'),
    buildOrThrow('tests/probe_bgcopy_bench0.c'),
    buildOrThrow('tests/probe_palette_regress.c'),
    buildOrThrow('tests/probe_palette_regress.c', { libPath: join(REPO_ROOT, 'tests', 'p98_broken_palette_readback.c') }),
  ]);
  console.log('ok: probe_fill / probe_flip / probe_state / probe_fill(故障注入=クリップ無し) / probe_key / probe_key(故障注入=差分無し) / probe_sprite / probe_sprite(故障注入=マスク無し) / probe_sprite(故障注入=クリップ無し) / probe_sprite_bench / probe_sprite_bench0 / probe_sprite_egc / probe_sprite_egc(故障注入=プレーン選択無し) / probe_sprite_bench_egc / probe_sprite_vram / probe_sprite_vram(故障注入=AND転送無し) / probe_sprite_bench_vram / probe_vram_upload_bytes / probe_vram_upload_bench / walk(デモ) / walk(故障注入=背景復帰無し) / probe_bgpage / probe_bgpage(故障注入=復元矩形1ドット縮小) / probe_bgpage_bench_full / probe_bgpage_bench_diff / probe_bgpage_bench0_bg / probe_walk2_assets / probe_walk2_assets(故障注入=R/Gプレーン入替) / walk2(デモ2、実素材) / probe_walk2_bench_full / probe_walk2_bench_diff / probe_walk2_bench0_bg / probe_tilebg_bench_cpu / probe_tilebg_bench_vram / probe_tilebg_bench0 / probe_state(故障注入=カーソル復帰無し) / probe_bgcopy / probe_bgcopy(故障注入=末尾1行コピー漏れ) / probe_bgcopy_bench_2x / probe_bgcopy_bench_copy / probe_bgcopy_bench0 / probe_palette_regress / probe_palette_regress(故障注入=パレット読み出し退避)');

  const programFds = {
    fill: programFdFor(fillExe, 'PROBE_FI'),
    flip: programFdFor(flipExe, 'PROBE_FL'),
    state: programFdFor(stateExe, 'PROBE_ST'),
    fillbroken: programFdFor(fillBrokenExe, 'PROBE_FI'),
    key: programFdFor(keyExe, 'PROBE_KE'),
    keybroken: programFdFor(keyBrokenExe, 'PROBE_KE'),
    sprite: programFdFor(spriteExe, 'PROBE_SP'),
    spritenomask: programFdFor(spriteNoMaskExe, 'PROBE_SP'),
    spritenoclip: programFdFor(spriteNoClipExe, 'PROBE_SP'),
    walk: programFdFor(walkExe, 'WALK'),
    walkbroken: programFdFor(walkBrokenExe, 'WALK_BRO'),
    spritebench: programFdFor(spriteBenchExe, 'PROBE_SB'),
    spritebench0: programFdFor(spriteBench0Exe, 'PROBE_S0'),
    spriteegc: programFdFor(spriteEgcExe, 'PROBE_SP'),
    spriteegcbroken: programFdFor(spriteEgcBrokenExe, 'PROBE_SP'),
    spritebenchegc: programFdFor(spriteBenchEgcExe, 'PROBE_SE'),
    spritevram: programFdFor(spriteVramExe, 'PROBE_SV'),
    spritevrambroken: programFdFor(spriteVramBrokenExe, 'PROBE_SV'),
    spritebenchvram: programFdFor(spriteBenchVramExe, 'PROBE_SR'),
    vramuploadbytes: programFdFor(vramUploadBytesExe, 'PROBE_VB'),
    vramuploadbench: programFdFor(vramUploadBenchExe, 'PROBE_UB'),
    bgpage: programFdFor(bgpageExe, 'PROBE_BG'),
    bgpagebroken: programFdFor(bgpageBrokenExe, 'PROBE_BG'),
    bgpagebenchfull: programFdFor(bgpageBenchFullExe, 'PROBE_BF'),
    bgpagebenchdiff: programFdFor(bgpageBenchDiffExe, 'PROBE_BD'),
    bgpagebench0bg: programFdFor(bgpageBench0BgExe, 'PROBE_B0'),
    walk2assets: programFdFor(walk2AssetsExe, 'PROBE_WA'),
    walk2assetsbroken: programFdFor(walk2AssetsBrokenExe, 'PROBE_WA'),
    walk2: programFdFor(walk2Exe, 'WALK2'),
    statecursorbroken: programFdFor(stateCursorBrokenExe, 'PROBE_ST'),
    cursor: programFdFor(cursorExe, 'PROBE_CU'),
    cursorbroken: programFdFor(cursorBrokenExe, 'PROBE_CU'),
    fkey: programFdFor(fkeyExe, 'PROBE_FK'),
    fkeybroken: programFdFor(fkeyBrokenExe, 'PROBE_FK'),
    walk2benchfull: programFdFor(walk2BenchFullExe, 'PROBE_W1'),
    walk2benchdiff: programFdFor(walk2BenchDiffExe, 'PROBE_W2'),
    walk2bench0bg: programFdFor(walk2Bench0BgExe, 'PROBE_W3'),
    tilebgbenchcpu: programFdFor(tilebgBenchCpuExe, 'PROBE_TC'),
    tilebgbenchvram: programFdFor(tilebgBenchVramExe, 'PROBE_TV'),
    tilebgbench0: programFdFor(tilebgBench0Exe, 'PROBE_T0'),
    bgcopy: programFdFor(bgcopyExe, 'PROBE_CB'),
    bgcopybroken: programFdFor(bgcopyBrokenExe, 'PROBE_CB'),
    bgcopybench2x: programFdFor(bgcopyBench2xExe, 'PROBE_C2'),
    bgcopybenchcopy: programFdFor(bgcopyBenchCopyExe, 'PROBE_CC'),
    bgcopybench0: programFdFor(bgcopyBench0Exe, 'PROBE_C0'),
    paletteregress: programFdFor(paletteRegressExe, 'PALREG'),
    paletteregressbroken: programFdFor(paletteRegressBrokenExe, 'PALREG'),
  };

  const server = await startServer(programFds);
  const puppeteer = await loadPuppeteer();
  const profile = await mkdtemp(`${tmpdir()}/p98lib-verify-`);
  const browser = await puppeteer.launch({
    executablePath: CHROME, userDataDir: profile, headless: 'new',
    args: ['--hide-scrollbars', '--autoplay-policy=no-user-gesture-required'],
  });

  try {
    console.log('\n--- 矩形塗り + クリップ (probe_fill) ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      await page.evaluate((port) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/fill.xdf`, 'PROBE_FI', { waitMs: 3000 }), PORT);
      if (errors.length) console.log('page errors:', errors);

      // 矩形A: (8,8,16,8) color=15 -> byte1,2 (x8-23) が全プレーンで0xFF、byte0とbyte3は0
      const rowA = 8 * ROW;
      for (const plane of ['B', 'R', 'G', 'I']) {
        const mem = await page.evaluate((addr, len) => window.p98probe.readMemory(addr, len), PLANE[plane] + rowA, 4);
        assertEqual(`矩形A row8 ${plane}plane byte0..3`, mem, [0x00, 0xFF, 0xFF, 0x00], results);
      }

      // 矩形B: (100,40,13,5) color=5(青+緑) -> byte12=0x0F,13=0xFF,14=0x80 (B,G) / 0 (R,I)
      const rowB = 40 * ROW;
      const expectB = { B: [0x0F, 0xFF, 0x80], R: [0x00, 0x00, 0x00], G: [0x0F, 0xFF, 0x80], I: [0x00, 0x00, 0x00] };
      for (const plane of ['B', 'R', 'G', 'I']) {
        const mem = await page.evaluate((addr, len) => window.p98probe.readMemory(addr, len), PLANE[plane] + rowB + 12, 3);
        assertEqual(`矩形B row40 ${plane}plane byte12..14`, mem, expectB[plane], results);
      }

      // 矩形C: (630,10,30,10) color=10(赤+輝度) -> x630-639のみ塗られる(byte78,79の一部)。
      // クリップが効いていれば次の行(row11)の先頭バイトは0のまま。
      const rowC = 10 * ROW;
      const memC = await page.evaluate((addr, len) => window.p98probe.readMemory(addr, len), PLANE.R + rowC + 78, 2);
      // x=630..639: byte78はx624-631のうちx630,631の2bitだけ(0x03)、byte79はx632-639全部(0xFF)
      assertEqual('矩形C row10 Rplane byte78..79 (画面内、左端はビット単位)', memC, [0x03, 0xFF], results);
      const memNextRow = await page.evaluate((addr, len) => window.p98probe.readMemory(addr, len), PLANE.R + rowC + ROW, 1);
      assertEqual('クリップ: 矩形Cの次の行の先頭バイトは触られていない', memNextRow, [0x00], results);
    });

    console.log('\n--- 表示ページ/描画ページの入れ替え (probe_flip) ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      const text = await page.evaluate((port) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/flip.xdf`, 'PROBE_FL', { waitForExit: true }), PORT);
      if (errors.length) console.log('page errors:', errors);
      const line = text.split('\n').find((l) => l.includes('R1=')) ?? '';
      console.log('screen text:', JSON.stringify(line));
      const m = (tag) => line.match(new RegExp(`${tag}=([0-9A-F]),([0-9A-F])`));
      const r1 = m('R1'); const r2 = m('R2'); const r3 = m('R3');
      results.push({ label: 'flip直後、まだ何も描いていない表示ページの中身は背景(0,0)', ok: !!r1 && r1[1] === '0' && r1[2] === '0', actual: r1, expected: '0,0' });
      console.log(`${r1 && r1[1] === '0' && r1[2] === '0' ? 'OK  ' : 'FAIL'} R1(flip直後の背景) = ${r1?.[0]}`);
      const r2ok = !!r2 && r2[1] === '0' && r2[2] === 'F';
      results.push({ label: 'clear(12)後、同じアドレスがcolor12(緑のみ)を反映する', ok: r2ok, actual: r2, expected: '0,F' });
      console.log(`${r2ok ? 'OK  ' : 'FAIL'} R2(clear(12)後) = ${r2?.[0]}`);
      const r3ok = !!r3 && r3[1] === 'F' && r3[2] === '0';
      results.push({ label: '2回目のflip後、元のページ(color3=青のみ)の内容が保たれている', ok: r3ok, actual: r3, expected: 'F,0' });
      console.log(`${r3ok ? 'OK  ' : 'FAIL'} R3(再flip後) = ${r3?.[0]}`);
    });

    console.log('\n--- 故障注入: probe_fill(クリップ無し版)はFAILするはず ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      await page.evaluate((port) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/fillbroken.xdf`, 'PROBE_FI', { waitMs: 3000 }), PORT);
      if (errors.length) console.log('page errors:', errors);
      const memNextRow = await page.evaluate((addr, len) => window.p98probe.readMemory(addr, len), PLANE.R + 10 * ROW + ROW, 1);
      const brokenDetected = memNextRow[0] !== 0x00;
      results.push({ label: '故障注入(クリップ無し)は次行の先頭バイトを汚す', ok: brokenDetected, actual: memNextRow, expected: 'nonzero' });
      console.log(`${brokenDetected ? 'OK  ' : 'FAIL'} 故障注入(クリップ無し)は次行の先頭バイトを汚す actual=[${bytesToHex(memNextRow)}]`);
    });

    console.log('\n--- 初期化/終了の状態退避・復元 (probe_state) ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      await page.evaluate((port) => window.p98probe.boot(`http://127.0.0.1:${port}/program/state.xdf`), PORT);
      const before23 = await page.evaluate((addr, len) => window.p98probe.readMemory(addr, len), 0x8C, 4);
      const text = await page.evaluate(() => window.p98probe.run('PROBE_ST', { waitForExit: true }));
      if (errors.length) console.log('page errors:', errors);
      console.log('screen text (末尾):', JSON.stringify(text.split('\n').filter((l) => l.includes('BEF=') || l.includes('AFT=')).at(-1)));
      const after23 = await page.evaluate((addr, len) => window.p98probe.readMemory(addr, len), 0x8C, 4);
      const match = text.match(/BEF=([0-9A-F]{3})[\s\S]*AFT=([0-9A-F]{3})/);
      // 【2026-09後半、検査を変更】以前は「AFT(quit後)がBEF(init前)と一致する」を
      // 合否条件にしていたが、これはp98_quit()が「読み出して退避した値を
      // 書き戻す」実装だった頃の話。パレットの読み出し(0xAA/0xAC/0xAE)が
      // np2kai上では実際の値を返さないことが分かり(docs/design.md「パレット」
      // 節参照)、p98_init()/p98_quit()は退避・復元をやめ、実測した既定パレット
      // 16色をそのまま書き込む/書き戻す方式に変更した。そのため今は
      // 「AFT(quit後)が既知の既定値(色番号1はG=0,R=0,B=7)と一致する」を
      // 検査する。BEFはこの新しい契約の下では意味を持たない参考値として
      // 画面には残す(上のconsole.logでそのまま出力する)。
      const PALETTE1_DEFAULT_GRB = '007'; // src/p98.cのp98__default_pal_g/r/b[1]と一致させる
      const paletteRestored = !!match && match[2] === PALETTE1_DEFAULT_GRB;
      results.push({ label: 'パレット(色番号1)がp98_quit後に既定値へ戻る', ok: paletteRestored, actual: match?.[2], expected: PALETTE1_DEFAULT_GRB });
      console.log(`${paletteRestored ? 'OK  ' : 'FAIL'} パレット(色番号1)がp98_quit後に既定値へ戻る(参考)BEF=${match?.[1]} AFT=${match?.[2]} 期待値=${PALETTE1_DEFAULT_GRB}`);
      assertEqual('INT23hベクタはp98_quit後に元へ戻る(0000:008C)', after23, before23, results);

      const vMatch = text.match(/V0=([0-9A-F]{4})[\s\S]*V1=([0-9A-F]{4})[\s\S]*V2=([0-9A-F]{4})/);
      const vectorChanged = !!vMatch && vMatch[1] !== vMatch[2];
      const vectorRestored = !!vMatch && vMatch[1] === vMatch[3];
      results.push({ label: 'ゲスト自身が読んでもINT23hはp98_init中に書き換わっている(陽性対照)', ok: vectorChanged, actual: vMatch?.[2], expected: `not ${vMatch?.[1]}` });
      console.log(`${vectorChanged ? 'OK  ' : 'FAIL'} INT23h V0(元)=${vMatch?.[1]} V1(init中)=${vMatch?.[2]} (異なるはず)`);
      results.push({ label: 'ゲスト自身が読んでもINT23hはp98_quit後に元へ戻る', ok: vectorRestored, actual: vMatch?.[3], expected: vMatch?.[1] });
      console.log(`${vectorRestored ? 'OK  ' : 'FAIL'} INT23h V2(quit後)=${vMatch?.[3]} (V0と一致するはず)`);
    });

    // ---- テキスト画面とカーソルの後始末(2026-09後半、docs/design.md参照) ----
    // WorkbenchNP2 ide/dos-prompt.mjs の currentDosPrompt() は
    // `screen.cursor`(engine.getScreenText().cursor、カーソル非表示だとnull)を
    // 見てDOSプロンプトを判定している。つまり「カーソルが表示に戻っているか」は
    // このライブラリの見た目の問題であるだけでなく、**この検証ハーネス自体が
    // 正しく動くための前提**でもある(既存のwaitForCurrentDosPrompt依存の
    // 検査を壊さないための直接確認)。
    console.log('\n--- テキスト画面とカーソルの後始末(p98_init:テキスト消去+カーソル非表示 / p98_quit:カーソル表示に復帰) ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      // 1) p98_init()中(グラフィックモードのまま静止するprobe_fill.c)は
      //    カーソルが非表示(getScreenText().cursor === null)のはず。
      await page.evaluate((port) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/fill.xdf`, 'PROBE_FI', { waitMs: 2000 }), PORT);
      if (errors.length) console.log('page errors(fill):', errors);
      const cursorDuringInit = await page.evaluate(() => window.p98probe.engine.getScreenText().cursor);
      const hiddenDuringInit = cursorDuringInit === null;
      results.push({ label: '[テキスト後始末] p98_init()中はカーソルが非表示(cursor===null)', ok: hiddenDuringInit, actual: JSON.stringify(cursorDuringInit), expected: 'null' });
      console.log(`${hiddenDuringInit ? 'OK  ' : 'FAIL'} [テキスト後始末] init中カーソル非表示 actual=${JSON.stringify(cursorDuringInit)}`);
    });

    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      // 2) probe_state.c(p98_init()→p98_quit()→print→exit)実行後はDOSへ
      //    戻り、カーソルが表示に戻っている(getScreenText().cursor !== null)。
      //    既存のwaitForCurrentDosPrompt依存の検査(以降の全節)が動いている
      //    こと自体がこの復帰の間接証拠でもあるが、ここでは直接cursorの値を見る
      //    (「検査が見るべきものを見るように直す」ため、プロンプト文字列の
      //    有無だけで判定しない)。
      await page.evaluate((port) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/state.xdf`, 'PROBE_ST', { waitForExit: true }), PORT);
      if (errors.length) console.log('page errors(state):', errors);
      const cursorAfterQuit = await page.evaluate(() => window.p98probe.engine.getScreenText().cursor);
      const shownAfterQuit = cursorAfterQuit !== null;
      results.push({ label: '[テキスト後始末] p98_quit()後はカーソルが表示に戻る(cursor!==null)', ok: shownAfterQuit, actual: JSON.stringify(cursorAfterQuit), expected: 'not null' });
      console.log(`${shownAfterQuit ? 'OK  ' : 'FAIL'} [テキスト後始末] quit後カーソル表示 actual=${JSON.stringify(cursorAfterQuit)}`);
    });

    // 【当初の想定が誤りだったことの記録】最初はここで「カーソル復帰を外した
    // 版はwaitForCurrentDosPrompt()がタイムアウトする」ことを故障注入検査に
    // しようとしたが、実測すると**タイムアウトしなかった**(=検出できな
    // かった)。原因を調べると、COMMAND.COMがプロンプトを表示する際に
    // カーソルを自分で表示状態へ戻す(実測で確認: p98_quit()の呼び出しを
    // 完全に無視しても、DOSプロンプトへ戻った時点ではcursorが非nullになる)
    // ため、「DOSプロンプトへ戻った後にcursorを見る」という検査方法では
    // p98_quit()自身がカーソルを戻したのか、COMMAND.COMが戻したのかを
    // 区別できないと判明した。そこで検査方法を変更し、
    // tests/probe_cursor.c(p98_quit()の直後、COMMAND.COMへ戻る前に
    // このプログラム自身がしばらく静止する)を使って、「COMMAND.COMが
    // 介入する前の、p98_quit()自身が残した状態」を直接見る方式にした。
    console.log('\n--- カーソル復帰(probe_cursor.c: p98_quit()直後、COMMAND.COMへ戻る前にカーソル状態を直接確認) ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await page.evaluate((port) => window.p98probe.boot(`http://127.0.0.1:${port}/program/cursor.xdf`), PORT);
      await page.evaluate(() => window.p98probe.runNoWait('PROBE_CU'));
      await sleep(1000); // probe_cursor.cはp98_quit()の後、約2秒(120フレーム)静止する
      const cursor = await page.evaluate(() => window.p98probe.engine.getScreenText().cursor);
      const ok = cursor !== null;
      results.push({ label: '[カーソル復帰] p98_quit()直後(COMMAND.COMへ戻る前)にカーソルが表示に戻っている', ok, actual: JSON.stringify(cursor), expected: 'not null' });
      console.log(`${ok ? 'OK  ' : 'FAIL'} [カーソル復帰] quit直後カーソル表示 actual=${JSON.stringify(cursor)}`);
      if (errors.length) console.log('page errors(cursor):', errors);
    });

    console.log('\n--- 故障注入: probe_cursor(p98_broken_cursor_noshow版)はp98_quit()直後もカーソル非表示のままのはず ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await page.evaluate((port) => window.p98probe.boot(`http://127.0.0.1:${port}/program/cursorbroken.xdf`), PORT);
      await page.evaluate(() => window.p98probe.runNoWait('PROBE_CU'));
      await sleep(1000);
      const cursor = await page.evaluate(() => window.p98probe.engine.getScreenText().cursor);
      const detected = cursor === null;
      results.push({ label: '[カーソル復帰故障注入] カーソル復帰を外すとp98_quit()直後もcursor===nullのまま(検出できる)', ok: detected, actual: JSON.stringify(cursor), expected: 'null' });
      console.log(`${detected ? 'OK  ' : 'FAIL'} [カーソル復帰故障注入] 復帰忘れを検出 actual=${JSON.stringify(cursor)}`);
      if (errors.length) console.log('page errors(cursorbroken):', errors);
    });

    // ファンクションキー行(テキスト画面24行目)。docs/design.md「ファンクション
    // キー行を消す」節参照。ESC[>1h(消す)/ESC[>1l(戻す)を実測した結果、
    // 文字コード面・属性面とも1バイトも違わず戻ることが分かったため、期待値は
    // 実測したそのままのバイト列を使う(col5..15、24行目)。
    // 文字コード面は1セル2バイト(下位=文字コード、上位=0)なので、
    // readMemoryで読んだ生バイト列を1つ置きに間引いて比較する。
    function deinterleaveLow(bytes) {
      const low = [];
      for (let i = 0; i < bytes.length; i += 2) low.push(bytes[i]);
      return low;
    }
    const FKEY_ROW = 24, FKEY_COL0 = 5, FKEY_COLS = 11;
    const FKEY_CHAR_ADDR = 0xA0000 + FKEY_ROW * 160 + FKEY_COL0 * 2;
    const FKEY_ATTR_ADDR = 0xA2000 + FKEY_ROW * 160 + FKEY_COL0 * 2;
    const FKEY_HIDDEN_CHAR = Array(FKEY_COLS).fill(0x20);
    const FKEY_HIDDEN_ATTR = Array(FKEY_COLS).fill(0xE1);
    // 実測(tools/_debug_fkey相当の使い捨てプローブ、コミットには残していない)
    // で確認した、消す前(=戻った後にあるべき)の実際の文字・属性列。
    const FKEY_SHOWN_CHAR = [0x20, 0x43, 0x31, 0x20, 0x20, 0x20, 0x20, 0x20, 0x43, 0x55, 0x20]; /* " C1     CU " */
    const FKEY_SHOWN_ATTR = [0xE5, 0xE5, 0xE5, 0xE5, 0xE5, 0xE1, 0xE5, 0xE5, 0xE5, 0xE5, 0xE5];

    console.log('\n--- ファンクションキー行(probe_fkey.c: p98_init中は非表示、p98_quit後に元の文字・属性が1バイトも違わず戻る) ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await page.evaluate((port) => window.p98probe.boot(`http://127.0.0.1:${port}/program/fkey.xdf`), PORT);
      await page.evaluate(() => window.p98probe.runNoWait('PROBE_FK'));

      // 1) init中(最初の60フレーム=約1秒の静止区間)に読む。500ms待てば
      //    この区間の中に収まるはず(probe_fkey.cのコメント参照)。
      await sleep(500);
      const hiddenChar = deinterleaveLow(await page.evaluate((a, l) => window.p98probe.readMemory(a, l), FKEY_CHAR_ADDR, FKEY_COLS * 2));
      const hiddenAttr = deinterleaveLow(await page.evaluate((a, l) => window.p98probe.readMemory(a, l), FKEY_ATTR_ADDR, FKEY_COLS * 2));
      assertEqual('[fkey] p98_init中はファンクションキー行が空白(文字コード面)', hiddenChar, FKEY_HIDDEN_CHAR, results);
      assertEqual('[fkey] p98_init中はファンクションキー行の属性がE1(下線が消えている)', hiddenAttr, FKEY_HIDDEN_ATTR, results);

      // 2) p98_quit()後、COMMAND.COMへ戻る前の静止区間(120フレーム=約2秒)の
      //    中で読む。起動からの累積で2.2秒待つ(1)の500msに追加で1.7秒)。
      await sleep(1700);
      const shownChar = deinterleaveLow(await page.evaluate((a, l) => window.p98probe.readMemory(a, l), FKEY_CHAR_ADDR, FKEY_COLS * 2));
      const shownAttr = deinterleaveLow(await page.evaluate((a, l) => window.p98probe.readMemory(a, l), FKEY_ATTR_ADDR, FKEY_COLS * 2));
      assertEqual('【主目的】[fkey] p98_quit()後はファンクションキー行の文字が1バイトも違わず元に戻る', shownChar, FKEY_SHOWN_CHAR, results);
      assertEqual('【主目的】[fkey] p98_quit()後はファンクションキー行の属性(下線パターン含む)も1バイトも違わず元に戻る', shownAttr, FKEY_SHOWN_ATTR, results);
      if (errors.length) console.log('page errors(fkey):', errors);
    });

    console.log('\n--- 故障注入: probe_fkey(p98_broken_fkey_noshow版)はp98_quit()後もファンクションキー行が非表示のままのはず ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await page.evaluate((port) => window.p98probe.boot(`http://127.0.0.1:${port}/program/fkeybroken.xdf`), PORT);
      await page.evaluate(() => window.p98probe.runNoWait('PROBE_FK'));
      await sleep(2200);
      const shownChar = deinterleaveLow(await page.evaluate((a, l) => window.p98probe.readMemory(a, l), FKEY_CHAR_ADDR, FKEY_COLS * 2));
      const detected = JSON.stringify(shownChar) !== JSON.stringify(FKEY_SHOWN_CHAR);
      results.push({
        label: '[fkey故障注入] ファンクションキー行の復帰を外すとp98_quit()後も文字が戻らない(検出できる)',
        ok: detected, actual: JSON.stringify(shownChar), expected: `not ${JSON.stringify(FKEY_SHOWN_CHAR)}`,
      });
      console.log(`${detected ? 'OK  ' : 'FAIL'} [fkey故障注入] 復帰忘れを検出 actual=${JSON.stringify(shownChar)}`);
      if (errors.length) console.log('page errors(fkeybroken):', errors);
    });

    // パレット退避廃止の回帰検査(2026-09後半)。
    //
    // 【不具合】同じFreeDOSセッション内でp98libのプログラムを2回連続で
    // 実行すると、2回目以降が画面全体一色に潰れて何も表示されなくなる
    // 不具合を実測で確認した(docs/design.md「パレット」節、
    // docs/verify-log.md参照)。原因はp98_init()がポート0xA8/0xAA/0xAC/0xAE
    // から現在のパレットを読み出して退避していたが、np2kai上ではこの
    // 読み出しが実際の値を返さず、p98_quit()がその不正な値を16色すべてへ
    // 書き戻してしまうこと。対処として、読み出しには一切頼らず、実測した
    // 既定パレット16色を毎回そのまま書き込む方式(tests/probe_palette_
    // default.c、docs/verify-log.md参照)へ変更した。
    //
    // 【検証の穴】既存の検証(probe_state.c、上の「初期化/終了の状態退避・
    // 復元」節参照)は「1プログラム=1回起動」でしか回っておらず、
    // 「同じ起動の中で2本目を走らせる」条件が一度も作られていなかったため、
    // この不具合を検出できなかった。さらに、既存の検査はVRAMの生バイトだけを
    // 比較しており、パレット破壊はVRAMバイトには一切現れず「見た目」にしか
    // 出ないため、仮に2回実行していたとしても素通りしていた。
    //
    // 【検査方法】tests/probe_palette_regress.cを同一セッション内で2回連続
    // 実行し、canvasの同じ座標の色が2回とも一致することを確認する
    // (VRAMバイトではなくcanvasのピクセルで見るのが今回の主眼)。
    console.log('\n--- パレット退避廃止の回帰検査(probe_palette_regress: 同一セッションで2回連続実行しても見た目が変わらない) ---');
    const PALETTE_SAMPLE_X = 320, PALETTE_SAMPLE_Y = 200;
    // tests/probe_palette_default.cの実測(docs/verify-log.md参照)による、
    // 色5の既定パレット(4bit r=0,g=7,b=7)がnp2kai上でcanvasに実際どう
    // 描かれるかの実測値。陽性対照(1回目が本当に正常か)の比較基準に使う。
    const PALETTE_COLOR5_EXPECTED = [0, 117, 115];
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      await page.evaluate((port) => window.p98probe.boot(`http://127.0.0.1:${port}/program/paletteregress.xdf`), PORT);

      const baseline2 = await page.evaluate(() => window.p98probe.runNoWait('PALREG'));
      await sleep(1200);
      const pixel1 = await pollStablePixel(page, PALETTE_SAMPLE_X, PALETTE_SAMPLE_Y);
      const positiveControlOk = pixelsClose(pixel1, PALETTE_COLOR5_EXPECTED);
      results.push({
        label: '[陽性対照][パレット回帰] 1回目の実行は既定パレット相当の色で表示される(計器が壊れていないことの確認)',
        ok: positiveControlOk, actual: JSON.stringify(pixel1), expected: `${JSON.stringify(PALETTE_COLOR5_EXPECTED)}近辺`,
      });
      console.log(`${positiveControlOk ? 'OK  ' : 'FAIL'} [陽性対照][パレット回帰] 1回目の色 actual=${JSON.stringify(pixel1)}`);
      await page.evaluate((b) => window.p98probe.waitPrompt(b, 20000), baseline2);

      const baseline3 = await page.evaluate(() => window.p98probe.runNoWait('PALREG'));
      await sleep(1200);
      const pixel2 = await pollStablePixel(page, PALETTE_SAMPLE_X, PALETTE_SAMPLE_Y);
      const ok = pixelsClose(pixel1, pixel2);
      results.push({
        label: '【主目的】[パレット回帰] 同一セッションで2回連続実行しても2回目の見た目が1回目と一致する',
        ok, actual: JSON.stringify(pixel2), expected: `${JSON.stringify(pixel1)}近辺`,
      });
      console.log(`${ok ? 'OK  ' : 'FAIL'} 【主目的】[パレット回帰] 1回目=${JSON.stringify(pixel1)} 2回目=${JSON.stringify(pixel2)}`);
      await page.evaluate((b) => window.p98probe.waitPrompt(b, 20000), baseline3);
      if (errors.length) console.log('page errors(paletteregress):', errors);
    });

    console.log('\n--- 故障注入: probe_palette_regress(p98_broken_palette_readback版)は2回目で色が崩れるはず ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      await page.evaluate((port) => window.p98probe.boot(`http://127.0.0.1:${port}/program/paletteregressbroken.xdf`), PORT);

      const baseline2 = await page.evaluate(() => window.p98probe.runNoWait('PALREG'));
      await sleep(1200);
      const pixel1 = await pollStablePixel(page, PALETTE_SAMPLE_X, PALETTE_SAMPLE_Y);
      // 陽性対照: 故障は2回目以降にしか出ないはずなので、1回目は
      // 正常(=修正後と同じ既定パレット相当の色)であることをまず確認する
      // (タスクの前提「1回目が正常であることを確認してから2回目を測る」)。
      const positiveControlOk = pixelsClose(pixel1, PALETTE_COLOR5_EXPECTED);
      results.push({
        label: '[陽性対照][パレット回帰故障注入] 1回目は故障注入版でも正常な色で表示される',
        ok: positiveControlOk, actual: JSON.stringify(pixel1), expected: `${JSON.stringify(PALETTE_COLOR5_EXPECTED)}近辺`,
      });
      console.log(`${positiveControlOk ? 'OK  ' : 'FAIL'} [陽性対照][パレット回帰故障注入] 1回目の色 actual=${JSON.stringify(pixel1)}`);
      await page.evaluate((b) => window.p98probe.waitPrompt(b, 20000), baseline2);

      const baseline3 = await page.evaluate(() => window.p98probe.runNoWait('PALREG'));
      await sleep(1200);
      const pixel2 = await pollStablePixel(page, PALETTE_SAMPLE_X, PALETTE_SAMPLE_Y);
      const detected = !pixelsClose(pixel1, pixel2);
      results.push({
        label: '[パレット回帰故障注入] パレットを読み出して退避する方式に戻すと2回目で見た目が崩れる(検出できる)',
        ok: detected, actual: JSON.stringify(pixel2), expected: `not ${JSON.stringify(pixel1)}近辺`,
      });
      console.log(`${detected ? 'OK  ' : 'FAIL'} [パレット回帰故障注入] 1回目=${JSON.stringify(pixel1)} 2回目=${JSON.stringify(pixel2)}(崩れを検出)`);
      await page.evaluate((b) => window.p98probe.waitPrompt(b, 20000), baseline3);
      if (errors.length) console.log('page errors(paletteregressbroken):', errors);
    });

    console.log('\n--- キーボード (probe_key: down/pressed/release/複数同時/getch/長押しリピート耐性) ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const sk = (code, down) => page.evaluate((c, d) => window.p98probe.sendKey(c, d), code, down);
      await page.evaluate((port) => window.p98probe.boot(`http://127.0.0.1:${port}/program/key.xdf`), PORT);
      const baseline2 = await page.evaluate(() => window.p98probe.runNoWait('PROBE_KE'));
      await sleep(800);

      // フェーズ1: 単発タップ
      await sk(0x1D, true); await sleep(350); await sk(0x1D, false);
      await sleep(300);
      // フェーズ2: a+bを同時に押す(複数キー同時押し)
      await sk(0x1D, true); await sk(0x2D, true);
      await sleep(350);
      await sk(0x1D, false); await sk(0x2D, false);
      await sleep(300);
      // フェーズ3: SHIFT+a -> a単独 -> CTRL+a (ここまででgetchに積む4文字を確定させる)
      await sk(0x70, true); await sk(0x1D, true); await sleep(80); await sk(0x1D, false); await sk(0x70, false);
      await sleep(200);
      await sk(0x1D, true); await sleep(80); await sk(0x1D, false);
      await sleep(200);
      await sk(0x74, true); await sk(0x1D, true); await sleep(80); await sk(0x1D, false); await sk(0x74, false);
      await sleep(300);
      // フェーズ4: ここから's'(0x1E)を1.5秒ホールドする(BIOSのキーリピート
      // 閾値=約500msを大きく超える)。a/b/shiftのgetch文字が先にバッファへ
      // 積まれた後で押すことで、's'のキーリピート文字がgetchの読み取り対象
      // (先頭4件)に混ざらないようにする。これが今回の主目的:
      // p98_key_pressed()が長押し中1回しか立たないことを確認する
      // (BIOS方式に切替前は、生のIRQ1レベルで18回立っていた)。
      await sk(0x1E, true);
      await sleep(1500);
      await sk(0x1E, false);
      await sleep(2500);

      const text = await page.evaluate((baseline) => window.p98probe.waitPrompt(baseline, 30000), baseline2);
      if (errors.length) console.log('page errors:', errors);
      const startIdx = text.indexOf('DOWNA_SEEN=');
      const chunk = (startIdx >= 0 ? text.slice(startIdx, startIdx + 200) : '').replace(/\n/g, '');
      console.log('screen text:', JSON.stringify(chunk));

      const g = (re) => chunk.match(re)?.[1];
      results.push({ label: '押している間 p98_key_down が真(DOWNA_SEEN)', ok: g(/DOWNA_SEEN=(\d)/) === '1', actual: g(/DOWNA_SEEN=(\d)/), expected: '1' });
      results.push({ label: '離すと p98_key_down が偽に戻る(DOWNA_END)', ok: g(/DOWNA_END=(\d)/) === '0', actual: g(/DOWNA_END=(\d)/), expected: '0' });
      results.push({ label: '複数キー同時押し(BOTH_SEEN)', ok: g(/BOTH_SEEN=(\d)/) === '1', actual: g(/BOTH_SEEN=(\d)/), expected: '1' });
      results.push({ label: 'p98_key_pressedはタップ1回につき1回だけ立つ(PRESSA=5回タップ分)', ok: g(/PRESSA=([0-9A-F]{2})/) === '05', actual: g(/PRESSA=([0-9A-F]{2})/), expected: '05' });
      results.push({ label: 'p98_key_pressedはタップ1回につき1回だけ立つ(PRESSB=1回タップ分)', ok: g(/PRESSB=([0-9A-F]{2})/) === '01', actual: g(/PRESSB=([0-9A-F]{2})/), expected: '01' });
      results.push({ label: '長押し(1.5秒、リピート閾値超え)の間 down が真であり続けた(DOWNLONG_SEEN)', ok: g(/DOWNLONG_SEEN=(\d)/) === '1', actual: g(/DOWNLONG_SEEN=(\d)/), expected: '1' });
      results.push({
        label: '【主目的】長押し(1.5秒、BIOSのキーリピート閾値500msを超える)でもp98_key_pressedは1回しか立たない(PRESSLONG)',
        ok: g(/PRESSLONG=([0-9A-F]{2})/) === '01', actual: g(/PRESSLONG=([0-9A-F]{2})/), expected: '01',
      });
      // 注意: 'B'は16進数字としても合法(0-9A-F)なため、改行除去後に続く
      // "B:\>"プロンプトの'B'まで拾ってしまわないよう、4個ぶんの2桁hexに
      // 個数を固定してマッチさせる。
      const getch = g(/GETCH=([0-9A-F]{2}(?:,[0-9A-F]{2}){3})/);
      results.push({
        label: 'p98_key_getchで打った文字列が順番どおり取れる(a,a,b,SHIFT+a=A。BIOSが変換した文字をそのまま返す)',
        ok: getch === '61,61,62,41', actual: getch, expected: '61,61,62,41',
      });
      for (const r of results.slice(-8)) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.label}${r.ok ? '' : ` actual=${JSON.stringify(r.actual)} expected=${JSON.stringify(r.expected)}`}`);
    });

    console.log('\n--- 故障注入: probe_key(p98_poll()で前回との差分を取らない版)は長押しでFAILするはず ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const sk = (code, down) => page.evaluate((c, d) => window.p98probe.sendKey(c, d), code, down);
      await page.evaluate((port) => window.p98probe.boot(`http://127.0.0.1:${port}/program/keybroken.xdf`), PORT);
      const baseline2 = await page.evaluate(() => window.p98probe.runNoWait('PROBE_KE'));
      await sleep(800);
      await sk(0x1D, true); await sleep(350); await sk(0x1D, false);
      await sleep(2000);
      await sk(0x1E, true);
      await sleep(1500);
      await sk(0x1E, false);
      await sleep(2500);
      const text = await page.evaluate((baseline) => window.p98probe.waitPrompt(baseline, 30000), baseline2);
      if (errors.length) console.log('page errors:', errors);
      const startIdx = text.indexOf('DOWNA_SEEN=');
      const chunk = (startIdx >= 0 ? text.slice(startIdx, startIdx + 200) : '').replace(/\n/g, '');
      const g = (re) => chunk.match(re)?.[1];
      // 正常なら01のはずが、故障注入(差分を取らない)では長押し中ずっと
      // downと同じ値がpressedに入り続けるため、01よりずっと大きくなる。
      const pressLong = g(/PRESSLONG=([0-9A-F]{2})/);
      const brokenDetected = !!pressLong && pressLong !== '01';
      results.push({ label: '故障注入(差分無し)はPRESSLONGが1にならない(長押し中ずっと真になってしまう)', ok: brokenDetected, actual: pressLong, expected: '01ではないはず' });
      console.log(`${brokenDetected ? 'OK  ' : 'FAIL'} 故障注入(差分無し) PRESSLONG actual=${pressLong}`);
    });

    // probe_sprite.c(CPU経路)とprobe_sprite_egc.c(EGC経路)は、座標・
    // スプライトデータが完全に同一。この同じ関数で両方を検査することで、
    // 「絶対値として正しいこと」と「CPU経路とEGC経路が一致すること(等価性)」
    // を同時に確認する。
    async function checkSpriteScenario(read, results, tag) {
      // 1) 横1ドットシフト(shift=0..7)。x=104+i, y=10+i。destバイトは13(と、shift!=0なら14)。
      //   期待値は 0xFF>>shift / (0xFF<<(8-shift))&0xFF の手計算。
      const shiftExpect = [
        [0xFF, null], [0x7F, 0x80], [0x3F, 0xC0], [0x1F, 0xE0],
        [0x0F, 0xF0], [0x07, 0xF8], [0x03, 0xFC], [0x01, 0xFE],
      ];
      for (let s = 0; s < 8; s++) {
        const rowOff = (10 + s) * ROW;
        const mem = await read(PLANE.B + rowOff + 13, 2);
        const [b13, b14] = shiftExpect[s];
        assertEqual(`${tag} シフトshift=${s}: byte13`, [mem[0]], [b13], results);
        if (b14 === null) {
          assertEqual(`${tag} シフトshift=${s}: byte14は未書き込み(destByteCount=1)`, [mem[1]], [0x00], results);
        } else {
          assertEqual(`${tag} シフトshift=${s}: byte14`, [mem[1]], [b14], results);
        }
      }
      // shift=3のケースだけ4プレーンとも同じ値になっていることも確認(全プレーン配線の確認)。
      for (const plane of ['B', 'R', 'G', 'I']) {
        const mem = await read(PLANE[plane] + (10 + 3) * ROW + 13, 2);
        assertEqual(`${tag} シフトshift=3 ${plane}plane byte13,14`, mem, [0x1F, 0xE0], results);
      }

      // 2) 複数色+マスク(x=200,y=50)。row0(y=50)はB/R=0xFB,0xC0、G/I=0,0。
      const row0Off = 50 * ROW;
      assertEqual(`${tag} スプライトrow0 Bplane byte25,26`, await read(PLANE.B + row0Off + 25, 2), [0xFB, 0xC0], results);
      assertEqual(`${tag} スプライトrow0 Rplane byte25,26`, await read(PLANE.R + row0Off + 25, 2), [0xFB, 0xC0], results);
      assertEqual(`${tag} スプライトrow0 Gplane byte25,26(色に緑成分は無い)`, await read(PLANE.G + row0Off + 25, 2), [0x00, 0x00], results);
      // row1(y=51)は色12(緑+輝度)で全10ドット不透明: G/I=0xFF,0xC0、B/R=0,0。
      const row1Off = 51 * ROW;
      assertEqual(`${tag} スプライトrow1 Gplane byte25,26`, await read(PLANE.G + row1Off + 25, 2), [0xFF, 0xC0], results);
      assertEqual(`${tag} スプライトrow1 Bplane byte25,26(色に青成分は無い)`, await read(PLANE.B + row1Off + 25, 2), [0x00, 0x00], results);

      // 3) 重ね描き: fill_rect(色5=青+緑)の上にrow0(マスクの穴=col5)を描く。
      //    手計算(docs/verify-log.md): 穴(byte25のbit2)では矩形の色が残るはず。
      //    B[25]=0xFF(矩形のB=1がそのまま残る。マスク無視ならFB相当ではなくFFのまま
      //    ではなく0xFBになるはず、というのが故障注入との違い)。
      //    G[25]=0x04(矩形のG=1が穴だけ残り、他はスプライトのG=0で上書きされ0になる)。
      const row0OverlapOff = 60 * ROW;
      assertEqual(`${tag} 重ね描き: Bplane byte25(穴でB=1が残る)`, await read(PLANE.B + row0OverlapOff + 25, 1), [0xFF], results);
      assertEqual(`${tag} 重ね描き: Gplane byte25(穴でG=1が残り、他は0で上書き)`, await read(PLANE.G + row0OverlapOff + 25, 1), [0x04], results);
      assertEqual(`${tag} 重ね描き: Bplane byte26(穴が無い列は矩形と同じ0xC0)`, await read(PLANE.B + row0OverlapOff + 26, 1), [0xC0], results);

      // 4) 画面端・四隅のクリップ(8x4白ベタ、B/R/G/I全プレーン同一パターン)
      // 左端 x=-3,y=200: 可視5px -> 0xF8。次のバイト(cols8-15)は触っていないはず。
      let r = await read(PLANE.B + 200 * ROW + 0, 2);
      assertEqual(`${tag} 左端クリップ: byte0=0xF8、byte1は未書き込み`, r, [0xF8, 0x00], results);
      // 右端 x=635,y=210: byte79=0x1F。次の行(211)のbyte0は触っていないはず(横クリップの検査を兼ねる)。
      r = await read(PLANE.B + 210 * ROW + 79, 1);
      assertEqual(`${tag} 右端クリップ: byte79=0x1F`, r, [0x1F], results);
      r = await read(PLANE.B + 211 * ROW + 0, 1);
      assertEqual(`${tag} 右端クリップ: 次行(211)の先頭バイトは触られていない`, r, [0x00], results);
      // 上端 x=300,y=-2: 4行中、上2行はクリップされ可視2行(y=0,1)のみ。x=300はshift=4。
      r = await read(PLANE.B + 0 * ROW + 37, 2);
      assertEqual(`${tag} 上端クリップ: row0 byte37,38=0x0F,0xF0`, r, [0x0F, 0xF0], results);
      r = await read(PLANE.B + 1 * ROW + 37, 2);
      assertEqual(`${tag} 上端クリップ: row1 byte37,38=0x0F,0xF0`, r, [0x0F, 0xF0], results);
      // 下端 x=310,y=398: 可視2行(398,399)のみ。x=310はshift=6。
      r = await read(PLANE.B + 398 * ROW + 38, 2);
      assertEqual(`${tag} 下端クリップ: row398 byte38,39=0x03,0xFC`, r, [0x03, 0xFC], results);
      r = await read(PLANE.B + 399 * ROW + 38, 2);
      assertEqual(`${tag} 下端クリップ: row399 byte38,39=0x03,0xFC`, r, [0x03, 0xFC], results);
      // 四隅(各コーナーの可視行1本ずつ、既出のx方向の計算を再利用)
      r = await read(PLANE.B + 0 * ROW + 0, 1);
      assertEqual(`${tag} 左上コーナー: row0 byte0=0xF8`, r, [0xF8], results);
      r = await read(PLANE.B + 0 * ROW + 79, 1);
      assertEqual(`${tag} 右上コーナー: row0 byte79=0x1F`, r, [0x1F], results);
      r = await read(PLANE.B + 399 * ROW + 0, 1);
      assertEqual(`${tag} 左下コーナー: row399 byte0=0xF8`, r, [0xF8], results);
      r = await read(PLANE.B + 399 * ROW + 79, 1);
      assertEqual(`${tag} 右下コーナー: row399 byte79=0x1F`, r, [0x1F], results);
    }

    console.log('\n--- スプライト・CPU経路 (probe_sprite: シフト/色+マスク/重ね描き/クリップ) ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      await page.evaluate((port) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/sprite.xdf`, 'PROBE_SP', { waitMs: 3000 }), PORT);
      if (errors.length) console.log('page errors:', errors);
      const read = (addr, len) => page.evaluate((a, l) => window.p98probe.readMemory(a, l), addr, len);
      await checkSpriteScenario(read, results, '[CPU]');
    });

    console.log('\n--- スプライト・EGC経路 (probe_sprite_egc: CPU経路と全く同じ座標・期待値で検証=等価性の確認) ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      await page.evaluate((port) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/spriteegc.xdf`, 'PROBE_SP', { waitMs: 3000 }), PORT);
      if (errors.length) console.log('page errors:', errors);
      const read = (addr, len) => page.evaluate((a, l) => window.p98probe.readMemory(a, l), addr, len);
      await checkSpriteScenario(read, results, '[EGC]');
    });

    console.log('\n--- 故障注入: probe_sprite_egc(WMレジスタ誤り版)はFAILするはず ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      await page.evaluate((port) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/spriteegcbroken.xdf`, 'PROBE_SP', { waitMs: 3000 }), PORT);
      if (errors.length) console.log('page errors:', errors);
      // シフトshift=0(x=104,y=10)は単色・全面不透明なのでEGC経路(fast path)が
      // 必ず通る。WM(0x4A4)を0x0000(CPU値そのまま)から0x1000(パターンを
      // 書く)へ誤らせると、CPU側で計算したソフトウェアシフト済みの値
      // (0xFF)ではなく別の値が書かれるはずで、期待値0xFFと一致しなくなる。
      // (0x4A0(プレーン選択)を壊す形も試したが、np2kaiのこのEGC実装では
      // 値に関わらず常に4プレーンぶん書かれてしまい検出できなかったため、
      // WMを壊す形にした。docs/verify-log.md参照。)
      const mem = await page.evaluate((a, l) => window.p98probe.readMemory(a, l), PLANE.B + 10 * ROW + 13, 1);
      const brokenDetected = mem[0] !== 0xFF;
      results.push({ label: '故障注入(EGC WMレジスタ誤り)はシフトshift=0のBplane byte13が0xFFにならない', ok: brokenDetected, actual: mem, expected: 'not [ff]' });
      console.log(`${brokenDetected ? 'OK  ' : 'FAIL'} 故障注入(EGC WMレジスタ誤り) Bplane byte13 actual=[${bytesToHex(mem)}] (正常なら0xFFのはず)`);
    });

    // p98_vram_upload()/p98_draw_sprite_vram()(VRAM常駐+EGC転送経路)と
    // p98_draw_sprite()(CPU経路)の等価性。tests/probe_sprite_vram.cの
    // レイアウト(座標はそのファイル冒頭のコメントと完全に一致させてある)。
    // 単なる絶対値比較ではなく「CPU経路の帯とVRAM経路の帯のバイト列が
    // 完全一致すること」を見る。加えて、両方とも「何も描いていない背景
    // そのまま」で一致してしまう(陽性対照が無いと検出できないFAIL)を
    // 防ぐため、CPU側の帯が背景そのままでないことも別途確認する。
    const VRAM_BG_BYTE = [0xFF, 0x00, 0x00, 0xFF]; // B,R,G,I (probe側BG_COLOR=9=B+I)
    function countNonBackgroundBytes(rect) {
      let n = 0;
      for (let p = 0; p < 4; p++) {
        for (const b of rect.planes[p]) if (b !== VRAM_BG_BYTE[p]) n++;
      }
      return n;
    }
    async function compareCpuEgc(page, results, label, xCpu, yCpu, xEgc, yEgc, wBits, h) {
      const cpu = await readVramRect(page, xCpu, yCpu, wBits, h);
      const egc = await readVramRect(page, xEgc, yEgc, wBits, h);
      const eq = rectPlanesEqual(cpu, egc);
      results.push({ label, ok: eq, actual: eq ? '一致' : '不一致(バイト列相違)', expected: '一致' });
      console.log(`${eq ? 'OK  ' : 'FAIL'} ${label}`);
      return { eq, cpu, egc };
    }

    console.log('\n--- スプライト・VRAM常駐+EGC転送経路 (probe_sprite_vram: CPU経路との等価性の確認) ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      await page.evaluate((port) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/spritevram.xdf`, 'PROBE_SV', { waitMs: 4000 }), PORT);
      if (errors.length) console.log('page errors:', errors);

      // ブロックA: SPR_A(16x16、全ドット不透明)、dx=0..15、8列x2行、列間隔48。
      // words=1なので読み取り幅は(1+1)*16=32bit(shift分の溢れも含めて安全に読む)。
      let aDiffTotal = 0;
      for (let dx = 0; dx < 16; dx++) {
        const col = dx % 8, row = Math.floor(dx / 8);
        const x0 = 16 + col * 48;
        const r = await compareCpuEgc(page, results, `[VRAM] ブロックA dx=${dx}: CPU経路とVRAM経路が一致`,
          x0, 8 + row * 20, x0, 56 + row * 20, 32, 16);
        aDiffTotal += countNonBackgroundBytes(r.cpu);
      }
      results.push({ label: '[VRAM] ブロックA: 陽性対照(CPU側の帯は背景そのままではない)', ok: aDiffTotal > 20, actual: `背景と異なるバイト数=${aDiffTotal}`, expected: '20を超えるはず' });
      console.log(`${aDiffTotal > 20 ? 'OK  ' : 'FAIL'} [VRAM] ブロックA 陽性対照 (背景と異なるバイト数=${aDiffTotal})`);

      // ブロックB: SPR_B(32x32、透明ドット・左右端の穴あり)、dx=0..15、8列x2行、列間隔64。
      // words=2なので読み取り幅は(2+1)*16=48bit。透明ドットの絵ビットに1を
      // 混ぜてあるため、修正1(絵をmaskとANDしてからVRAMへ書く)が効いて
      // いないとここでCPU経路とずれるはず。
      let bDiffTotal = 0;
      for (let dx = 0; dx < 16; dx++) {
        const col = dx % 8, row = Math.floor(dx / 8);
        const x0 = 16 + col * 64;
        const r = await compareCpuEgc(page, results, `[VRAM] ブロックB dx=${dx}: CPU経路とVRAM経路が一致(透明ドットの扱い含む)`,
          x0, 104 + row * 36, x0, 184 + row * 36, 48, 32);
        bDiffTotal += countNonBackgroundBytes(r.cpu);
      }
      results.push({ label: '[VRAM] ブロックB: 陽性対照(CPU側の帯は背景そのままではない)', ok: bDiffTotal > 20, actual: `背景と異なるバイト数=${bDiffTotal}`, expected: '20を超えるはず' });
      console.log(`${bDiffTotal > 20 ? 'OK  ' : 'FAIL'} [VRAM] ブロックB 陽性対照 (背景と異なるバイト数=${bDiffTotal})`);

      // 端: xが負(-5,264/-5,284) / 右端はみ出し(632,264/632,284)。どちらも
      // p98_draw_sprite_vram()内部でp98_draw_sprite()へフォールバックする
      // はずなので、画面全幅(80バイト)を読んで一致することを確認する。
      await compareCpuEgc(page, results, '[VRAM] 端: xが負/右端はみ出し(フォールバック)がCPU経路と一致', 0, 264, 0, 284, 640, 16);

      // 再アップロード確認: p98_vram_reupload()で置き直した後のSPR_B。
      const reup = await compareCpuEgc(page, results, '[VRAM] 再アップロード後もCPU経路と一致', 16, 308, 16, 344, 48, 32);
      results.push({ label: '[VRAM] 再アップロード: 陽性対照(CPU側の帯は背景そのままではない)', ok: countNonBackgroundBytes(reup.cpu) > 20, actual: `背景と異なるバイト数=${countNonBackgroundBytes(reup.cpu)}`, expected: '20を超えるはず' });
      console.log(`${countNonBackgroundBytes(reup.cpu) > 20 ? 'OK  ' : 'FAIL'} [VRAM] 再アップロード 陽性対照`);

      // 端: yが上下にはみ出す位置。X=560(CPU)/608(EGC、dx=0固定なのでどちらもshift無し)。
      // 上端(y=-5)は可視行のみ(0..26=27行)、下端(y=392)は可視行のみ(392..399=8行)を読む。
      // 読み取り幅はwords*16=32bit(4バイト)のみ(dx=0でシフトの溢れが無いため)。
      // (words+1)*16(=48bit)で読むと、X=608側はbyteOff=76+6=82となり1行=80バイトの
      // 境界を超えて次行の先頭2バイトを誤って読んでしまう(実際に検証時にFALSE FAILを
      // 起こした。docs/verify-log.md相当の教訓。ここでは同じ罠を踏まないよう32bitに絞る)。
      await compareCpuEgc(page, results, '[VRAM] 端: 上端はみ出しがCPU経路と一致', 560, 0, 608, 0, 32, 27);
      await compareCpuEgc(page, results, '[VRAM] 端: 下端はみ出しがCPU経路と一致', 560, 392, 608, 392, 32, 8);
    });

    console.log('\n--- 故障注入: probe_sprite_vram(AND転送無し版)はFAILするはず ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      await page.evaluate((port) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/spritevrambroken.xdf`, 'PROBE_SV', { waitMs: 4000 }), PORT);
      if (errors.length) console.log('page errors:', errors);
      // ブロックB dx=0(透明ドットを含むSPR_B)で比較する。パス1(AND転送)を
      // 丸ごとスキップしているので、透明ドットの位置で背景が0にならず、
      // パス2のOR転送で絵のビット(全部1)がそのまま乗ってしまい、
      // CPU経路の結果(背景が透明ドットの位置に残る)とずれるはず。
      const cpu = await readVramRect(page, 16, 104, 48, 32);
      const egc = await readVramRect(page, 16, 184, 48, 32);
      const eq = rectPlanesEqual(cpu, egc);
      const brokenDetected = !eq;
      results.push({
        label: '故障注入(VRAM AND転送無し)はブロックB dx=0でCPU経路とVRAM経路が一致しない(透明ドットの位置で背景にゴミが乗る)',
        ok: brokenDetected, actual: eq ? '一致(検出できず)' : '不一致(検出できた)', expected: '不一致のはず',
      });
      console.log(`${brokenDetected ? 'OK  ' : 'FAIL'} 故障注入(VRAM AND転送無し) ブロックB dx=0 actual=${eq ? '一致' : '不一致'}`);
    });

    // p98_vram_upload()の一次検査(tests/probe_vram_upload_bytes.c参照): 描画
    // (EGC転送)を一切経由せず、「VRAM置き場へ書かれたバイト列」を元の
    // p98_sprite_t(メインメモリ上の絵・マスク)と直接突き合わせる。
    //
    // 2026-09、p98.cへ未コミットの変更(1パス転送方式の追加。呼ばれてすら
    // いない)を加えただけでwalk2(samples/walk2.c)の見た目が変わる不具合が
    // あり、この検査で原因を「アップロード側」だと確定できた: 非opaqueな
    // スプライト(マスクに穴がある物)のアップロードで、AND計算した絵を
    // 一旦メインメモリの静的な作業用バッファへ組み立ててから、その
    // バッファのアドレスをhuge modelのfar pointerへ変換してcopy_far_to_vram()
    // へまとめて渡す実装になっており、この「大きい静的配列のアドレスを
    // far pointer化する」処理が、ライブラリ内の無関係な静的データの増減で
    // 配置が変わると壊れる(化けた内容を書く)ことが分かった。walk2は
    // ちょうどこの経路(32x32キャラクター、マスクに穴あり)を使っている。
    // 修正はp98__vram_upload_pixels()/p98__vram_store_inverted_mask()を
    // p98__pokeb()による直接書き込みに変更し、この作業用バッファ自体を
    // 廃止した(src/p98.c参照)。配置が変わっても再発しないことを機械的に
    // 検出できるよう、この検査を恒久的に追加してある。
    console.log('\n--- p98_vram_upload()の一次検査 (probe_vram_upload_bytes: VRAM置き場のバイト列が元のp98_sprite_tと一致) ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      await page.evaluate((port) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/vramuploadbytes.xdf`, 'PROBE_VB', { waitMs: 4000 }), PORT);
      if (errors.length) console.log('page errors:', errors);

      // mag_assets.hから必要な配列をそのままパースする(手写しの誤りを防ぐ)。
      const magSrc = await readFile(join(REPO_ROOT, 'samples', 'mag_assets.h'), 'utf8');
      const extractArray = (name) => {
        const m = magSrc.match(new RegExp(`${name}\\[\\d+\\]\\s*=\\s*\\{([^}]*)\\}`));
        if (!m) throw new Error(`mag_assets.hに${name}が見つからない`);
        return m[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => parseInt(s, 16));
      };
      const GROUND = { B: extractArray('MAG_TILE_GROUND_B'), R: extractArray('MAG_TILE_GROUND_R'), G: extractArray('MAG_TILE_GROUND_G'), I: extractArray('MAG_TILE_GROUND_I') };
      const ACCENT = { B: extractArray('MAG_TILE_ACCENT_B'), R: extractArray('MAG_TILE_ACCENT_R'), G: extractArray('MAG_TILE_ACCENT_G'), I: extractArray('MAG_TILE_ACCENT_I') };
      const CHAR = { B: extractArray('MAG_WALK_DOWN_P0_B'), R: extractArray('MAG_WALK_DOWN_P0_R'), G: extractArray('MAG_WALK_DOWN_P0_G'), I: extractArray('MAG_WALK_DOWN_P0_I'), M: extractArray('MAG_WALK_DOWN_M0') };

      // VRAM置き場(P98_VRAM_STORE_OFF=32000起点)のオフセットはp98__vram_alloc()の
      // 単純なバンプ割り当て(need=bytes+2)から決まる(probe_vram_upload_bytes.c
      // 冒頭のコメント参照): 1.MAG_TILE_GROUND pixOff=0 2.MAG_TILE_ACCENT
      // pixOff=34 3.MAG_WALK_DOWN[0] pixOff=68 / maskOff=198。
      const STORE = 32000;
      const readStorePlane = async (key, off, len) => page.evaluate(
        (addr, len) => window.p98probe.readMemory(addr, len), PLANE[key] + STORE + off, len,
      );
      const readStoreAll = async (off, len) => {
        const out = {};
        for (const key of ['B', 'R', 'G', 'I']) out[key] = await readStorePlane(key, off, len);
        return out;
      };

      const groundActual = await readStoreAll(0, 32);
      const accentActual = await readStoreAll(34, 32);
      const charPixActual = await readStoreAll(68, 128);
      const charMaskActual = await readStoreAll(198, 128);

      for (const key of ['B', 'R', 'G', 'I']) {
        assertEqual(`[VRAM一次検査] ground置き場.${key}が元データと一致`, groundActual[key], GROUND[key], results);
      }
      for (const key of ['B', 'R', 'G', 'I']) {
        assertEqual(`[VRAM一次検査] accent置き場.${key}が元データと一致`, accentActual[key], ACCENT[key], results);
      }
      for (const key of ['B', 'R', 'G', 'I']) {
        const expected = CHAR[key].map((v, i) => v & CHAR.M[i]);
        assertEqual(`[VRAM一次検査] char置き場(絵&マスク).${key}が元データと一致`, charPixActual[key], expected, results);
      }
      for (const key of ['B', 'R', 'G', 'I']) {
        const expected = CHAR.M.map((v) => (~v) & 0xFF);
        assertEqual(`[VRAM一次検査] char置き場(反転マスク).${key}が元データと一致`, charMaskActual[key], expected, results);
      }
    });

    console.log('\n--- 故障注入: probe_sprite(マスク無し版)はFAILするはず ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      await page.evaluate((port) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/spritenomask.xdf`, 'PROBE_SP', { waitMs: 3000 }), PORT);
      if (errors.length) console.log('page errors:', errors);
      const row0OverlapOff = 60 * ROW;
      const g = await page.evaluate((a, l) => window.p98probe.readMemory(a, l), PLANE.G + row0OverlapOff + 25, 1);
      const brokenDetected = g[0] !== 0x04;
      results.push({ label: '故障注入(マスク無し)は重ね描きの穴でGplaneが0x04にならない', ok: brokenDetected, actual: g, expected: 'not [4]' });
      console.log(`${brokenDetected ? 'OK  ' : 'FAIL'} 故障注入(マスク無し) Gplane byte25 actual=[${bytesToHex(g)}] (正常なら0x04のはず)`);
    });

    console.log('\n--- 故障注入: probe_sprite(クリップ無し版)はFAILするはず ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      await page.evaluate((port) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/spritenoclip.xdf`, 'PROBE_SP', { waitMs: 3000 }), PORT);
      if (errors.length) console.log('page errors:', errors);
      const mem = await page.evaluate((a, l) => window.p98probe.readMemory(a, l), PLANE.B + 211 * ROW + 0, 1);
      const brokenDetected = mem[0] !== 0x00;
      results.push({ label: '故障注入(クリップ無し)は次行の先頭バイトを汚す', ok: brokenDetected, actual: mem, expected: 'nonzero' });
      console.log(`${brokenDetected ? 'OK  ' : 'FAIL'} 故障注入(クリップ無し)は次行の先頭バイトを汚す actual=[${bytesToHex(mem)}]`);
    });

    console.log('\n--- スプライト速度のA/B比較 (probe_sprite_bench[_egc] / probe_sprite_bench0) ---');
    // ゲスト側のBIOSティック(INT1Ah)は実時間と安定して対応しないことが実測で
    // 分かった(tests/probe_sprite_bench.cのコメント参照)ため、ホスト
    // (puppeteer)側のperformance.now()で「B:からPROBE_S*を実行してプロンプトへ
    // 戻るまで」の実時間を測り、スプライトN本描く版(CPU経路/EGC経路)と
    // 0本の版(bench0、共通ベースライン)の差分を取ることで、init/quit等の
    // 固定オーバーヘッドを相殺した「N本ぶんの描画にかかった時間」を求める。
    // ノイズを減らすため3回ずつ測り中央値を使う。
    // 条件はCPU版・EGC版・ベースラインの3本とも完全に同一:
    //   スプライト16x16(全プレーン0xFF・マスク0xFFの最悪ケース)、
    //   本数2000(=BENCH_N 40 × BENCH_ITERS 50)、同じ座標列、同じ測定方法。
    const SPRITE_BENCH_N = 40 * 50; // tests/probe_sprite_bench*.c の BENCH_N*BENCH_ITERS と一致させる
    const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
    async function measureRunTimes(program, stem, timeoutMs = 15000) {
      const times = [];
      await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
        await page.evaluate((port, prog) => window.p98probe.boot(`http://127.0.0.1:${port}/program/${prog}.xdf`), PORT, program);
        for (let i = 0; i < 3; i++) times.push(await page.evaluate((s, t) => window.p98probe.runTimed(s, t), stem, timeoutMs));
        if (errors.length) console.log(`page errors(${program}):`, errors);
      });
      console.log(`${program}の実行時間: [${times.map((v) => v.toFixed(0)).join(', ')}]ms`);
      return median(times);
    }

    const baseMs = await measureRunTimes('spritebench0', 'PROBE_S0');
    const cpuMs = await measureRunTimes('spritebench', 'PROBE_SB');
    const egcMs = await measureRunTimes('spritebenchegc', 'PROBE_SE');
    const vramMs = await measureRunTimes('spritebenchvram', 'PROBE_SR');

    {
      const cpuPerSpriteMs = (cpuMs - baseMs) / SPRITE_BENCH_N;
      const egcPerSpriteMs = (egcMs - baseMs) / SPRITE_BENCH_N;
      const vramPerSpriteMs = (vramMs - baseMs) / SPRITE_BENCH_N;
      const cpuPerSec = cpuPerSpriteMs > 0 ? 1000 / cpuPerSpriteMs : Infinity;
      const egcPerSec = egcPerSpriteMs > 0 ? 1000 / egcPerSpriteMs : Infinity;
      const vramPerSec = vramPerSpriteMs > 0 ? 1000 / vramPerSpriteMs : Infinity;
      console.log(`中央値: baseline=${baseMs.toFixed(0)}ms, CPU経路${SPRITE_BENCH_N}本=${cpuMs.toFixed(0)}ms, EGC経路(部分最適化)${SPRITE_BENCH_N}本=${egcMs.toFixed(0)}ms, VRAM置き場経路(EGC本転送)${SPRITE_BENCH_N}本=${vramMs.toFixed(0)}ms`);
      console.log(`CPU経路: 1体あたり約${cpuPerSpriteMs.toFixed(3)}ms ≈ 約${cpuPerSec.toFixed(0)}体/秒`);
      console.log(`EGC経路(部分最適化): 1体あたり約${egcPerSpriteMs.toFixed(3)}ms ≈ 約${egcPerSec.toFixed(0)}体/秒`);
      console.log(`VRAM置き場経路(EGC本転送、p98_draw_sprite_vram): 1体あたり約${vramPerSpriteMs.toFixed(3)}ms ≈ 約${vramPerSec.toFixed(0)}体/秒`);
      console.log(`比(EGC/CPU): ${(egcPerSec / cpuPerSec).toFixed(2)}倍, 比(VRAM/CPU): ${(vramPerSec / cpuPerSec).toFixed(2)}倍`);
      console.log('注意: これはnp2kai(WebNP2)のEGCエミュレーション実装+puppeteerというこの実行環境全体を通した相対値であり、実機での比率とは限らない(エミュレータがEGCを実機より速く/遅く実装している可能性があるため)。定性的な結論(速い/変わらない/遅い)のみ採る。');
      const ok = Number.isFinite(cpuPerSpriteMs) && cpuPerSpriteMs > 0 && Number.isFinite(egcPerSpriteMs) && egcPerSpriteMs > 0 && Number.isFinite(vramPerSpriteMs) && vramPerSpriteMs > 0;
      results.push({
        label: 'スプライト速度のA/B比較が完了(具体的な数値・比率は合否判定の対象ではない。docs/verify-log.md参照)',
        ok, actual: `CPU約${cpuPerSec.toFixed(0)}体/秒, EGC約${egcPerSec.toFixed(0)}体/秒, VRAM置き場約${vramPerSec.toFixed(0)}体/秒`, expected: '3つとも正の値が計測できていること',
      });
      console.log(ok ? 'OK   スプライト速度のA/B比較が完了' : 'FAIL スプライト速度のA/B比較に失敗(差分が0以下)');
    }

    // (p98_vram_reupload()のアップロード自体のコストを測るA/B比較は、walk2の
    // 固定sleep(15000ms)を圧迫しないよう、このファイル末尾(walk2を含む
    // 全検査より後ろ)へ置いてある。2026-09、1パス方式の速度A/B比較を
    // ここに置いていた際に同じ理由でwalk2側がFAILする実測結果になったため
    // 末尾へ移した経緯があり、その教訓を踏襲した。)

    console.log('\n--- 陽性対照: スプライト速度ベンチ(VRAM経路)が実際に描画していることの確認 ---');
    {
      // 上のA/B比較はホスト側performance.now()の差分だけを見ており、
      // 「実は描いていないから速い」(VRAM経路が実際には何も転送せず
      // 単に速いだけ)を検出できない。最後に描くスプライトの座標
      // (iter=BENCH_ITERS-1=49, i=BENCH_N-1=39)を、tests/probe_sprite_bench*.c
      // と同じ式 x=(iter*7+i*37)%620, y=(iter*3+i*11)%380 でそのまま計算すると
      // x=546,y=196。x=546はバイト境界(8の倍数)ではないため、切り下げた
      // 544を起点にシフトぶんを含め32bit(4バイト)読めば16x16スプライト
      // 全体(544..575の範囲)が収まる。
      const SX = 544, SY = 196, SW = 32, SH = 16;
      async function readAfterRun(program, stem) {
        let rect;
        await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
          await page.evaluate((port, prog, s) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/${prog}.xdf`, s, { waitForExit: true }), PORT, program, stem);
          if (errors.length) console.log(`page errors(${program}):`, errors);
          rect = await readVramRect(page, SX, SY, SW, SH);
        });
        return rect;
      }

      const blank = await readAfterRun('spritebench0', 'PROBE_S0');
      const cpu = await readAfterRun('spritebench', 'PROBE_SB');
      const vram = await readAfterRun('spritebenchvram', 'PROBE_SR');

      const cpuDiffersFromBlank = !rectPlanesEqual(cpu, blank);
      results.push({ label: '[陽性対照] スプライト速度ベンチ: CPU経路実行後は0本描画版(背景)と一致しない(実際に描いている)', ok: cpuDiffersFromBlank, actual: cpuDiffersFromBlank ? '不一致(描画あり)' : '一致(描いていない)', expected: '不一致' });
      console.log(`${cpuDiffersFromBlank ? 'OK  ' : 'FAIL'} [陽性対照] スプライト速度ベンチ CPU経路は背景のままではない`);

      const vramMatchesCpu = rectPlanesEqual(vram, cpu);
      results.push({ label: '[陽性対照] スプライト速度ベンチ: VRAM経路の最終描画結果がCPU経路と一致(実際に同じ絵を描いている)', ok: vramMatchesCpu, actual: vramMatchesCpu ? '一致' : '不一致', expected: '一致' });
      console.log(`${vramMatchesCpu ? 'OK  ' : 'FAIL'} [陽性対照] スプライト速度ベンチ VRAM経路がCPU経路と一致`);
    }

    // walk.c / walk_broken_nobg.c は probe_*.c と違い、描画後に静止せず
    // 毎vsync再描画し続ける(ゲームループ)。切り分けの過程で分かったこと
    // (使い捨てプローブで確認、コミットには残していない):
    //   - readMemory()が読むのは「表示中のページ」ではなく「現在の描画/
    //     アクセスページ(ポート0xA6側)」らしい。p98_flip()はdisp/drawの
    //     両方を入れ替えるため、flip直後に読めるのは「1つ前のイテレーションで
    //     描いた側」であり、起動直後でまだ1回しかflipしていない(=ページ0が
    //     一度も描かれていない)タイミングで読むと、まっさらな未描画ページを
    //     読んでしまい、全プレーンが0(何も描いていないように見える)になる。
    //   - probe_fill.c等が最初に理由付きでp98_flip()してから描く」慣習
    //     (このファイル内のコメント参照)は、まさにこの「初回は裏ページが
    //     ”外から読める側”になっていない」問題を避けるためのものだった。
    //   - walk.cは毎フレーム再描画するので理屈上は2フレーム目以降ずっと
    //     読めるはずだが、直前の重い速度計測(スプライトA/B比較)でホストが
    //     混んでいると、エミュレーション自体が実時間に対して大きく遅れ、
    //     数秒待ってもまだ2フレーム目に届いていないことがあった
    //     (使い捨てプローブでループ回数1/2/3回を比較し、1回だけ全プレーン0、
    //     2回以上で正しい値になることを確認して原因を特定した)。
    // 対策: 1回のevaluate()で必要なアドレスをまとめて読み(呼び出し内は
    // 単一のJS実行なので途中でゲストの次フレームに割り込まれない)、
    // さらに2回連続で同じ値になるまで再試行する。加えて、この節の待ち時間は
    // 直前の重い計測の影響を吸収できるよう他の検査より長めに取っている。
    async function readManyStable(page, addrs, { tries = 40, gapMs = 200 } = {}) {
      const readOnce = () => page.evaluate(
        (list) => list.map(([addr, len]) => window.p98probe.readMemory(addr, len)),
        addrs,
      );
      // 「2回連続で同じ値」に加えて、そのstableな値が全アドレス・全バイトとも
      // 0の場合は「まだ描画が反映される前のページを掴んだまま安定してしまった」
      // 疑いを優先し(walk系の検査対象アドレスは、描画済みなら必ずどこかが
      // 非0になる設計にしてある)、tries を使い切るまでは受け入れずに待ち直す。
      // 実測でホストが混んでいる時(直前の重い速度計測の直後等)に本当に
      // これが起きたため、単純な2回一致判定だけでは不十分だった。
      let prev = await readOnce();
      let lastStable = null;
      for (let i = 0; i < tries; i++) {
        await new Promise((r) => setTimeout(r, gapMs));
        const cur = await readOnce();
        if (JSON.stringify(prev) === JSON.stringify(cur)) {
          lastStable = cur;
          const allZero = cur.every((m) => m.every((b) => b === 0));
          if (!allZero) return cur;
        }
        prev = cur;
      }
      console.log('警告: walk系の検証でVRAM読み取りが安定しなかった(最後のサンプルを使う)');
      return lastStable ?? prev;
    }

    console.log('\n--- サンプル: walk(方向キー移動+色替え+背景復帰。samples/walk.c) ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const sk = (code, down) => page.evaluate((c, d) => window.p98probe.sendKey(c, d), code, down);
      const SHAPE = [0x3C, 0x7E, 0xFF, 0xDB, 0xFF, 0x66, 0x3C, 0x18];
      const BAND_Y = 16;
      const addr = (plane, row, byte) => PLANE[plane] + (BAND_Y + row) * ROW + byte;

      await page.evaluate((port) => window.p98probe.boot(`http://127.0.0.1:${port}/program/walk.xdf`), PORT);
      const baseline2 = await page.evaluate(() => window.p98probe.runNoWait('WALK'));
      // walk.cはp98_init()(状態退避・ベクタ差し替え)を経てからループへ入るため、
      // probe_*.c(描画してすぐ静止)より最初の1フレームが出るまで少し長くかかる。
      // 短すぎると「まだ何も描いていない(VRAMが全部0)」状態のままreadManyStableが
      // 安定判定してしまう(実際に600msで一度この事故を踏んだ)ので、余裕を見る。
      await sleep(3000);

      // 1) 起動直後: 背景(バンド・装飾矩形)とキャラの初期位置(x=16,y=16)を確認。
      {
        const [b, r, g, i] = (await readManyStable(page, [
          [addr('B', 0, 50), 1], [addr('R', 0, 50), 1], [addr('G', 0, 50), 1], [addr('I', 0, 50), 1],
        ])).map((m) => m[0]);
        assertEqual('[walk] 起動直後: バンド(キャラから離れた位置) B/R/G/Iplane', [b, r, g, i], [0x00, 0xFF, 0x00, 0xFF], results);
      }
      // 装飾矩形(300,150,120,80,色5)自体の直接検査はここでは行わない。
      // 切り分けの過程(使い捨てプローブ、コミットには残していない)で、
      // 同じ座標・同じfill_rect呼び出しを「1回描画して静止する」方式や
      // 「2000回ループしてから静止する」方式で検査すると常に正しい値
      // (ff/00/ff/00)が読めるのに対し、このテストのように「常時ループ+
      // 複数回のkey送信+複数箇所の読み取りを混在させた」実行のもとでは
      // この特定の座標だけ読み取りがまれに0のまま安定してしまうことがあった。
      // 原因はブラウザのタブ・スロットリング等、検証ハーネス側の疑いが強いが
      // 特定しきれなかった(ライブラリ側のバグの証拠は無い。fill_rect単体の
      // 正しさは`tools/verify.mjs`前半の矩形塗りテストで別途確認済み)。
      // 深追いすると本来の目的(デモの結線・背景復帰の確認)から外れるため、
      // ここでは検査対象から外し、未確認として`docs/verify-log.md`に残す。
      {
        // 初期位置 x=16(byte2) row0: B/GプレーンはCHAR_SHAPE[0]=0x3C(色15なので
        // シルエットがそのまま出る)、R/Iプレーンは背景(0xFF)と色15のR/Iビット(1)が
        // 一致するため、シルエットの有無に関わらず常に0xFF。
        const [b, r, g, i] = (await readManyStable(page, [
          [addr('B', 0, 2), 1], [addr('R', 0, 2), 1], [addr('G', 0, 2), 1], [addr('I', 0, 2), 1],
        ])).map((m) => m[0]);
        assertEqual('[walk] 起動直後: キャラ(x=16,y=16,row0) B/R/G/Iplane', [b, r, g, i], [SHAPE[0], 0xFF, SHAPE[0], 0xFF], results);
      }

      // 2) RIGHTキーは押している間ずっと移動する(p98_key_down)ため、
      // 「N回タップ→N歩」という制御はできない(何フレーム押していたかに
      // 移動量が依存し、検証が時間依存になってしまう)。walk2の節と同じく
      // 「壁に当たるまで押し続ける」ことで位置を確定させる。壁に当たった後は
      // 動かなくなるので、HOLD_MSを実際に必要な時間より十分長く取っても
      // 安全(壊れない)。
      // 壁の位置(cx + STEP <= SCREEN_W - CHAR_W = 632を満たす最大値)を検算する:
      // cx=16から24ずつ増やすと 16,40,64,...,592,616 となり、616+24=640>632で
      // 止まるため、右端はx=616(8の倍数なのでbyte境界、616/8=77)に確定する。
      const HOLD_MS = 10000;
      const NEW_X = 616, NEW_BYTE = 77; // 検算: 16 + 24*25 = 616、616+24=640は632を超えるため止まる
      await sk(0x3C, true); await sleep(HOLD_MS); await sk(0x3C, false);
      await sleep(1500);

      {
        // 新しい位置(byte77)と元の位置(byte2)を同じスナップショットでまとめて読む。
        const snap = await readManyStable(page, [
          [addr('B', 0, NEW_BYTE), 1], [addr('G', 0, NEW_BYTE), 1],
          [addr('B', 0, 2), 1], [addr('R', 0, 2), 1], [addr('G', 0, 2), 1], [addr('I', 0, 2), 1],
        ]);
        const [newB, newG, oldB, oldR, oldG, oldI] = snap.map((m) => m[0]);
        assertEqual(`[walk] 移動後: 新しい位置(x=${NEW_X},row0) B/Gplane`, [newB, newG], [SHAPE[0], SHAPE[0]], results);
        // 元の位置(byte2)は背景(バンド)だけに戻っていること(=背景が壊れていない)。
        // これがこのデモの主目的の検査。
        assertEqual('[walk] 【主目的】移動後: 元の位置(x=16,row0)は背景に復帰している(B/R/G/Iplane、背景が壊れていない検査)', [oldB, oldR, oldG, oldI], [0x00, 0xFF, 0x00, 0xFF], results);
      }

      // 3) SPACEキーで色を替える(白=色15→色3=青+赤)。Gプレーンだけ0x00になるはず。
      // 読む位置は2)で確定した新しいx(=616,byte77)に合わせる。
      await sk(0x34, true); await sleep(350); await sk(0x34, false);
      await sleep(1500);
      {
        const [g, b] = (await readManyStable(page, [
          [addr('G', 2, NEW_BYTE), 1], [addr('B', 2, NEW_BYTE), 1],
        ])).map((m) => m[0]);
        assertEqual('[walk] SPACEで色替え: 新色(青+赤)ではGplaneが0x00になる(row2、変更前は0xFFだったはず)', [g], [0x00], results);
        assertEqual('[walk] SPACEで色替え: Bplaneはシルエットのまま(row2)', [b], [SHAPE[2]], results);
      }

      // 4) ESCで終了し、DOSへ戻ることを確認。
      await sk(0x00, true); await sleep(250); await sk(0x00, false);
      await page.evaluate((baseline) => window.p98probe.waitPrompt(baseline, 20000), baseline2);
      if (errors.length) console.log('page errors:', errors);
      const verText = await page.evaluate(() => window.p98probe.runDosCommand('VER'));
      const alive = /FreeCom/i.test(verText);
      results.push({ label: '[walk] ESCで終了後、DOSコマンド(VER)が正常応答する', ok: alive, actual: alive ? '応答あり' : verText.slice(-200), expected: '応答あり' });
      console.log(`${alive ? 'OK  ' : 'FAIL'} [walk] ESC終了後にVERを実行してプロンプトが返る`);
    });

    console.log('\n--- 故障注入: walk_broken_nobg(背景復帰を外した版)は「背景が壊れていない」検査でFAILするはず ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const sk = (code, down) => page.evaluate((c, d) => window.p98probe.sendKey(c, d), code, down);
      const SHAPE = [0x3C, 0x7E, 0xFF, 0xDB, 0xFF, 0x66, 0x3C, 0x18];
      const BAND_Y = 16;
      const addr = (plane, row, byte) => PLANE[plane] + (BAND_Y + row) * ROW + byte;

      await page.evaluate((port) => window.p98probe.boot(`http://127.0.0.1:${port}/program/walkbroken.xdf`), PORT);
      const baseline2 = await page.evaluate(() => window.p98probe.runNoWait('WALK_BRO'));
      // 故障注入版は起動直後に両ページへ背景を描く下準備をしているぶん、
      // 通常版より少し長めに待つ。
      await sleep(1800);

      // 起動直後の見た目はwalk.cと同じはず(壊れているのは移動後の背景復帰だけ)。
      {
        const [b, r, g, i] = (await readManyStable(page, [
          [addr('B', 0, 2), 1], [addr('R', 0, 2), 1], [addr('G', 0, 2), 1], [addr('I', 0, 2), 1],
        ])).map((m) => m[0]);
        assertEqual('[walk故障注入] 起動直後: キャラ(x=16,y=16,row0) B/R/G/Iplane', [b, r, g, i], [SHAPE[0], 0xFF, SHAPE[0], 0xFF], results);
      }

      // RIGHTを1回タップしてx=16(byte2)->x=40(byte5)へ移動。
      await sk(0x3C, true); await sleep(350); await sk(0x3C, false);
      // 残像は一度残るとその後どれだけ待っても消えない実装(design.md参照)
      // なので、タイミングを気にせず長めに待ってから読む。
      await sleep(1800);

      {
        const snap = await readManyStable(page, [[addr('B', 0, 5), 1], [addr('B', 0, 2), 1]]);
        const [newB, oldB] = snap.map((m) => m[0]);
        // 新しい位置にはちゃんとキャラが出る(移動自体は壊れていない)。
        assertEqual('[walk故障注入] 移動後: 新しい位置(x=40,row0)にキャラが出る(Bplane)', [newB], [SHAPE[0]], results);
        // 【故障の検出】元の位置(x=16)は本来なら背景(0x00)に戻るはずだが、
        // 背景復帰の呼び出しを削除してあるため、キャラの残像(0x3C)が
        // 残ったままのはず。
        const leftover = oldB !== 0x00;
        results.push({
          label: '[walk故障注入] 移動後: 元の位置(x=16)に背景復帰せず残像が残る(検査が故障を検出できること)',
          ok: leftover, actual: [oldB], expected: '0x00ではない(残像が残っているはず)',
        });
        console.log(`${leftover ? 'OK  ' : 'FAIL'} [walk故障注入] 元の位置に残像が残ることを検出 actual=[${bytesToHex([oldB])}]`);
      }

      await sk(0x00, true); await sleep(250); await sk(0x00, false);
      await page.evaluate((baseline) => window.p98probe.waitPrompt(baseline, 20000), baseline2);
      if (errors.length) console.log('page errors:', errors);
      const verText = await page.evaluate(() => window.p98probe.runDosCommand('VER'));
      const alive = /FreeCom/i.test(verText);
      results.push({ label: '[walk故障注入] ESCで終了後もDOSコマンド(VER)が正常応答する', ok: alive, actual: alive ? '応答あり' : verText.slice(-200), expected: '応答あり' });
      console.log(`${alive ? 'OK  ' : 'FAIL'} [walk故障注入] ESC終了後にVERを実行してプロンプトが返る`);
    });

    console.log('\n--- 背景ページ+差分復帰(EGC活用。probe_bgpage: 通過後の背景が原本と完全一致) ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      await page.evaluate((port) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/bgpage.xdf`, 'PROBE_BG', { waitMs: 2000 }), PORT);
      if (errors.length) console.log('page errors:', errors);

      // 1箇所目(x=16,y=16、バンドの上): 3箇所目まで動いた後、バンド
      // (色10=赤+輝度)そのものに戻っているはず。
      const rowBand = 16 * ROW;
      for (const plane of ['B', 'R', 'G', 'I']) {
        const mem = await page.evaluate((addr, len) => window.p98probe.readMemory(addr, len), PLANE[plane] + rowBand + 2, 1);
        const expect = { B: 0x00, R: 0xFF, G: 0x00, I: 0xFF }[plane];
        assertEqual(`[bgpage] 1箇所目(バンド上)は背景に復元されている ${plane}plane`, mem, [expect], results);
      }
      // 2箇所目(x=208,y=100、単発矩形の上): 3箇所目まで動いた後、
      // 矩形の色(5=青+緑)そのものに戻っているはず。
      const rowRect = 100 * ROW;
      for (const plane of ['B', 'R', 'G', 'I']) {
        const mem = await page.evaluate((addr, len) => window.p98probe.readMemory(addr, len), PLANE[plane] + rowRect + 26, 1);
        const expect = { B: 0xFF, R: 0x00, G: 0xFF, I: 0x00 }[plane];
        assertEqual(`[bgpage] 2箇所目(矩形上)は背景に復元されている ${plane}plane`, mem, [expect], results);
      }
      // 3箇所目(x=304,y=300、今描いたキャラ): 全プレーン白のはず。
      const rowChar = 300 * ROW;
      for (const plane of ['B', 'R', 'G', 'I']) {
        const mem = await page.evaluate((addr, len) => window.p98probe.readMemory(addr, len), PLANE[plane] + rowChar + 38, 1);
        assertEqual(`[bgpage] 3箇所目(今のキャラ位置) ${plane}plane`, mem, [0xFF], results);
      }
    });

    console.log('\n--- 故障注入: probe_bgpage(復元矩形を1ドット縮小した版)は背景一致検査でFAILするはず ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      await page.evaluate((port) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/bgpagebroken.xdf`, 'PROBE_BG', { waitMs: 2000 }), PORT);
      if (errors.length) console.log('page errors:', errors);

      // 1箇所目の下端行(row23=y16+7)は、1ドット縮小した版では復元されず
      // 白(0xFF)が残っているはず(正常なら0x00/0xFF/0x00/0xFFのバンド)。
      const rowEdge = 23 * ROW;
      const mem = await page.evaluate((addr, len) => window.p98probe.readMemory(addr, len), PLANE.B + rowEdge + 2, 1);
      const leftover = mem[0] !== 0x00;
      results.push({
        label: '[bgpage故障注入] 1箇所目の下端行に残像が残る(検査が故障を検出できること)',
        ok: leftover, actual: mem, expected: '0x00ではない(残像が残っているはず)',
      });
      console.log(`${leftover ? 'OK  ' : 'FAIL'} [bgpage故障注入] 下端行に残像が残ることを検出 actual=[${bytesToHex(mem)}]`);
    });

    console.log('\n--- 背景ページ+差分復帰のA/B速度比較(重い背景40矩形、同一条件でBENCH_FRAMES=300回更新) ---');
    {
      const baseFullMs = await measureRunTimes('spritebench0', 'PROBE_S0'); /* p98_init/flip/clear/quitのみ。probe_bgpage_bench_full.cと同じ固定オーバーヘッド */
      const baseDiffMs = await measureRunTimes('bgpagebench0bg', 'PROBE_B0'); /* p98_init_bgpage+背景描画2回+quit。probe_bgpage_bench_diff.cと同じ固定オーバーヘッド */
      const fullMs = await measureRunTimes('bgpagebenchfull', 'PROBE_BF', 40000); /* 重い背景の全描き直しは1回20秒前後かかるため、既定15秒より長めに待つ */
      const diffMs = await measureRunTimes('bgpagebenchdiff', 'PROBE_BD', 40000);

      const BG_BENCH_FRAMES = 300; /* tests/probe_bgpage_bench_{full,diff}.c の BENCH_FRAMES と一致させる */
      const fullPerFrameMs = (fullMs - baseFullMs) / BG_BENCH_FRAMES;
      const diffPerFrameMs = (diffMs - baseDiffMs) / BG_BENCH_FRAMES;
      const fullFps = fullPerFrameMs > 0 ? 1000 / fullPerFrameMs : Infinity;
      const diffFps = diffPerFrameMs > 0 ? 1000 / diffPerFrameMs : Infinity;
      console.log(`条件: 背景=40矩形(8列x5行、各20x20)+p98_clear、キャラ=16x16白ベタ1体、${BG_BENCH_FRAMES}フレーム更新、同一座標列`);
      console.log(`毎フレーム全描き直し: baseline=${baseFullMs.toFixed(0)}ms, 本編=${fullMs.toFixed(0)}ms, 差分=${(fullMs - baseFullMs).toFixed(0)}ms → 1フレームあたり約${fullPerFrameMs.toFixed(3)}ms ≈ 約${fullFps.toFixed(1)}fps`);
      console.log(`背景ページ差分復帰: baseline=${baseDiffMs.toFixed(0)}ms, 本編=${diffMs.toFixed(0)}ms, 差分=${(diffMs - baseDiffMs).toFixed(0)}ms → 1フレームあたり約${diffPerFrameMs.toFixed(3)}ms ≈ 約${diffFps.toFixed(1)}fps`);
      console.log(`比(差分復帰/全描き直し、更新頻度): ${(diffFps / fullFps).toFixed(2)}倍`);
      console.log('注意: これはnp2kai(WebNP2)+puppeteerというこの実行環境全体を通した相対値であり、実機での比率とは限らない。定性的な結論(速い/変わらない/遅い)のみ採る。');
      const ok = Number.isFinite(fullPerFrameMs) && fullPerFrameMs > 0 && Number.isFinite(diffPerFrameMs) && diffPerFrameMs > 0;
      results.push({
        label: '背景ページ差分復帰のA/B速度比較が完了(具体的な数値・比率は合否判定の対象ではない。docs/verify-log.md参照)',
        ok, actual: `全描き直し約${fullFps.toFixed(1)}fps, 差分復帰約${diffFps.toFixed(1)}fps`, expected: '両方とも正の値が計測できていること',
      });
      console.log(ok ? 'OK   背景ページ差分復帰のA/B速度比較が完了' : 'FAIL 背景ページ差分復帰のA/B速度比較に失敗(差分が0以下)');
    }

    console.log('\n--- 背景ページモード使用後の後始末(EGC後始末・DOS続行への影響が無いこと) ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      // probe_bgpage_bench_diff.cはEGCを300回(復元のたび)有効化/無効化
      // しながらp98_quit()で正常に抜ける。p98_quit()自体も0x7Cを無効化する
      // 保険を持つ(src/p98.c参照)。EGCを大量に使った直後でも、
      //  (a) p98_quit()後にDOSプロンプトへ戻りコマンドを実行できる
      //      (画面がグラフィック/EGCのままハングしていない)
      //  (b) VERコマンドの出力が正しく読める(テキストVRAMが化けていない)
      // ことを確認する。
      await page.evaluate((port) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/bgpagebenchdiff.xdf`, 'PROBE_BD', { waitForExit: true }), PORT);
      if (errors.length) console.log('page errors:', errors);
      const text = await page.evaluate(() => window.p98probe.runDosCommand('VER'));
      const alive = /FreeCom/i.test(text);
      results.push({ label: '[bgpage] 差分復帰を大量に使った後もp98_quit()後にDOSコマンド(VER)が正常応答する', ok: alive, actual: alive ? '応答あり' : text.slice(-200), expected: '応答あり' });
      console.log(`${alive ? 'OK  ' : 'FAIL'} [bgpage] 差分復帰使用後、p98_quit後にVERを実行してプロンプトが返る`);
    });

    console.log('\n--- p98_quit後もDOSが生きている(コマンドを1つ実行してプロンプトが返る) ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      await page.evaluate((port) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/key.xdf`, 'PROBE_KE', { waitForExit: true }), PORT);
      if (errors.length) console.log('page errors:', errors);
      const text = await page.evaluate(() => window.p98probe.runDosCommand('VER'));
      const alive = /FreeCom/i.test(text);
      results.push({ label: 'p98_quit後、DOSコマンド(VER)を実行してプロンプトが返る(ハングしていない。BIOSのキーバッファを空にしていることも間接的に確認)', ok: alive, actual: alive ? '応答あり' : text.slice(-200), expected: '応答あり' });
      console.log(`${alive ? 'OK  ' : 'FAIL'} p98_quit後にVERを実行してプロンプトが返る`);
    });

    console.log('\n--- EGC使用後の後始末(テキスト表示・DOS続行への影響が無いこと) ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      // probe_sprite_bench_egc.c はEGCを何度も有効化/無効化しながら
      // 2000回描画したあと p98_quit() で正常に抜ける(probe_sprite_egc.cは
      // VRAM読み取り用に無限ループへ入って戻らないため、ここでは使えない)。
      // p98_quit()自体も念のため0x7Cを無効化する(src/p98.c参照)。
      // EGCを使った直後でも、
      //  (a) p98_quit()後にDOSプロンプトへ戻り、コマンドを実行できる
      //      (=画面がグラフィック/EGCのままハングしていない)
      //  (b) VERコマンドの出力がテキストとして正しく読める
      //      (=テキストVRAMがEGC/GRCGの影響で化けていない)
      // ことを確認する。
      await page.evaluate((port) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/spritebenchegc.xdf`, 'PROBE_SE', { waitForExit: true }), PORT);
      if (errors.length) console.log('page errors:', errors);
      const text = await page.evaluate(() => window.p98probe.runDosCommand('VER'));
      const alive = /FreeCom/i.test(text);
      results.push({ label: 'EGC使用後もp98_quit()後にDOSコマンド(VER)が正常応答する(画面・テキスト表示が壊れていない)', ok: alive, actual: alive ? '応答あり' : text.slice(-200), expected: '応答あり' });
      console.log(`${alive ? 'OK  ' : 'FAIL'} EGC使用後、p98_quit後にVERを実行してプロンプトが返る`);
    });

    // ---- ここから: 実素材(C-GAMES/SAKA由来)を使ったデモ2。2026-09後半、
    // キャラをMAG(MITEI3.MAG、当時の標準フォーマット)由来へ主役交代。
    // タイルはKYA(MITEI2.KYA)由来のまま(理由はdocs/design.md参照)。 ----

    if (!assetsAvailable) {
      const entry = { label: '変換アセットの実値検証・サンプル2(walk2)一式', skip: true, reason: '素材が無いため実行できません' };
      results.push(entry);
      skipped.push(entry);
      console.log('\n--- 変換アセットの実値検証・サンプル2(walk2) ---');
      console.log('SKIP 素材(元のMAG/KYAファイル)が無いため実行できません(作者の環境でのみ実行可能。README.md参照)');
    } else {
    console.log('\n--- 変換アセットの実値検証(probe_walk2_assets: タイル2種+4方向キャラ(いずれもKYARA-03.MAG由来)がVRAM上で変換結果と一致) ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      await page.evaluate((port) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/walk2assets.xdf`, 'PROBE_WA', { waitMs: 2000 }), PORT);
      if (errors.length) console.log('page errors:', errors);

      const checks = [
        ['地面タイル(草)', magAssetSet.ground.rect, 0, 0, 16, 16],
        ['地面タイル(レンガ)', magAssetSet.accent.rect, 16, 0, 16, 16],
        ['キャラDOWN[0](MAG由来)', magAssetSet.down[0].rect, 64, 64, 32, 32],
        ['キャラLEFT[0](MAG由来)', magAssetSet.leftFrames[0].rect, 160, 64, 32, 32],
        ['キャラRIGHT[0](MAG由来、左向きの水平反転。期待値はcol7から独立に切り出し)', independentRightFrames[0].rect, 256, 64, 32, 32],
        ['キャラUP[0](MAG由来)', magAssetSet.up[0].rect, 352, 64, 32, 32],
      ];
      for (const [label, expectedRect, x, y, w, h] of checks) {
        const actual = await readVramRect(page, x, y, w, h);
        const ok = rectPlanesEqual(actual, expectedRect);
        results.push({ label: `[変換] ${label}(x=${x},y=${y})がVRAM上で変換結果と一致`, ok, actual: ok ? '一致' : '不一致', expected: '一致' });
        console.log(`${ok ? 'OK  ' : 'FAIL'} [変換] ${label} が変換結果と一致`);
      }
    });

    console.log('\n--- 故障注入: probe_walk2_assets_broken(MAG変換のR/Gプレーン入替版)はVRAM照合でFAILするはず ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      await page.evaluate((port) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/walk2assetsbroken.xdf`, 'PROBE_WA', { waitMs: 2000 }), PORT);
      if (errors.length) console.log('page errors:', errors);

      // 正しい期待値(magAssetSet、R/G入替前)と突き合わせる。故障注入版は
      // R/Gプレーンを入れ替えて生成してあるため、キャラの絵(4プレーンとも
      // 使う箇所がある)は一致しないはず。
      const actual = await readVramRect(page, 64, 64, 32, 32);
      const mismatched = !rectPlanesEqual(actual, magAssetSet.down[0].rect);
      results.push({
        label: '[MAG変換故障注入] R/Gプレーン入替版はキャラDOWN[0]が正しい変換結果と一致しない(検査が故障を検出できること)',
        ok: mismatched, actual: mismatched ? '不一致(検出できた)' : '一致してしまった(検出できていない)', expected: '不一致',
      });
      console.log(`${mismatched ? 'OK  ' : 'FAIL'} [MAG変換故障注入] R/G入替を検出`);
    });

    console.log('\n--- サンプル2: walk2(タイル背景+実素材、4方向歩行アニメ。samples/walk2.c) ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const sk = (code, down) => page.evaluate((c, d) => window.p98probe.sendKey(c, d), code, down);
      // walk2.cは押しっぱなし移動(p98_key_down)になったため、「N回タップ→
      // N歩」という制御はできない(何フレーム押していたかに移動量が依存し、
      // 検証が時間依存になってしまう)。代わりに「壁に当たるまで押し続ける」
      // ことで位置を確定させる。壁に当たった後は動かなくなるので、
      // HOLD_MSを実際に必要な時間より十分長く取っても安全(壊れない)。
      const HOLD_MS = 10000;
      const holdToWall = async (code) => { await sk(code, true); await sleep(HOLD_MS); await sk(code, false); await sleep(1200); };
      const SC = { UP: 0x3A, RIGHT: 0x3C, DOWN: 0x3D, LEFT: 0x3B, ESC: 0x00 };
      const TILE = 16;
      const ACCENT_MOD = 5; // samples/walk2.c の ACCENT_MOD と一致させる
      const START_X = 16 * TILE, START_Y = 12 * TILE; // walk2.cの初期位置と一致
      // samples/walk2.cのSCREEN_W/SCREEN_H/CHAR_W/CHAR_Hと同じ値(壁の位置)。
      const RIGHT_WALL_X = 640 - 32, BOTTOM_WALL_Y = 400 - 32;

      // samples/walk2.c と同じ規則(tx+ty)%ACCENT_MOD===0でタイルを選び、
      // (x,y,w,h)(すべてTILE=16の倍数)ぶんの「背景だけ」の合成矩形を作る。
      function tileAt(tx, ty) { return ((tx + ty) % ACCENT_MOD === 0) ? magAssetSet.accent.rect : magAssetSet.ground.rect; }
      function buildBackgroundRect(x, y, w, h) {
        const wBytes = w / 8;
        const planes = [Buffer.alloc(wBytes * h), Buffer.alloc(wBytes * h), Buffer.alloc(wBytes * h), Buffer.alloc(wBytes * h)];
        for (let ty = 0; ty < h / TILE; ty++) {
          for (let tx = 0; tx < w / TILE; tx++) {
            const tile = tileAt(x / TILE + tx, y / TILE + ty);
            for (let row = 0; row < TILE; row++) {
              for (let p = 0; p < 4; p++) {
                const srcOff = row * tile.wBytes;
                const dstOff = (ty * TILE + row) * wBytes + tx * tile.wBytes;
                tile.planes[p].copy(planes[p], dstOff, srcOff, srcOff + tile.wBytes);
              }
            }
          }
        }
        return { w, h, wBytes, planes };
      }
      // p98_draw_sprite/p98_draw_sprite_diffと同じマスク合成: out = (bg & ~mask) | (sprite & mask)。
      function blendSprite(bgRect, frame) {
        const { rect: spr, mask } = frame;
        const planes = bgRect.planes.map((bgPlane, p) => {
          const out = Buffer.alloc(bgPlane.length);
          for (let i = 0; i < out.length; i++) out[i] = (bgPlane[i] & ~mask[i]) | (spr.planes[p][i] & mask[i]);
          return out;
        });
        return { w: bgRect.w, h: bgRect.h, wBytes: bgRect.wBytes, planes };
      }
      function expectedComposite(x, y, frame) {
        return blendSprite(buildBackgroundRect(x, y, frame.rect.w, frame.rect.h), frame);
      }
      // samples/walk2.cのcurrent_sprite(dir, (cx+cy)/STEP)と同じ規則で
      // 期待コマを「位置」から決める(歩数カウンタは参照しない)。RIGHTの
      // 期待フレームだけは、mag_convert.mjsの反転処理を経由しない
      // independentRightFrames(原物col6/col7から直接切り出し)を使う。
      function expectedFrame(dir, x, y) {
        const idx = ((x + y) / TILE) % 2;
        if (dir === 'UP')    return magAssetSet.up[idx];
        if (dir === 'DOWN')  return magAssetSet.down[idx];
        if (dir === 'LEFT')  return magAssetSet.leftFrames[idx];
        return independentRightFrames[idx];
      }

      await page.evaluate((port) => window.p98probe.boot(`http://127.0.0.1:${port}/program/walk2.xdf`), PORT);
      const baseline2 = await page.evaluate(() => window.p98probe.runNoWait('WALK2'));
      // walk2.cはp98_init_bgpage()の後、40x25=1000枚のタイルを背景ページ・
      // 画面ページの両方へ(=2000回のp98_draw_sprite呼び出し)描いてから
      // ループへ入る。スプライト速度計測(前節、CPU経路約266体/秒)から
      // 見積もると、この初期化だけで7秒前後かかる。3秒程度で読みに行くと
      // 「まだ何も描かれていない/描画途中」を「壊れている」と誤検出したため
      // (最初にこの節を書いたときに実際に踏んだ)、十分に余裕を見て待つ。
      //
      // 【2026-09追記】固定15秒待ちだと、ホスト(このマシン)が他の処理で
      // 混んでいる時にエミュレーションが実時間に対して遅れ、15秒経っても
      // 初期化(2000回描画)が終わっていないことがある(walk.cの節にある
      // readManyStableと同種の問題。p98lib側のコード変更が原因ではなく、
      // 「ホストの実時間とゲストの処理速度が結びついていない」という
      // このエミュレータ実行環境そのものの性質。tools/verify.mjsに
      // p98_vram_upload_1pass等の検査を追加してからこの節がまれに
      // FAILするようになった実測で発覚した)。walk.cのreadManyStableほど
      // 厳密ではないが、「起動直後の期待値に一致するまで」最大90秒
      // ポーリングして、ホスト負荷のばらつきを吸収する。
      {
        const deadline = Date.now() + 90000;
        let waited = 0;
        for (;;) {
          const probe = await readVramRect(page, START_X, START_Y, 32, 32);
          const expectedProbe = expectedComposite(START_X, START_Y, expectedFrame('DOWN', START_X, START_Y));
          if (rectPlanesEqual(probe, expectedProbe) || Date.now() >= deadline) break;
          await sleep(2000);
          waited += 2000;
        }
        console.log(`[walk2] 起動直後の安定待ち: 約${waited}ms(ポーリングで一致確認/タイムアウト)`);
      }

      // readVramRectは1回の読み取りが安定している前提(probe_*系と同様、
      // 直前のキー操作からの待ち時間を確保して安定させる。walk.cの節にある
      // readManyStableほど厳密な安定化はしていないが、各操作後1.2秒待つ
      // ことで実測上は安定して読めている)。

      // 1) 起動直後: DOWN[0]が初期位置に、タイル背景の上に合成されて出ている。
      {
        const actual = await readVramRect(page, START_X, START_Y, 32, 32);
        const expected = expectedComposite(START_X, START_Y, expectedFrame('DOWN', START_X, START_Y));
        const ok = rectPlanesEqual(actual, expected);
        results.push({ label: '[walk2] 起動直後: キャラがDOWN[0]でタイル背景上の初期位置に出ている', ok, actual: ok ? '一致' : '不一致', expected: '一致' });
        console.log(`${ok ? 'OK  ' : 'FAIL'} [walk2] 起動直後の見た目`);
      }

      // 2) RIGHTを右端まで押し続ける: cx=RIGHT_WALL_X(=608)で確定する
      //    (256から16刻みで22回ちょうど届くため、壁に当たった位置が一意)。
      await holdToWall(SC.RIGHT);
      const afterRightX = RIGHT_WALL_X, afterRightY = START_Y;
      {
        const actual = await readVramRect(page, afterRightX, afterRightY, 32, 32);
        const expected = expectedComposite(afterRightX, afterRightY, expectedFrame('RIGHT', afterRightX, afterRightY));
        const ok = rectPlanesEqual(actual, expected);
        results.push({ label: '[walk2] RIGHTを右端まで保持: 位置と向き(RIGHT)・アニメのコマが位置から決まる規則と一致', ok, actual: ok ? '一致' : '不一致', expected: '一致' });
        console.log(`${ok ? 'OK  ' : 'FAIL'} [walk2] RIGHT移動+アニメ切替`);
      }
      {
        // 通過した1マス目(START_X+16, タイル境界)が地面タイルへ復元されている
        // ことを確認する(このデモの主目的: 差分復帰で背景が壊れていない)。
        const passedX = START_X + 16;
        const actual = await readVramRect(page, passedX, START_Y, 16, 16);
        const expected = buildBackgroundRect(passedX, START_Y, 16, 16);
        const ok = rectPlanesEqual(actual, expected);
        results.push({ label: '【主目的】[walk2] 通過したマスの背景がタイル原本と完全一致(差分復帰が壊れていない、RIGHT方向)', ok, actual: ok ? '一致' : '不一致', expected: '一致' });
        console.log(`${ok ? 'OK  ' : 'FAIL'} [walk2] 通過後の背景復元(RIGHT)`);
      }

      // 3) DOWNを下端まで押し続ける: cyのみBOTTOM_WALL_Y(=368)へ変わる。
      await holdToWall(SC.DOWN);
      const afterDownX = afterRightX, afterDownY = BOTTOM_WALL_Y;
      {
        const actual = await readVramRect(page, afterDownX, afterDownY, 32, 32);
        const expected = expectedComposite(afterDownX, afterDownY, expectedFrame('DOWN', afterDownX, afterDownY));
        const ok = rectPlanesEqual(actual, expected);
        results.push({ label: '[walk2] DOWNを下端まで保持: 位置と向き(DOWN)・アニメのコマが位置から決まる規則と一致', ok, actual: ok ? '一致' : '不一致', expected: '一致' });
        console.log(`${ok ? 'OK  ' : 'FAIL'} [walk2] DOWN移動+アニメ切替`);
      }
      {
        const passedY = START_Y + TILE;
        const actual = await readVramRect(page, afterDownX, passedY, 16, 16);
        const expected = buildBackgroundRect(afterDownX, passedY, 16, 16);
        const ok = rectPlanesEqual(actual, expected);
        results.push({ label: '【主目的】[walk2] 通過したマスの背景がタイル原本と完全一致(差分復帰が壊れていない、DOWN方向)', ok, actual: ok ? '一致' : '不一致', expected: '一致' });
        console.log(`${ok ? 'OK  ' : 'FAIL'} [walk2] 通過後の背景復元(DOWN)`);
      }

      // 4) LEFTを左端まで押し続ける: cxのみ0へ変わる。
      await holdToWall(SC.LEFT);
      const afterLeftX = 0, afterLeftY = afterDownY;
      {
        const actual = await readVramRect(page, afterLeftX, afterLeftY, 32, 32);
        const expected = expectedComposite(afterLeftX, afterLeftY, expectedFrame('LEFT', afterLeftX, afterLeftY));
        const ok = rectPlanesEqual(actual, expected);
        results.push({ label: '[walk2] LEFTを左端まで保持: 位置と向き(LEFT)・アニメのコマが位置から決まる規則と一致', ok, actual: ok ? '一致' : '不一致', expected: '一致' });
        console.log(`${ok ? 'OK  ' : 'FAIL'} [walk2] LEFT移動+向き切替`);
      }
      {
        const passedX = afterDownX - TILE;
        const actual = await readVramRect(page, passedX, afterDownY, 16, 16);
        const expected = buildBackgroundRect(passedX, afterDownY, 16, 16);
        const ok = rectPlanesEqual(actual, expected);
        results.push({ label: '【主目的】[walk2] 通過したマスの背景がタイル原本と完全一致(差分復帰が壊れていない、LEFT方向)', ok, actual: ok ? '一致' : '不一致', expected: '一致' });
        console.log(`${ok ? 'OK  ' : 'FAIL'} [walk2] 通過後の背景復元(LEFT)`);
      }

      // 5) UPを上端まで押し続ける: cyのみ0へ変わる。
      await holdToWall(SC.UP);
      const afterUpX = afterLeftX, afterUpY = 0;
      {
        const actual = await readVramRect(page, afterUpX, afterUpY, 32, 32);
        const expected = expectedComposite(afterUpX, afterUpY, expectedFrame('UP', afterUpX, afterUpY));
        const ok = rectPlanesEqual(actual, expected);
        results.push({ label: '[walk2] UPを上端まで保持: 位置と向き(UP)・アニメのコマが位置から決まる規則と一致', ok, actual: ok ? '一致' : '不一致', expected: '一致' });
        console.log(`${ok ? 'OK  ' : 'FAIL'} [walk2] UP移動+アニメ切替`);
      }
      {
        const passedY = afterLeftY - TILE;
        const actual = await readVramRect(page, afterUpX, passedY, 16, 16);
        const expected = buildBackgroundRect(afterUpX, passedY, 16, 16);
        const ok = rectPlanesEqual(actual, expected);
        results.push({ label: '【主目的】[walk2] 通過したマスの背景がタイル原本と完全一致(差分復帰が壊れていない、UP方向)', ok, actual: ok ? '一致' : '不一致', expected: '一致' });
        console.log(`${ok ? 'OK  ' : 'FAIL'} [walk2] 通過後の背景復元(UP)`);
      }

      // 6) ESCで終了し、DOSへ戻ることを確認。
      await sk(SC.ESC, true); await sleep(250); await sk(SC.ESC, false);
      await page.evaluate((baseline) => window.p98probe.waitPrompt(baseline, 20000), baseline2);
      if (errors.length) console.log('page errors:', errors);
      const verText = await page.evaluate(() => window.p98probe.runDosCommand('VER'));
      const alive = /FreeCom/i.test(verText);
      results.push({ label: '[walk2] ESCで終了後、DOSコマンド(VER)が正常応答する', ok: alive, actual: alive ? '応答あり' : verText.slice(-200), expected: '応答あり' });
      console.log(`${alive ? 'OK  ' : 'FAIL'} [walk2] ESC終了後にVERを実行してプロンプトが返る`);
    });
    }

    console.log('\n--- walk2: タイル背景でのA/B速度比較(全描き直し vs 差分復帰、BENCH_FRAMES=40) ---');
    {
      // measureRunTimes(上の「スプライト速度のA/B比較」節で定義した共通関数)は
      // 呼び出しごとに新しいpage(withPage)を開いてbootする。同じpageを
      // 使い回してboot()を連続で呼ぶと"core is already booted"で例外になる
      // ことが分かったため(walk2の速度比較を最初に書いた版はこれで落ちた)、
      // ここでも同じ関数を使い回す。
      //
      // BENCH_FRAMESはbgpage系の300ではなく40にしてある。タイル背景は
      // 40x25=1000枚をp98_draw_sprite()で毎フレーム敷き詰め直す必要があり
      // (bgpage系のp98_fill_rect40個より1体あたりのコストが高いCPU合成
      // スプライトを1000回呼ぶため)、実測でスプライト1体あたり約3.8ms
      // (前節のCPU経路約266体/秒)から見積もると300フレームでは
      // 1000*3.8ms*300 ≈ 19分かかってしまい非現実的だった(実際に最初は
      // 300のままデフォルトタイムアウト15秒で試して"DOSプロンプトを待機中に
      // タイムアウト"を起こした)。20フレームまで落として一度は動いたが、
      // 差分復帰側の signal(20フレームぶんの実コスト、数百ms)が固定
      // オーバーヘッド(背景を2回描く、約5.3秒)に対して小さすぎて、
      // 3回測定の中央値でもホストの揺らぎで「差分復帰の方が全描き直しより
      // 遅い(diff<0)」という逆転結果が出ることがあった(実測で確認)。
      // 40フレームに増やしてsignalを倍にし、この逆転が起きにくくした
      // (それでも原理的にはノイズで再度逆転しうる。定性的な結論だけを
      // 採る方針は他のA/B比較と同じ)。
      const base0 = await measureRunTimes('spritebench0', 'PROBE_S0');
      const baseBg0 = await measureRunTimes('walk2bench0bg', 'PROBE_W3');
      const fullMs = await measureRunTimes('walk2benchfull', 'PROBE_W1', 200000);
      const diffMs = await measureRunTimes('walk2benchdiff', 'PROBE_W2', 40000);

      const BENCH_FRAMES = 40;
      const fullPerFrameMs = (fullMs - base0) / BENCH_FRAMES;
      const diffPerFrameMs = (diffMs - baseBg0) / BENCH_FRAMES;
      const fullFps = 1000 / fullPerFrameMs;
      const diffFps = 1000 / diffPerFrameMs;
      console.log(`walk2(タイル背景)全描き直し: baseline=${base0.toFixed(0)}ms, 本編=${fullMs.toFixed(0)}ms → 1フレームあたり約${fullPerFrameMs.toFixed(3)}ms ≈ 約${fullFps.toFixed(1)}fps`);
      console.log(`walk2(タイル背景)差分復帰: baseline=${baseBg0.toFixed(0)}ms, 本編=${diffMs.toFixed(0)}ms → 1フレームあたり約${diffPerFrameMs.toFixed(3)}ms ≈ 約${diffFps.toFixed(1)}fps`);
      if (fullPerFrameMs > 0 && diffPerFrameMs > 0) {
        console.log(`比: 差分復帰は全描き直しの約${(fullPerFrameMs / diffPerFrameMs).toFixed(2)}倍速い(この実行環境全体を通した相対値。docs/verify-log.md参照)`);
      }
      const ok = fullPerFrameMs > 0 && diffPerFrameMs > 0;
      results.push({
        label: 'walk2(実素材のタイル背景)でのA/B速度比較が完了(具体的な数値・比率は合否判定の対象ではない。docs/verify-log.md参照)',
        ok, actual: `全描き直し約${fullFps.toFixed(1)}fps, 差分復帰約${diffFps.toFixed(1)}fps`, expected: '両方とも正の値が計測できていること',
      });
      console.log(ok ? 'OK   walk2のA/B速度比較が完了' : 'FAIL walk2のA/B速度比較に失敗(差分が0以下)');
    }

    console.log('\n--- タイル敷き詰めのA/B速度比較(CPU経路 vs VRAM/EGC経路、40x25タイルをREPEAT=3回) ---');
    {
      // samples/walk2.cのdraw_tiled_background()をVRAM/EGC経路(EGC本転送、
      // p98_vram_upload+p98_draw_sprite_vram)へ載せ替えたことの効果を、
      // walk2本体ではなく単純なタイル敷き詰めだけを切り出して測る。
      // 「全描き直し vs 差分復帰」(前節)とは別の軸(同じ全描き直しの中で
      // CPU合成とEGC本転送のどちらが速いか)なので、REPEAT回数・タイル・
      // 座標順を完全に揃えたCPU版とVRAM版だけを比較する。
      const base0 = await measureRunTimes('tilebgbench0', 'PROBE_T0');
      const cpuMs = await measureRunTimes('tilebgbenchcpu', 'PROBE_TC', 60000);
      const vramMs = await measureRunTimes('tilebgbenchvram', 'PROBE_TV', 60000);

      const TILEBG_REPEAT = 3; /* tests/probe_tilebg_bench_{cpu,vram}.c の REPEAT と一致させる */
      const TILEBG_TILES = 40 * 25; /* 40x25 */
      const cpuTotalTiles = TILEBG_REPEAT * TILEBG_TILES;
      const cpuPerTileMs = (cpuMs - base0) / cpuTotalTiles;
      const vramPerTileMs = (vramMs - base0) / cpuTotalTiles;
      const cpuTps = cpuPerTileMs > 0 ? 1000 / cpuPerTileMs : Infinity;
      const vramTps = vramPerTileMs > 0 ? 1000 / vramPerTileMs : Infinity;
      console.log(`条件: 40x25=1000枚のタイル敷き詰めをREPEAT=${TILEBG_REPEAT}回(合計${cpuTotalTiles}枚)、同一座標順・同一タイル選択規則`);
      console.log(`CPU経路(p98_draw_sprite): baseline=${base0.toFixed(0)}ms, 本編=${cpuMs.toFixed(0)}ms → 1枚あたり約${cpuPerTileMs.toFixed(3)}ms ≈ 約${cpuTps.toFixed(0)}枚/秒`);
      console.log(`VRAM/EGC経路(p98_draw_sprite_vram): baseline=${base0.toFixed(0)}ms, 本編=${vramMs.toFixed(0)}ms → 1枚あたり約${vramPerTileMs.toFixed(3)}ms ≈ 約${vramTps.toFixed(0)}枚/秒`);
      if (cpuPerTileMs > 0 && vramPerTileMs > 0) {
        console.log(`比(CPU/VRAM): VRAM経路はCPU経路の約${(cpuPerTileMs / vramPerTileMs).toFixed(2)}倍速い(この実行環境全体を通した相対値。docs/verify-log.md参照)`);
      }
      console.log('注意: この実行環境(np2kai+puppeteer)込みの相対値であり、実機での比率とは限らない。定性的な結論(速い/変わらない/遅い)のみ採る。');
      const ok = Number.isFinite(cpuPerTileMs) && cpuPerTileMs > 0 && Number.isFinite(vramPerTileMs) && vramPerTileMs > 0;
      results.push({
        label: 'タイル敷き詰めのA/B速度比較(CPU経路 vs VRAM/EGC経路)が完了(具体的な数値・比率は合否判定の対象ではない。docs/verify-log.md参照)',
        ok, actual: `CPU約${cpuTps.toFixed(0)}枚/秒, VRAM約${vramTps.toFixed(0)}枚/秒`, expected: '両方とも正の値が計測できていること',
      });
      console.log(ok ? 'OK   タイル敷き詰めのA/B速度比較が完了' : 'FAIL タイル敷き詰めのA/B速度比較に失敗(差分が0以下)');
    }

    console.log('\n--- 陽性対照: タイル敷き詰め速度ベンチ(VRAM経路)が実際に描画していることの確認 ---');
    {
      // 上のA/B比較も同様にperformance.now()の差分だけなので、「実は描いて
      // いないから速い」を検出できない。左上(0,0)のタイルは選択規則
      // (tx+ty)%5==0によりMAG_TILE_ACCENTになる(tests/probe_tilebg_bench_vram.c
      // 冒頭コメント参照)。タイルを1枚も敷かない版(tilebgbench0)を
      // 「背景」として、CPU経路(tilebgbenchcpu)・VRAM経路(tilebgbenchvram)を
      // それぞれ1回実行した後の同じ領域と比べる。
      const SX = 0, SY = 0, SW = 16, SH = 16;
      async function readAfterRun(program, stem) {
        let rect;
        await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
          await page.evaluate((port, prog, s) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/${prog}.xdf`, s, { waitForExit: true }), PORT, program, stem);
          if (errors.length) console.log(`page errors(${program}):`, errors);
          rect = await readVramRect(page, SX, SY, SW, SH);
        });
        return rect;
      }

      const blank = await readAfterRun('tilebgbench0', 'PROBE_T0');
      const cpu = await readAfterRun('tilebgbenchcpu', 'PROBE_TC');
      const vram = await readAfterRun('tilebgbenchvram', 'PROBE_TV');

      const cpuDiffersFromBlank = !rectPlanesEqual(cpu, blank);
      results.push({ label: '[陽性対照] タイル敷き詰め速度ベンチ: CPU経路実行後は0枚敷き版(背景)と一致しない(実際に描いている)', ok: cpuDiffersFromBlank, actual: cpuDiffersFromBlank ? '不一致(描画あり)' : '一致(描いていない)', expected: '不一致' });
      console.log(`${cpuDiffersFromBlank ? 'OK  ' : 'FAIL'} [陽性対照] タイル敷き詰め速度ベンチ CPU経路は背景のままではない`);

      const vramMatchesCpu = rectPlanesEqual(vram, cpu);
      results.push({ label: '[陽性対照] タイル敷き詰め速度ベンチ: VRAM経路の最終描画結果がCPU経路と一致(実際に同じ絵を描いている)', ok: vramMatchesCpu, actual: vramMatchesCpu ? '一致' : '不一致', expected: '一致' });
      console.log(`${vramMatchesCpu ? 'OK  ' : 'FAIL'} [陽性対照] タイル敷き詰め速度ベンチ VRAM経路がCPU経路と一致`);
    }

    // =====================================================================
    // 背景ページ→画面ページのまるごとコピー(p98_copy_bgpage_to_screen()、
    // 2026-09後半、docs/design.md参照)の正しさ・A/B速度比較。
    // =====================================================================

    // 背景ページに描いたのと同じパターンをNode側で独立に組み立てる
    // (probe_bgcopy.cのdraw_background_pattern()と完全に同じ矩形列。
    // 期待値の計算経路と検証対象(WebNP2上のVRAM実値)を別経路にするため、
    // 検証対象からのコピーではなくp98_fill_rectの塗り方を独立に再実装する)。
    function buildBgCopyExpectedPlanes() {
      const w = 640, h = 400, wBytes = 80;
      const bitIndex = { B: 0, R: 1, G: 2, I: 3 };
      const buffers = { B: Buffer.alloc(wBytes * h, 0), R: Buffer.alloc(wBytes * h, 0), G: Buffer.alloc(wBytes * h, 0), I: Buffer.alloc(wBytes * h, 0) };
      function fillRect(x, y, rw, rh, color) {
        const byteX = x / 8, byteW = rw / 8; // このプローブの矩形は全てバイト境界に揃えてある
        for (const plane of ['B', 'R', 'G', 'I']) {
          const val = (color & (1 << bitIndex[plane])) ? 0xFF : 0x00;
          for (let row = y; row < y + rh; row++) {
            for (let bx = 0; bx < byteW; bx++) buffers[plane][row * wBytes + byteX + bx] = val;
          }
        }
      }
      fillRect(0, 0, 640, 4, 10);
      fillRect(0, 200, 640, 8, 5);
      fillRect(200, 100, 64, 32, 12);
      fillRect(0, 396, 640, 4, 9);
      return { w, h, wBytes, planes: [buffers.B, buffers.R, buffers.G, buffers.I] };
    }
    function buildUniformColorPlanes(color) {
      const w = 640, h = 400, wBytes = 80;
      const bitIndex = { B: 0, R: 1, G: 2, I: 3 };
      const planes = ['B', 'R', 'G', 'I'].map((plane) => Buffer.alloc(wBytes * h, (color & (1 << bitIndex[plane])) ? 0xFF : 0x00));
      return { w, h, wBytes, planes };
    }

    console.log('\n--- 背景ページ→画面ページのまるごとコピー(probe_bgcopy: コピー後の画面が背景と完全一致) ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      await page.evaluate((port) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/bgcopy.xdf`, 'PROBE_CB', { waitMs: 2000 }), PORT);
      if (errors.length) console.log('page errors:', errors);

      const expected = buildBgCopyExpectedPlanes();
      const actual = await readVramRect(page, 0, 0, 640, 400);
      const wholeScreenOk = rectPlanesEqual(actual, expected);
      results.push({ label: '【主目的】[bgcopy] コピー後の画面ページが背景ページの内容(非一様パターン)と画面全体・4プレーンとも完全一致', ok: wholeScreenOk, actual: wholeScreenOk ? '完全一致' : '不一致あり', expected: '完全一致' });
      console.log(`${wholeScreenOk ? 'OK  ' : 'FAIL'} [bgcopy] コピー後の画面全体が背景と完全一致`);

      // [陽性対照1] 背景パターンは単色の塗りつぶしではない(複数の色を使っている)ことの確認。
      // 同じRplaneで、色10(赤+輝度)の帯があるy=0(0xFFのはず)と、
      // どの矩形にも触れていないy=300(p98_clear(0)のまま=0x00のはず)を
      // 比べる(違うプレーン同士を比べると、たまたま同じ0xFF/0x00に
      // なる色の組み合わせを選んでしまい判定が意味を持たなくなる失敗を
      // 実際に一度やった。docs/verify-log.md参照)。
      const rowTop = await page.evaluate((a, l) => window.p98probe.readMemory(a, l), PLANE.R + 0 * ROW + 0, 1);
      const rowUntouched = await page.evaluate((a, l) => window.p98probe.readMemory(a, l), PLANE.R + 300 * ROW + 0, 1);
      const nonUniform = rowTop[0] !== rowUntouched[0];
      results.push({ label: '[陽性対照] [bgcopy] 背景パターンは単色の塗りつぶしではない(Rplaneのy=0とy=300(未使用領域)が異なる値)', ok: nonUniform, actual: [rowTop[0], rowUntouched[0]], expected: '異なる値' });
      console.log(`${nonUniform ? 'OK  ' : 'FAIL'} [陽性対照] [bgcopy] 背景パターンが非一様であることを確認 actual=[0x${rowTop[0]?.toString(16)}, 0x${rowUntouched[0]?.toString(16)}]`);

      // [陽性対照2] コピー前に画面へ塗った色(6=赤+緑、背景のどの矩形にも
      // 使っていない色)が、コピー後の画面全体には1箇所も残っていないこと
      // (=コピーが実際に効いていて、単に「元から一致していた」わけではない)。
      const precopy = buildUniformColorPlanes(6);
      const precopyGone = !rectPlanesEqual(actual, precopy);
      results.push({ label: '[陽性対照] [bgcopy] コピー前に画面へ塗った色(6)は画面全体には残っていない(コピーが実際に効いている)', ok: precopyGone, actual: precopyGone ? 'コピー前の色は残っていない' : 'コピー前の色のまま(コピーが効いていない)', expected: 'コピー前の色は残っていない' });
      console.log(`${precopyGone ? 'OK  ' : 'FAIL'} [陽性対照] [bgcopy] コピー前の色が残っていないことを確認`);
    });

    console.log('\n--- 故障注入: probe_bgcopy(コピーを末尾1行分減らした版)は画面最下行の一致検査でFAILするはず ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      await page.evaluate((port) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/bgcopybroken.xdf`, 'PROBE_CB', { waitMs: 2000 }), PORT);
      if (errors.length) console.log('page errors:', errors);

      // 画面最下行(y=399)は、故障注入版ではコピーされないため、
      // コピー前の色(6=赤+緑)のまま残っているはず(正常なら背景の
      // 色9=青+輝度になる)。
      const rowLast = await readVramRect(page, 0, 399, 640, 1);
      const expectedLast = { w: 640, h: 1, wBytes: 80, planes: buildBgCopyExpectedPlanes().planes.map((p) => p.subarray(399 * 80, 400 * 80)) };
      const leftover = !rectPlanesEqual(rowLast, expectedLast);
      results.push({
        label: '[bgcopy故障注入] 画面最下行(y=399)が背景と一致せず、コピー前の色が残る(検査が故障を検出できること)',
        ok: leftover, actual: leftover ? '不一致(残像あり)' : '一致(検出できていない)', expected: '不一致',
      });
      console.log(`${leftover ? 'OK  ' : 'FAIL'} [bgcopy故障注入] 画面最下行に残像が残ることを検出`);
    });

    console.log('\n--- 背景ページ→画面ページのまるごとコピーのA/B速度比較(draw_tiled_background()を2回 vs 1回+コピー、REPEAT=3) ---');
    {
      // (a) walk2.cの起動時と同じやり方: draw_tiled_background_vram()を
      //     背景ページ・画面ページへそれぞれ1回ずつ(計2回)。
      // (b) draw_tiled_background_vram()を背景ページへ1回だけ+
      //     p98_copy_bgpage_to_screen()でまるごとコピー。
      // どちらも「タイル・タイル選択規則・座標順・REPEAT=3」を完全に揃え、
      // 同じ固定オーバーヘッド(bgcopybench0=p98_init_bgpage+p98_quitのみ)
      // との差分を取る。1ワードごとにポート0xA6のOUTを2回叩くコピー方式
      // (VRAM/EGC経路のタイル敷き詰め自体の約1/8のfar call回数だが、
      // OUTのI/Oウェイトが乗る)が、タイル敷き詰めをもう1回やるのと比べて
      // 速いかどうかは自明ではないため、ここで実測する(docs/design.md参照。
      // 結果がどちらであっても数値をそのまま記録する方針)。
      const base0 = await measureRunTimes('bgcopybench0', 'PROBE_C0');
      const twiceMs = await measureRunTimes('bgcopybench2x', 'PROBE_C2', 60000);
      const copyMs = await measureRunTimes('bgcopybenchcopy', 'PROBE_CC', 60000);

      const BGCOPY_REPEAT = 3; /* tests/probe_bgcopy_bench_{2x,copy}.c の REPEAT と一致させる */
      const twicePerIterMs = (twiceMs - base0) / BGCOPY_REPEAT;
      const copyPerIterMs = (copyMs - base0) / BGCOPY_REPEAT;
      const twiceFps = twicePerIterMs > 0 ? 1000 / twicePerIterMs : Infinity;
      const copyFps = copyPerIterMs > 0 ? 1000 / copyPerIterMs : Infinity;
      console.log(`条件: 40x25=1000枚のVRAM/EGCタイル敷き詰めをREPEAT=${BGCOPY_REPEAT}回、同一座標順・同一タイル選択規則`);
      console.log(`(a) draw_tiled_background_vram()を2回(背景+画面): baseline=${base0.toFixed(0)}ms, 本編=${twiceMs.toFixed(0)}ms → 1回あたり約${twicePerIterMs.toFixed(3)}ms ≈ 約${twiceFps.toFixed(2)}回/秒`);
      console.log(`(b) draw_tiled_background_vram()を1回+p98_copy_bgpage_to_screen(): baseline=${base0.toFixed(0)}ms, 本編=${copyMs.toFixed(0)}ms → 1回あたり約${copyPerIterMs.toFixed(3)}ms ≈ 約${copyFps.toFixed(2)}回/秒`);
      if (twicePerIterMs > 0 && copyPerIterMs > 0) {
        console.log(`比((a)/(b)): (b)は(a)の約${(twicePerIterMs / copyPerIterMs).toFixed(2)}倍速い(1より大きければ(b)が速い。1未満なら(b)の方が遅い)`);
      }
      console.log('注意: これもnp2kai(WebNP2)+puppeteerというこの実行環境全体を通した相対値であり、実機での比率とは限らない。定性的な結論(速い/変わらない/遅い)のみ採る。数値が期待通りでなくても作り直さず、出た値をそのまま記録する(feedback_control_and_fault_injection.md)。');
      const ok = Number.isFinite(twicePerIterMs) && twicePerIterMs > 0 && Number.isFinite(copyPerIterMs) && copyPerIterMs > 0;
      results.push({
        label: '背景ページ→画面ページのまるごとコピーのA/B速度比較が完了(具体的な数値・比率・どちらが速いかは合否判定の対象ではない。docs/verify-log.md参照)',
        ok, actual: `(a)約${twiceFps.toFixed(2)}回/秒, (b)約${copyFps.toFixed(2)}回/秒`, expected: '両方とも正の値が計測できていること',
      });
      console.log(ok ? 'OK   背景ページコピーのA/B速度比較が完了' : 'FAIL 背景ページコピーのA/B速度比較に失敗(差分が0以下)');
    }

    // =====================================================================
    // p98_vram_reupload()(アップロードそのもの)のコストの計測(2026-09)。
    // あえてこのファイルの最後尾(walk2を含む全ての既存検査より後ろ)に
    // 置いてある: 以前ここに1パス転送方式(EGCマスクレジスタで透明ドットを
    // 抜く方式。実測で2パス方式の約0.27倍=約3.7倍遅いと分かり撤去した。
    // docs/design.md参照)の検査を置いていた際、「スプライト・VRAM常駐+
    // EGC転送経路」節・「スプライト速度のA/B比較」節の直後に置くと
    // ホスト側の累積負荷が増え、walk2(samples/walk2.c)の固定sleep
    // (15000ms、実時間ベースでホストの実際の処理速度に依存する作り)が
    // 実質的に不足してFAILすることを実測した(feedback_probe_perturbs_
    // the_subjectと同種の「計測(を増やすこと)が対象を変える」現象)。
    // 同じ教訓を踏まえ、このアップロードコスト計測もファイル末尾に置く。
    // =====================================================================

    console.log('\n--- p98_vram_reupload()のアップロードコスト計測 (probe_vram_upload_bench) ---');
    // p98__copy_far_to_vram()(まとめてrep movsb)を撤去し、p98__pokeb()に
    // よる1バイトずつの直接書き込みへ寄せた(docs/design.md「配置依存の
    // 不具合」節参照)ことで、アップロード自体は遅くなっているはず。
    // walk2はコマが変わるたびにp98_vram_reupload()で置き直しているため、
    // そのコストを知っておく必要がある。
    //
    // 32x32・マスクに穴がある(非opaque)スプライトをN回(tests/
    // probe_vram_upload_bench.cのBENCH_N*BENCH_ITERS=100回)
    // p98_vram_reupload()するだけのベンチを、既に計測済みのbaseMs
    // (probe_sprite_bench0.c、init/flip/clear/quitの固定オーバーヘッド
    // のみ)との差分で測る。計測方法(ホスト側performance.now()の差分、
    // 3回計測して中央値)はprobe_sprite_bench*.cと完全に同一。
    // 比較対象(別方式)は無いので比は出さない。「1回あたり何ms」と、
    // 「CPU経路でスプライトを1体描く(cpuPerSpriteMs、上の「スプライト
    // 速度のA/B比較」節で計測済みのcpuMs/baseMsから再計算)のと比べて
    // どうか」が分かる形にする。
    const UPLOAD_BENCH_N = 100; // tests/probe_vram_upload_bench.c の BENCH_N*BENCH_ITERS と一致させる
    const uploadBenchMs = await measureRunTimes('vramuploadbench', 'PROBE_UB');
    {
      const cpuPerSpriteMsAgain = (cpuMs - baseMs) / SPRITE_BENCH_N;
      const uploadPerCallMs = (uploadBenchMs - baseMs) / UPLOAD_BENCH_N;
      console.log(`中央値: baseline=${baseMs.toFixed(0)}ms, アップロード${UPLOAD_BENCH_N}回=${uploadBenchMs.toFixed(0)}ms`);
      console.log(`p98_vram_reupload(): 1回あたり約${uploadPerCallMs.toFixed(3)}ms`);
      console.log(`(参考)CPU経路でスプライト(16x16)を1体描く: 1体あたり約${cpuPerSpriteMsAgain.toFixed(3)}ms`);
      console.log(`比(アップロード1回/CPU経路1体描画): ${(uploadPerCallMs / cpuPerSpriteMsAgain).toFixed(2)}倍`);
      console.log('注意: 数値が期待通りでなくても実装を作り直さず、出た値をそのまま記録する方針(feedback_control_and_fault_injection.md)。これもnp2kai(WebNP2)+puppeteerというこの実行環境全体を通した相対値であり、実機での比率とは限らない。');
      const ok = Number.isFinite(uploadPerCallMs) && uploadPerCallMs > 0;
      results.push({
        label: 'p98_vram_reupload()のアップロードコスト計測が完了(具体的な数値は合否判定の対象ではない。docs/verify-log.md参照)',
        ok, actual: `1回あたり約${uploadPerCallMs.toFixed(3)}ms`, expected: '正の値が計測できていること',
      });
      console.log(ok ? 'OK   アップロードコスト計測が完了' : 'FAIL アップロードコスト計測に失敗(差分が0以下)');
    }

    console.log('\n--- 陽性対照: アップロードコストベンチが実際にVRAMへ書いていることの確認 ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      // tests/probe_vram_upload_bench.cの1回目のp98_vram_upload()は
      // 起動直後(p98_vram_reset()を呼んでいないため常に先頭)なので、
      // pixOff=0のはず(p98__vram_alloc()の単純なバンプ割り当て)。
      // Bプレーン(青、g_plane0=全バイト0xFF)の先頭バイトは、非opaqueな
      // ので「絵&マスク」= 0xFF & 0x7E(g_maskの各行先頭バイト)= 0x7Eに
      // なるはず(何も書いていなければVRAM初期値の0のまま)。
      await page.evaluate((port) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/vramuploadbench.xdf`, 'PROBE_UB', { waitForExit: true }), PORT);
      if (errors.length) console.log('page errors(vramuploadbench):', errors);
      const storeB = await page.evaluate((addr, len) => window.p98probe.readMemory(addr, len), PLANE.B + 32000, 1);
      const ok = storeB[0] === 0x7E;
      results.push({ label: '[陽性対照] アップロードコストベンチ: 置き場(pixOff=0)のBプレーン先頭バイトが期待値(絵&マスク=0x7E)と一致(実際に書いている)', ok, actual: `0x${storeB[0]?.toString(16)}`, expected: '0x7e' });
      console.log(`${ok ? 'OK  ' : 'FAIL'} [陽性対照] アップロードコストベンチ 置き場の内容確認 actual=0x${storeB[0]?.toString(16)}`);
    });
  } finally {
    await browser.close();
    await rm(profile, { recursive: true, force: true });
    server.close();
  }

  // 終了コード(README.md「検証の回し方」参照):
  //   0: 全項目OK、SKIPも無し(素材ありの作者環境で全項目通過)。
  //   1: 1件以上の本当の失敗(FAIL)がある。
  //   2: FAILは無いが、素材が無く実行できなかった項目(SKIP)がある
  //      (異常ではないが、全項目は検証できていない状態として区別する)。
  const skippedResults = results.filter((r) => r.skip);
  const failed = results.filter((r) => !r.ok && !r.skip);
  const okCount = results.length - failed.length - skippedResults.length;
  console.log(`\n=== ${okCount}/${results.length - skippedResults.length} OK` +
    (skippedResults.length ? `(SKIP ${skippedResults.length}件、素材なしのため実行不可)` : '') + ' ===');
  if (skippedResults.length) {
    console.log('SKIPした項目(素材が無いため実行できません。合格扱いにはしていません):');
    for (const s of skippedResults) console.log(`  - ${s.label}: ${s.reason}`);
  }
  if (failed.length) {
    process.exitCode = 1;
  } else if (skippedResults.length) {
    process.exitCode = 2;
  } else {
    process.exitCode = 0;
  }
}

await main();
