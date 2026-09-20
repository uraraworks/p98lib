/* 故障注入: tools/mag_convert.mjs generate --broken-swap-rg で生成した
 * (R/Gプレーンを入れ替えた)版を使う。probe_walk2_assets.cと全く同じ座標へ
 * 同じ絵を描くが、キャラの色が化けているはずなので、正しい期待値との比較
 * 検査がFAILすることを確認するためのプローブ(tools/verify.mjs参照)。
 */
#include "p98.h"
#include "mag_assets_broken_rg.h"

int main(void) {
    p98_init();
    p98_flip();
    p98_clear(0);

    p98_draw_sprite(&MAG_TILE_GROUND, 0, 0);
    p98_draw_sprite(&MAG_TILE_ACCENT, 16, 0);

    p98_draw_sprite(MAG_WALK_DOWN[0], 64, 64);
    p98_draw_sprite(MAG_WALK_LEFT[0], 160, 64);
    p98_draw_sprite(MAG_WALK_RIGHT[0], 256, 64);
    p98_draw_sprite(MAG_WALK_UP[0], 352, 64);

    for (;;) { }
    return 0;
}
