/* 「背景ページ+差分復帰(EGC活用)」方式の速度基準(A/B比較のB)。
 * probe_bgpage_bench_full.cと全く同じ重い背景(40個の矩形)・同じキャラ
 * サイズ・同じ移動パターン・同じBENCH_FRAMES回数で、背景は最初に1回だけ
 * 描き、以後はp98_draw_sprite_diff()だけを呼ぶ。tools/verify.mjsが
 * tests/probe_bgpage_bench0_bg.c(p98_init_bgpage相当の固定オーバーヘッドのみ)
 * との差分を取り、比較する。
 */
#include "p98.h"

#define CHAR_W 16
#define CHAR_H 16
static const unsigned char SPR_BITS[32] = {
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
};
static const p98_sprite_t SPR = { CHAR_W, CHAR_H, { SPR_BITS, SPR_BITS, SPR_BITS, SPR_BITS }, SPR_BITS };

#define BG_COLS 8
#define BG_ROWS 5
#define BG_CELL 80
#define BG_RECT 20
#define BENCH_FRAMES 300

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
    int iter;
    p98_init_bgpage();

    p98_set_draw_target(P98_TARGET_BACKGROUND);
    draw_heavy_background();
    p98_set_draw_target(P98_TARGET_SCREEN);
    draw_heavy_background();

    for (iter = 0; iter < BENCH_FRAMES; iter++) {
        int x = ((iter * 37) % 76) * 8;
        int y = ((iter * 11) % 46) * 8;
        p98_draw_sprite_diff(&SPR, x, y);
    }

    p98_quit();
    return 0;
}
