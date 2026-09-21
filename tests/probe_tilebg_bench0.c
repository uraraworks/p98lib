/* tests/probe_tilebg_bench_cpu.c / probe_tilebg_bench_vram.c の
 * 「ベースライン(タイルを1枚も敷かない)」版。p98_init/p98_flip/p98_quitの
 * 固定オーバーヘッドだけを含む(probe_sprite_bench0.cと同じ考え方だが、
 * CPU経路・VRAM経路のどちらの本編も背景ページを使わずp98_init()だけで
 * 敷き詰めるため、こちらもp98_init_bgpage()ではなくp98_init()を使う)。
 * tools/verify.mjsで本編との実行時間の差分を取ることで、固定
 * オーバーヘッドを相殺した「タイル敷き詰めREPEAT回ぶんのコスト」を求める。
 */
#include "p98.h"

int main(void) {
    p98_init();
    p98_flip();
    p98_quit();
    return 0;
}
