/* p98_flip() の実測用プローブ。
 *
 * 表示ページ/描画ページはポート0xA4/0xA6で切り替わるが、裏ページの物理アドレスが
 * 単純な「+一定オフセット」なのか、それとも読み書きそのものがバンク切り替えに
 * なっているのか(=表からは0xA8000等の同じアドレスとして見えるが、その時点で
 * 選ばれている側の実体を指す)は WebNP2-wiki に記載が無い。そこで、この
 * プローブは「外側からVRAMを直接2箇所読み比べる」のではなく、
 * ゲスト自身が同じアドレス(0xA8000等)を読み直して確かめる方式にした
 * (どちらの実装方式であっても、ゲストから見た読み出し結果は正しいはずなので)。
 *
 * 手順:
 *   1. clear(3)  -- 描画ページ(裏)を color=3(青+赤) で塗る
 *   2. flip()    -- 表示ページ=3が塗られた面になり、描画ページは元の表側(0)になる
 *   3. アドレス0xA8000(青)/0xB8000(緑)を読み、"R1=bb gg" として出力
 *      (この時点でCPUから0xA8000等を読むと、今の描画ページ=表だった側の中身が
 *      見えるはず。まだ何も描いていないので背景=0のはず)
 *   4. clear(12) -- 描画ページ(今は表だった側)を color=12(緑+輝度) で塗る
 *   5. 同じアドレスを読み直し、"R2=bb gg" として出力(color12どおり緑=FF,青=00のはず)
 *   6. flip()    -- 表示を12側に、描画をまた3側(裏)へ戻す
 *   7. 同じアドレスを読み、"R3=bb gg" として出力
 *      (描画ページがstep1で塗った青+赤の面に戻るので、青=FF,緑=00のはず。
 *       12を塗った内容で上書きされていない=ページが独立して内容を保持している
 *       ことの確認になる)
 */
#include "p98.h"

static void t_putc(char c) {
    asm("mov dl, [bp+8]");
    asm("mov ah, 0x02");
    asm("int 0x21");
}

static unsigned char t_peekb(unsigned seg, unsigned off) {
    asm("mov ax, [bp+8]");
    asm("mov es, ax");
    asm("mov bx, [bp+12]");
    asm("mov al, [es:bx]");
    asm("movzx eax, al");
}

static void t_puthex1(unsigned char v) {
    unsigned char n = (unsigned char)(v & 0x0F);
    t_putc((char)(n < 10 ? ('0' + n) : ('A' + n - 10)));
}

static void report(const char *label, unsigned char b, unsigned char g) {
    while (*label) { t_putc(*label); label++; }
    t_putc('=');
    t_puthex1(b);
    t_putc(',');
    t_puthex1(g);
    t_putc(' ');
}

int main(void) {
    unsigned char b1, g1, b2, g2, b3, g3;

    p98_init();

    p98_clear(3);
    p98_flip();
    b1 = t_peekb(0xA800, 0);
    g1 = t_peekb(0xB800, 0);

    p98_clear(12);
    b2 = t_peekb(0xA800, 0);
    g2 = t_peekb(0xB800, 0);

    p98_flip();
    b3 = t_peekb(0xA800, 0);
    g3 = t_peekb(0xB800, 0);

    p98_quit();

    report("R1", b1, g1);
    report("R2", b2, g2);
    report("R3", b3, g3);
    t_putc('\r');
    t_putc('\n');
    return 0;
}
