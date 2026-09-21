#!/usr/bin/env node
// KYA(MITEI2.KYA)とMAG(MITEI2.MAG)は同じ絵のはず。
// 両方を変換した結果のバイト列(パレット・全画素のパレット番号)が一致することを
// 機械的に確認する。どちらが正しいかを最初から決め打ちせず、両方独立に
// デコードして突き合わせる(「片方だけ見てそれらしいで終わらせない」ため)。
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseKya, pixelIndex } from './kya_convert.mjs';
import { decodeMag } from './mag_decode.mjs';

export async function compareKyaMag(kyaPath, magPath) {
  const kyaBuf = await readFile(kyaPath);
  const kya = parseKya(kyaBuf);
  const magBuf = await readFile(magPath);
  const mag = decodeMag(new Uint8Array(magBuf));

  const report = { ok: true, issues: [] };

  if (kya.rowBytes * 8 !== mag.width || kya.rows !== mag.height) {
    report.ok = false;
    report.issues.push(`寸法不一致: KYA=${kya.rowBytes * 8}x${kya.rows} MAG=${mag.width}x${mag.height}`);
    return report;
  }
  const width = mag.width, height = mag.height;

  // パレット(16色、各0-15)。MAGは8bit(0-255、17の倍数)を>>4して4bitへ。
  const magPalette4 = mag.palette.map((c) => ({ r: c.r >> 4, g: c.g >> 4, b: c.b >> 4 }));
  let paletteMismatch = 0;
  for (let i = 0; i < 16; i++) {
    const k = kya.palette[i], m = magPalette4[i];
    if (k.r !== m.r || k.g !== m.g || k.b !== m.b) {
      paletteMismatch++;
      report.issues.push(`パレット[${i}]不一致: KYA=(${k.r},${k.g},${k.b}) MAG=(${m.r},${m.g},${m.b})`);
    }
  }
  report.paletteMismatch = paletteMismatch;
  if (paletteMismatch > 0) report.ok = false;

  // 全画素(640x400=256000画素)のパレット番号を突き合わせる。
  let pixelMismatch = 0;
  const firstMismatches = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // KYAは4プレーンのバイト列から都度ビットを読む(pixelIndexはrect単位の
      // ローカル座標を取るため、ここでは1x1のrectを都度作らず、直接
      // planeRowOffsetを使って読む)。
      const byteIdx = x >> 3;
      const bitMask = 0x80 >> (x & 7);
      let kIdx = 0;
      for (let p = 0; p < 4; p++) {
        const off = kya.planeRowOffset(p, y) + byteIdx;
        if (kya.buf[off] & bitMask) kIdx |= (1 << p);
      }
      const mIdx = mag.pixels[y * width + x];
      if (kIdx !== mIdx) {
        pixelMismatch++;
        if (firstMismatches.length < 10) firstMismatches.push({ x, y, kya: kIdx, mag: mIdx });
      }
    }
  }
  report.pixelMismatch = pixelMismatch;
  report.totalPixels = width * height;
  report.firstMismatches = firstMismatches;
  if (pixelMismatch > 0) {
    report.ok = false;
    report.issues.push(`画素不一致: ${pixelMismatch}/${width * height}画素`);
  }

  return report;
}

async function main() {
  const [, , kyaPath, magPath] = process.argv;
  if (!kyaPath || !magPath) {
    console.error('Usage: node tools/compare_kya_mag.mjs <path.KYA> <path.MAG>');
    process.exitCode = 2;
    return;
  }
  const report = await compareKyaMag(resolve(kyaPath), resolve(magPath));
  console.log(`パレット不一致: ${report.paletteMismatch ?? 'N/A'}/16`);
  console.log(`画素不一致: ${report.pixelMismatch ?? 'N/A'}/${report.totalPixels ?? 'N/A'}`);
  if (report.issues.length) console.log('詳細:', report.issues.slice(0, 20));
  if (report.firstMismatches?.length) console.log('最初の不一致画素:', report.firstMismatches);
  console.log(report.ok ? 'OK: KYAとMAGは完全一致' : 'FAIL: 不一致あり');
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  await main();
}
