/*
 * ★故障注入版(tests/p98_broken_egc_noplane.c)★
 * src/p98.c のコピーに対し、EGC有効化時のWM(0x4A4)レジスタだけを
 * わざと誤った値(0x1000=パターンを書くモード)にしてある。docs/verify-log.md
 * の陰性対照(EGC等価性検査がFAILを検出できることの確認)専用。通常の
 * ビルド・配布物には含めない。ファイル名は初期の実験(0x4A0=プレーン選択を
 * 壊す案。np2kaiでは効果が無く検出できなかった)の名残。
 *
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
 *  - unityビルド廃止(2026-09、docs/design.md参照)に伴い、p98__outb()だけは
 *    本物の別ファイル(src/p98_asm.asm)のNASMへ切り出し、tools/build.mjsが
 *    ライブラリのCオブジェクト・ユーザーのCオブジェクトとは別にアセンブルして
 *    リンク段で合流させる。残りのプリミティブは引き続きasm()ブロックのまま
 *    (全部を移す必要はなく、経路が動くことを示すのがスコープ)。
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

/* キーボード。2026-09、IRQ1直接受信方式からBIOS(INT 18h)方式へ切替
 * (docs/design.md参照)。理由: 生のIRQ1割り込みでは「押しっぱなしで
 * break→makeが繰り返し来る」キーリピートを根本的に止められないことが
 * 実測で分かったため。BIOSのキーセンス(AH=04h)は状態を読むだけで
 * リピートの影響を受けない。
 *
 * INT 18h AH=04h(キーセンス、実測で確定。docs/design.md/verify-log.md参照):
 *  - AL=グループ番号(0-15)を渡すと、AHにそのグループの8スキャンコード分の
 *    押下状態がビットで返る。group=scancode>>3, bit=scancode&7, 1=押している
 *  - 作者が1996年当時に書いたSAKA.ASM/SHUTING.ASMのソースに
 *    実例があり、そこから読み取った規則をnp2kai上のsendKey注入で独立に
 *    実測して確認した(全数ではなく2キーぶんのサンプル実測。他はSAKA.ASM/
 *    SHUTING.ASMの実例と整合)
 *  - この呼び出しはキーバッファを消費しない。文字入力は別途AH=00h/01hを使う
 */
#define P98_KBD_GROUPS        16

#define P98_SEG_PLANE_B     0xA800
#define P98_SEG_PLANE_R     0xB000
#define P98_SEG_PLANE_G     0xB800
#define P98_SEG_PLANE_I     0xE000

#define P98_BYTES_PER_LINE  80
#define P98_PLANE_BYTES     32000  /* 80 * 400 */
#define P98_SCREEN_W        640
#define P98_SCREEN_H        400

/* 表示ページ/描画ページはポート0xA4/0xA6の「バンク切り替え」方式(実測で確認済み。
 * docs/design.md「表示ページ/描画ページ(0xA4/0xA6)は…」節、docs/verify-log.md
 * probe_flip参照)。0xA8000等のセグメントは常に「今CPUから見えている面」を指し、
 * ソフト側でページ番号に応じたオフセットを足す必要は無い(むしろ足すと
 * プレーン間隔0x8000バイトと衝突して隣のプレーンを壊す。過去に試して誤りだと
 * 判明した仮説と同じ計算になるため、意図的に何も足さない)。 */

/* =====================================================================
 * 低レベル asm プリミティブ
 * ===================================================================== */

/* out port, val (1バイト)。実装は src/p98_asm.asm (別ファイルのNASM) にあり、
 * tools/build.mjs がライブラリのCオブジェクトとは別にアセンブル・リンクする
 * (unityビルド廃止。詳細はdocs/design.md)。 */
extern void p98__outb(unsigned port, unsigned char val);

/* dst=(dst&~mask)|(bits&mask) をES:[bx]への1回の読み書きで行う。実装は
 * src/p98_asm.asm。p98_draw_sprite() の内側ループ(1バイトごとの合成)用に
 * 追加した(p98__outbと同じ「別ファイルのNASM→ELFオブジェクト」経路)。 */
extern void p98__blend_bits(unsigned seg, unsigned off, unsigned char bits, unsigned char mask);

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

