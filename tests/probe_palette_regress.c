/* 「同じFreeDOSセッション内でp98libのプログラムを2回連続で実行しても、
 * 2回目の見た目が1回目と同じであること」を確認する回帰プローブ。
 *
 * p98_init()直後は draw_page=1 / disp_page=0 (flip前提の初期状態)なので、
 * draw_page(=1)へ塗ってから p98_flip() で disp_page 側へ回し、
 * 実際に画面へ表示される状態にする(probe_palette_default.c と同じ理由)。
 * その後 p98_wait_vsync() でしばらく静止し、外部(tools/verify.mjs)が
 * canvasのピクセルを読む時間を確保してから p98_quit() し、通常どおり
 * DOSプロンプトへ戻る(このプログラム自身が2回目の実行にも使われる)。
 */
#include "p98.h"

int main(void) {
    int i;
    p98_init();
    p98_fill_rect(0, 0, 640, 400, 5); /* 全画面を色5で塗る。パレットが
                                          潰れていれば見た目の色が変わる */
    p98_flip();
    /* 約5秒(300フレーム)静止する。外部(tools/verify.mjs)は起動直後の
     * 実行時間ばらつき(FreeDOSの初回ディスクキャッシュの有無等)を考慮して
     * 数秒の余裕を見てからcanvasのピクセルを読むため、静止時間は
     * 十分に長く取る。 */
    for (i = 0; i < 300; i++) { p98_wait_vsync(); }
    p98_quit();
    return 0;
}
