/* probe_walk2_bench_diff.c の固定オーバーヘッドのみ版(p98_init_bgpage +
 * タイル背景を2回描く + p98_quit)。tools/verify.mjs がこれとの差分を
 * probe_walk2_bench_diff.c の実測から引いて「差分復帰そのもの」のコストを
 * 求める(probe_bgpage_bench0_bg.cと同じ考え方)。
 */
#include "p98.h"
#include "mag_assets.h"

#define SCREEN_W 640
#define SCREEN_H 400
#define TILE 16
#define TILE_COLS (SCREEN_W / TILE)
#define TILE_ROWS (SCREEN_H / TILE)
#define ACCENT_MOD 5

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
    p98_init_bgpage();
    p98_set_draw_target(P98_TARGET_BACKGROUND);
    draw_tiled_background();
    p98_set_draw_target(P98_TARGET_SCREEN);
    draw_tiled_background();
    p98_quit();
    return 0;
}