static const unsigned p98__plane_seg[4] = { P98_SEG_PLANE_B, P98_SEG_PLANE_R, P98_SEG_PLANE_G, P98_SEG_PLANE_I };

static unsigned char p98__inited = 0;
static p98_sprite_backend_t p98__sprite_backend = P98_SPRITE_CPU;
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
 * キーボード(BIOS INT 18h方式。IRQ1直接受信は廃止。docs/design.md参照)
 * ===================================================================== */

/* 128スキャンコード分の押下状態(1bit/code)。BIOSのキーセンス(AH=04h)を
 * p98_poll()で全16グループぶん読み、スナップショットとして持つ。 */
static unsigned char p98__key_cur_down[P98_KBD_GROUPS];    /* 直近のp98_poll()時点 */
static unsigned char p98__key_prev_down[P98_KBD_GROUPS];   /* 前回のp98_poll()時点 */
static unsigned char p98__key_pressed_snap[P98_KBD_GROUPS];/* cur & ~prev(このpollで新規に押されたビット) */

/* AH=04h キーセンス。AL=グループ番号(0-15)。戻り値(AH)の各ビットが
 * group*8+bit のスキャンコードの押下状態(1=押している)。実測で確認済み
 * (docs/verify-log.md参照。作者の1996年のソース(SAKA.ASM/SHUTING.ASM)の
 * 実例とも一致)。バッファは消費しない。 */
static unsigned char p98__kbd_sense(unsigned char group) {
    asm("mov al, [bp+8]");
    asm("mov ah, 0x04");
    asm("int 0x18");
    asm("movzx eax, ah");
}

/* AH=01h キーの有無を覗く(消費しない)。戻り値: 0=無し、それ以外=有り。 */
static unsigned p98__kbd_peek(void) {
    asm("mov ah, 0x01");
    asm("int 0x18");
    asm("mov al, bh");
    asm("movzx eax, al");
}

/* AH=00h キーを1件取り出す(無ければ待つ。呼ぶ前に必ずp98__kbd_peek()で
 * 確認すること)。AH=スキャンコード、AL=文字コードがAXにまとまって返るので、
 * 下位8bit(AL)だけを返す。 */
static unsigned p98__kbd_get(void) {
    asm("mov ah, 0x00");
    asm("int 0x18");
    asm("movzx eax, al");
}

/* BIOSのタイプアヘッドバッファを空にする。p98_quit()で必ず呼ぶ:
 * キーセンス(AH=04h)はバッファを消費しないため、押しっぱなしにしていた
 * キーのmake/breakがBIOSの16件バッファに残ったままp98_quit()を抜けると、
 * 戻った先のCOMMAND.COM(や他のプログラム)がそれを入力として読んでしまう
 * (実測で確認した副作用。docs/verify-log.md参照)。 */
static void p98__kbd_drain(void) {
    int guard = 0;
    while (p98__kbd_peek() != 0 && guard < 32) {
        p98__kbd_get();
        guard++;
    }
}

static void p98__key_reset_state(void) {
    int i;
    for (i = 0; i < P98_KBD_GROUPS; i++) {
        p98__key_cur_down[i] = 0;
        p98__key_prev_down[i] = 0;
        p98__key_pressed_snap[i] = 0;
    }
}

/* =====================================================================
 * 公開API
 * ===================================================================== */

