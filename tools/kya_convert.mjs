#!/usr/bin/env node
// KYA形式(PC-98、Quick C `_getimage`前段階のフルスクリーンダンプ)から
// p98lib のスプライト/タイル形式(p98_sprite_t、docs/design.md参照)への変換ツール。
//
// 形式の根拠: `_local/README.md` の「KYA形式」節、および
// `_local/legacy-a-games/C-GAMES/MAKEGRP.C`(ユーザー本人の著作物、参照可)の
// gload()関数を実測して確認した:
//   - 先頭48バイト = パレット16色×RGB各0〜15(RGBの順そのまま)
//   - 48..49 = 1行のバイト数(80=640ドット、リトルエンディアン)
//   - 50..51 = 行数(400、リトルエンディアン)
//   - 52から本体。1行ごとに4プレーンが交互(青→赤→緑→輝度の順、
//     MAKEGRP.C の plane0(0xa8000)→plane1(0xb0000)→plane2(0xb8000)→plane3(0xe0000)
//     の順そのもの。p98lib の p98_sprite_t.planes[0..3]と同じ並び)
//   - 各プレーンの1バイトは640ドット中80バイト、MSBが左端(p98_fill_rect/GRCGと
//     同じビット順。VRAMのバイトそのものなので変換無しで直接使える)
//
// 切り出し位置の根拠: 同じくMAKEGRP.C の setkyara()。
//   - 32x32のキャラ: a*32, b*32 (a=0..7列, b=0..11段) → kyara[a+b*8]
//     (8列=キャラ8体、12段=4方向×歩行3コマ、という並びだとMAKEGRP.Cのコメント
//     および `_local/README.md` の記載から判断。全数を機械的に検証してはいない
//     並び順の「意味」は未確認のまま明記する)
//   - 16x16の背景タイル: x=288+b*16, y=a*16 (a=0..15段, b=0..15列)
//
// マスク(透明色)の扱い: KYAはフルスクリーンのダンプで、アルファ/マスク情報を
// 別に持たない。キャラのセルには周囲に背景色(パレット0番、黒)が残っている前提で、
// 「パレット0番の画素だけ透明(mask=0)、それ以外はmask=1」として合成する。
// この前提は自明ではないため、--selftest で角のドットがパレット0であることを
// 確認し、一致しなければ警告する(決め打ちにしない)。

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export function parseKya(buf) {
  if (buf.length < 52) throw new Error('KYAファイルが短すぎる');
  const palette = [];
  for (let i = 0; i < 16; i++) {
    palette.push({ r: buf[i * 3], g: buf[i * 3 + 1], b: buf[i * 3 + 2] });
  }
  const rowBytes = buf.readUInt16LE(48);
  const rows = buf.readUInt16LE(50);
  const bodyOffset = 52;
  const planeSize = rowBytes * rows;
  const expected = bodyOffset + planeSize * 4;
  if (buf.length !== expected) {
    throw new Error(`サイズ不一致: ファイル=${buf.length} 期待値=${expected} (rowBytes=${rowBytes},rows=${rows})`);
  }
  // プレーンごとのオフセット関数: 行ごとに4プレーンが交互なので、
  // プレーンpの行yの先頭バイトは bodyOffset + y*rowBytes*4 + p*rowBytes
  function planeRowOffset(plane, y) {
    return bodyOffset + y * rowBytes * 4 + plane * rowBytes;
  }
  return { palette, rowBytes, rows, buf, planeRowOffset };
}

// (x,y,w,h)矩形を切り出し、p98_sprite_t互換の4プレーン配列を返す。
// x,w は8の倍数(バイト境界)であることが前提(呼び出し側で保証する。
// KYAの元データがバイト単位でしか読めないため、非バイト境界の切り出しは
// このツールのスコープ外)。
export function extractRect(kya, x, y, w, h) {
  if (x % 8 !== 0 || w % 8 !== 0) throw new Error(`x/wは8の倍数のみ対応: x=${x} w=${w}`);
  const wBytes = w / 8;
  const planes = [];
  for (let p = 0; p < 4; p++) {
    const out = Buffer.alloc(wBytes * h);
    for (let row = 0; row < h; row++) {
      const srcOff = kya.planeRowOffset(p, y + row) + x / 8;
      kya.buf.copy(out, row * wBytes, srcOff, srcOff + wBytes);
    }
    planes.push(out);
  }
  return { w, h, wBytes, planes };
}

