/*
 * ★故障注入版(samples/walk.c の壊れた変種)★
 * p98lib自体は正常な src/p98.c のまま使う。壊しているのは「デモ側の
 * 使い方」であり、ループの毎フレームで背景を描き直す処理(walk.cの
 * draw_background()呼び出し)を削除しただけ。
 *
 * 目的: 「背景の退避・復元は利用者の責任」というp98libの仕様上の注意点を
 * 実際に外すと何が起きるかを示し、tools/verify.mjsの「背景が壊れていない」
 * 検査がこの版ではFAILする(=検査自体が壊れた使い方を検出できる)ことを
 * 確認するための陰性対照。通常の配布物には含めない(docs/verify-log.md参照)。
 *
 * 壊れ方: 起動直後に一度だけ背景を描き、以後はキャラを新しい位置に
 * 「上書きするだけ」で、古い位置を背景で塗り直さない。ダブルバッファ
 * (p98_flip)は使い続けるため、表示ページと描画ページが交互に入れ替わる。
 * その結果、移動後しばらくすると両方のページに「新しい位置のキャラ」が
 * 反映される一方、"古い位置のキャラの絵"はどちらのページからも一度も
 * 消されないまま残り続ける(=元いた場所にキャラの残像が永久に残る)。
 * この残留は移動後どれだけ待っても消えない(次に消すコードが無いため)ので、
 * 検証側はタイミングを気にせず「移動から十分待ってから読む」だけでよい。
 */
#include "p98.h"

#define SCREEN_W 640
#define SCREEN_H 400

#define CHAR_W 8
#define CHAR_H 8
#define STEP   24

#define BAND_Y     16
#define BAND_H     CHAR_H
#define BAND_COLOR 10

#define SC_RIGHT 0x3C
#define SC_LEFT  0x3B
#define SC_ESC   0x00

static const unsigned char CHAR_SHAPE[CHAR_H] = {
    0x3C, 0x7E, 0xFF, 0xDB, 0xFF, 0x66, 0x3C, 0x18
};

static const p98_sprite_t SPR_WHITE = { CHAR_W, CHAR_H, { CHAR_SHAPE, CHAR_SHAPE, CHAR_SHAPE, CHAR_SHAPE }, CHAR_SHAPE };

static void draw_background(void) {
    p98_clear(0);
    p98_fill_rect(0, BAND_Y, SCREEN_W, BAND_H, BAND_COLOR);
    p98_fill_rect(300, 150, 120, 80, 5);
    p98_fill_rect(450, 250, 100, 70, 12);
}

int main(void) {
    int cx = 16, cy = BAND_Y;
    int running = 1;

    p98_init();

    /* 両ページへ同じ背景を用意してからキャラを描く(起動直後の見た目を
     * walk.cと揃えるための下準備。故障注入の本体はループ側)。 */
    draw_background();
    p98_flip();
    draw_background();
    p98_draw_sprite(&SPR_WHITE, cx, cy);
    p98_flip();

    while (running) {
        p98_wait_vsync();
        p98_poll();

        if (p98_key_pressed(SC_RIGHT) && cx + STEP <= SCREEN_W - CHAR_W) cx += STEP;
        if (p98_key_pressed(SC_LEFT)  && cx - STEP >= 0)                 cx -= STEP;
        if (p98_key_down(SC_ESC)) running = 0;

        /* 【故障注入】ここで draw_background() を呼んでいない。
         * walk.cとの唯一の意図的な差分。 */
        p98_draw_sprite(&SPR_WHITE, cx, cy);
        p98_flip();
    }

    p98_quit();
    return 0;
}
