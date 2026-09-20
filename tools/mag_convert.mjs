// MAG形式(MAKI02) → p98スプライト形式への変換ツール。
// tools/kya_convert.mjs と同じ形(buildAssetSet/stringifyAssets/generateAssets)に
// 揃えてある。KYAはユーザー独自形式(作者向けに残す)だが、MAGは当時の標準
// フォーマットなので、公開デモの素材はこちらを主役にする(コーディネーター指示)。
//
// mag.tsの取り込み方について(docs/design.md「MAG形式対応」節参照):
// tools/mag_decode.mjs へ手作業でJS化した移植を置いた(TSのまま読む/
// ビルド済みを置く、との比較と理由はそちらのコメント参照)。
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decodeMag } from './mag_decode.mjs';
import { computeMask, mirrorRectHorizontal, verifyMirror, emitCArray } from './kya_convert.mjs';

// 2026-09後半、ORIGINAL/KYARA-03.MAG(ユーザー本人のオリジナル作品と確認済み、
// 2026-09-21。docs/assets.md参照)へ切り替えた。MITEI2.KYAと同じ配置
// (8列×12段のキャラ、x=288〜のタイル領域)だが、背景タイルの描き込みが
// MITEI2系より多く、キャラの色数も多い(実測で確認、docs/design.md
// 「MAG形式対応」節の追記参照)。CHAR_ROW/TILE_GROUND/TILE_ACCENTは
// 決め打ちにせず、実際に変換・モザイク化して目視確認した上で選んだ。
const CHAR_ROW = 0;
const TILE_GROUND = { a: 0, b: 0 }; // 草(グリーン、スペックル)
const TILE_ACCENT = { a: 0, b: 2 }; // レンガ(暗い赤、斜め模様)

function pixelAt(decoded, x, y) {
  return decoded.pixels[y * decoded.width + x];
}

// (x,y,w,h)矩形を切り出し、KYA側のrectと同じ形({w,h,wBytes,planes:[4 Buffer]})
// で返す。プレーン順・ビット重みはKYAと共通の規約(bit0=B,bit1=R,bit2=G,bit3=I)。
export function extractRectFromMag(decoded, x, y, w, h) {
  if (x % 8 !== 0 || w % 8 !== 0) throw new Error(`x/wは8の倍数のみ対応: x=${x} w=${w}`);
  const wBytes = w / 8;
  const planes = [Buffer.alloc(wBytes * h), Buffer.alloc(wBytes * h), Buffer.alloc(wBytes * h), Buffer.alloc(wBytes * h)];
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const idx = pixelAt(decoded, x + col, y + row);
      for (let p = 0; p < 4; p++) {
        if (idx & (1 << p)) {
          const byteIdx = row * wBytes + (col >> 3);
          planes[p][byteIdx] |= (0x80 >> (col & 7));
        }
      }
    }
  }
  return { w, h, wBytes, planes };
}

// 機械検証: 切り出した4プレーンから画素を再構成し、mag.pixelsの元の値と
// 1画素も違わず一致することを確認する(KYA側のverifyRectAgainstSourceに相当)。
export function verifyRectAgainstMag(decoded, rect, x, y) {
  for (let row = 0; row < rect.h; row++) {
    for (let col = 0; col < rect.w; col++) {
      let idx = 0;
      for (let p = 0; p < 4; p++) {
        const byteIdx = row * rect.wBytes + (col >> 3);
        if (rect.planes[p][byteIdx] & (0x80 >> (col & 7))) idx |= (1 << p);
      }
      const expected = pixelAt(decoded, x + col, y + row);
      if (idx !== expected) return { ok: false, x: x + col, y: y + row, got: idx, expected };
    }
  }
  return { ok: true };
}

export async function buildAssetSetFromMag(magPath) {
  const buf = await readFile(magPath);
  const decoded = decodeMag(new Uint8Array(buf));
  const palette = decoded.palette.map((c) => ({ r: c.r >> 4, g: c.g >> 4, b: c.b >> 4 }));

  function charFrame(col) {
    const rect = extractRectFromMag(decoded, col * 32, CHAR_ROW * 32, 32, 32);
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
    const rect = extractRectFromMag(decoded, 288 + b * 16, a * 16, 16, 16);
    const mask = Buffer.alloc(rect.wBytes * rect.h, 0xFF); // タイルは全面不透明
    return { rect, mask };
  }
  const ground = tileFrame(TILE_GROUND);
  const accent = tileFrame(TILE_ACCENT);

  return { decoded, palette, up, down, leftFrames, rightFrames, ground, accent };
}

