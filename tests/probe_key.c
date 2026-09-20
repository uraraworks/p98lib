/* p98_poll()/p98_key_down()/p98_key_pressed()/p98_key_getch() の実測用プローブ。
 *
 * scancode 0x1D='a', 0x2D='b', 0x01='1' を使う。手順(外部のブラウザ自動操作が
 * sendKey()でscancodeを注入する。tools/verify.mjs参照):
 *   フェーズ1: 'a' を単発で押して離す(down/pressed/releaseの基本確認)
 *   フェーズ2: 'a' と 'b' を同時に押して離す(複数キー同時押し)
 *   フェーズ3: SHIFT+'a' → 'a' 単独 → CTRL+'a' の順で打ち、getchで
 *              'A'(0x41) 'a'(0x61) 0x01(CTRL+A) が順に取れるか確認
 *   フェーズ4: SHIFT+'1' で '!'(0x21) が取れるか確認(記号シフトの一例)
 *
 * 250フレーム(vsync、約4.4秒)の間、毎フレーム p98_poll() を呼び、'a'/'b' の
 * down/pressedを観測して集計する(既出フラグ・最終フレームでのdown・
 * pressedが立った回数・同時にdownだったか)。個々のフレームのログは
 * 画面に出さず集計値だけを出力する(このプローブでは集計で十分なため)。
 */
#include "p98.h"

#define SC_A 0x1D
#define SC_B 0x2D
#define FRAMES 250

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
    int ch1, ch2, ch3, ch4, ch5, ch6, ch7;

    p98_init();

    for (i = 0; i < FRAMES; i++) {
        p98_wait_vsync();
        p98_poll();
        if (p98_key_down(SC_A)) downA_seen = 1;
        if (p98_key_down(SC_B)) downB_seen = 1;
        if (p98_key_down(SC_A) && p98_key_down(SC_B)) both_down_seen = 1;
        if (p98_key_pressed(SC_A)) pressedA_count++;
        if (p98_key_pressed(SC_B)) pressedB_count++;
        if (i == FRAMES - 1) downA_end = p98_key_down(SC_A);
    }

    ch1 = p98_key_getch();
    ch2 = p98_key_getch();
    ch3 = p98_key_getch();
    ch4 = p98_key_getch();
    ch5 = p98_key_getch();
    ch6 = p98_key_getch();
    ch7 = p98_key_getch();

    p98_quit();

    t_puts("DOWNA_SEEN="); t_putc((char)('0' + downA_seen)); t_putc(' ');
    t_puts("DOWNA_END="); t_putc((char)('0' + downA_end)); t_putc(' ');
    t_puts("DOWNB_SEEN="); t_putc((char)('0' + downB_seen)); t_putc(' ');
    t_puts("BOTH_SEEN="); t_putc((char)('0' + both_down_seen)); t_putc(' ');
    t_puts("PRESSA="); t_puthex2((unsigned char)pressedA_count); t_putc(' ');
    t_puts("PRESSB="); t_puthex2((unsigned char)pressedB_count); t_putc(' ');
    t_puts("GETCH=");
    t_puthex2((unsigned char)ch1); t_putc(',');
    t_puthex2((unsigned char)ch2); t_putc(',');
    t_puthex2((unsigned char)ch3); t_putc(',');
    t_puthex2((unsigned char)ch4); t_putc(',');
    t_puthex2((unsigned char)ch5); t_putc(',');
    t_puthex2((unsigned char)ch6); t_putc(',');
    t_puthex2((unsigned char)ch7);
    t_putc('\r'); t_putc('\n');
    return 0;
}