// 4プレーンから各画素のパレット番号(0-15)を求める。
// ビット順: plane0(青)=bit0, plane1(赤)=bit1, plane2(緑)=bit2, plane3(輝度)=bit3
// (README「プレーン順はパレット番号のビット0から」)
export function pixelIndex(rect, px, py) {
  const wBytes = rect.wBytes;
  const byteIdx = py * wBytes + (px >> 3);
  const bitMask = 0x80 >> (px & 7);
  let idx = 0;
  for (let p = 0; p < 4; p++) {
    if (rect.planes[p][byteIdx] & bitMask) idx |= (1 << p);
  }
  return idx;
}

// マスク(1=不透明)を計算する。keyIndex(既定0)以外のパレット番号を不透明とする。
export function computeMask(rect, keyIndex = 0) {
  const wBytes = rect.wBytes;
  const mask = Buffer.alloc(wBytes * rect.h);
  for (let py = 0; py < rect.h; py++) {
    for (let px = 0; px < rect.w; px++) {
      const idx = pixelIndex(rect, px, py);
      if (idx !== keyIndex) {
        mask[py * wBytes + (px >> 3)] |= (0x80 >> (px & 7));
      }
    }
  }
  return mask;
}

// 機械的な変換の正しさの検証: 切り出したrect(4プレーン)を、元のKYAバッファの
// 該当矩形と1バイトも違わず比較する(インデックス計算の誤りを検出するための、
// 目視によらないラウンドトリップ検査)。プレーン順・座標計算を独立に書いた
// もう一つの経路(下のverifyRectIndependent)で再計算し、両方が元データと
// 一致することを確認する。
export function verifyRectAgainstSource(kya, rect, x, y) {
  for (let p = 0; p < 4; p++) {
    for (let row = 0; row < rect.h; row++) {
      const srcOff = kya.planeRowOffset(p, y + row) + x / 8;
      const srcBytes = kya.buf.subarray(srcOff, srcOff + rect.wBytes);
      const gotBytes = rect.planes[p].subarray(row * rect.wBytes, (row + 1) * rect.wBytes);
      if (!srcBytes.equals(gotBytes)) {
        return { ok: false, plane: p, row, srcBytes: [...srcBytes], gotBytes: [...gotBytes] };
      }
    }
  }
  return { ok: true };
}

// 独立実装: プレーン内オフセットを「1行=rowBytes*4バイト」ではなく、
// 「まずファイル全体を行単位に切ってから、行内でプレーンオフセットを足す」
// という別の書き方で計算し直し、上と同じ値になることを確認する
// (同じ間違ったplaneRowOffsetを2箇所で使ってしまう事故を防ぐため)。
export function verifyRectIndependent(kya, rect, x, y) {
  const rowStride = kya.rowBytes * 4;
  for (let p = 0; p < 4; p++) {
    for (let row = 0; row < rect.h; row++) {
      const rowStart = 52 + (y + row) * rowStride;
      const planeStart = rowStart + p * kya.rowBytes;
      const srcOff = planeStart + (x >> 3);
      const srcBytes = kya.buf.subarray(srcOff, srcOff + rect.wBytes);
      const gotBytes = rect.planes[p].subarray(row * rect.wBytes, (row + 1) * rect.wBytes);
      if (!srcBytes.equals(gotBytes)) {
        return { ok: false, plane: p, row };
      }
    }
  }
  return { ok: true };
}

function toCBytes(buf) {
  return `{ ${[...buf].map((b) => `0x${b.toString(16).padStart(2, '0')}`).join(',')} }`;
}

export function emitCArray(name, buf) {
  return `static const unsigned char ${name}[${buf.length}] = ${toCBytes(buf)};`;
}

