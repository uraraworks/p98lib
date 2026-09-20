/* walk2(タイル背景+実素材)での「背景ページ+差分復帰」方式の速度基準
 * (A/B比較のB)。probe_walk2_bench_full.cと全く同じタイル背景・同じキャラ
 * サイズ・同じ移動パターン・同じBENCH_FRAMES回数で、背景は最初に1回だけ
 * 描き、以後はp98_draw_sprite_diff()だけを呼ぶ。
 * tools/verify.mjsがprobe_walk2_bench0_bg.c(固定オーバーヘッドのみ)との
 * 差分を取り、probe_walk2_bench_full.cと比較する。
 */
#include "p98.h"
#include "mag_assets.h"

#define SCREEN_W 640
#define SCREEN_H 400
#define TILE 16
#define TILE_COLS (SCREEN_W / TILE)
#define TILE_ROWS (SCREEN_H / TILE)
#define ACCENT_MOD 5
#define BENCH_FRAMES 40

static void draw_tiled_background(void) {
    int tx, ty;
    for (ty = 0; ty < TILE_ROWS; ty++) {
        for (tx = 0; tx < TILE_COLS; tx++) {
            const p98_sprite_t *tile = ((tx + ty) % ACCENT_MOD == 0) ? &MAG_TILE_ACCENT : &MAG_TILE_GROUND;
            p98_draw_sprite(tile, tx * TILE, ty * TILE);
        }
    }
}

int main(void) {
    int iter;
    p98_init_bgpage();

    p98_set_draw_target(P98_TARGET_BACKGROUND);
    draw_tiled_background();
    p98_set_draw_target(P98_TARGET_SCREEN);
    draw_tiled_background();

    for (iter = 0; iter < BENCH_FRAMES; iter++) {
        int x = ((iter * 37) % 76) * 8;
        int y = ((iter * 11) % 46) * 8;
        p98_draw_sprite_diff(MAG_WALK_DOWN[iter % 2], x, y);
    }

    p98_quit();
    return 0;
}
