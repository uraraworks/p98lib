// MAG (MAKIchan MAKI02) 16色画像フォーマットのデコーダ。
//
// 出自: 作者の別プロジェクト `WebPaint98/src/mag/mag.ts` の decodeMag() を
// 元にした移植(型注釈を外しただけの1:1ポート、ロジックは変更していない。
// エンコード側(encodeMag)は今回のスコープ(既存MAGを読むだけ)では不要なため
// 移植していない)。
//
// なぜ「コピーしてJS化」したか(TSのまま読む/ビルド済みを置く、との比較。
// docs/design.md「MAG形式対応」節参照):
//   - p98libは公開予定のリポジトリで、tools/*.mjsは素のNode(バージョン不問の
//     ESM)でそのまま動く前提にしてある(tools/kya_convert.mjs等、既存コードと
//     同じ方針)。TSファイルをそのまま読む方式は、実行側にtsx/ts-node等の
//     追加ツールチェーンかNodeのTypeScript実験的サポート(バージョン依存)を
//     要求してしまい、「公開したとき他の人の環境で動くか」という基準に対して
//     余計な前提を持ち込む。
//   - WebPaint98側のビルド成果物(dist等)を直接参照する方式は、
//     WorkbenchNP2の`../WorkbenchNP2`参照と違い、WebPaint98はp98libの
//     ビルドに必須の依存ではない(p98lib単体で動く前提を崩したくない)ため
//     採用しなかった。
//   - 型注釈を外すだけの機械的な変換なので、ロジックの取り違えのリスクは
//     低い。正しく移植できたかは、このファイル単体のセルフテスト
//     (`node tools/mag_decode.mjs selftest <path.MAG>`)と、
//     `tools/kya_convert.mjs`側のKYAとの突き合わせ検査の両方で確認する
//     (どちらか一方だけでは「移植ミスが両方に同じ形で入っている」可能性を
//     消せないため)。

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const COPY_TABLE = [
  [0, 0], // 0: 未使用(リテラル)
  [1, 0], [2, 0], [4, 0],
  [0, 1], [1, 1],
  [0, 2], [1, 2], [2, 2],
  [0, 4], [1, 4], [2, 4],
  [0, 8], [1, 8], [2, 8],
  [0, 16],
];

const SIGNATURE = 'MAKI02  ';

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.bitPos = 0;
  }
  get totalBits() { return this.bytes.length * 8; }
  get consumedBits() { return this.bitPos; }
  readBit() {
    const byteIdx = this.bitPos >> 3;
    if (byteIdx >= this.bytes.length) throw new Error('MAG decode: flagA (bitstream) overrun');
    const bit = 7 - (this.bitPos & 7);
    this.bitPos++;
    return (this.bytes[byteIdx] >> bit) & 1;
  }
}

class ByteReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }
  get length() { return this.bytes.length; }
  get consumed() { return this.pos; }
  readByte(context) {
    if (this.pos >= this.bytes.length) throw new Error(`MAG decode: ${context} overrun`);
    return this.bytes[this.pos++];
  }
}

function readU16LE(bytes, offset) {
  const b0 = bytes[offset], b1 = bytes[offset + 1];
  if (b0 === undefined || b1 === undefined) throw new Error('MAG decode: header truncated (u16)');
  return b0 | (b1 << 8);
}

function readU32LE(bytes, offset) {
  const b0 = bytes[offset], b1 = bytes[offset + 1], b2 = bytes[offset + 2], b3 = bytes[offset + 3];
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) {
    throw new Error('MAG decode: header truncated (u32)');
  }
  return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
}

/** MAG (MAKI02) バイト列をデコードする。戻り値:
 * { width, height, x1, y1, pixels: Uint8Array(width*height, 0-15), palette: [{r,g,b} x16 (各0-255)] } */