export function stringifyMagAssets(assetSet, magPathForComment) {
  const { palette, up, down, leftFrames, rightFrames, ground, accent } = assetSet;
  const lines = [];
  lines.push('/* 自動生成: tools/mag_convert.mjs generate で作成。手編集しないこと。');
  lines.push(` * 元データ: ${magPathForComment.replace(/^.*[\\/]/, '')} (ユーザー本人のオリジナル作品と確認済み。docs/assets.md参照)`);
  lines.push(' * 生成内容: キャラ(CHAR_ROW段目)の歩行4方向アニメ + 地面タイル2種。');
  lines.push(' */');
  lines.push('#include "p98.h"');
  lines.push('');
  lines.push('/* パレット: MAGファイルのパレット(ファイル上はG,R,Bの順、8bitを>>4して4bitへ)。');
  lines.push(' * MITEI2.KYAのパレットと完全一致することを確認済み(tools/compare_kya_mag.mjs)。 */');
  lines.push(`#define MAG_PALETTE_COUNT 16`);
  lines.push(`static const unsigned char MAG_PALETTE[16][3] = {`);
  for (const c of palette) lines.push(`  { ${c.r}, ${c.g}, ${c.b} },`);
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
  emitGroup('MAG_WALK_UP', up);
  emitGroup('MAG_WALK_DOWN', down);
  emitGroup('MAG_WALK_LEFT', leftFrames);
  emitGroup('MAG_WALK_RIGHT', rightFrames);

  function emitTile(name, frame) {
    lines.push(emitCArray(`${name}_B`, frame.rect.planes[0]));
    lines.push(emitCArray(`${name}_R`, frame.rect.planes[1]));
    lines.push(emitCArray(`${name}_G`, frame.rect.planes[2]));
    lines.push(emitCArray(`${name}_I`, frame.rect.planes[3]));
    lines.push(emitCArray(`${name}_M`, frame.mask));
    lines.push(`static const p98_sprite_t ${name} = { 16, 16, { ${name}_B, ${name}_R, ${name}_G, ${name}_I }, ${name}_M };`);
    lines.push('');
  }
  emitTile('MAG_TILE_GROUND', ground);
  emitTile('MAG_TILE_ACCENT', accent);

  return lines.join('\n') + '\n';
}

// 故障注入用: R/Gプレーンを入れ替えた版(KYA側のswapRGPlanesと同じ考え方)。
export function swapRGPlanesMag(assetSet) {
  function swapFrame(frame) {
    const planes = frame.rect.planes.slice();
    const tmp = planes[1]; planes[1] = planes[2]; planes[2] = tmp;
    return { rect: { ...frame.rect, planes }, mask: frame.mask };
  }
  return {
    decoded: assetSet.decoded,
    palette: assetSet.palette,
    up: assetSet.up.map(swapFrame),
    down: assetSet.down.map(swapFrame),
    leftFrames: assetSet.leftFrames.map(swapFrame),
    rightFrames: assetSet.rightFrames.map(swapFrame),
    ground: swapFrame(assetSet.ground),
    accent: swapFrame(assetSet.accent),
  };
}

export async function generateMagAssets(magPath, opts = {}) {
  let assetSet = await buildAssetSetFromMag(magPath);
  if (opts.swapPlanes) assetSet = swapRGPlanesMag(assetSet);
  return stringifyMagAssets(assetSet, magPath);
}

async function selfTest(magPath) {
  const buf = await readFile(magPath);
  const decoded = decodeMag(new Uint8Array(buf));
  let failures = 0;
  for (let b = 0; b < 8; b++) {
    for (let a = 0; a < 8; a++) {
      const rect = extractRectFromMag(decoded, a * 32, b * 32, 32, 32);
      const v = verifyRectAgainstMag(decoded, rect, a * 32, b * 32);
      if (!v.ok) { failures++; console.error(`FAIL kyara a=${a} b=${b}`, v); }
    }
  }
  console.log(`MAGキャラ切り出しのラウンドトリップ検査(8x8=64枚): ${failures === 0 ? 'すべてOK' : `${failures}件FAIL`}`);
  return failures === 0;
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
    const code = await generateMagAssets(src, { swapPlanes });
    await writeFile(outPath, code);
    console.log(`wrote ${outPath} (${code.length} bytes)${swapPlanes ? ' [故障注入版]' : ''}`);
    return;
  }
  console.error('Usage: node tools/mag_convert.mjs selftest <path.MAG>');
  console.error('       node tools/mag_convert.mjs generate <path.MAG> <out.h> [--broken-swap-rg]');
  process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  await main();
}
