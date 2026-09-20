/* samples/mag_assets.h (MAG変換ツールの出力)・samples/kya_assets.h(タイルの
 * みKYA側を流用)が、VRAM上に期待どおりのドット列で出ることを確認するための
 * プローブ。バイト境界に揃った座標へタイル2種(KYA由来)+4方向の代表フレーム
 * (MAG由来)を1枚ずつ描き、静止する。
 * 期待値はtools/verify.mjs側でtools/mag_convert.mjsのbuildAssetSetFromMag()・
 * tools/kya_convert.mjsのbuildAssetSet()を直接呼んで計算し(=このCソースとは
 * 独立した経路)、VRAMの実値と比較する。
 */
#include "p98.h"
#include "kya_assets.h"
#include "mag_assets.h"

int main(void) {
    p98_init();
    p98_flip();
    p98_clear(0);

    p98_draw_sprite(&KYA_TILE_GROUND, 0, 0);
    p98_draw_sprite(&KYA_TILE_ACCENT, 16, 0);

    p98_draw_sprite(MAG_WALK_DOWN[0], 64, 64);
    p98_draw_sprite(MAG_WALK_LEFT[0], 160, 64);
    p98_draw_sprite(MAG_WALK_RIGHT[0], 256, 64);
    p98_draw_sprite(MAG_WALK_UP[0], 352, 64);

    for (;;) { }
    return 0;
}
