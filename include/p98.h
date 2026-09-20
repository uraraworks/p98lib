/*
 * p98.h - PC-98(386以上) 向け最小グラフィックライブラリ
 *
 * 対象: WebNP2(NP2kai) + FreeDOS(98)、WorkbenchNP2 の SmallerC huge model。
 * 仕様の根拠: WebNP2-wiki (Graphics.md / Timing-and-Interrupts.md 等) と
 * 実機ではなくエミュレータ上での実測。詳細は docs/design.md を参照。
 *
 * スコープ: 画面初期化・VSYNC待ち・ページ交換・GRCGによる塗り・パレット設定・
 * キーボード。スプライトは docs/design.md に API の形だけを設計として
 * 書いてある(未実装)。
 */
#ifndef P98_H
#define P98_H

/* 640x400 16色モードを開始する。元の画面モード・パレット・書き換える
 * 割り込みベクタ(INT 23h)を退避し、Ctrl+C による異常終了時に画面が
 * グラフィックモードのまま固まらないよう INT 23h を無害化する。
 * 戻り値: 成功時0、失敗時0以外(現状は常に成功する)。
 */
int p98_init(void);

/* p98_init() で変更した状態(画面モード・パレット・INT 23h ベクタ)を
 * すべて元へ戻す。p98_init() を呼んでいない状態で呼んではいけない。
 */
void p98_quit(void);

/* 次の垂直帰線が始まるまで待つ(ポーリング)。 */
void p98_wait_vsync(void);

/* 表示ページと描画ページを入れ替える。以後の p98_clear()/p98_fill_rect() は
 * 新しい描画ページ(= 直前まで表示していなかった側)に書く。
 */
void p98_flip(void);

/* p98_init() 以降に p98_flip() を呼んだ回数。 */
unsigned long p98_frames(void);

/* 描画ページ全体を color (0-15) で塗る。 */
void p98_clear(int color);

/* 描画ページの矩形 (x, y, w, h) を color (0-15) で塗る。
 * 画面外・負のx/y・w<=0・h<=0 は画面内の範囲だけに切り詰める(クリップ)。
 * 完全に画面外の矩形は何もしない。
 */
void p98_fill_rect(int x, int y, int w, int h, int color);

/* パレット番号 index (0-15) の色を r,g,b (各0-15) に設定する。 */
void p98_set_palette(int index, int r, int g, int b);

/* ---- キーボード (p98_init()～p98_quit()の間だけ有効) ----
 * 実装はBIOS(INT 18h)方式(2026-09、IRQ1直接受信方式から切替。
 * docs/design.md参照。理由: 生のIRQ1では「押しっぱなしで本物のbreak→make
 * ペアが繰り返し来る」キーリピートを止められないことが実測で分かったため、
 * リピートの影響を受けないBIOSのキーセンス(AH=04h)へ切り替えた)。
 * ベクタ横取り・PIC操作は行わない。scancode は 0-127
 * (WebNP2-wiki Keyboard.md のスキャンコード表と同じ体系、bit7は使わない)。
 *
 * 制限(design.md/verify-log.md参照): p98_poll()を呼ぶ間隔より短い
 * 「ちょん押し」(1フレーム未満で離される押下)は取りこぼす。BIOSの
 * センスは「今その瞬間押しているか」を返すだけの状態読み取りで、
 * IRQ1直接受信方式にあったような「edgeビットを別に持って取りこぼしを防ぐ」
 * 対策ができないため。
 */

/* このフレーム分の入力を取り込む(スナップショット方式)。BIOSのキーセンス
 * (INT 18h AH=04h)を全16グループぶん読み、前回のp98_poll()との差分から
 * p98_key_pressed()を求める。毎フレーム1回、ループの先頭で呼ぶ想定。
 */
void p98_poll(void);

/* scancode を押している間ずっと真(1)。範囲外(0-127以外)は常に0。 */
int p98_key_down(int scancode);

/* 直前の p98_poll() から今回の p98_poll() までの間に、scancodeが新たに
 * 押された(前回は押されておらず、今回は押されている)なら真(1)。
 * 押しっぱなしにしてもp98_poll()の間隔をまたいで真になるのは最初の1回だけ
 * (BIOSのキーリピートの影響を受けない)。
 */
int p98_key_pressed(int scancode);