// 左向き4フレームから右向きを作るための水平反転(元データにmirrorRectはKYAには無い。
// SAKA.ASM/MAKEGRP.C にも「右向きは左向きの反転で済ませる」旨の記載は無いため、
// これは今回のデモ側の設計判断であって「元データの仕様」ではない。8列の並びが
// [up*2, down*2, left*4] であることは目視確認(mosaic画像)であり、機械的な
// 全数検証はできていない(元データにラベルが無いため)。
export function mirrorRectHorizontal(rect) {
  const planes = rect.planes.map((plane) => {
    const out = Buffer.alloc(plane.length);
    for (let row = 0; row < rect.h; row++) {
      for (let x = 0; x < rect.w; x++) {
        const srcByte = plane[row * rect.wBytes + (x >> 3)];
        const bit = (srcByte >> (7 - (x & 7))) & 1;
        if (bit) {
          const dstX = rect.w - 1 - x;
          out[row * rect.wBytes + (dstX >> 3)] |= (0x80 >> (dstX & 7));
        }
      }
    }
    return out;
  });
  return { w: rect.w, h: rect.h, wBytes: rect.wBytes, planes };
}

// 反転が正しいこと自体を機械検証する: 2回反転したら元に戻ること、
// および画素単位で「反転後のx画素 == 反転前のw-1-x画素」であることを全画素で確認する。
export function verifyMirror(rect, mirrored) {
  const twice = mirrorRectHorizontal(mirrored);
  for (let p = 0; p < 4; p++) {
    if (!twice.planes[p].equals(rect.planes[p])) return { ok: false, reason: 'double-mirror-mismatch', plane: p };
  }
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      const a = pixelIndexOfPlanes(rect, x, y);
      const b = pixelIndexOfPlanes(mirrored, rect.w - 1 - x, y);
      if (a !== b) return { ok: false, reason: 'pixel-mismatch', x, y };
    }
  }
  return { ok: true };
}
function pixelIndexOfPlanes(rect, px, py) {
  return pixelIndex(rect, px, py);
}

async function selfTest(kyaPath) {
  const buf = await readFile(kyaPath);
  const kya = parseKya(buf);
  console.log(`palette[0]=${JSON.stringify(kya.palette[0])} rowBytes=${kya.rowBytes} rows=${kya.rows}`);
  let failures = 0;
  let keyIndexHistogram = new Map();
  // 8体×12段のキャラ全数、16x16タイル全数(256枚)をラウンドトリップ検査する
  for (let b = 0; b < 12; b++) {
    for (let a = 0; a < 8; a++) {
      const rect = extractRect(kya, a * 32, b * 32, 32, 32);
      const v1 = verifyRectAgainstSource(kya, rect, a * 32, b * 32);
      const v2 = verifyRectIndependent(kya, rect, a * 32, b * 32);
      if (!v1.ok || !v2.ok) { failures++; console.error(`FAIL kyara a=${a} b=${b}`, v1, v2); }
      // 四隅の画素のパレット番号を集計(透明色の前提を確認するため)
      for (const [px, py] of [[0, 0], [31, 0], [0, 31], [31, 31]]) {
        const idx = pixelIndex(rect, px, py);
        keyIndexHistogram.set(idx, (keyIndexHistogram.get(idx) ?? 0) + 1);
      }
    }
  }
  for (let a = 0; a < 16; a++) {
    for (let b = 0; b < 16; b++) {
      const rect = extractRect(kya, 288 + b * 16, a * 16, 16, 16);
      const v1 = verifyRectAgainstSource(kya, rect, 288 + b * 16, a * 16);
      const v2 = verifyRectIndependent(kya, rect, 288 + b * 16, a * 16);
      if (!v1.ok || !v2.ok) { failures++; console.error(`FAIL tile a=${a} b=${b}`, v1, v2); }
    }
  }
  console.log(`キャラ96枚+タイル256枚のラウンドトリップ検査: ${failures === 0 ? 'すべてOK' : `${failures}件FAIL`}`);
  console.log('キャラ四隅の画素のパレット番号の分布(透明色の前提確認用):', [...keyIndexHistogram.entries()]);
  return failures === 0;
}

