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
 * 実装はキーボード割り込み(IRQ1 = INT 09h、実測で確認。docs/design.md参照)を
 * 自前の割り込みハンドラで奪う方式。scancode は 0-127
 * (WebNP2-wiki Keyboard.md のスキャンコード表と同じ体系、bit7は使わない)。
 * かな/漢字変換、GRPH配列の文字は対象外。
 */

/* このフレーム分の入力を取り込む(スナップショット方式)。
 * p98_key_down()/p98_key_pressed() はこの呼び出し時点の状態を返す。
 * 毎フレーム1回、ループの先頭で呼ぶ想定。
 */
void p98_poll(void);

/* scancode を押している間ずっと真(1)。範囲外(0-127以外)は常に0。 */
int p98_key_down(int scancode);

/* 直前の p98_poll() から今回の p98_poll() までの間に、scancode の
 * 押下(立ち上がり)が最低1回あれば真(1)。短い押下でも取りこぼさないよう、
 * 割り込みハンドラ側で「押した」フラグを立て、p98_poll()で読み出してから
 * クリアする(次にp98_pollを呼ぶまで消えない)。
 */
int p98_key_pressed(int scancode);

/* 文字入力のリングバッファから1文字取り出す。無ければ0を返す(非ブロッキング)。
 * SHIFT(押している間)とCAPS(トグル)を反映する。CTRL+文字キーは制御コード
 * (例: CTRL+aは0x01)を返す。かな・GRPHは文字を生成しない(対象外)。
 */
int p98_key_getch(void);

#endif /* P98_H */
