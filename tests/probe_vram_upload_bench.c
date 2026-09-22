/* p98_vram_reupload()(アップロードそのもの)だけのコストを測るベンチ。
 *
 * 経緯: p98__copy_far_to_vram()を撤去し、不透明・非opaqueともp98__pokeb()
 * による1バイトずつの直接書き込みへ寄せた(docs/design.md「配置依存の
 * 不具合」節参照)。これによりアップロード自体は(まとめてrep movsbしていた
 * 頃より)遅くなっているはずで、walk2(samples/walk2.c)はコマが変わる
 * たびにp98_vram_reupload()で置き直しているため、そのコストを知っておく
 * 必要がある。
 *
 * 32x32・マスクに穴がある(非opaque)スプライトを対象にする。非opaqueは
 * 「絵&マスクをpokeb」に加えて「反転マスクをpokeb」も行う分だけ、
 * opaqueより1回あたりのアップロードが重い(p98__vram_upload_pixels()/
 * p98__vram_store_inverted_mask()参照)。walk2のキャラクター素材
 * (MAG_WALK_DOWN等、32x32でマスクに穴あり)と条件をそろえてある。
 *
 * tools/verify.mjsは、既に計測済みのbaseMs(tests/probe_sprite_bench0.c、
 * p98_init/p98_flip/p98_clear/p98_quitの固定オーバーヘッドのみ)との差分を
 * 取ることで、固定オーバーヘッドを相殺した「アップロードN回ぶんのコスト」
 * を求める(BENCH_N*BENCH_ITERSの合計アップロード回数で割って1回あたりに
 * する)。ベースラインの取り方・計測方法(ホスト側performance.now()の差分、
 * 3回計測して中央値)はprobe_sprite_bench*.cと完全に同一にしてある。
 *
 * 描画(p98_draw_sprite_vram等)は一切呼ばない。アップロードだけを繰り返す。
 * 最初の1回はp98_vram_upload()で置き場を確保し、以後はp98_vram_reupload()
 * (walk2が毎フレーム行っているのと同じ経路)で同じ内容を置き直し続ける。
 */
#include "p98.h"

#define BW 32
#define BH 32
#define ROWBYTES (BW / 8)

static unsigned char g_plane0[ROWBYTES * BH];
static unsigned char g_plane1[ROWBYTES * BH];
static unsigned char g_plane2[ROWBYTES * BH];
static unsigned char g_plane3[ROWBYTES * BH];
static unsigned char g_mask[ROWBYTES * BH];

static p98_sprite_t g_spr;

#define BENCH_N     20
#define BENCH_ITERS 5 /* 合計100回アップロード */

int main(void) {
    int iter, i, row;
    p98_vram_sprite_t vs;

    p98_init();
    p98_flip();
    p98_clear(0);

    for (i = 0; i < ROWBYTES * BH; i++) {
        g_plane0[i] = 0xFF;
        g_plane1[i] = 0x0F;
        g_plane2[i] = 0xF0;
        g_plane3[i] = 0xAA;
    }
    /* 各行のマスクを0x7E,0xFF,0xFF,0x7E(左右端が透明)にし、probe_sprite_vram.c
     * のSPR_Bと同じ「マスクに穴がある」条件をそろえる。 */
    for (row = 0; row < BH; row++) {
        g_mask[row * ROWBYTES + 0] = 0x7E;
        for (i = 1; i < ROWBYTES - 1; i++) g_mask[row * ROWBYTES + i] = 0xFF;
        g_mask[row * ROWBYTES + (ROWBYTES - 1)] = 0x7E;
    }

    g_spr.w = BW;
    g_spr.h = BH;
    g_spr.planes[0] = g_plane0;
    g_spr.planes[1] = g_plane1;
    g_spr.planes[2] = g_plane2;
    g_spr.planes[3] = g_plane3;
    g_spr.mask = g_mask;

    if (p98_vram_upload(&g_spr, &vs) != 0) { p98_quit(); return 1; }

    for (iter = 0; iter < BENCH_ITERS; iter++) {
        for (i = 0; i < BENCH_N; i++) {
            p98_vram_reupload(&vs, &g_spr);
        }
    }

    p98_quit();
    return 0;
}
