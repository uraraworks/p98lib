# 素材の出自と権利(公開前の混入検査の基準)

p98libのサンプル・テスト・変換ツールが参照するゲーム素材(KYA/MAG形式の
画像ファイル)は、すべて`../_local/legacy-a-games/`配下(このrepoの外、
`.gitignore`対象。p98lib自体には画像ファイルそのものはコミットしない)に
ある。変換した結果(Cのバイト配列、`samples/*.h`)だけをこのrepoへ
コミットしている。

**このファイルは「使ってよい素材の一覧」であり、将来レビューする側が
新しい変換データを見たときに「元ファイルがこの一覧にあるか」を確認する
ための基準にする。一覧に無いファイル由来のデータをコミットしない。**

## 使ってよい(公開repoへ入れてよい)

| パス | 由来 | 確認日 | 備考 |
|---|---|---|---|
| `C-GAMES/SAKA/*.KYA` `*.MAG` `*.GRP` | ユーザー本人のオリジナル作品 | 2026-09-20 | RPGキャラ(32x32、4方向歩行)+16x16背景タイル |
| `ORIGINAL/KYARA-03.MAG` | ユーザー本人のオリジナル作品 | 2026-09-21 | `MITEI2.KYA`と同じ配置。背景タイルの描き込みが多く、キャラの色数も多い「色付き完全版」 |
| `ORIGINAL/KYARA-04.MAG` | ユーザー本人のオリジナル作品 | 2026-09-21 | KYARA-03と同系統。現時点ではp98lib側で未使用 |

## 使わない(未確認、または権利上の理由)

| パス | 理由 |
|---|---|
| `ORIGINAL/KEN.MAG` | 版権キャラ(ストリートファイターIIのケン)の模写 |
| `ORIGINAL/`配下のその他すべて(`BACK2-1.MAG`,`DOLPHIN.MAG`,`FIRE.MAG`,`ICON.MAG`,`KAKU_SCR.MAG`,`KAUTOU.MAG`,`KYARA-01.MAG`,`KYARA-02.MAG`,`KYU.MAG`,`M_BOX.MAG`,`NEW1.MAG`,`NEZI1.MAG`,`POST.MAG`,`SCREEN.MAG`,`SOUKO.MAG`,`TEST.KYA`,`TEST.MAG`,`TITTLE.MAG`,`TITTLE2.MAG`等) | 出自未確認(オリジナルか模写か本人未確認)。確認が取れるまで使わない |
| `A-GAMES/KAKUTOU/`配下の画像(`MAG/`・`KYARA_01.KDT`・`GAMEN.DAT`) | デザインがユーザー本人の友人の作。公開には本人の了解が要る(ユーザーのオリジナルではあるが友人デザインのため) |

**方針: `ORIGINAL/`はフォルダ単位で除外するのではなく、ファイル単位で
判断する**(2026-09-21、指示更新。以前は「`ORIGINAL/`配下は使わない」と
していたが、ユーザー本人による個別確認が取れたファイルは使ってよいことに
変わった)。迷うものは入れず、報告して止める。

## p98lib内で実際に使っている・生成したファイル

| 生成物(このrepoにコミット) | 元データ | 変換ツール |
|---|---|---|
| `samples/kya_assets.h` | `C-GAMES/SAKA/MITEI2.KYA` | `tools/kya_convert.mjs`(作者向け、KYAはp98lib独自形式のため公開しても他の人は変換できない) |
| `tests/kya_assets_broken_rg.h` | 同上(R/Gプレーン入替の故障注入版) | 同上 |
| `samples/mag_assets.h` | `ORIGINAL/KYARA-03.MAG` | `tools/mag_convert.mjs`(公開向け本命。MAGは当時の標準フォーマット) |
| `tests/mag_assets_broken_rg.h` | 同上(R/Gプレーン入替の故障注入版) | 同上 |

`samples/walk2.c`(公開デモ)は`samples/mag_assets.h`(=`KYARA-03.MAG`由来)
だけを使う。`samples/kya_assets.h`は`tools/kya_convert.mjs`の動作確認・
作者向けの参照実装として残しているが、現行デモからは参照していない。

`tools/verify.mjs`の「KYA経由とMAG経由の突き合わせ」検査は、上記の
`C-GAMES/SAKA/MITEI2.KYA`/`MITEI2.MAG`/`MITEI3.KYA`/`MITEI3.MAG`を
実行時に`../_local/`から直接読んで比較するだけで、変換データそのものは
コミットしていない(パレット一致の確認と、画素不一致という実測結果の
記録が目的。詳細は`docs/design.md`「MAG形式対応」節参照)。

## 経緯(素材選定の変遷)

1. `samples/walk2.c`は当初`C-GAMES/SAKA/MITEI2.KYA`(キャラ8体×4方向、
   多色)を使っていた。
2. コーディネーターの指示で「MAGは当時の標準フォーマットなので主役に」
   となり、`MITEI3.MAG`(キャラは多色)へキャラを差し替えたが、実測すると
   `MITEI3.MAG`のタイル領域は白黒2色しか無く、タイルは`MITEI2.KYA`由来の
   ままにしていた(KYA/MAG混在)。
3. さらに`ORIGINAL/KYARA-03.MAG`(ユーザー本人のオリジナル作品と確認済み、
   2026-09-21)が見つかり、`MITEI2.KYA`と同じ配置でありながら
   キャラ・タイルとも色数が多い「色付き完全版」だと判明したため、
   現在はキャラ・タイルとも`KYARA-03.MAG`一本に統一している。
