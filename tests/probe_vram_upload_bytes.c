/* p98_vram_upload() の一次検査プローブ。
 *
 * 目的: 「p98_vram_upload()がVRAMへ書いた内容が、元のp98_sprite_t(メイン
 * メモリ上の絵・マスクのバイト列)と一致するか」を、描画(EGC転送)を一切
 * 経由せずに直接確かめる。walk2(samples/walk2.c)がまさに使っている素材
 * ・呼び出し順・初期化手順(draw_tiled_background()を含む)をそのまま
 * 再現する(2026-09、「未コミットの変更を足しただけでwalk2の見た目が
 * 変わる」不具合の調査で、この一致検査自体が有効な検出手段だと分かった
 * ため、恒久的な検査として追加した)。
 *
 * walk2.cとの違い: main()の初期化(タイル2枚のアップロード→背景/画面への
 * タイル敷き詰め)までは完全に同じだが、その後はキャラクターの画面描画
 * (p98_draw_sprite_vram_diff等)を一切行わない。draw_character()の中身の
 * うち、キャラクターのp98_vram_upload()だけを取り出して呼び、あとは
 * 無限ループする。これにより「アップロード」だけを「(キャラクターの)
 * 描画」から切り離して検査できる。
 *
 * (2026-09の実測: タイルのアップロード自体は問題なく、"何か1回でも
 * p98_draw_sprite()/p98_draw_sprite_vram()を呼んだ後" に限って、非opaque
 * スプライト(キャラクター)のアップロードがVRAM置き場へ化けた内容を
 * 書き込むことがある。draw_tiled_background()を再現に含めているのは、
 * この前提条件を確実に踏むため)。
 *
 * VRAM置き場(P98_VRAM_STORE_OFF=32000起点)のオフセットはp98__vram_alloc()の
 * 単純なバンプ割り当て(need=bytes+2)から以下の通り決まる(いずれもp98.c
 * 側の実装に依存する値なので、tools/verify.mjs側のコメントにも明記する):
 *   1. MAG_TILE_GROUND (16x16、全ドット不透明): pixOff=0    (need=32+2=34)
 *   2. MAG_TILE_ACCENT (16x16、全ドット不透明): pixOff=34   (need=32+2=34)
 *   3. MAG_WALK_DOWN[0] (32x32、マスクに穴あり): pixOff=68  (need=128+2=130)
 *                                                  maskOff=198 (need=128+2=130)
 * (3.は不透明ではないため、p98_vram_upload()は反転マスク(~spr->mask)も
 * maskOffへ書く。pixOffには「絵 & マスク」を書く。詳細はsrc/p98.cの
 * p98__vram_upload_pixels()参照)。
 */
#include "p98.h"
#include "mag_assets.h"

#define TILE 16
#define TILE_COLS (640 / TILE)
#define TILE_ROWS (400 / TILE)
#define ACCENT_MOD 5

/* walk2.cのcurrent_sprite()と同じく、UP/DOWN/LEFT/RIGHTの全素材をリンカに
 * 含めさせるためだけのダミー参照(実行はしない)。walk2.c実機と同じだけの
 * 静的データ量をリンクさせておかないと、この検査が検出したい「配置に
 * 依存する不具合」を見逃す(2026-09調査時点の実測: データ量が少ないと
 * 再現しなかった)。 */
static const p98_sprite_t * volatile p98__dummy_ref;

/* walk2.cのapply_palette()そのまま。 */
static void apply_palette(void) {
    int i;
    for (i = 0; i < MAG_PALETTE_COUNT; i++) {
        p98_set_palette(i, MAG_PALETTE[i][0], MAG_PALETTE[i][1], MAG_PALETTE[i][2]);
    }
}

/* walk2.cのdraw_tiled_background()そのまま(比較対象を完全に揃えるため)。 */
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

int main(void) {
    p98_vram_sprite_t vsGround, vsAccent, vsChar;
    int tilesVram;

    p98__dummy_ref = MAG_WALK_UP[0];
    p98__dummy_ref = MAG_WALK_UP[1];
    p98__dummy_ref = MAG_WALK_DOWN[1];
    p98__dummy_ref = MAG_WALK_LEFT[0];
    p98__dummy_ref = MAG_WALK_LEFT[1];
    p98__dummy_ref = MAG_WALK_RIGHT[0];
    p98__dummy_ref = MAG_WALK_RIGHT[1];

    p98_init_bgpage();
    apply_palette();

    p98_vram_reset();
    tilesVram = (p98_vram_upload(&MAG_TILE_GROUND, &vsGround) == 0)
             && (p98_vram_upload(&MAG_TILE_ACCENT, &vsAccent) == 0);

    p98_set_draw_target(P98_TARGET_BACKGROUND);
    draw_tiled_background(tilesVram, &vsGround, &vsAccent);
    p98_set_draw_target(P98_TARGET_SCREEN);
    draw_tiled_background(tilesVram, &vsGround, &vsAccent);

    /* ここまではwalk2.cのmain()の初期化部分と完全に同じ(draw_character()の
     * 呼び出し直前まで)。以後は描画せず、p98_vram_upload()だけ呼ぶ
     * (walk2.cのdraw_character()の中身のうち、初回のp98_vram_upload()
     * 部分だけを取り出した形)。 */
    p98_vram_upload(MAG_WALK_DOWN[0], &vsChar);

    for (;;) { }
    return 0;
}
