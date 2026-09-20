/* 「毎フレーム背景を全部描き直す」方式の速度基準(A/B比較のA)。
 * tools/verify.mjs が tests/probe_sprite_bench0.c(p98_init/p98_flip/
 * p98_clear/p98_quitの固定オーバーヘッドのみ)との差分を取り、
 * 「重い背景(40個の矩形)をBENCH_FRAMES回描き直す+キャラを1体描く」
 * コストを求める。docs/design.mdの「使い勝手で気づいた点」で指摘した
 * 「背景の退避・復元が完全に利用者任せ」への対策(差分復帰、
 * probe_bgpage_bench_diff.c)との比較用。
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
    p98_init();
    p98_flip();

    for (iter = 0; iter < BENCH_FRAMES; iter++) {
        int x = ((iter * 37) % 76) * 8;   /* 8の倍数(バイト境界)、0..600 */
        int y = ((iter * 11) % 46) * 8;   /* 8の倍数、0..360 */
        draw_heavy_background();
        p98_draw_sprite(&SPR, x, y);
    }

    p98_quit();
    return 0;
}
