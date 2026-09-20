/* p98_draw_sprite() の実測用プローブ。VRAMを直接読んで判定する(probe_fill.cと同じ方式)。
 *
 * 使うスプライトは3種類:
 *  - SPR_SHIFT: 8x1、全プレーン0xFF・マスク0xFFの1バイト幅の白ベタ。
 *    横1ドットシフト(バイト境界をまたぐ位置を含む)の確認用。
 *  - SPR_MAIN : 10x3、行ごとに色とマスクの穴が異なる。複数色合成とマスクの
 *    穴から背景が見えることの確認用。
 *  - SPR_CLIP : 8x4、全プレーン0xFF・マスク0xFFの白ベタ。
 *    画面四隅・上下左右の端でのクリップの確認用。
 *
 * 期待値の導出はすべて docs/verify-log.md に手計算で残す。
 */
#include "p98.h"

static const unsigned char SHIFT_BITS[1] = { 0xFF };
static const unsigned char SHIFT_MASK[1] = { 0xFF };
static const p98_sprite_t SPR_SHIFT = { 8, 1, { SHIFT_BITS, SHIFT_BITS, SHIFT_BITS, SHIFT_BITS }, SHIFT_MASK };

/* 10x3。1行=2バイト(w=10 -> ceil(10/8)=2)。
 * row0: 色3(青+赤)、col5(byte0のbit2)だけ透明(マスクの穴)
 * row1: 色12(緑+輝度)、全10ドット不透明
 * row2: 色15(白)、col0とcol9だけ不透明(それ以外は透明)
 */
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
    p98_flip(); /* probe_fill.cと同じ理由で表側(バンク切り替えの疑いに関係無い側)へ */
    p98_clear(0);

    /* 1) 横1ドットシフト(shift=0..7)。x=104+i (destバイト13から)、
     *    y=10+iで1行ずつ離して重ならないようにする。 */
    for (i = 0; i < 8; i++) {
        p98_draw_sprite(&SPR_SHIFT, 104 + i, 10 + i);
    }

    /* 2) 複数色+マスクの穴(バイト境界に揃ったx=200,y=50)。背景は0のままなので
     *    この時点では「穴が0を保つ」ことと「背景が0でない状態から穴越しに
     *    見える」ことを区別できない。区別は3)で行う。 */
    p98_draw_sprite(&SPR_MAIN, 200, 50);

    /* 3) 重ね描き: 先に色5(青+緑)の矩形を敷き、その上に穴あきスプライトを描く。
     *    穴(col5)では矩形の色がそのまま残るはず。 */
    p98_fill_rect(200, 60, 10, 3, 5);
    p98_draw_sprite(&SPR_MAIN, 200, 60);

    /* 4) 画面端・四隅のクリップ(8x4白ベタ) */
    p98_draw_sprite(&SPR_CLIP, -3, 200);   /* 左端(5px可視) */
    p98_draw_sprite(&SPR_CLIP, 635, 210);  /* 右端(5px可視、バイト境界外への漏れも検査) */
    p98_draw_sprite(&SPR_CLIP, 300, -2);   /* 上端(2行可視) */
    p98_draw_sprite(&SPR_CLIP, 310, 398);  /* 下端(2行可視) */
    p98_draw_sprite(&SPR_CLIP, -3, -2);    /* 左上コーナー */
    p98_draw_sprite(&SPR_CLIP, 635, -2);   /* 右上コーナー */
    p98_draw_sprite(&SPR_CLIP, -3, 398);   /* 左下コーナー */
    p98_draw_sprite(&SPR_CLIP, 635, 398);  /* 右下コーナー */

    for (;;) { }
    return 0;
}
