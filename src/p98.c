/*
 * p98.c - p98.h の実装。
 *
 * 設計方針(詳細は docs/design.md):
 *  - 速度が要る処理(ポートI/O・VRAMのrep stosb一括書き込み)は生の asm() ブロックで書く。
 *    SmallerC(huge model)の asm() は文字列を「そのまま」出力するだけで、Cの変数を
 *    自動でオペランドに束縛してくれない。そこで asm ブロックは
 *      (a) 関数引数を [bp+8]/[bp+12]/... で読む(スタック相対。huge modelでも
 *          スタックはSSベースの素直な実アドレスなので安全)
 *      (b) VRAMセグメントは引数からESへ直接ロードする(DS経由の巻き戻しが要らない)
 *    の2パターンだけに限定し、Cのグローバル変数をasmから直接触らない
 *    (huge modelはグローバル変数アクセスのたびにコンパイラがDSを積み直す
 *    独自の正規化をしており、asm側でそれを模倣するのは危険なので避けた)。
 *  - 引数のスタックオフセット(+8,+12,...)は当てずっぽうではなく、
 *    SmallerC自身がコンパイル結果に出す "; loc x : (@N)" コメントを実際に
 *    出力させて確認した値(huge modelでは各引数が型によらず4バイトスロットを
 *    占める)。tools/build.mjs のビルド検証、および docs/design.md 参照。
 */
#include "p98.h"

/* ---- ハードウェア定数(WebNP2-wiki Graphics.md / Timing-and-Interrupts.md) ---- */
#define P98_PORT_VSYNC      0x60
#define P98_PORT_GDC_GRAPH  0xA2
#define P98_PORT_MODE16     0x6A
#define P98_PORT_DISP_PAGE  0xA4
#define P98_PORT_DRAW_PAGE  0xA6
#define P98_PORT_GRCG_MODE  0x7C
#define P98_PORT_GRCG_TILE  0x7E
#define P98_PORT_PAL_INDEX  0xA8
#define P98_PORT_PAL_GREEN  0xAA
#define P98_PORT_PAL_RED    0xAC
#define P98_PORT_PAL_BLUE   0xAE

#define P98_SEG_PLANE_B     0xA800
#define P98_SEG_PLANE_R     0xB000
#define P98_SEG_PLANE_G     0xB800
#define P98_SEG_PLANE_I     0xE000

#define P98_BYTES_PER_LINE  80
#define P98_PLANE_BYTES     32000  /* 80 * 400 */
#define P98_SCREEN_W        640
#define P98_SCREEN_H        400

/* 表示ページ1(裏画面)は各プレーンのセグメント先頭から +0x0800 (=32KB) の位置にある。
 * WebNP2-wiki には明記が無いため、docs/verify-log.md の実測(表示ページ0側と1側の
 * 両方を読み比べて確認)で裏付けている。
 */
#define P98_PAGE_SEG_STRIDE 0x0800

/* =====================================================================
 * 低レベル asm プリミティブ
 * ===================================================================== */

/* out port, val (1バイト) */
static void p98__outb(unsigned port, unsigned char val) {
    asm("mov dx, [bp+8]");
    asm("mov al, [bp+12]");
    asm("out dx, al");
}

/* in port (1バイト、ゼロ拡張して返す) */
static unsigned char p98__inb(unsigned port) {
    asm("mov dx, [bp+8]");
    asm("in al, dx");
    asm("movzx eax, al");
}

/* seg:off から count バイトを val で埋める(rep stosb)。GRCG有効中に呼べば
 * 1回の呼び出しで4プレーン分を一気に書ける。 */
static void p98__fillmem(unsigned seg, unsigned off, unsigned count, unsigned char val) {
    asm("mov ax, [bp+8]");
    asm("mov es, ax");
    asm("mov di, [bp+12]");
    asm("mov cx, [bp+16]");
    asm("mov al, [bp+20]");
    asm("rep stosb");
}

