/* walk2(samples/walk2.c)のdraw_tiled_background()(40x25=1000枚のタイル
 * 敷き詰め)を、p98_draw_sprite()(CPU合成、p98__blend_bits)経路でREPEAT回
 * 繰り返すだけの速度基準(A/B比較のA)。tests/probe_tilebg_bench_vram.cと
 * 「タイル・タイル選択規則・座標順・REPEAT回数」を完全に揃え、
 * tools/verify.mjsがtests/probe_tilebg_bench0.c(固定オーバーヘッドのみ)
 * との差分を取って比較する。
 *
 * walk2.cはCPU経路で背景を起動時に2回(背景ページ+画面ページ)描くだけ
 * だが、1回ぶんの実行時間は他のA/B比較(スプライト速度、bgpage)に比べて
 * 短く、REPEATが1回だとホストの揺らぎに埋もれやすいため、ここでは
 * REPEAT=3回に増やしてsignalを稼いでいる(他のA/B比較でも同様の理由で
 * BENCH_FRAMESを調整した実績があるため。docs/verify-log.md参照)。
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

    for (iter = 0; iter < REPEAT; iter++) {
        draw_tiled_background();
    }

    p98_quit();
    return 0;
}
