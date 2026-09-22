# p98lib

A minimal C graphics/input library for PC-98 (386+) games, built and verified on WebNP2(NP2kai).

PC-98(386以上)向けの、C言語で書くゲームのための最小グラフィックライブラリです。
画面初期化・VSYNC待ち・ページ交換・GRCGによる塗り・パレット設定・キーボード(BIOS
キーセンス方式)・スプライト(CPU合成/EGC/VRAM常駐+EGC転送)・背景ページ+差分復帰を
実装しています。

対象環境:
- PC-98(386以上)。ターゲットOSは FreeDOS(98) / MS-DOS。
- コンパイラは [WorkbenchNP2](https://github.com/uraraworks/WorkbenchNP2) が提供する
  SmallerC の **huge model**。
- 動作確認は **WebNP2(NP2kai)上のみ**で行っています(下記「できないこと・限界」参照)。

仕様の根拠は WebNP2-wiki(Graphics.md / Timing-and-Interrupts.md 等)と、実機ではなく
WebNP2(NP2kai)上での実測です。third-party のライブラリ実装(master.lib 等)のソースは
一切参照していません。設計判断の経緯・実測結果は `docs/design.md`、検証の実行結果は
`docs/verify-log.md` にすべて記録してあります。

## ビルドの前提: WorkbenchNP2 が隣に要ります

`tools/build.mjs` は [WorkbenchNP2](https://github.com/uraraworks/WorkbenchNP2) の
`toolchain/*.mjs`(SmallerC/NASMのwasmビルド一式)を、**`../WorkbenchNP2` への相対パスで
そのまま import** します。ビルド済み成果物をこのリポジトリ側へコピーする方式には
していません。理由:

- huge model 対応は WorkbenchNP2 側で継続的に更新されており、コピーすると鮮度が
  失われるため。
- wasm 本体を含む数MB〜十数MBのバイナリを、別リポジトリへ重複して抱えたくないため。
- WorkbenchNP2 側を書き換えないため、依存が壊れたときの原因切り分けがしやすいため。

つまり「ツールチェーンを二重に持たない」方針です。この代わり、**WorkbenchNP2の
チェックアウトが p98lib の隣(`../WorkbenchNP2`)に無いとビルドできません。**

```
some-dir/
├── p98lib/          (このリポジトリ)
└── WorkbenchNP2/     (別途 clone。https://github.com/uraraworks/WorkbenchNP2)
```

セットアップ手順:

```sh
cd some-dir
git clone https://github.com/uraraworks/WorkbenchNP2.git
cd p98lib
node tools/build.mjs samples/hello.c   # ビルドできれば前提OK
```

## 最小の使用例(`samples/hello.c`)

```c
#include "p98.h"

int main(void) {
    int i;

    p98_init();
    p98_clear(0);
    p98_fill_rect(100, 50, 200, 80, 5);
    p98_flip();

    for (i = 0; i < 60; i++) {
        p98_wait_vsync();
    }

    p98_quit();
    return 0;
}
```

## デモの動かし方

```sh
node tools/build.mjs samples/walk.c    # 単色矩形のスプライトが歩くデモ
node tools/build.mjs samples/walk2.c   # 実素材(MAG形式)を使ったタイル背景+4方向歩行デモ
```

いずれも WorkbenchNP2 のビルド経路を通して MZ EXE + 実行用フロッピーイメージ(.xdf)を
生成します。実行は WebNP2(NP2kai) 上で行ってください(WorkbenchNP2 の ide 一式、または
お手元の np2kai 環境)。`samples/walk2.c` は方向キーで4方向に歩き、ESCで終了します。

## 検証の回し方

```sh
node tools/verify.mjs
```

WebNP2(NP2kai)+FreeDOS(98)上で実際にプローブプログラムを走らせ、VRAM/TVRAMの実バイト値で
判定する229項目の検証です(故障注入込み。詳細・実測結果は `docs/verify-log.md`)。
puppeteer 経由でヘッドレスブラウザを起動するため、実行環境によっては `CHROME_PATH`
環境変数でChromeの実行ファイルパスを指定してください。

**素材(元のMAG/KYAファイル)を伴う項目は作者の環境でのみ実行可能です。**
このリポジトリには変換済みのCバイト配列(`samples/mag_assets.h`等)しか
コミットしておらず、元の画像ファイルは含まれていません(`docs/assets.md`参照)。
素材が無い環境で実行すると、素材を必要とする項目(KYA/MAGの突き合わせ、
walk2デモの変換結果検証)は**「素材が無いため実行できません」とSKIP表示され、
合格扱いにはなりません**。素材を必要としない項目(画面初期化・キーボード・
スプライト・背景ページ等の大半)は通常どおり実行されます。

終了コードは次の3通りです:
- `0`: 全項目OK、SKIPも無し(素材ありの環境で全項目通過)。
- `1`: 1件以上の本当の失敗(FAIL)がある。
- `2`: FAILは無いが、素材が無く実行できなかった項目(SKIP)がある
  (異常ではないが、全項目を検証できたわけではない状態)。

## できないこと・制限(正直に書きます)

- **`p98_flip()`(ページ二重化)と背景ページ方式は併用できません。** どちらも
  「表示/描画ページの入れ替え」という同じ仕組みを取り合うため、設計上どちらか一方を
  選ぶ必要があります(詳細は `docs/design.md`)。
- **`p98_poll()` の呼び出し間隔より短い押下は取りこぼします。** BIOSキーセンス方式
  (`INT 18h AH=04h`)は「今その瞬間押しているか」を読むだけの状態読み取りのため、
  1回の `p98_poll()` と次の `p98_poll()` の間に完全に収まる押下(押してから
  次のpollより前に離す)は `down` にも `pressed` にも一切反映されません。対策は
  していません(詳細は `docs/design.md` のキーボードの節)。
- **実機での動作確認は行っていません。** すべて WebNP2(NP2kai) 上での実測です。
  実機PC-98での挙動(特に表示/描画ページのバンク切り替え方式)は未確認です。
- **速度の数値はエミュレータ込みの相対値です。** `tools/verify.mjs` が出力する
  スプライト描画コスト等は、np2kai(WebNP2)+puppeteer というこの実行環境全体を
  通した相対的な基準であり、実機のfpsや絶対的な性能を示すものではありません。
- EGC経由のスプライト描画(`P98_SPRITE_EGC`)は、CPU合成(既定)より速くなりません
  (実測 約0.95倍)。等価性(描画結果が一致すること)は確認済みですが、速度上の
  メリットは現状ありません(詳細は `docs/design.md`)。
- 別経路として、スプライトをあらかじめVRAM上へアップロードしてEGCで本転送する
  `p98_vram_upload()`/`p98_draw_sprite_vram()`があり、こちらはCPU合成より
  大幅に速くなります(詳細・実測比率は `docs/design.md`)。ただし置き場が
  各プレーン768バイトしかなく、幅は16の倍数のスプライトのみ対応です
  (横方向に画面端をはみ出す座標ではCPU合成へ自動でフォールバックします)。
- 400ライン以外の画面モード、8色モードは未検証です(スコープ外)。
- **検証(`tools/verify.mjs`)のうち素材を伴う項目は作者の環境でのみ実行可能です。**
  上記「検証の回し方」参照。

## 素材について

`samples/mag_assets.h` / `samples/kya_assets.h`(および `tests/` 配下の対応する
故障注入版)は、変換済みの C バイト配列であり、元の画像ファイルそのものはこの
リポジトリにコミットしていません。すべて作者が1996〜97年に制作したオリジナル
作品から変換したものです。出自の一覧は `docs/assets.md` を参照してください。

## ライセンス

MIT License です。詳細は `LICENSE` を参照してください。同梱の素材(変換済みの
Cバイト配列)についての扱いは `LICENSE` の別項、および `docs/assets.md` を参照してください。

## コントリビュート

`CONTRIBUTING.md` を参照してください。**受け取らないもの**(他人の実装からの逆アセ/移植、
出典不明の仕様記述、権利未確認の素材)を明記しています。

## 開発者向け: 混入検査フックの有効化

このリポジトリを clone しただけでは pre-commit フックは有効になりません。以下で
有効化してください:

```sh
git config core.hooksPath tools/hooks
```

これにより、コミット前に `tools/check_assets.mjs` が走り、`docs/assets.md` の
「使ってよい」一覧に無い素材由来のファイル・`_local/` 由来のパス・生の画像/ディスク系
ファイルの混入をコミット前に止めます。単体でも実行できます:

```sh
node tools/check_assets.mjs         # ステージ済みファイルを検査
node tools/check_assets.mjs --all   # 追跡中の全ファイルを検査
```
