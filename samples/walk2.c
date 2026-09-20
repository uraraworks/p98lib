/* p98lib デモ2: 実素材(ユーザー本人のオリジナル作品)を使った、
 * タイル背景+4方向歩行アニメのデモ。
 *
 * 【2026-09後半、素材をより良い原本(ORIGINAL/KYARA-03.MAG)へ差し替え】
 * 当初はC-GAMES/SAKA/MITEI2.KYA(キャラは多色だが背景タイルの描き込みが
 * 少ない)→ MITEI3.MAG(キャラは多色だがタイル領域はモノクロ、キャラも
 * SAKA/MITEI2.KYAとは別人)の順で試したが、`_local/legacy-a-games/
 * ORIGINAL/KYARA-03.MAG`(ユーザー本人のオリジナル作品と確認済み、
 * 2026-09-21。docs/assets.md参照)が、MITEI2.KYAと同じ配置でありながら
 * 背景タイルの描き込みが多く、キャラの色数も多い「色付き完全版」だと
 * 分かったため、こちらへ差し替えた。キャラ・タイルとも同じファイル
 * (KYARA-03.MAG)から切り出している(samples/mag_assets.h、
 * tools/mag_convert.mjsで自動生成。手編集しないこと)。
 *
 * KYA(p98lib独自形式)はユーザー本人しか変換できないため、公開して他の人にも
 * 使ってもらう変換ツールとしてはMAG(当時の標準フォーマット)を主役にした。
 * KYA対応は作者向けとして tools/kya_convert.mjs に残してある
 * (このデモでは使わない)。
 *
 *   - キャラ: 32x32、UP/DOWN 各2フレーム、LEFT 4フレーム、RIGHT はLEFTの
 *     水平反転(元データに右向きの絵は無いため、変換ツール側で生成)。
 *   - 地面: 16x16タイル2種(草・レンガ)。画面全体(40列x25段)へ敷き詰める。
 *
 * 描画方式: p98_init_bgpage() + 背景ページへタイルを1回だけ敷き詰め、
 * 以後は p98_draw_sprite_diff() でキャラだけを動かす(差分復帰。
 * docs/design.md「背景ページ+差分復帰」参照)。
 *
 * 操作: 方向キーで4方向に歩く(押した回数ぶんSTEP移動、押すたびに
 * アニメが1コマ進む。原作の1996年ゲーム(SAKA.ASM等)と同じくBIOSキーセンス
 * 方式で、なめらかな連続移動ではなく「歩数」単位の移動にしてある。
 * tools/verify.mjsでの検証をVRAMの実バイトで行うため、STEPは16(バイト境界の
 * 倍数)に揃えている)。ESCで終了する。
 */
#include "p98.h"
#include "mag_assets.h"

#define SCREEN_W 640
#define SCREEN_H 400
#define TILE 16
#define TILE_COLS (SCREEN_W / TILE)
#define TILE_ROWS (SCREEN_H / TILE)

#define CHAR_W 32
#define CHAR_H 32
#define STEP   16

#define SC_UP    0x3A
#define SC_RIGHT 0x3C
#define SC_DOWN  0x3D
#define SC_LEFT  0x3B
#define SC_ESC   0x00

typedef enum { DIR_DOWN = 0, DIR_UP = 1, DIR_LEFT = 2, DIR_RIGHT = 3 } dir_t;

static void apply_palette(void) {
    int i;
    for (i = 0; i < MAG_PALETTE_COUNT; i++) {
        p98_set_palette(i, MAG_PALETTE[i][0], MAG_PALETTE[i][1], MAG_PALETTE[i][2]);
    }
}

/* タイルを敷き詰める。(tx+ty)がACCENT_MODで割り切れるマスへレンガを置き、
 * それ以外は草にする(単純な市松/縞模様。データの意味は無い、見た目の変化用)。 */
#define ACCENT_MOD 5
static void draw_tiled_background(void) {
    int tx, ty;
    for (ty = 0; ty < TILE_ROWS; ty++) {
        for (tx = 0; tx < TILE_COLS; tx++) {
            const p98_sprite_t *tile = ((tx + ty) % ACCENT_MOD == 0) ? &MAG_TILE_ACCENT : &MAG_TILE_GROUND;
            p98_draw_sprite(tile, tx * TILE, ty * TILE);
        }
    }
}

/* SmallerCのswitch文はp98lib内で実績が無いため(既存コードは全てif/elseで
 * 統一している)、未検証のパターンを新規に持ち込まないよう安全側に倒してif/elseにした。 */
static const p98_sprite_t *current_sprite(dir_t dir, int step) {
    if (dir == DIR_UP)    return MAG_WALK_UP[step % 2];
    if (dir == DIR_DOWN)  return MAG_WALK_DOWN[step % 2];
    if (dir == DIR_LEFT)  return MAG_WALK_LEFT[step % 4];
    return MAG_WALK_RIGHT[step % 4];
}

int main(void) {
    int cx = 16 * TILE, cy = 12 * TILE; /* 画面中央寄りから開始(タイル境界に揃える) */
    dir_t dir = DIR_DOWN;
    int step = 0;
    int running = 1;

    p98_init_bgpage();
    apply_palette();

    p98_set_draw_target(P98_TARGET_BACKGROUND);
    draw_tiled_background();

    p98_set_draw_target(P98_TARGET_SCREEN);
    draw_tiled_background();

    p98_draw_sprite_diff(current_sprite(dir, step), cx, cy);

    while (running) {
        p98_wait_vsync();
        p98_poll();

        if (p98_key_down(SC_ESC)) running = 0;

        if (p98_key_pressed(SC_RIGHT) && cx + STEP <= SCREEN_W - CHAR_W) {
            cx += STEP; dir = DIR_RIGHT; step++;
        } else if (p98_key_pressed(SC_LEFT) && cx - STEP >= 0) {
            cx -= STEP; dir = DIR_LEFT; step++;
        } else if (p98_key_pressed(SC_DOWN) && cy + STEP <= SCREEN_H - CHAR_H) {
            cy += STEP; dir = DIR_DOWN; step++;
        } else if (p98_key_pressed(SC_UP) && cy - STEP >= 0) {
            cy -= STEP; dir = DIR_UP; step++;
        } else {
            continue; /* 移動が無ければ再描画しない(前回のまま) */
        }

        p98_draw_sprite_diff(current_sprite(dir, step), cx, cy);
    }

    p98_quit();
    return 0;
}
