/* p98_poll()/p98_key_down()/p98_key_pressed()/p98_key_getch() の実測用プローブ。
 * 2026-09、キーボードがBIOS(INT18h)センス方式へ切り替わったことに伴い書き直した。
 *
 * scancode 0x1D='a', 0x2D='b', 0x1E='s'(長押し専用) を使う。手順
 * (外部のブラウザ自動操作がsendKey()でscancodeを注入する。tools/verify.mjs参照):
 *   - 's' はテスト全体の間ずっと(冒頭近くから終盤近くまで)押しっぱなしにする。
 *     BIOSのキーリピート閾値(約500ms)を大きく超える長さ確実に押しっぱなしに
 *     なるようにするためで、フレーム境界との厳密な同期を避けるための設計
 *     (host側の実時間とゲスト側のフレーム数を正確に合わせなくても、
 *     「テスト全体を通して1回だけ押した」ことにできる)。
 *   - 'a' を単発で押して離す(down/pressed/releaseの基本確認)
 *   - 'a' と 'b' を同時に押して離す(複数キー同時押し)
 *   - SHIFT+'a' → 'a' 単独 → CTRL+'a' の順で打ち、getchで
 *     'A'(0x41) 'a'(0x61) 0x01(CTRL+A) が順に取れるか確認
 * pressedLong_count は 's' の押しっぱなしの間、1回しか真にならないはず
 * (これが今回の主目的。BIOSのキーセンスは状態を読むだけなので、
 * リピートの影響を受けないはず)。
 */
#include "p98.h"

#define SC_A 0x1D
#define SC_B 0x2D
#define SC_LONG 0x1E
#define FRAMES 280

static void t_putc(char c) {
    asm("mov dl, [bp+8]");
    asm("mov ah, 0x02");
    asm("int 0x21");
}
static void t_puts(const char *s) { while (*s) { t_putc(*s); s++; } }
static void t_puthex2(unsigned char v) {
    static const char *hex = "0123456789ABCDEF";
    t_putc(hex[(v >> 4) & 0xF]);
    t_putc(hex[v & 0xF]);
}

int main(void) {
    int i;
    int downA_seen = 0, downA_end = 0;
    int downB_seen = 0;
    int pressedA_count = 0, pressedB_count = 0;
    int both_down_seen = 0;
    int pressedLong_count = 0, downLong_seen = 0;
    int ch1, ch2, ch3, ch4;

    p98_init();

    for (i = 0; i < FRAMES; i++) {
        p98_wait_vsync();
        p98_poll();
        if (p98_key_down(SC_A)) downA_seen = 1;
        if (p98_key_down(SC_B)) downB_seen = 1;
        if (p98_key_down(SC_A) && p98_key_down(SC_B)) both_down_seen = 1;
        if (p98_key_pressed(SC_A)) pressedA_count++;
        if (p98_key_pressed(SC_B)) pressedB_count++;
        if (p98_key_down(SC_LONG)) downLong_seen = 1;
        if (p98_key_pressed(SC_LONG)) pressedLong_count++;
        if (i == FRAMES - 1) downA_end = p98_key_down(SC_A);
    }

    ch1 = p98_key_getch();
    ch2 = p98_key_getch();
    ch3 = p98_key_getch();
    ch4 = p98_key_getch();

    p98_quit();

    t_puts("DOWNA_SEEN="); t_putc((char)('0' + downA_seen)); t_putc(' ');
    t_puts("DOWNA_END="); t_putc((char)('0' + downA_end)); t_putc(' ');
    t_puts("DOWNB_SEEN="); t_putc((char)('0' + downB_seen)); t_putc(' ');
    t_puts("BOTH_SEEN="); t_putc((char)('0' + both_down_seen)); t_putc(' ');
    t_puts("PRESSA="); t_puthex2((unsigned char)pressedA_count); t_putc(' ');
    t_puts("PRESSB="); t_puthex2((unsigned char)pressedB_count); t_putc(' ');
    t_puts("DOWNLONG_SEEN="); t_putc((char)('0' + downLong_seen)); t_putc(' ');
    t_puts("PRESSLONG="); t_puthex2((unsigned char)pressedLong_count); t_putc(' ');
    t_puts("GETCH=");
    t_puthex2((unsigned char)ch1); t_putc(',');
    t_puthex2((unsigned char)ch2); t_putc(',');
    t_puthex2((unsigned char)ch3); t_putc(',');
    t_puthex2((unsigned char)ch4);
    t_putc('\r'); t_putc('\n');
    return 0;
}
