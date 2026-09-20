/* tests/probe_sprite_bench.c のEGCバックエンド版。
 * 同じスプライト・同じ座標列・同じ本数(BENCH_N*BENCH_ITERS=2000)・同じ
 * ベースライン(probe_sprite_bench0.c)を使い、tools/verify.mjs で
 * ホスト側performance.now()の差分方式によりCPU経路とA/B比較する。
 * 条件をそろえるため、このファイルは probe_sprite_bench.c と
 * 「p98_set_sprite_backend(P98_SPRITE_EGC)を呼ぶ」以外は完全に同一。
 */
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

    p98_init();
    p98_flip();
    p98_clear(0);
    p98_set_sprite_backend(P98_SPRITE_EGC);

    for (iter = 0; iter < BENCH_ITERS; iter++) {
        for (i = 0; i < BENCH_N; i++) {
            int x = (iter * 7 + i * 37) % 620;
            int y = (iter * 3 + i * 11) % 380;
            p98_draw_sprite(&BENCH_SPR, x, y);
        }
    }

    p98_quit();
    return 0;
}