/* seg:off の1バイトを読む */
static unsigned char p98__peekb(unsigned seg, unsigned off) {
    asm("mov ax, [bp+8]");
    asm("mov es, ax");
    asm("mov bx, [bp+12]");
    asm("mov al, [es:bx]");
    asm("movzx eax, al");
}

/* seg:off へ1バイト書く */
static void p98__pokeb(unsigned seg, unsigned off, unsigned char val) {
    asm("mov ax, [bp+8]");
    asm("mov es, ax");
    asm("mov bx, [bp+12]");
    asm("mov al, [bp+16]");
    asm("mov [es:bx], al");
}

/* DS:DX = seg:off を INT n (nは即値ではなく AH=0x25 / AL=vecno で渡す形) へ設定する。
 * vecno と off は AX の下位ワードとしてまとめて渡す都合上、呼び出し側で
 * AH=0x25 を組み立ててから呼ぶ(p98__set_vector参照)。 */
static void p98__set_vector(unsigned char vecno, unsigned seg, unsigned off) {
    asm("push ds");
    asm("mov dx, [bp+16]");   /* off */
    asm("mov ax, [bp+12]");   /* seg */
    asm("mov ds, ax");
    asm("mov al, [bp+8]");    /* vecno */
    asm("mov ah, 0x25");
    asm("int 0x21");
    asm("pop ds");
}

/* AH=0x35 AL=vecno の割り込みベクタ取得。戻り値の下位16bit=offset。 */
static unsigned p98__get_vector_off(unsigned char vecno) {
    asm("mov al, [bp+8]");
    asm("mov ah, 0x35");
    asm("int 0x21");
    asm("mov ax, bx");
    asm("movzx eax, ax");
}

/* 同上、セグメント側。 */
static unsigned p98__get_vector_seg(unsigned char vecno) {
    asm("mov al, [bp+8]");
    asm("mov ah, 0x35");
    asm("int 0x21");
    asm("mov ax, es");
    asm("movzx eax, ax");
}

/* AH=0x42 (グラフィック/テキスト画面モード切替)。CH=mode。 */
static void p98__int18_mode(unsigned char mode) {
    asm("mov ch, [bp+8]");
    asm("mov cl, 0");
    asm("mov ah, 0x42");
    asm("int 0x18");
}

/* =====================================================================
 * ライブラリ状態
 * ===================================================================== */

static unsigned char p98__inited = 0;
static unsigned char p98__draw_page = 1; /* 0=最初から表示している側, 1=裏 */
static unsigned long p98__frame_count = 0;

/* p98_init() で退避する状態 */
static unsigned char p98__saved_pal_g[16];
static unsigned char p98__saved_pal_r[16];
static unsigned char p98__saved_pal_b[16];
static unsigned p98__saved_int23_seg;
static unsigned p98__saved_int23_off;

/* Ctrl+C (INT 23h) を無害化するハンドラ。何もせず戻るだけ。
 * huge model の __interrupt 関数は全レジスタを push/pop し、iret で終わる
 * (retf ではない)ことをコンパイル結果で確認済み。 */
static void __interrupt p98__ctrlc_handler(void) {
}

/* =====================================================================
 * 公開API
 * ===================================================================== */

int p98_init(void) {
    int i;
    unsigned long handler_addr;
    unsigned handler_seg, handler_off;

    if (p98__inited) return 0;

    /* パレットを退避(WebNP2-wiki: 0xA8/0xAA/0xAC/0xAEは読み出せる、と実測記載あり) */
    for (i = 0; i < 16; i++) {
        p98__outb(P98_PORT_PAL_INDEX, (unsigned char)i);
        p98__saved_pal_g[i] = p98__inb(P98_PORT_PAL_GREEN);
        p98__saved_pal_r[i] = p98__inb(P98_PORT_PAL_RED);
        p98__saved_pal_b[i] = p98__inb(P98_PORT_PAL_BLUE);
    }

    /* INT 23h(Ctrl+C)を退避してから無害化ハンドラへ差し替える */
    p98__saved_int23_off = p98__get_vector_off(0x23);
    p98__saved_int23_seg = p98__get_vector_seg(0x23);

    handler_addr = (unsigned long)(void*)p98__ctrlc_handler;
    handler_seg = (unsigned)(handler_addr >> 4);
    handler_off = (unsigned)(handler_addr & 0xFUL);
    p98__set_vector(0x23, handler_seg, handler_off);

    /* 640x400 16色・グラフィック表示 */
    p98__int18_mode(0xC0);         /* 400ライン・表画面 */
    p98__outb(P98_PORT_MODE16, 1); /* 16色モード */

    p98__draw_page = 1;
    p98__outb(P98_PORT_DRAW_PAGE, 1);
    p98__outb(P98_PORT_DISP_PAGE, 0);
    p98__outb(P98_PORT_GDC_GRAPH, 0x0D); /* グラフィック表示開始 */

    p98__frame_count = 0;
    p98__inited = 1;
    return 0;
}

