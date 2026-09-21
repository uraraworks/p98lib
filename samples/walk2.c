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
 * 以後は差分復帰でキャラだけを動かす(docs/design.md「背景ページ+差分復帰」参照)。
 * 2026-09後半、EGC本転送(VRAM置き場常駐、include/p98.h「EGCによる本来の
 * スプライト転送」参照)へ載せ替えた:
 *   - タイル2種(16x16・全ドット不透明)は起動時に p98_vram_upload() で
 *     置き場へ常駐させ、以後は p98_draw_sprite_vram() で敷く。
 *   - キャラ(32x32・マスクあり、絵128B+反転マスク128B=256B)は置き場
 *     768B/プレーンに8コマ全部は収まらないため、スロットを1つだけ確保し、
 *     直前に置いたコマと違うときだけ p98_vram_reupload() で置き直す
 *     (draw_character()参照)。描画は p98_draw_sprite_vram_diff()。
 *   - p98_vram_upload()が失敗した場合(想定外の容量不足等)は、デモが
 *     黙って壊れないよう、その系統(タイル/キャラそれぞれ独立に)だけ
 *     従来のCPU経路(p98_draw_sprite()/p98_draw_sprite_diff())へ
 *     フォールバックする。見た目・操作とも従来と変わらない。
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
 * それ以外は草にする(単純な市松/縞模様。データの意味は無い、見た目の変化用)。
 * useTilesVramが真ならEGC本転送(VRAM置き場常駐)経路、偽なら従来のCPU
 * 経路(p98_draw_sprite())を使う。どちらでも敷く内容・座標は完全に同じ
 * (p98_vram_upload()の成否だけで経路を切り替え、見た目は変えない)。 */
#define ACCENT_MOD 5
static void draw_tiled_background(int useTilesVram, const p98_vram_sprite_t *vsGround, const p98_vram_sprite_t *vsAccent) {
    int tx, ty;
    for (ty = 0; ty < TILE_ROWS; ty++) {
        for (tx = 0; tx < TILE_COLS; tx++) {
            int accent = ((tx + ty) % ACCENT_MOD == 0);
            if (useTilesVram) {
                p98_draw_sprite_vram(accent ? vsAccent : vsGround, tx * TILE, ty * TILE);
            } else {
                const p98_sprite_t *tile = accent ? &MAG_TILE_ACCENT : &MAG_TILE_GROUND;
                p98_draw_sprite(tile, tx * TILE, ty * TILE);
            }
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

/* キャラを(x,y)へ描く。*charVramOkが真の間は、置き場のスロット1つ
 * (*vs)をコマ替えのたびに使い回す: 直前に置いたコマ(*loaded)と今回の
 * sprが違うときだけアップロードし直す(同じコマが続く間は何もしない)。
 * 初回(*loaded==0)はp98_vram_upload()、2回目以降はp98_vram_reupload()を
 * 使う(w/h/opaqueが同じであることが前提。歩行アニメの8コマは全て
 * 32x32・マスクありで揃っているため一致するはずだが、万一
 * 一致せず失敗した場合も*charVramOkを落として以後はCPU経路へ
 * フォールバックするので、デモが止まったり結果がおかしくなったりはしない)。 */
static void draw_character(const p98_sprite_t *spr, int x, int y,
                            int *charVramOk, p98_vram_sprite_t *vs, const p98_sprite_t **loaded) {
    if (*charVramOk && *loaded != spr) {
        int rc = (*loaded == 0) ? p98_vram_upload(spr, vs) : p98_vram_reupload(vs, spr);
        if (rc == 0) {
            *loaded = spr;
        } else {
            *charVramOk = 0; /* 以後は今回もこの先もCPU経路へフォールバック */
        }
    }

    if (*charVramOk) {
        p98_draw_sprite_vram_diff(vs, x, y);
    } else {
        p98_draw_sprite_diff(spr, x, y);
    }
}

int main(void) {
    int cx = 16 * TILE, cy = 12 * TILE; /* 画面中央寄りから開始(タイル境界に揃える) */
    dir_t dir = DIR_DOWN;
    unsigned int frame = 0; /* 移動を4フレームに1回へ間引くためのカウンタ */
    int running = 1;

    p98_vram_sprite_t vsTileGround, vsTileAccent, vsChar;
    int tilesVram;
    int charVramOk = 1; /* 初回のdraw_character()呼び出しでp98_vram_upload()を試す */
    const p98_sprite_t *charLoaded = 0; /* 現在vsCharに載っているコマ(未アップロードならNULL) */

    p98_init_bgpage();
    apply_palette();

    /* タイル2種(16x16・全ドット不透明)をEGC本転送用の置き場へ常駐させる。
     * 置き場は768B/プレーンしか無いが、タイルは全ドット不透明でマスクを
     * 使わないため32B(+余裕2B)ずつしか消費しない。p98_vram_upload()が
     * 0以外を返した場合(想定外の容量不足など)は、両方とも従来のCPU経路
     * へフォールバックする(片方だけVRAM・片方だけCPUという中途半端な
     * 状態にはしない)。 */
    tilesVram = (p98_vram_upload(&MAG_TILE_GROUND, &vsTileGround) == 0)
             && (p98_vram_upload(&MAG_TILE_ACCENT, &vsTileAccent) == 0);

    p98_set_draw_target(P98_TARGET_BACKGROUND);
    draw_tiled_background(tilesVram, &vsTileGround, &vsTileAccent);

    p98_set_draw_target(P98_TARGET_SCREEN);
    draw_tiled_background(tilesVram, &vsTileGround, &vsTileAccent);

    /* 歩数カウンタ(step++)を廃止し、位置からコマを決める方式にした。
     * 押しっぱなし移動(p98_key_down)にすると「何歩進んだか」は何フレーム
     * 押していたかに依存してしまい、tools/verify.mjsでの検証が時間依存に
     * なって予測できなくなる。位置(cx+cy)は移動量から一意に決まるので、
     * それをそのままコマ番号の元にする。 */
    draw_character(current_sprite(dir, (cx + cy) / STEP), cx, cy, &charVramOk, &vsChar, &charLoaded);

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

        draw_character(current_sprite(dir, (cx + cy) / STEP), cx, cy, &charVramOk, &vsChar, &charLoaded);
    }

    p98_quit();
    return 0;
}
