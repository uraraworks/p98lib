/* p98_init_bgpage()/p98_set_draw_target()/p98_draw_sprite_diff() の実測用
 * プローブ。VRAMを直接読んで判定する(probe_sprite.cと同じ方式)。
 *
 * 背景ページに矩形2つ(バンド状+単発)を描き、画面ページへ同じ背景を
 * コピー(1回だけ、通常のp98_fill_rectで)してから、p98_draw_sprite_diff()
 * でキャラクタを3箇所へ順に描く。
 *   1箇所目(バンドの上)→2箇所目(単発矩形の上)→3箇所目(何もない場所)
 * と動かし、1箇所目・2箇所目とも「次に動いた後」に元の背景と一致する
 * ことを確認する(=黒背景だけでなく色付きの背景の上でも正しく復元
 * できることを確認する)。
 */
#include "p98.h"

#define CHAR_W 8
#define CHAR_H 8
static const unsigned char SPR_BITS[CHAR_H] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };
static const p98_sprite_t SPR_WHITE = { CHAR_W, CHAR_H, { SPR_BITS, SPR_BITS, SPR_BITS, SPR_BITS }, SPR_BITS };

static void draw_background(void) {
    p98_clear(0);
    p98_fill_rect(0, 16, 640, 8, 10);   /* 横バンド(赤+輝度) */
    p98_fill_rect(200, 100, 64, 32, 5); /* 単発矩形(青+緑) */
}

int main(void) {
    p98_init_bgpage();

    p98_set_draw_target(P98_TARGET_BACKGROUND);
    draw_background();

    p98_set_draw_target(P98_TARGET_SCREEN);
    draw_background(); /* 画面側にも最初は同じ背景を描いておく */

    p98_draw_sprite_diff(&SPR_WHITE, 16, 16);   /* 1箇所目(バンドの上) */
    p98_draw_sprite_diff(&SPR_WHITE, 208, 100); /* 2箇所目(単発矩形の上)。1箇所目が復元されるはず */
    p98_draw_sprite_diff(&SPR_WHITE, 304, 300); /* 3箇所目(何もない場所、バイト境界=304/8=38)。2箇所目が復元されるはず */

    for (;;) { }
    return 0;
}