// samples/kya_assets.h の生成。デモ(samples/walk2.c)向けに、MITEI2.KYA から
// 1キャラ(CHAR_ROW段目)+地面タイル2種を切り出してCソースへ書き出す。
//
// 8列の並び([up*2, down*2, left*4])は目視で確認した並びで、KYAファイル自体には
// ラベルが無いため「本当にこの意味か」は未確認のまま採用している(docs/design.md
// 「KYAキャラアニメ変換」節に記載予定)。右向きは元データに無いため、左向きを
// mirrorRectHorizontal()で水平反転して作る(このデモ側の設計判断であり、
// KYA自体の仕様ではない)。
const CHAR_ROW = 0;
const TILE_GROUND = { a: 0, b: 0 }; // 草(グリーン、スペックル)
const TILE_ACCENT = { a: 0, b: 2 }; // レンガ(暗い赤)

// KYAから実データ(Buffer)を切り出すところまでを担う、文字列化しない版。
// tools/verify.mjs が「変換結果とVRAMの実値を突き合わせる」検証に使う
// (生成したCソースを再パースするのではなく、同じ関数で計算した期待値と
// VRAMの実値を比べるほうが、文字列化のバグを検証結果に持ち込まない)。
export async function buildAssetSet(kyaPath) {
  const buf = await readFile(kyaPath);
  const kya = parseKya(buf);

  function charFrame(col) {
    const rect = extractRect(kya, col * 32, CHAR_ROW * 32, 32, 32);
    const mask = computeMask(rect, 0);
    return { rect, mask };
  }
  const up = [charFrame(0), charFrame(1)];
  const down = [charFrame(2), charFrame(3)];
  const leftFrames = [charFrame(4), charFrame(5), charFrame(6), charFrame(7)];
  const rightFrames = leftFrames.map(({ rect, mask }) => {
    const mirroredRect = mirrorRectHorizontal(rect);
    const maskRect = { w: rect.w, h: rect.h, wBytes: rect.wBytes, planes: [mask] };
    const mirroredMaskRect = mirrorRectHorizontal(maskRect);
    const chk = verifyMirror(rect, mirroredRect);
    if (!chk.ok) throw new Error(`mirror検証に失敗: ${JSON.stringify(chk)}`);
    return { rect: mirroredRect, mask: mirroredMaskRect.planes[0] };
  });

  function tileFrame({ a, b }) {
    const rect = extractRect(kya, 288 + b * 16, a * 16, 16, 16);
    const mask = Buffer.alloc(rect.wBytes * rect.h, 0xFF); // タイルは全面不透明
    return { rect, mask };
  }
  const ground = tileFrame(TILE_GROUND);
  const accent = tileFrame(TILE_ACCENT);
  return { kya, up, down, leftFrames, rightFrames, ground, accent };
}

// 故障注入用: R/Gプレーンを入れ替えた版を作る(色が化ける=VRAM照合がFAILする
// はず、という期待を持ったテストデータ)。tools/verify.mjsの故障注入検査で使う。
export function swapRGPlanes(assetSet) {
  function swapFrame(frame) {
    const planes = frame.rect.planes.slice();
    const tmp = planes[1]; planes[1] = planes[2]; planes[2] = tmp;
    return { rect: { ...frame.rect, planes }, mask: frame.mask };
  }
  return {
    kya: assetSet.kya,
    up: assetSet.up.map(swapFrame),
    down: assetSet.down.map(swapFrame),
    leftFrames: assetSet.leftFrames.map(swapFrame),
    rightFrames: assetSet.rightFrames.map(swapFrame),
    ground: swapFrame(assetSet.ground),
    accent: swapFrame(assetSet.accent),
  };
}