export function decodeMag(bytes) {
  const sigBytes = bytes.subarray(0, SIGNATURE.length);
  let sigOk = sigBytes.length === SIGNATURE.length;
  if (sigOk) {
    for (let i = 0; i < SIGNATURE.length; i++) {
      if (sigBytes[i] !== SIGNATURE.charCodeAt(i)) { sigOk = false; break; }
    }
  }
  if (!sigOk) throw new Error("MAG decode: signature 'MAKI02  ' not found");

  let sepIdx = -1;
  for (let i = SIGNATURE.length; i < bytes.length; i++) {
    if (bytes[i] === 0x1a) { sepIdx = i; break; }
  }
  if (sepIdx < 0) throw new Error('MAG decode: comment terminator 0x1A not found');

  const headerBase = sepIdx + 1;
  if (headerBase + 32 > bytes.length) throw new Error('MAG decode: header truncated');

  let x1 = readU16LE(bytes, headerBase + 4);
  const y1 = readU16LE(bytes, headerBase + 6);
  let x2 = readU16LE(bytes, headerBase + 8);
  const y2 = readU16LE(bytes, headerBase + 10);
  const flagAOffsetField = readU32LE(bytes, headerBase + 12);
  const flagBOffsetField = readU32LE(bytes, headerBase + 16);
  const flagBSize = readU32LE(bytes, headerBase + 20);
  const pixelOffsetField = readU32LE(bytes, headerBase + 24);
  const pixelSize = readU32LE(bytes, headerBase + 28);

  x1 &= ~7;
  x2 |= 7;

  const width = x2 - x1 + 1;
  const height = y2 - y1 + 1;
  if (width <= 0 || height <= 0) throw new Error(`MAG decode: invalid dimensions ${width}x${height}`);
  if (width % 8 !== 0) throw new Error(`MAG decode: width ${width} not a multiple of 8`);

  const paletteOffset = headerBase + 32;
  const palette = [];
  for (let i = 0; i < 16; i++) {
    const o = paletteOffset + i * 3;
    // ファイル上の並びは G,R,B(docs/design.md「MAG形式対応」節参照、実測でも確認)。
    const g = bytes[o];
    const r = bytes[o + 1];
    const b = bytes[o + 2];
    if (g === undefined || r === undefined || b === undefined) throw new Error('MAG decode: palette truncated');
    palette.push({ r, g, b });
  }

  const flagAStart = headerBase + flagAOffsetField;
  const flagBStart = headerBase + flagBOffsetField;
  const pixelStart = headerBase + pixelOffsetField;

  if (flagBStart > bytes.length || flagAStart > flagBStart) throw new Error('MAG decode: flag offsets out of range');
  const flagABytes = bytes.subarray(flagAStart, flagBStart);
  const flagBBytes = bytes.subarray(flagBStart, flagBStart + flagBSize);
  const pixelBytes = bytes.subarray(pixelStart, pixelStart + pixelSize);
  if (flagBBytes.length !== flagBSize || pixelBytes.length !== pixelSize) {
    throw new Error('MAG decode: flagB/pixel data truncated');
  }

  const lineBytes = (width / 8) * 4;
  const unitsPerLine = lineBytes / 2;
  const flagBytesPerLine = unitsPerLine / 2;
  if (!Number.isInteger(flagBytesPerLine)) throw new Error('MAG decode: unexpected line layout (unitsPerLine not even)');

  const bitReader = new BitReader(flagABytes);
  const flagBReader = new ByteReader(flagBBytes);
  const pixelReader = new ByteReader(pixelBytes);

  const rawLines = new Uint8Array(height * lineBytes);
  let prevFlagBytes = new Uint8Array(flagBytesPerLine);

  for (let row = 0; row < height; row++) {
    const curFlagBytes = new Uint8Array(flagBytesPerLine);
    let unit = 0;
    for (let fb = 0; fb < flagBytesPerLine; fb++) {
      const bit = bitReader.readBit();
      const raw = bit === 1 ? flagBReader.readByte('flagB') : 0;
      const fbyte = (raw ^ prevFlagBytes[fb]) & 0xff;
      curFlagBytes[fb] = fbyte;
      const hi = (fbyte >> 4) & 0xf;
      const lo = fbyte & 0xf;
      for (const nib of [hi, lo]) {
        const pos = row * lineBytes + unit * 2;
        if (nib === 0) {
          rawLines[pos] = pixelReader.readByte('pixel data');
          rawLines[pos + 1] = pixelReader.readByte('pixel data');
        } else {
          const entry = COPY_TABLE[nib];
          if (!entry) throw new Error(`MAG decode: invalid copy nibble ${nib}`);
          const [dw, dl] = entry;
          const srcRow = row - dl;
          const srcUnit = unit - dw;
          if (srcRow < 0 || srcUnit < 0) {
            throw new Error(`MAG decode: copy reference out of range (row=${row} unit=${unit} nib=${nib})`);
          }
          const srcPos = srcRow * lineBytes + srcUnit * 2;
          rawLines[pos] = rawLines[srcPos];
          rawLines[pos + 1] = rawLines[srcPos + 1];
        }
        unit++;
      }
    }
    prevFlagBytes = curFlagBytes;
  }

  const flagAPaddingBits = bitReader.totalBits - bitReader.consumedBits;
  if (flagAPaddingBits < 0 || flagAPaddingBits >= 8) {
    throw new Error(`MAG decode: flagA stream not fully consumed (${bitReader.consumedBits}/${bitReader.totalBits} bits)`);
  }
  if (flagBReader.consumed !== flagBReader.length) {
    throw new Error(`MAG decode: flagB stream not fully consumed (${flagBReader.consumed}/${flagBReader.length} bytes)`);
  }
  if (pixelReader.consumed !== pixelReader.length) {
    throw new Error(`MAG decode: pixel stream not fully consumed (${pixelReader.consumed}/${pixelReader.length} bytes)`);
  }

  const pixels = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    const rowOffset = row * lineBytes;
    for (let byteIdx = 0; byteIdx < lineBytes; byteIdx++) {
      const byte = rawLines[rowOffset + byteIdx];
      const x = byteIdx * 2;
      pixels[row * width + x] = (byte >> 4) & 0xf;
      pixels[row * width + x + 1] = byte & 0xf;
    }
  }

  return { width, height, x1, y1, pixels, palette };
}

async function selfTest(magPath) {
  const buf = await readFile(magPath);
  const decoded = decodeMag(new Uint8Array(buf));
  console.log(`${magPath}: ${decoded.width}x${decoded.height} x1=${decoded.x1} y1=${decoded.y1}`);
  console.log('palette[0..3] (8bit r,g,b):', decoded.palette.slice(0, 4));
  console.log('pixels.length =', decoded.pixels.length, '(期待値:', decoded.width * decoded.height, ')');
  return decoded;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === 'selftest') {
    await selfTest(rest[0]);
    return;
  }
  console.error('Usage: node tools/mag_decode.mjs selftest <path.MAG>');
  process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  await main();
}
