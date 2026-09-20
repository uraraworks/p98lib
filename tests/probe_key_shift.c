/* SHIFT記号変換(p98__shifted_symbol)の実測結果を固定するプローブ。
 * docs/verify-log.md「SHIFT記号変換の全数実測」参照。BIOS(INT18h)基準の
 * 実測で確定した値を、p98_key_getch()経由で確認する。
 *
 * host側(tools/verify.mjs)がSHIFTを押しっぱなしにして、以下の順で
 * scancodeをタップする:
 *   0x0C('^') 0x0D('\') 0x1A('@') 0x1B('[') 0x28(']') 0x33(単独では無変換)
 * 期待される文字(実測値): '`'(0x60) '|'(0x7C) '~'(0x7E) '{'(0x7B) '}'(0x7D) '_'(0x5F)
 * とくに最初の3つ('^'→'`'、'\'→'|'、'@'→'~')は当初の推測(JIS配列知識のみ)
 * から実測で訂正した箇所(design.md参照)。
 */
#include "p98.h"

#define FRAMES 300

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
    int ch1, ch2, ch3, ch4, ch5, ch6;

    p98_init();
    for (i = 0; i < FRAMES; i++) {
        p98_wait_vsync();
        p98_poll();
    }
    ch1 = p98_key_getch();
    ch2 = p98_key_getch();
    ch3 = p98_key_getch();
    ch4 = p98_key_getch();
    ch5 = p98_key_getch();
    ch6 = p98_key_getch();
    p98_quit();

    t_puts("SHIFTGETCH=");
    t_puthex2((unsigned char)ch1); t_putc(',');
    t_puthex2((unsigned char)ch2); t_putc(',');
    t_puthex2((unsigned char)ch3); t_putc(',');
    t_puthex2((unsigned char)ch4); t_putc(',');
    t_puthex2((unsigned char)ch5); t_putc(',');
    t_puthex2((unsigned char)ch6);
    t_putc('\r'); t_putc('\n');
    return 0;
}
