/* p98_copy_bgpage_to_screen()のA/B速度比較(Aの側)。
 * samples/walk2.cの起動時の実際のやり方(draw_tiled_background()を
 * 背景ページ・画面ページへそれぞれ1回ずつ、計2回呼ぶ)を、
 * REPEAT回繰り返して速度のsignalを稼ぐ(tests/probe_tilebg_bench_{cpu,vram}.c
 * と同じ考え方)。タイルはwalk2.cが実際に使っているVRAM/EGC経路
 * (p98_vram_upload+p98_draw_sprite_vram)を使う(walk2.cは通常この経路が
 * 成功するため)。
 *
 * tests/probe_bgcopy_bench_copy.c(Bの側=draw_tiled_background()を1回+
 * p98_copy_bgpage_to_screen())と「タイル・タイル選択規則・座標順・
 * REPEAT回数」を完全に揃えてある。tools/verify.mjsがtests/probe_bgcopy_bench0.c
 * (固定オーバーヘッドのみ)との差分を取って比較する。
 */
#include "p98.h"
#include "mag_assets.h"

#define SCREEN_W 640
#define SCREEN_H 400
#define TILE 16
#define TILE_COLS (SCREEN_W / TILE)
#define TILE_ROWS (SCREEN_H / TILE)
#define ACCENT_MOD 5
#define REPEAT 3

static void draw_tiled_background_vram(const p98_vram_sprite_t *vsGround, const p98_vram_sprite_t *vsAccent) {
    int tx, ty;
    for (ty = 0; ty < TILE_ROWS; ty++) {
        for (tx = 0; tx < TILE_COLS; tx++) {
            const p98_vram_sprite_t *tile = ((tx + ty) % ACCENT_MOD == 0) ? vsAccent : vsGround;
            p98_draw_sprite_vram(tile, tx * TILE, ty * TILE);
        }
    }
}

int main(void) {
    int iter;
    p98_vram_sprite_t vsGround, vsAccent;

    p98_init_bgpage();

    if (p98_vram_upload(&MAG_TILE_GROUND, &vsGround) != 0) { p98_quit(); return 1; }
    if (p98_vram_upload(&MAG_TILE_ACCENT, &vsAccent) != 0) { p98_quit(); return 1; }

    for (iter = 0; iter < REPEAT; iter++) {
        p98_set_draw_target(P98_TARGET_BACKGROUND);
        draw_tiled_background_vram(&vsGround, &vsAccent);

        p98_set_draw_target(P98_TARGET_SCREEN);
        draw_tiled_background_vram(&vsGround, &vsAccent);
    }

    p98_quit();
    return 0;
}