void p98_quit(void) {
    int i;
    if (!p98__inited) return;

    p98__outb(P98_PORT_GDC_GRAPH, 0x0C); /* グラフィック表示終了 */
    p98__outb(P98_PORT_DISP_PAGE, 0);
    p98__outb(P98_PORT_DRAW_PAGE, 0);
    p98__int18_mode(0xC0);               /* 400ライン・表画面へ戻す */

    for (i = 0; i < 16; i++) {
        p98__outb(P98_PORT_PAL_INDEX, (unsigned char)i);
        p98__outb(P98_PORT_PAL_GREEN, p98__saved_pal_g[i]);
        p98__outb(P98_PORT_PAL_RED, p98__saved_pal_r[i]);
        p98__outb(P98_PORT_PAL_BLUE, p98__saved_pal_b[i]);
    }

    p98__set_vector(0x23, p98__saved_int23_seg, p98__saved_int23_off);

    p98__inited = 0;
}

void p98_wait_vsync(void) {
    while (p98__inb(P98_PORT_VSYNC) & 0x20) { }
    while (!(p98__inb(P98_PORT_VSYNC) & 0x20)) { }
}

void p98_flip(void) {
    unsigned char new_display = p98__draw_page;
    unsigned char new_draw = (unsigned char)(p98__draw_page ^ 1);
    p98__outb(P98_PORT_DISP_PAGE, new_display);
    p98__outb(P98_PORT_DRAW_PAGE, new_draw);
    p98__draw_page = new_draw;
    p98__frame_count++;
}

unsigned long p98_frames(void) {
    return p98__frame_count;
}

static unsigned p98__page_stride(void) {
    return p98__draw_page ? P98_PAGE_SEG_STRIDE : 0;
}

void p98_clear(int color) {
    unsigned stride = p98__page_stride();
    unsigned char b = (color & 1) ? 0xFF : 0x00;
    unsigned char r = (color & 2) ? 0xFF : 0x00;
    unsigned char g = (color & 4) ? 0xFF : 0x00;
    unsigned char i = (color & 8) ? 0xFF : 0x00;

    p98__outb(P98_PORT_GRCG_MODE, 0x80);
    p98__outb(P98_PORT_GRCG_TILE, b);
    p98__outb(P98_PORT_GRCG_TILE, r);
    p98__outb(P98_PORT_GRCG_TILE, g);
    p98__outb(P98_PORT_GRCG_TILE, i);
    p98__fillmem((unsigned)(P98_SEG_PLANE_B + stride), 0, P98_PLANE_BYTES, 0xFF);
    p98__outb(P98_PORT_GRCG_MODE, 0x00);
}

/* 1バイト内の[bitLo, bitHi]の範囲(0=左端~7=右端の並びで、bit7が左端)を
 * colorのプレーンbitに応じて塗り、範囲外は既存の値を保つ。 */
static void p98__blend_byte(unsigned seg, unsigned off, int color, int planeBitIndex, unsigned char mask) {
    unsigned char old = p98__peekb(seg, off);
    unsigned char want = (color & (1 << planeBitIndex)) ? 0xFF : 0x00;
    unsigned char updated = (unsigned char)((old & ~mask) | (want & mask));
    p98__pokeb(seg, off, updated);
}

