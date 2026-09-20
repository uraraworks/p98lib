/* ファンクションキー行(テキスト画面24行目)の表示/非表示の実測用プローブ。
 * p98_init()中(グラフィックモード)はしばらく静止し、外部(tools/verify.mjs)
 * からテキストVRAMの24行目を読んで「消えていること」を確認できるようにする。
 * p98_quit()の後も、COMMAND.COMへ戻る前にしばらく静止する(tests/probe_cursor.c
 * と同じ理由: COMMAND.COM自身が画面を触る前の、p98_quit()自身が残した状態を
 * 見るため)。
 */
#include "p98.h"

int main(void) {
    int i;
    p98_init();
    for (i = 0; i < 60; i++) {   /* 約1秒。init中に外部から読む時間を確保 */
        p98_wait_vsync();
    }
    p98_quit();
    for (i = 0; i < 120; i++) {  /* 約2秒。quit直後、COMMAND.COMへ戻る前に読む時間を確保 */
        p98_wait_vsync();
    }
    return 0;
}
