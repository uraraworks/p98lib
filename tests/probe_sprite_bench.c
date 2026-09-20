/* p98_draw_sprite() の速度の基準取り。
 *
 * 「1フレームあたり何本描けるか」を、実機のfpsとしてではなく、
 * このエミュレータ実装上の相対的な基準として測る(docs/design.md参照。
 * 実機の速度は約束しない・約束できない)。
 *
 * 計測方式についての実測結果(重要): 当初はゲスト側でBIOSのティックカウント
 * (INT1Ah、約18.2Hz)を読み、その差分で経過時間を測ろうとした。しかし
 * 実測すると、同じ処理でも「ホスト(ブラウザ)側のDate.now()で測った実時間」と
 * 「ゲストのBIOSティックカウントの差分」が全く連動しない(ある回では
 * ゲストの方が長く、別の回ではホストの方が長く出る)ことが分かった。
 * このpuppeteer(headless Chrome)上のWebNP2実行では、ゲストのBIOSタイマー
 * 割り込みの刻みが実時間と安定して対応していない可能性が高いと考えている
 * (原因の特定はスコープ外。未確認のまま明記する)。
 *
 * そこで計測方式を「ホスト側のDate.now()で、このプログラム(B:から実行して
 * プロンプトに戻るまで)の実行時間を測り、スプライトを描く本数が違う2つの
 * 版(このファイルと tests/probe_sprite_bench0.c)の差分を取る」方式に変えた
 * (tools/verify.mjs参照)。2つの版は「何本描くか」以外は同一の処理
 * (p98_init/p98_flip/p98_clear/p98_quit)なので、差分を取ればinit/quit等の
 * 固定オーバーヘッドが相殺され、「N本ぶんの描画にかかった時間」だけが残る。
 */
#include "p98.h"

/* 16x16、全プレーン0xFF・マスク0xFF(=全ドット不透明、最悪ケース)。 */
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
