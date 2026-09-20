/* tests/probe_sprite.c のEGCバックエンド版。
 *
 * 目的: probe_sprite.c と全く同じシナリオ・座標・スプライトデータを、
 * p98_draw_sprite_ex(..., P98_SPRITE_EGC) で描く。tools/verify.mjs は
 * probe_sprite.c(CPU経路)に使ったのと**全く同じ期待値**で、このプログラムの
 * VRAM出力を検証する(共有の検証関数を使う)。これにより
 *  - EGC経路がCPU経路と完全に同じ結果になること(等価性)
 *  - EGC経路自体もクリップ・マスク・複数色合成が正しいこと
 * を同時に確認する。差分は p98_draw_sprite の呼び出しをすべて
 * p98_draw_sprite_ex(..., P98_SPRITE_EGC) に変えただけ。
 */
#include "p98.h"

static const unsigned char SHIFT_BITS[1] = { 0xFF };
static const unsigned char SHIFT_MASK[1] = { 0xFF };
static const p98_sprite_t SPR_SHIFT = { 8, 1, { SHIFT_BITS, SHIFT_BITS, SHIFT_BITS, SHIFT_BITS }, SHIFT_MASK };

static const unsigned char SPR_B[6] = { 0xFB, 0xC0,  0x00, 0x00,  0x80, 0x40 };
static const unsigned char SPR_R[6] = { 0xFB, 0xC0,  0x00, 0x00,  0x80, 0x40 };
static const unsigned char SPR_G[6] = { 0x00, 0x00,  0xFF, 0xC0,  0x80, 0x40 };
static const unsigned char SPR_I[6] = { 0x00, 0x00,  0xFF, 0xC0,  0x80, 0x40 };
static const unsigned char SPR_MASK[6] = { 0xFB, 0xC0,  0xFF, 0xC0,  0x80, 0x40 };
static const p98_sprite_t SPR_MAIN = { 10, 3, { SPR_B, SPR_R, SPR_G, SPR_I }, SPR_MASK };

static const unsigned char CLIP_BITS[4] = { 0xFF, 0xFF, 0xFF, 0xFF };
static const unsigned char CLIP_MASK[4] = { 0xFF, 0xFF, 0xFF, 0xFF };
static const p98_sprite_t SPR_CLIP = { 8, 4, { CLIP_BITS, CLIP_BITS, CLIP_BITS, CLIP_BITS }, CLIP_MASK };

int main(void) {
    int i;
    p98_init();
    p98_flip();
    p98_clear(0);

    for (i = 0; i < 8; i++) {
        p98_draw_sprite_ex(&SPR_SHIFT, 104 + i, 10 + i, P98_SPRITE_EGC);
    }

    p98_draw_sprite_ex(&SPR_MAIN, 200, 50, P98_SPRITE_EGC);

    p98_fill_rect(200, 60, 10, 3, 5);
    p98_draw_sprite_ex(&SPR_MAIN, 200, 60, P98_SPRITE_EGC);

    p98_draw_sprite_ex(&SPR_CLIP, -3, 200, P98_SPRITE_EGC);
    p98_draw_sprite_ex(&SPR_CLIP, 635, 210, P98_SPRITE_EGC);
    p98_draw_sprite_ex(&SPR_CLIP, 300, -2, P98_SPRITE_EGC);
    p98_draw_sprite_ex(&SPR_CLIP, 310, 398, P98_SPRITE_EGC);
    p98_draw_sprite_ex(&SPR_CLIP, -3, -2, P98_SPRITE_EGC);
    p98_draw_sprite_ex(&SPR_CLIP, 635, -2, P98_SPRITE_EGC);
    p98_draw_sprite_ex(&SPR_CLIP, -3, 398, P98_SPRITE_EGC);
    p98_draw_sprite_ex(&SPR_CLIP, 635, 398, P98_SPRITE_EGC);

    for (;;) { }
    return 0;
}
