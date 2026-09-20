/* p98_init()/p98_quit() の状態退避・復元の実測用プローブ。
 * このファイルだけで使う検証専用ヘルパ(t_で始まる)はライブラリ本体には含めない。
 *
 * 標準出力に "BEF=grb AFT=grb" (パレット色番号1のG/R/B、各16進1桁) を書き出す。
 * BEF(p98_init前)とAFT(p98_quit後)が一致すれば、p98_set_palette()で変更した
 * パレットがp98_quit()で正しく元へ戻ったことになる。
 * INT 23h(Ctrl+C)ベクタの退避/復元は、このプログラムの実行前後で
 * 0000:008C を直接メモリダンプして比較する(tools/verify.mjs 側)。
 */
#include "p98.h"

static void t_putc(char c) {
    asm("mov dl, [bp+8]");
    asm("mov ah, 0x02");
    asm("int 0x21");
}

static unsigned char t_inb(unsigned port) {
    asm("mov dx, [bp+8]");
    asm("in al, dx");
    asm("movzx eax, al");
}

static void t_outb(unsigned port, unsigned char v) {
    asm("mov dx, [bp+8]");
    asm("mov al, [bp+12]");
    asm("out dx, al");
}

static void t_puthex1(unsigned char v) {
    unsigned char n = (unsigned char)(v & 0x0F);
    t_putc((char)(n < 10 ? ('0' + n) : ('A' + n - 10)));
}

static void dump_palette1(void) {
    t_outb(0xA8, 1);
    t_puthex1(t_inb(0xAA)); /* G */
    t_puthex1(t_inb(0xAC)); /* R */
    t_puthex1(t_inb(0xAE)); /* B */
}

static unsigned char t_peekb(unsigned seg, unsigned off) {
    asm("mov ax, [bp+8]");
    asm("mov es, ax");
    asm("mov bx, [bp+12]");
    asm("mov al, [es:bx]");
    asm("movzx eax, al");
}

static void dump_int23(void) {
    /* 0000:008C (=INT23hベクタ, offset→segmentの順で4バイト) を直接読む。 */
    t_puthex1(t_peekb(0, 0x8F)); t_puthex1(t_peekb(0, 0x8E));
    t_puthex1(t_peekb(0, 0x8D)); t_puthex1(t_peekb(0, 0x8C));
}

int main(void) {
    t_putc('B'); t_putc('E'); t_putc('F'); t_putc('=');
    dump_palette1();
    t_putc(' ');
    t_putc('V'); t_putc('0'); t_putc('=');
    dump_int23();
    t_putc(' ');

    p98_init();
    p98_set_palette(1, 3, 9, 12);

    /* p98_init()がINT23hベクタを本当に書き換えているか(=単なる無変化の
     * 「戻した」を「壊れていても通る」検査にしないため)、quit前にも読む。 */
    t_putc('V'); t_putc('1'); t_putc('=');
    dump_int23();
    t_putc(' ');

    p98_quit();

    t_putc('A'); t_putc('F'); t_putc('T'); t_putc('=');
    dump_palette1();
    t_putc(' ');
    t_putc('V'); t_putc('2'); t_putc('=');
    dump_int23();
    t_putc('\r');
    t_putc('\n');
    return 0;
}
