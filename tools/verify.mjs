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
const PAGE_STRIDE = 0x8000; // 仮説: 裏ページはプレーン先頭から+0x8000バイト

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

async function main() {
  const results = [];
  console.log('--- ビルド ---');
  const [fillExe, flipExe, stateExe, fillBrokenExe, keyExe, keyBrokenExe] = await Promise.all([
    buildOrThrow('tests/probe_fill.c'),
    buildOrThrow('tests/probe_flip.c'),
    buildOrThrow('tests/probe_state.c'),
    buildOrThrow('tests/probe_fill.c', { libPath: join(REPO_ROOT, 'tests', 'p98_broken_noclip.c') }),
    buildOrThrow('tests/probe_key.c'),
    buildOrThrow('tests/probe_key.c', { libPath: join(REPO_ROOT, 'tests', 'p98_broken_nodiff.c') }),
  ]);
  console.log('ok: probe_fill / probe_flip / probe_state / probe_fill(故障注入=クリップ無し) / probe_key / probe_key(故障注入=差分無し)');

  const programFds = {
    fill: programFdFor(fillExe, 'PROBE_FI'),
    flip: programFdFor(flipExe, 'PROBE_FL'),
    state: programFdFor(stateExe, 'PROBE_ST'),
    fillbroken: programFdFor(fillBrokenExe, 'PROBE_FI'),
    key: programFdFor(keyExe, 'PROBE_KE'),
    keybroken: programFdFor(keyBrokenExe, 'PROBE_KE'),
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
      const paletteRestored = !!match && match[1] === match[2];
      results.push({ label: 'パレット(色番号1)がp98_quit後に元へ戻る', ok: paletteRestored, actual: match?.[2], expected: match?.[1] });
      console.log(`${paletteRestored ? 'OK  ' : 'FAIL'} パレット(色番号1)がp98_quit後に元へ戻る BEF=${match?.[1]} AFT=${match?.[2]}`);
      assertEqual('INT23hベクタはp98_quit後に元へ戻る(0000:008C)', after23, before23, results);

      const vMatch = text.match(/V0=([0-9A-F]{4})[\s\S]*V1=([0-9A-F]{4})[\s\S]*V2=([0-9A-F]{4})/);
      const vectorChanged = !!vMatch && vMatch[1] !== vMatch[2];
      const vectorRestored = !!vMatch && vMatch[1] === vMatch[3];
      results.push({ label: 'ゲスト自身が読んでもINT23hはp98_init中に書き換わっている(陽性対照)', ok: vectorChanged, actual: vMatch?.[2], expected: `not ${vMatch?.[1]}` });
      console.log(`${vectorChanged ? 'OK  ' : 'FAIL'} INT23h V0(元)=${vMatch?.[1]} V1(init中)=${vMatch?.[2]} (異なるはず)`);
      results.push({ label: 'ゲスト自身が読んでもINT23hはp98_quit後に元へ戻る', ok: vectorRestored, actual: vMatch?.[3], expected: vMatch?.[1] });
      console.log(`${vectorRestored ? 'OK  ' : 'FAIL'} INT23h V2(quit後)=${vMatch?.[3]} (V0と一致するはず)`);
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

    console.log('\n--- p98_quit後もDOSが生きている(コマンドを1つ実行してプロンプトが返る) ---');
    await withPage(browser, `http://127.0.0.1:${PORT}/ide/p98-probe.html`, async (page, errors) => {
      await page.evaluate((port) => window.p98probe.runProgram(`http://127.0.0.1:${port}/program/key.xdf`, 'PROBE_KE', { waitForExit: true }), PORT);
      if (errors.length) console.log('page errors:', errors);
      const text = await page.evaluate(() => window.p98probe.runDosCommand('VER'));
      const alive = /FreeDOS|Kernel|Version/i.test(text);
      results.push({ label: 'p98_quit後、DOSコマンド(VER)を実行してプロンプトが返る(ハングしていない。BIOSのキーバッファを空にしていることも間接的に確認)', ok: alive, actual: alive ? '応答あり' : text.slice(-200), expected: '応答あり' });
      console.log(`${alive ? 'OK  ' : 'FAIL'} p98_quit後にVERを実行してプロンプトが返る`);
    });
  } finally {
    await browser.close();
    await rm(profile, { recursive: true, force: true });
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} OK ===`);
  if (failed.length) process.exitCode = 1;
}

await main();
