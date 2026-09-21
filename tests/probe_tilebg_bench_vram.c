/* tests/probe_tilebg_bench_cpu.cのVRAM/EGC経路版(A/B比較のB)。
 * 「タイル・タイル選択規則・座標順・REPEAT回数」を完全に揃え、描画部分
 * だけp98_draw_sprite_vram()を使う。2種のタイル(MAG_TILE_GROUND/ACCENT、
 * 16x16、全ドット不透明)はどちらも幅16の倍数・全ドット不透明で
 * p98_vram_upload()の対象になるため、ループの外で1回だけアップロードし、
 * 以後は使い回す(walk2.cの載せ替えで採ったのと同じ方針。
 * docs/design.md参照)。
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

    p98_init();
    p98_flip();

    /* 置き場は768バイト/プレーンで、16x16全ドット不透明のタイルは
     * 32バイト(+余裕2バイト)/枚しか使わないため、2枚アップロードしても
     * 容量には十分な余裕がある。戻り値が非0(容量不足等)なら、このベンチ
     * 自体が前提の不成立を示すことになるので描かずに終了する
     * (samples/walk2.cのフォールバックと違い、ベンチはA/B比較が目的の
     * ためフォールバックせず、条件が崩れたことをそのまま示す)。 */
    if (p98_vram_upload(&MAG_TILE_GROUND, &vsGround) != 0) { p98_quit(); return 1; }
    if (p98_vram_upload(&MAG_TILE_ACCENT, &vsAccent) != 0) { p98_quit(); return 1; }

    for (iter = 0; iter < REPEAT; iter++) {
        draw_tiled_background_vram(&vsGround, &vsAccent);
    }

    p98_quit();
    return 0;
}