int p98_init(void) {
    int i;
    unsigned long handler_addr;
    unsigned handler_seg, handler_off;

    if (p98__inited) return 0;

    p98__key_reset_state();

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

    /* キーボードはBIOS(INT18h)方式に切り替えたため、ベクタ横取り・PIC操作・
     * EOI処理は一切行わない(docs/design.md参照)。 */

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

    /* GRCG/EGC(ポート0x7C)を念のため無効化する。p98_draw_sprite()の
     * EGC経路は正常時は必ず自分で無効化して抜けるが、万一有効なまま
     * (異常系や将来の変更で)p98_quit()に来ても、以後の普通のVRAM書き込みが
     * 化けたままにならないようにする保険(docs/design.md参照)。 */
    p98__outb(0x7C, 0x00);

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

    /* BIOSのタイプアヘッドバッファを空にする。押しっぱなしのキーがあると
     * ここでバッファに溜まったままの可能性があり、空にせずに戻ると
     * COMMAND.COM(や次に動くプログラム)がそれを入力として読んでしまう
     * (実測で確認した副作用。docs/verify-log.md参照)。 */
    p98__kbd_drain();

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

void p98_clear(int color) {
    unsigned char b = (color & 1) ? 0xFF : 0x00;
    unsigned char r = (color & 2) ? 0xFF : 0x00;
    unsigned char g = (color & 4) ? 0xFF : 0x00;
    unsigned char i = (color & 8) ? 0xFF : 0x00;

    p98__outb(P98_PORT_GRCG_MODE, 0x80);
    p98__outb(P98_PORT_GRCG_TILE, b);
    p98__outb(P98_PORT_GRCG_TILE, r);
    p98__outb(P98_PORT_GRCG_TILE, g);
    p98__outb(P98_PORT_GRCG_TILE, i);
    p98__fillmem((unsigned)P98_SEG_PLANE_B, 0, P98_PLANE_BYTES, 0xFF);
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

    seg_b = (unsigned)P98_SEG_PLANE_B;
    seg_r = (unsigned)P98_SEG_PLANE_R;
    seg_g = (unsigned)P98_SEG_PLANE_G;
    seg_i = (unsigned)P98_SEG_PLANE_I;

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

/* =====================================================================
 * スプライト(CPU合成。docs/design.md参照)
 * ===================================================================== */

/* p98_draw_sprite() の横1ドットシフトの方式について(実測で確認・docs/design.md):
 * 「8通りの事前シフト済みビットマップを持つ」方式と比較検討し、今回は
 * 「描画のたびにCPUでシフトして合成する」方式を採用した。理由:
 *   - 事前シフト方式はデータサイズが約8倍(w方向に+1バイト×8パターン)になり、
 *     このスコープ(データ形式もここで初めて決める段階)ではまだ実データの
 *     点数・サイズ感が読めないため、まずメモリ効率の良い方式で組んで
 *     tools/verify.mjsの速度計測(本ドキュメント末尾)で「CPU合成のまま
 *     どこまで持つか」を数値化し、次回のEGC高速化の判断材料にする方針にした。
 *   - シフト自体はソース側の1バイトを読むたびに `>>` と `<<` を1回ずつ行うだけ
 *     (キャリー処理はソース1バイトにつき1回)で、事前シフト方式でも結局
 *     「どのシフト済みデータを選ぶか」の分岐が要ることを考えると、実装の
 *     複雑さの差ほど自明な有利さが無いと判断した。
 * どちらが実際に速いかの直接比較は今回は行っていない(未確認。次回EGC版との
 * 比較時に、必要ならこの判断も再検証する)。
 *
 * 内側ループ(1バイトごとのマスク合成)は p98__blend_bits (src/p98_asm.asm) へ
 * 切り出し、read-modify-write を1回のasm呼び出しで済ませている。
 */
/* =====================================================================
 * EGC(2026-09後半、実測で確認できた範囲のみ使用。docs/design.md参照)
 * =====================================================================
 *
 * WebNP2-wiki Graphics.mdのEGC節で「未検証」とされていたマスク(0x4A8)と
 * シフト(0x4AC)を実測した(使い捨てプローブ、コミットには残していない。
 * 詳細な実験内容と結果はdocs/verify-log.md参照)。分かったこと:
 *   - マスク(0x4A8)は、どのWM値・読み出しの有無の組み合わせでも
 *     ビット単位の合成として機能しなかった(全ビット上書き/無効化/
 *     ゼロ化のいずれかで、意図した部分マスクにはならなかった)。
 *   - シフト(0x4AC)は「ワード単位(mov ax,[..]/mov [..],ax)の書き込み」
 *     でのみ効果があり、値は「レジスタ値-1」ぶん左シフトする(0と1は
 *     どちらも「シフト無し」)。ただし1ワード書き込みの**奇数側アドレスの
 *     バイトは一切更新されず**、ワードをまたいだキャリー(繰り上がり)も
 *     発生しなかった。VRAM上に常駐させたデータからrep movswで読む方式も
 *     試したが、EGC有効中の読み出しが実際の格納値を返さなかった
 *     (常に0になった)。
 * これらの結果、**マスク+シフトを組み合わせた「任意の4プレーン別データを
 * シフトしながらマスク合成する」という当初期待した使い方は、この
 * np2kai実装では再現できなかった。**
 *
 * 一方で、wikiが既に確認していた「1回のCPU書き込みで4プレーンすべてに
 * 同じ値が書ける」(WM=0x0000、プレーン全選択)という基本機能は実測でも
 * 問題無く再現できた。そこで今回のEGC経路は、この確実に効く機能**だけ**を
 * 使い、シフト計算(ソフトウェア)の結果、
 *   - マスクが全ビット不透明(0xFF)で、
 *   - 4プレーンの合成結果が全プレーンで同一の値になる
 *     (単色スプライトの内部等、実際のゲームでもよくあるケース)
 * バイトに限り、4回の p98__blend_bits 呼び出し(1プレーンずつ)を
 * 1回のEGC書き込み(4プレーン同時)に置き換える。それ以外
 * (透明ドットを含む・プレーンごとに異なる色のバイト)は、確実性を優先して
 * 従来のCPU経路(p98__blend_bits)のままにする。
 */
static void p98__egc_outw(unsigned port, unsigned val) {
    /* wiki: 「いずれも16ビットのレジスタですが、下位・上位を1バイトずつ
     * 書いてもかまいません」との実測記載どおり、既存の(実績のある)
     * p98__outb を2回呼ぶだけにし、新規のワード出力asmは増やさない。 */
    p98__outb(port, (unsigned char)(val & 0xFF));
    p98__outb((unsigned)(port + 1), (unsigned char)(val >> 8));
}

/* 有効化順序は固定(wiki実測): 0x7Cのbit7を先に立て、0x6Aを2回書く。 */
static void p98__egc_enable(void) {
    p98__outb(0x7C, 0x80);
    p98__outb(0x6A, 0x07);
    p98__outb(0x6A, 0x05);
    p98__egc_outw(0x4A0, 0xFF00); /* 4プレーンすべてに書く(wiki実測) */
    p98__egc_outw(0x4A2, 0x0000); /* パターン源: CPU書き込み値そのまま */
    /* ★故障注入版(tests/p98_broken_egc_noplane.c)★ WM(0x4A4)をわざと
     * 「パターンを書く」モード(0x1000)にしてある。正しい設定
     * (0x0000=CPUが書いた値をそのまま書く)を落とすと、CPU側で計算した
     * ソフトウェアシフト済みのバイト値(bits[0])が無視され、意図しない値
     * (パターンレジスタ側の値)が書かれるはず。docs/verify-log.mdの
     * 陰性対照専用。(注記: 0x4A0(プレーン選択)を落とす/誤らせる形も
     * 試したが、np2kaiのこのEGC実装では0x4A0の値に関わらず常に4プレーン
     * ぶん書かれてしまい、故障として検出できなかったため、代わりに
     * WMを壊す形にした。) */
    p98__egc_outw(0x4A4, 0x1000);
    p98__egc_outw(0x4A8, 0xFFFF); /* マスク: このEGC経路では常に「全ビット
                                    * 不透明」のバイトにしか使わないため、
                                    * マスクレジスタ自体は無効(全通過)の
                                    * ままにする(実測でビット単位の効果が
                                    * 確認できなかったため、当てにしない)。 */
    p98__egc_outw(0x4AC, 0x0000); /* シフト無し(このEGC経路はソフトウェアで
                                    * シフト済みの1バイトを渡すだけなので、
                                    * EGC自身のシフト機能は使わない)。 */
    p98__egc_outw(0x4AE, 0x0007); /* wiki実測の既定値をそのまま使う */
}

/* 使い終わったら必ず戻す(wiki: 戻し忘れると以降の普通の書き込みが
 * EGCを通ったままになる)。 */
static void p98__egc_disable(void) {
    p98__outb(0x7C, 0x00);
}

static void p98__draw_sprite_impl(const p98_sprite_t *spr, int x, int y, p98_sprite_backend_t backend) {
    int srcStride;
    int shift;
    int startByte;
    int destByteCount;
    int row;
    int egcActive = 0;

    if (!spr || spr->w <= 0 || spr->h <= 0) return;
    if (y + spr->h <= 0 || y >= P98_SCREEN_H) return;

    srcStride = (spr->w + 7) >> 3;
    shift = ((x % 8) + 8) % 8;
    startByte = (x - shift) >> 3; /* 負になり得る(整数除算は shift済みなので割り切れる) */
    destByteCount = srcStride + (shift ? 1 : 0);

    for (row = 0; row < spr->h; row++) {
        int scrY = y + row;
        unsigned rowOff;
        int db;

        if (scrY < 0 || scrY >= P98_SCREEN_H) continue;
        rowOff = (unsigned)(scrY * P98_BYTES_PER_LINE);

        for (db = 0; db < destByteCount; db++) {
            int destByteIdx = startByte + db;
            int srcLo = db;      /* 現在の出力バイトの上位ビットへ寄与するソースバイト */
            int srcHi = db - 1;  /* 前のソースバイトの下位ビットが今回の出力バイトの下位側へ回り込む */
            unsigned char maskLo, maskHi, maskByte;
            unsigned char bits[4];
            unsigned off;
            int p;

            if (destByteIdx < 0 || destByteIdx >= P98_BYTES_PER_LINE) continue;

            maskLo = (srcLo >= 0 && srcLo < srcStride) ? spr->mask[row * srcStride + srcLo] : 0;
            maskHi = (srcHi >= 0 && srcHi < srcStride) ? spr->mask[row * srcStride + srcHi] : 0;
            maskByte = (unsigned char)((shift ? (maskLo >> shift) : maskLo) | (shift ? (unsigned char)(maskHi << (8 - shift)) : 0));
            if (maskByte == 0) continue; /* このバイトは全ドット透明 */

            off = rowOff + (unsigned)destByteIdx;
            for (p = 0; p < 4; p++) {
                const unsigned char *plane = spr->planes[p];
                unsigned char lo = (srcLo >= 0 && srcLo < srcStride) ? plane[row * srcStride + srcLo] : 0;
                unsigned char hi = (srcHi >= 0 && srcHi < srcStride) ? plane[row * srcStride + srcHi] : 0;
                bits[p] = (unsigned char)((shift ? (lo >> shift) : lo) | (shift ? (unsigned char)(hi << (8 - shift)) : 0));
            }

            if (backend == P98_SPRITE_EGC && maskByte == 0xFF
                && bits[0] == bits[1] && bits[1] == bits[2] && bits[2] == bits[3]) {
                if (!egcActive) { p98__egc_enable(); egcActive = 1; }
                p98__pokeb(p98__plane_seg[0], off, bits[0]);
            } else {
                if (egcActive) { p98__egc_disable(); egcActive = 0; }
                for (p = 0; p < 4; p++) {
                    p98__blend_bits(p98__plane_seg[p], off, bits[p], maskByte);
                }
            }
        }
    }

    if (egcActive) p98__egc_disable();
}

void p98_draw_sprite(const p98_sprite_t *spr, int x, int y) {
    p98__draw_sprite_impl(spr, x, y, p98__sprite_backend);
}

void p98_draw_sprite_ex(const p98_sprite_t *spr, int x, int y, p98_sprite_backend_t backend) {
    p98__draw_sprite_impl(spr, x, y, backend);
}

void p98_set_sprite_backend(p98_sprite_backend_t backend) {
    p98__sprite_backend = backend;
}

p98_sprite_backend_t p98_get_sprite_backend(void) {
    return p98__sprite_backend;
}

/* =====================================================================
 * キーボード公開API
 * ===================================================================== */

void p98_poll(void) {
    int g;
    for (g = 0; g < P98_KBD_GROUPS; g++) {
        unsigned char mask = p98__kbd_sense((unsigned char)g);
        p98__key_pressed_snap[g] = (unsigned char)(mask & (unsigned char)~p98__key_prev_down[g]);
        p98__key_prev_down[g] = mask;
        p98__key_cur_down[g] = mask;
    }
}

int p98_key_down(int scancode) {
    if (scancode < 0 || scancode > 127) return 0;
    return (p98__key_cur_down[scancode >> 3] >> (scancode & 7)) & 1;
}

int p98_key_pressed(int scancode) {
    if (scancode < 0 || scancode > 127) return 0;
    return (p98__key_pressed_snap[scancode >> 3] >> (scancode & 7)) & 1;
}

int p98_key_getch(void) {
    if (p98__kbd_peek() == 0) return 0;
    return (int)p98__kbd_get();
}