/* 文字入力をBIOSのキーバッファ(INT 18h AH=01h/00h)から1文字取り出す。
 * 無ければ0を返す(非ブロッキング)。SHIFT/CAPS/CTRL等の変換はBIOSが
 * 行った結果をそのまま返す(WebNP2-wiki Keyboard.md参照)。
 */
int p98_key_getch(void);

/* ---- スプライト(CPU合成のみ。EGCでの高速化は次回スコープ。docs/design.md参照) ----
 *
 * データ形式: 4プレーン(青・赤・緑・輝度)+マスクの1bpp(1ドット1ビット)ビットマップ。
 * 各プレーン・マスクとも共通のレイアウト:
 *   - 1行 = ceil(w/8) バイト、MSBが左端のドット(p98_fill_rect/GRCGと同じビット順)。
 *   - 行方向はパディング無しで詰めて並べる(1プレーンぶんの総バイト数 = ceil(w/8)*h)。
 *   - mask のビットが1の位置だけ画面へ書く(背景を壊さない)。0の位置は
 *     4プレーンとも背景をそのまま残す。
 * 4プレーン+別マスクという形式にした理由(1bppにした理由も含む、docs/design.md参照):
 *   - VRAM自体が4プレーン×1bppの構造なので、変換無しでそのままVRAMへ書ける。
 *   - マスクを「背景色をキーカラーにする」方式にしなかったのは、GRCGを介さない
 *     1バイト単位のread-modify-write(p98__peekb/pokeb系)で合成するため、
 *     キーカラー比較よりビットAND/ORの方がシンプルで速いため。
 */
typedef struct {
    int w;                          /* 幅(ドット数、1以上) */
    int h;                          /* 高さ(ドット数、1以上) */
    const unsigned char *planes[4]; /* [0]=青 [1]=赤 [2]=緑 [3]=輝度。各 ceil(w/8)*h バイト */
    const unsigned char *mask;      /* 1=描画する ceil(w/8)*h バイト */
} p98_sprite_t;

/* スプライトを描画ページの (x, y) (スプライトの左上が来る座標) へ描く。
 * x は1ドット単位で自由に指定できる(バイト境界に揃っている必要は無い)。
 * 画面外・負のx/y・スプライトが画面端からはみ出す場合は、はみ出した部分だけを
 * 描かず、画面内の部分だけ描く(p98_fill_rect と同様のクリップ)。
 * spr が NULL、または w<=0 || h<=0 の場合は何もしない。
 */
void p98_draw_sprite(const p98_sprite_t *spr, int x, int y);

/* ---- 描画バックエンド(CPU合成 / EGC。2026-09後半、docs/design.md参照) ----
 * P98_SPRITE_CPU: 常に p98__blend_bits(1バイト単位のread-modify-write)で
 *   4プレーンぶん個別に書く。全ケースで正しく動く既定値。
 * P98_SPRITE_EGC: 実測で確認できたEGCの「1回のCPU書き込みで4プレーン
 *   すべてに同じ値を書ける」機能を使い、透明ドットを含まず4プレーンの
 *   結果が全て同一になるバイト(単色スプライトの内部等)だけを高速化する。
 *   それ以外のバイト(マスクの穴・プレーンごとに異なる色)はCPU経路に
 *   自動でフォールバックするため、**見た目の結果はP98_SPRITE_CPUと
 *   常に一致する**(tools/verify.mjsの等価性検査で確認済み)。
 *   マスク・シフトレジスタ自体はEGCの機能として使っていない(実測で
 *   ビット単位のマスク合成が再現できなかったため。docs/design.md参照)。
 */
typedef enum { P98_SPRITE_CPU = 0, P98_SPRITE_EGC = 1 } p98_sprite_backend_t;

/* 以後の p98_draw_sprite() が使うバックエンドを切り替える(既定:CPU)。 */
void p98_set_sprite_backend(p98_sprite_backend_t backend);
p98_sprite_backend_t p98_get_sprite_backend(void);

/* p98_set_sprite_backend()の設定に関わらず、バックエンドを明示して描く
 * (検証用。両方のバックエンドを同じプログラム内で叩き分けられるように)。 */
void p98_draw_sprite_ex(const p98_sprite_t *spr, int x, int y, p98_sprite_backend_t backend);

#endif /* P98_H */