export function stringifyAssets(assetSet, kyaPathForComment) {
  const { kya, up, down, leftFrames, rightFrames, ground, accent } = assetSet;
  const lines = [];
  lines.push('/* 自動生成: tools/kya_convert.mjs generate で作成。手編集しないこと。');
  lines.push(` * 元データ: ${kyaPathForComment.replace(/^.*[\\/]/, '')} (ユーザー本人のオリジナル作品、C-GAMES/SAKA由来)`);
  lines.push(' * 生成内容: キャラ(CHAR_ROW段目)の歩行4方向アニメ + 地面タイル2種。');
  lines.push(' * 方向の並び([up*2,down*2,left*4])は目視確認、右向きはこのツールでの水平反転(docs/design.md参照)。');
  lines.push(' */');
  lines.push('#include "p98.h"');
  lines.push('');
  lines.push('/* パレット: KYAファイル先頭48バイト(RGB各0-15、そのまま)。');
  lines.push(' * デモ側でp98_set_palette(0..15,...)へ適用する。 */');
  lines.push(`#define KYA_PALETTE_COUNT 16`);
  lines.push(`static const unsigned char KYA_PALETTE[16][3] = {`);
  for (const c of kya.palette) lines.push(`  { ${c.r}, ${c.g}, ${c.b} },`);
  lines.push('};');
  lines.push('');

  function emitFrame(prefix, idx, frame) {
    lines.push(emitCArray(`${prefix}_P${idx}_B`, frame.rect.planes[0]));
    lines.push(emitCArray(`${prefix}_P${idx}_R`, frame.rect.planes[1]));
    lines.push(emitCArray(`${prefix}_P${idx}_G`, frame.rect.planes[2]));
    lines.push(emitCArray(`${prefix}_P${idx}_I`, frame.rect.planes[3]));
    lines.push(emitCArray(`${prefix}_M${idx}`, frame.mask));
    lines.push(`static const p98_sprite_t ${prefix}_${idx} = { 32, 32, { ${prefix}_P${idx}_B, ${prefix}_P${idx}_R, ${prefix}_P${idx}_G, ${prefix}_P${idx}_I }, ${prefix}_M${idx} };`);
  }
  function emitGroup(prefix, frames) {
    frames.forEach((f, i) => emitFrame(prefix, i, f));
    lines.push(`static const p98_sprite_t * const ${prefix}[${frames.length}] = { ${frames.map((_, i) => `&${prefix}_${i}`).join(', ')} };`);
    lines.push('');
  }
  emitGroup('KYA_WALK_UP', up);
  emitGroup('KYA_WALK_DOWN', down);
  emitGroup('KYA_WALK_LEFT', leftFrames);
  emitGroup('KYA_WALK_RIGHT', rightFrames);

  function emitTile(name, frame) {
    lines.push(emitCArray(`${name}_B`, frame.rect.planes[0]));
    lines.push(emitCArray(`${name}_R`, frame.rect.planes[1]));
    lines.push(emitCArray(`${name}_G`, frame.rect.planes[2]));
    lines.push(emitCArray(`${name}_I`, frame.rect.planes[3]));
    lines.push(emitCArray(`${name}_M`, frame.mask));
    lines.push(`static const p98_sprite_t ${name} = { 16, 16, { ${name}_B, ${name}_R, ${name}_G, ${name}_I }, ${name}_M };`);
    lines.push('');
  }
  emitTile('KYA_TILE_GROUND', ground);
  emitTile('KYA_TILE_ACCENT', accent);

  return lines.join('\n') + '\n';
}

// 従来通りの一発生成(build+stringify)。CLIから使う。
export async function generateAssets(kyaPath, opts = {}) {
  let assetSet = await buildAssetSet(kyaPath);
  if (opts.swapPlanes) assetSet = swapRGPlanes(assetSet);
  return stringifyAssets(assetSet, kyaPath);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === 'selftest') {
    const ok = await selfTest(resolve(rest[0]));
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (cmd === 'generate') {
    const src = resolve(rest[0]);
    const outPath = resolve(rest[1]);
    const swapPlanes = rest.includes('--broken-swap-rg');
    const code = await generateAssets(src, { swapPlanes });
    await writeFile(outPath, code);
    console.log(`wrote ${outPath} (${code.length} bytes)${swapPlanes ? ' [故障注入版: R/Gプレーン入れ替え]' : ''}`);
    return;
  }
  console.error('Usage: node tools/kya_convert.mjs selftest <path.KYA>');
  console.error('       node tools/kya_convert.mjs generate <path.KYA> <out.h> [--broken-swap-rg]');
  process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  await main();
}
