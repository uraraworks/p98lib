/* tests/probe_sprite_bench.c の「ベースライン(0本描画)」版。
 * p98_init/p98_flip/p98_clear/p98_quit の固定オーバーヘッドだけを含み、
 * p98_draw_sprite() は1回も呼ばない。tools/verify.mjs で本編との
 * 実行時間の差分を取ることで、固定オーバーヘッドを相殺した
 * 「スプライトN本ぶんの描画コスト」を求める。
 */
#include "p98.h"

int main(void) {
    p98_init();
    p98_flip();
    p98_clear(0);
    p98_quit();
    return 0;
}
