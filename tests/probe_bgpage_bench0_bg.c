/* tests/probe_bgpage_bench_diff.c の「ベースライン(背景を描いてキャラは
 * 1回も動かさない)」版。p98_init_bgpage/両ページへの背景描画/p98_quitの
 * 固定オーバーヘッドだけを含む。tools/verify.mjsで本編との差分を取り、
 * 「差分復帰をBENCH_FRAMES回行うコスト」を求める。
 */
#include "p98.h"

#define BG_COLS 8
#define BG_ROWS 5
#define BG_CELL 80
#define BG_RECT 20

static void draw_heavy_background(void) {
    int cx, cy;
    p98_clear(0);
    for (cy = 0; cy < BG_ROWS; cy++) {
        for (cx = 0; cx < BG_COLS; cx++) {
            int color = 1 + ((cx + cy * BG_COLS) % 15);
            p98_fill_rect(cx * BG_CELL + 4, cy * BG_CELL + 4, BG_RECT, BG_RECT, color);
        }
    }
}

int main(void) {
    p98_init_bgpage();
    p98_set_draw_target(P98_TARGET_BACKGROUND);
    draw_heavy_background();
    p98_set_draw_target(P98_TARGET_SCREEN);
    draw_heavy_background();
    p98_quit();
    return 0;
}
