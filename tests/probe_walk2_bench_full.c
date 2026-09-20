/* walk2(タイル背景+実素材)での「毎フレーム背景を全部描き直す」方式の
 * 速度基準(A/B比較のA)。probe_bgpage_bench_full.cと同じ枠組みだが、
 * 背景は40個の矩形ではなく、実際にwalk2で使うタイル敷き詰め(40x25枚)。
 * tools/verify.mjsがprobe_sprite_bench0.c(固定オーバーヘッドのみ)との
 * 差分を取り、probe_walk2_bench_diff.cと比較する。
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
    p98_init();
    p98_flip();

    for (iter = 0; iter < BENCH_FRAMES; iter++) {
        int x = ((iter * 37) % 76) * 8;
        int y = ((iter * 11) % 46) * 8;
        draw_tiled_background();
        p98_draw_sprite(MAG_WALK_DOWN[iter % 2], x, y);
    }

    p98_quit();
    return 0;
}