void p98_fill_rect(int x, int y, int w, int h, int color) {
    int x0, y0, x1, y1;
    int row;
    unsigned stride;
    unsigned seg_b, seg_r, seg_g, seg_i;

    if (w <= 0 || h <= 0) return;
    x0 = x;
    y0 = y;
    x1 = x + w;
    y1 = y + h;
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > P98_SCREEN_W) x1 = P98_SCREEN_W;
    if (y1 > P98_SCREEN_H) y1 = P98_SCREEN_H;
    if (x0 >= x1 || y0 >= y1) return; /* 完全に画面外 */

    stride = p98__page_stride();
    seg_b = (unsigned)(P98_SEG_PLANE_B + stride);
    seg_r = (unsigned)(P98_SEG_PLANE_R + stride);
    seg_g = (unsigned)(P98_SEG_PLANE_G + stride);
    seg_i = (unsigned)(P98_SEG_PLANE_I + stride);

    for (row = y0; row < y1; row++) {
        int leftByte = x0 >> 3;
        int rightByte = (x1 - 1) >> 3;
        unsigned rowOff = (unsigned)(row * P98_BYTES_PER_LINE);

        if (leftByte == rightByte) {
            unsigned char mask = (unsigned char)(0xFF >> (x0 & 7));
            mask &= (unsigned char)(0xFF << (7 - ((x1 - 1) & 7)));
            unsigned off = rowOff + (unsigned)leftByte;
            p98__blend_byte(seg_b, off, color, 0, mask);
            p98__blend_byte(seg_r, off, color, 1, mask);
            p98__blend_byte(seg_g, off, color, 2, mask);
            p98__blend_byte(seg_i, off, color, 3, mask);
        } else {
            unsigned char leftMask = (unsigned char)(0xFF >> (x0 & 7));
            unsigned char rightMask = (unsigned char)(0xFF << (7 - ((x1 - 1) & 7)));
            int midCount = rightByte - leftByte - 1;
            unsigned leftOff = rowOff + (unsigned)leftByte;
            unsigned rightOff = rowOff + (unsigned)rightByte;

            p98__blend_byte(seg_b, leftOff, color, 0, leftMask);
            p98__blend_byte(seg_r, leftOff, color, 1, leftMask);
            p98__blend_byte(seg_g, leftOff, color, 2, leftMask);
            p98__blend_byte(seg_i, leftOff, color, 3, leftMask);

            if (midCount > 0) {
                unsigned char b = (color & 1) ? 0xFF : 0x00;
                unsigned char r = (color & 2) ? 0xFF : 0x00;
                unsigned char g = (color & 4) ? 0xFF : 0x00;
                unsigned char i = (color & 8) ? 0xFF : 0x00;
                unsigned midOff = rowOff + (unsigned)(leftByte + 1);

                p98__outb(P98_PORT_GRCG_MODE, 0x80);
                p98__outb(P98_PORT_GRCG_TILE, b);
                p98__outb(P98_PORT_GRCG_TILE, r);
                p98__outb(P98_PORT_GRCG_TILE, g);
                p98__outb(P98_PORT_GRCG_TILE, i);
                p98__fillmem(seg_b, midOff, (unsigned)midCount, 0xFF);
                p98__outb(P98_PORT_GRCG_MODE, 0x00);
            }

            p98__blend_byte(seg_b, rightOff, color, 0, rightMask);
            p98__blend_byte(seg_r, rightOff, color, 1, rightMask);
            p98__blend_byte(seg_g, rightOff, color, 2, rightMask);
            p98__blend_byte(seg_i, rightOff, color, 3, rightMask);
        }
    }
}

void p98_set_palette(int index, int r, int g, int b) {
    p98__outb(P98_PORT_PAL_INDEX, (unsigned char)(index & 0x0F));
    p98__outb(P98_PORT_PAL_GREEN, (unsigned char)(g & 0x0F));
    p98__outb(P98_PORT_PAL_RED, (unsigned char)(r & 0x0F));
    p98__outb(P98_PORT_PAL_BLUE, (unsigned char)(b & 0x0F));
}
