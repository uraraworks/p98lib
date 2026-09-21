/* tests/probe_sprite_bench.c のVRAM/EGC(置き場アップロード)経路版。
 * 同じスプライト・同じ座標列・同じ本数(BENCH_N*BENCH_ITERS=2000)・同じ
 * ベースライン(probe_sprite_bench0.c)を使い、tools/verify.mjs で
 * ホスト側performance.now()の差分方式によりCPU経路とA/B比較する。
 *
 * probe_sprite_bench.cのBENCH_SPRは16x16・幅16の倍数・全プレーン0xFF
 * (=全ドット不透明)なので、そのままp98_vram_upload()の対象にできる
 * (幅16の倍数でない別スプライトを用意する必要が無い。条件をそろえる
 * ため、寸法・ビットパターンともbench.cのBENCH_SPRと完全に同一にして
 * ある)。アップロードはループの外で1回だけ行い(同じコマを毎回
 * 描くだけなのでp98_vram_reupload()も不要)、以後はp98_draw_sprite_vram()
 * を呼ぶだけにする。 */
#include "p98.h"

static const unsigned char BENCH_PLANE[32] = {
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
    0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
};
static const p98_sprite_t BENCH_SPR = { 16, 16, { BENCH_PLANE, BENCH_PLANE, BENCH_PLANE, BENCH_PLANE }, BENCH_PLANE };

#define BENCH_N     40
#define BENCH_ITERS 50 /* 合計2000回描画 */

int main(void) {
    int iter, i;
    p98_vram_sprite_t vs;

    p98_init();
    p98_flip();
    p98_clear(0);

    if (p98_vram_upload(&BENCH_SPR, &vs) != 0) { p98_quit(); return 1; }

    for (iter = 0; iter < BENCH_ITERS; iter++) {
        for (i = 0; i < BENCH_N; i++) {
            int x = (iter * 7 + i * 37) % 620;
            int y = (iter * 3 + i * 11) % 380;
            p98_draw_sprite_vram(&vs, x, y);
        }
    }

    p98_quit();
    return 0;
}
