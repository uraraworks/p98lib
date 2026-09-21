/* p98lib デモ2: 実素材(作者が制作したオリジナル作品)を使った、
 * タイル背景+4方向歩行アニメのデモ。
 *
 * 素材はORIGINAL/KYARA-03.MAG(docs/assets.md参照)から、キャラ・タイルとも
 * 同じファイルを切り出している(samples/mag_assets.h、
 * tools/mag_convert.mjsで自動生成。手編集しないこと)。
 *
 * KYA(p98lib独自形式)は作者しか変換できないため、公開して他の人にも
 * 使ってもらう変換ツールとしてはMAG(当時の標準フォーマット)を主役にした。
 * KYA対応は参考実装として tools/kya_convert.mjs に残してある
 * (このデモでは使わない)。
 *
 *   - キャラ: 32x32、UP/DOWN/LEFT/RIGHT 各2フレーム(原物の並びは
 *     上×2/下×2/左×2/右×2で、右向きも作者が最初から描いている。ただし
 *     変換ツール側は「左向きの水平反転が右向きの原物とバイト単位で完全一致する」
 *     ことを実測・機械検証した上で、反転で右向きを生成している。
 *     tools/mag_convert.mjs参照)。
 *   - 地面: 16x16タイル2種(草・レンガ)。画面全体(40列x25段)へ敷き詰める。
 *
 * 描画方式: p98_init_bgpage() + 背景ページへタイルを1回だけ敷き詰め、
 * 以後は p98_draw_sprite_diff() でキャラだけを動かす(差分復帰。
 * docs/design.md「背景ページ+差分復帰」参照)。
 *
 * 操作: 方向キーを押している間、歩き続ける(p98_key_down()。離すと止まる)。
 * 毎VSYNCで動かすと速すぎるため、4フレームに1回だけ移動判定する。
 * アニメのコマは「歩数カウンタ」ではなく現在位置(cx+cy)/STEPから決める
 * (何フレーム押していたかに依存させず、位置さえ決まればコマも一意に
 * 決まるようにして、tools/verify.mjsでの検証を時間依存にしないため)。
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
    if (dir == DIR_LEFT)  return MAG_WALK_LEFT[step % 2];
    return MAG_WALK_RIGHT[step % 2];
}

int main(void) {
    int cx = 16 * TILE, cy = 12 * TILE; /* 画面中央寄りから開始(タイル境界に揃える) */
    dir_t dir = DIR_DOWN;
    unsigned int frame = 0; /* 移動を4フレームに1回へ間引くためのカウンタ */
    int running = 1;

    p98_init_bgpage();
    apply_palette();

    p98_set_draw_target(P98_TARGET_BACKGROUND);
    draw_tiled_background();

    p98_set_draw_target(P98_TARGET_SCREEN);
    draw_tiled_background();

    /* 歩数カウンタ(step++)を廃止し、位置からコマを決める方式にした。
     * 押しっぱなし移動(p98_key_down)にすると「何歩進んだか」は何フレーム
     * 押していたかに依存してしまい、tools/verify.mjsでの検証が時間依存に
     * なって予測できなくなる。位置(cx+cy)は移動量から一意に決まるので、
     * それをそのままコマ番号の元にする。 */
    p98_draw_sprite_diff(current_sprite(dir, (cx + cy) / STEP), cx, cy);

    while (running) {
        p98_wait_vsync();
        p98_poll();
        frame++;

        if (p98_key_down(SC_ESC)) running = 0;

        /* 毎VSYNCで16px動くと速すぎるため、4フレームに1回だけ移動判定する
         * (ESCの終了判定は上で毎フレーム行う)。 */
        if (frame % 4 != 0) continue;

        if (p98_key_down(SC_RIGHT) && cx + STEP <= SCREEN_W - CHAR_W) {
            cx += STEP; dir = DIR_RIGHT;
        } else if (p98_key_down(SC_LEFT) && cx - STEP >= 0) {
            cx -= STEP; dir = DIR_LEFT;
        } else if (p98_key_down(SC_DOWN) && cy + STEP <= SCREEN_H - CHAR_H) {
            cy += STEP; dir = DIR_DOWN;
        } else if (p98_key_down(SC_UP) && cy - STEP >= 0) {
            cy -= STEP; dir = DIR_UP;
        } else {
            continue; /* 移動が無ければ再描画しない(前回のまま) */
        }

        p98_draw_sprite_diff(current_sprite(dir, (cx + cy) / STEP), cx, cy);
    }

    p98_quit();
    return 0;
}
