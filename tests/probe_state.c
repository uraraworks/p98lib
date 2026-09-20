/* p98_init()/p98_quit() の状態退避・復元の実測用プローブ。
 * このファイルだけで使う検証専用ヘルパ(t_で始まる)はライブラリ本体には含めない。
 *
 * 標準出力に "BEF=grb V0=.... V1=.... AFT=grb V2=...." を書き出す。
 * BEF(p98_init前)とAFT(p98_quit後)が一致すれば、p98_set_palette()で変更した
 * パレットがp98_quit()で正しく元へ戻ったことになる。
 * INT 23h(Ctrl+C)ベクタの退避/復元は、このプログラムの実行前後で
 * 0000:008C を直接メモリダンプして比較する(tools/verify.mjs 側)。
 *
 * 【2026-09後半、書き方を変更】以前は各フェーズ(init前/init中/quit後)で
 * その場ですぐ t_putc() して画面に出していたが、p98_init()がテキスト画面を
 * 消すようになった(docs/design.md「テキスト画面とカーソルの後始末」参照)ため、
 * init前に出した"BEF="等の文字がp98_init()内の画面クリアで消えてしまう
 * ようになった(実測で確認: "BEF=..."部分だけ空白に化けた)。これは
 * ライブラリのバグではなく、このプローブが「グラフィックモード遷移をまたいで
 * その場に文字を書く」という、テキスト画面を消す仕様とは相性の悪い書き方を
 * していたことが原因。値は全てその場でバッファへ控えておき、p98_quit()の
 * 後(テキスト画面がもう消されない段階)で1回にまとめて出力するように直した。
 * 「テキストが消えるから検査を緩める」のではなく、検査対象のプログラム自身の
 * 出力タイミングを直した。
 */
#include "p98.h"

static void t_putc(char c) {
    asm("mov dl, [bp+8]");
    asm("mov ah, 0x02");
    asm("int 0x21");
}

static void t_puts(const char *s) {
    while (*s) { t_putc(*s); s++; }
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

static char hex1(unsigned char v) {
    unsigned char n = (unsigned char)(v & 0x0F);
    return (char)(n < 10 ? ('0' + n) : ('A' + n - 10));
}

/* パレット色番号1のG/R/Bを16進1桁ずつ、buf[0..2]へ書く(buf[3]='\0'は
 * 呼び出し側で入れる)。 */
static void dump_palette1_to(char *buf) {
    t_outb(0xA8, 1);
    buf[0] = hex1(t_inb(0xAA)); /* G */
    buf[1] = hex1(t_inb(0xAC)); /* R */
    buf[2] = hex1(t_inb(0xAE)); /* B */
}

static unsigned char t_peekb(unsigned seg, unsigned off) {
    asm("mov ax, [bp+8]");
    asm("mov es, ax");
    asm("mov bx, [bp+12]");
    asm("mov al, [es:bx]");
    asm("movzx eax, al");
}

/* 0000:008C (=INT23hベクタ, offset→segmentの順で4バイト) を直接読み、
 * 16進4桁をbuf[0..3]へ書く。 */
static void dump_int23_to(char *buf) {
    buf[0] = hex1(t_peekb(0, 0x8F));
    buf[1] = hex1(t_peekb(0, 0x8E));
    buf[2] = hex1(t_peekb(0, 0x8D));
    buf[3] = hex1(t_peekb(0, 0x8C));
}

int main(void) {
    char bef[4], aft[4], v0[5], v1[5], v2[5];
    bef[3] = '\0';
    aft[3] = '\0';
    v0[4] = '\0';
    v1[4] = '\0';
    v2[4] = '\0';

    dump_palette1_to(bef);
    dump_int23_to(v0);

    p98_init();
    p98_set_palette(1, 3, 9, 12);

    /* p98_init()がINT23hベクタを本当に書き換えているか(=単なる無変化の
     * 「戻した」を「壊れていても通る」検査にしないため)、quit前にも読む。 */
    dump_int23_to(v1);

    p98_quit();

    dump_palette1_to(aft);
    dump_int23_to(v2);

    /* ここまでの値をp98_quit()の後で1回にまとめて出力する(上のコメント参照。
     * p98_init()中のテキスト画面クリアの影響を受けない)。 */
    t_puts("BEF="); t_puts(bef); t_putc(' ');
    t_puts("V0="); t_puts(v0); t_putc(' ');
    t_puts("V1="); t_puts(v1); t_putc(' ');
    t_puts("AFT="); t_puts(aft); t_putc(' ');
    t_puts("V2="); t_puts(v2);
    t_putc('\r');
    t_putc('\n');
    return 0;
}
