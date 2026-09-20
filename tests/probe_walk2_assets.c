/* samples/kya_assets.h (KYA変換ツールの出力)が、VRAM上に期待どおりの
 * ドット列で出ることを確認するためのプローブ。バイト境界に揃った座標へ
 * タイル2種+4方向の代表フレームを1枚ずつ描き、静止する。
 * 期待値はtools/verify.mjs側でtools/kya_convert.mjsのbuildAssetSet()を
 * 直接呼んで計算し(=このCソースとは独立した経路)、VRAMの実値と比較する。
 */
#include "p98.h"
#include "kya_assets.h"

int main(void) {
    p98_init();
    p98_flip();
    p98_clear(0);

    p98_draw_sprite(&KYA_TILE_GROUND, 0, 0);
    p98_draw_sprite(&KYA_TILE_ACCENT, 16, 0);

    p98_draw_sprite(KYA_WALK_DOWN[0], 64, 64);
    p98_draw_sprite(KYA_WALK_LEFT[0], 160, 64);
    p98_draw_sprite(KYA_WALK_RIGHT[0], 256, 64);
    p98_draw_sprite(KYA_WALK_UP[0], 352, 64);

    for (;;) { }
    return 0;
}
