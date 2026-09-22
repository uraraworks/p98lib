/* tests/probe_bgcopy_bench_2x.c / probe_bgcopy_bench_copy.c の
 * 「ベースライン(タイルを1枚も敷かない・コピーもしない)」版。
 * p98_init_bgpage/p98_quitの固定オーバーヘッドだけを含む
 * (tests/probe_tilebg_bench0.cと同じ考え方だが、bgpageモードの
 * オーバーヘッド込みで揃えるためp98_init()ではなくp98_init_bgpage()を使う)。
 * tools/verify.mjsで本編との実行時間の差分を取ることで、固定
 * オーバーヘッドを相殺した「REPEAT回ぶんのコスト」を求める。
 */
#include "p98.h"

int main(void) {
    p98_init_bgpage();
    p98_quit();
    return 0;
}
