/*
 * ★故障注入版(tests/p98_broken_shiftswap.c)★
 * src/p98.c のコピーに対し、SHIFT記号変換のうち実測で訂正した3件
 * (0x0C/0x1Aの入れ替え、0x0Dの欠落)をわざと実測前の誤った状態に戻してある。
 * docs/verify-log.mdの陰性対照(検査がこの誤りを検出できるか)専用。
 * 通常のビルド・配布物には含めない。
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

/* キーボード(IRQ1)。実測(docs/design.md「キーボード割り込みの実測」参照):
 *  - IRQ1 = INT 09h (IRQ0=08h/IRQ2=0Ahと同じ「IRQn -> INT(8+n)」規則どおりだったが、
 *    design.md旧稿のINT33h説は誤りだったので推測では確定しなかった)
 *  - マスクは既定で外れている(ポート0x02 bit1)
 *  - スキャンコードはポート0x41から読める。bit7が離した(break)を示す
 *  - EOI(0x20をポート0x00へ)を送らないと2回目以降の割り込みが来なくなる
 *    (故障注入で確認: EOI無しだと最初の1回しか来ない)
 */
#define P98_PORT_KBD_DATA   0x41
#define P98_PORT_PIC0_MASK  0x02
#define P98_PORT_PIC0_CMD   0x00
#define P98_PIC_EOI         0x20
#define P98_IRQ1_MASKBIT    0x02

#define P98_SC_SHIFT        0x70
#define P98_SC_CAPS         0x71
#define P98_SC_CTRL         0x74
#define P98_KBUF_SIZE       32

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

/* out port, val (1バイト)。実装は src/p98_asm.asm (別ファイルのNASM) にあり、
 * tools/build.mjs がライブラリのCオブジェクトとは別にアセンブル・リンクする
 * (unityビルド廃止。詳細はdocs/design.md)。 */
extern void p98__outb(unsigned port, unsigned char val);

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
static unsigned p98__saved_int09_seg;
static unsigned p98__saved_int09_off;
static unsigned char p98__saved_pic0_mask;

/* Ctrl+C (INT 23h) を無害化するハンドラ。何もせず戻るだけ。
 * huge model の __interrupt 関数は全レジスタを push/pop し、iret で終わる
 * (retf ではない)ことをコンパイル結果で確認済み。 */
static void __interrupt p98__ctrlc_handler(void) {
}

/* =====================================================================
 * キーボード(IRQ1 = INT 09h。実測はsrc/p98.c冒頭の定数コメント参照)
 * ===================================================================== */

/* 128スキャンコード分のビット配列(1bit/code)。 */
static unsigned char p98__key_raw_down[16];   /* ハンドラが直接更新する「今押しているか」 */
static unsigned char p98__key_edge_down[16];  /* ハンドラが押下のたびに立てる。p98_pollが読んでクリア */
static unsigned char p98__key_cur_down[16];   /* p98_poll()時点のdownスナップショット */
static unsigned char p98__key_pressed_snap[16]; /* p98_poll()時点のpressedスナップショット */

static unsigned char p98__kbuf[P98_KBUF_SIZE];
static unsigned char p98__kbuf_head = 0; /* 次に書く位置 */
static unsigned char p98__kbuf_tail = 0; /* 次に読む位置 */

static unsigned char p98__mod_shift = 0; /* SHIFT: 押している間だけ */
static unsigned char p98__mod_ctrl = 0;  /* CTRL: 押している間だけ */
static unsigned char p98__mod_caps = 0;  /* CAPS: トグル(押した瞬間に反転) */

/* スキャンコード -> 未シフト文字(WebNP2-wiki Keyboard.md のAL列)。0=文字なし。
 * かな/GRPH配列、機能キー・カーソルキー等(元からAL=0x00)は0のまま。 */
static const unsigned char p98__chtab_base[128] = {
    /*0x00*/ 0x1B,0x31,0x32,0x33,0x34,0x35,0x36,0x37,
    /*0x08*/ 0x38,0x39,0x30,0x2D,0x5E,0x5C,0x08,0x09,
    /*0x10*/ 0x71,0x77,0x65,0x72,0x74,0x79,0x75,0x69,
    /*0x18*/ 0x6F,0x70,0x40,0x5B,0x0D,0x61,0x73,0x64,
    /*0x20*/ 0x66,0x67,0x68,0x6A,0x6B,0x6C,0x3B,0x3A,
    /*0x28*/ 0x5D,0x7A,0x78,0x63,0x76,0x62,0x6E,0x6D,
    /*0x30*/ 0x2C,0x2E,0x2F,0x00,0x20,0x00,0x00,0x00,
    /*0x38*/ 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
    /*0x40*/ 0x2D,0x2F,0x37,0x38,0x39,0x2A,0x34,0x35,
    /*0x48*/ 0x36,0x2B,0x31,0x32,0x33,0x3D,0x30,0x2C,
    /*0x50*/ 0x2E,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
    /*0x58*/ 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
    /*0x60*/ 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
    /*0x68*/ 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
    /*0x70*/ 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
    /*0x78*/ 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
};

static unsigned char p98__is_letter(unsigned char code) {
    if (code >= 0x10 && code <= 0x19) return 1; /* q..p */
    if (code >= 0x1D && code <= 0x25) return 1; /* a..l */
    if (code >= 0x29 && code <= 0x2F) return 1; /* z..m */
    return 0;
}

/* SHIFT時の記号の変化。全件、BIOS(INT18h)基準の実測で確認済み
 * (docs/verify-log.md「SHIFT記号変換の全数実測」参照。BIOSが返す文字コードを
 * 正解とし、ROM内の変換テーブルは読み出していない)。KP_*(0x40-0x50)と
 * ESC/BS/TAB/ENTER/SPACE/0x0Aはここに載っていない=SHIFTで変化しない
 * (実測で確認済み)ため、switchに無いものはp98__key_to_char側でbase(未シフト値)
 * をそのまま返す。
 *
 * 実測で当初の推測から訂正した箇所(2026-09):
 *  - 0x0C('^')と0x1A('@')は当初逆に書いていた。実測の正解は
 *    0x0C→'`'(0x60)、0x1A→'~'(0x7E)。
 *  - 0x0D('\')のSHIFTは当初未実装(caseが無かった)。実測の正解は'|'(0x7C)。
 */
static unsigned char p98__shifted_symbol(unsigned char code) {
    switch (code) {
        case 0x01: return 0x21; case 0x02: return 0x22; case 0x03: return 0x23;
        case 0x04: return 0x24; case 0x05: return 0x25; case 0x06: return 0x26;
        case 0x07: return 0x27; case 0x08: return 0x28; case 0x09: return 0x29;
        case 0x0B: return 0x3D; /* - -> = */
        /* ★故障注入: 実測前の推測に戻す(0x0C/0x1Aを入れ替え、0x0Dを欠落させる)。
         * docs/verify-log.mdの陰性対照専用。通常のビルド・配布物には含めない。 */
        case 0x0C: return 0x7E; /* (誤り)^ -> ~ */
        case 0x1A: return 0x60; /* (誤り)@ -> ` */
        case 0x1B: return 0x7B; /* [ -> { */
        case 0x28: return 0x7D; /* ] -> } */
        case 0x26: return 0x2B; /* ; -> + */
        case 0x27: return 0x2A; /* : -> * */
        case 0x30: return 0x3C; /* , -> < */
        case 0x31: return 0x3E; /* . -> > */
        case 0x32: return 0x3F; /* / -> ? */
        case 0x33: return 0x5F; /* 実測: SHIFT+0x33 -> '_' */
        default: return 0;
    }
}

static unsigned char p98__key_to_char(unsigned char code) {
    unsigned char base = p98__chtab_base[code];
    if (base == 0 && code != 0x33) return 0;

    if (p98__is_letter(code)) {
        unsigned char upper = (unsigned char)(p98__mod_shift ^ p98__mod_caps);
        if (p98__mod_ctrl) {
            unsigned char up = (unsigned char)(base - 0x20);
            return (unsigned char)(up & 0x1F);
        }
        if (upper) return (unsigned char)(base - 0x20);
        return base;
    }

    if (p98__mod_ctrl) return 0; /* 非文字キーのCTRL組み合わせは対象外 */

    if (p98__mod_shift) {
        unsigned char sh = p98__shifted_symbol(code);
        if (sh) return sh;
    }
    return base;
}

static void p98__kbuf_push(unsigned char ch) {
    unsigned char next = (unsigned char)((p98__kbuf_head + 1) % P98_KBUF_SIZE);
    if (next == p98__kbuf_tail) return; /* 満杯なら黙って捨てる */
    p98__kbuf[p98__kbuf_head] = ch;
    p98__kbuf_head = next;
}

/* 割り込みハンドラ本体。ここでの仕事は最小限(状態更新とリングバッファへの
 * 積み込みだけ)。ポート入出力はp98__inb/p98__outb(bp相対asm、DS非依存)を
 * 再利用し、それ以外はグローバル変数への普通のC代入だけで済ませる
 * (huge modelのグローバルアクセスはコンパイラが毎回DSを積み直すため安全)。 */
static void __interrupt p98__key_isr(void) {
    unsigned char sc = p98__inb(P98_PORT_KBD_DATA);
    unsigned char released = (unsigned char)(sc & 0x80);
    unsigned char code = (unsigned char)(sc & 0x7F);
    unsigned char idx = (unsigned char)(code >> 3);
    unsigned char bit = (unsigned char)(1 << (code & 7));

    /* オートリピート対策(実測で確認。docs/verify-log.md「キーリピートの実測」
     * 参照): 生のIRQ1割り込みは、キーを押しっぱなしにすると約500ms後から
     * 約50ms間隔で同じmakeコード(bit7=0)が繰り返し来る。BIOS(INT18h)側の
     * リピートと同じ周期で、生のスキャンコードレベルでも再現することを
     * 実測で確認した。何も対策しないと「1回押している間ずっとpressed()が
     * 何度も真になる」「CAPSが1回の長押しで何度もトグルする」というバグに
     * なるため、「直前から押されていなかった(was_down==0)」ときだけ
     * edge_down/CAPSトグルを更新する(リピートのmakeコードは無視する)。 */
    {
        unsigned char was_down = (unsigned char)(p98__key_raw_down[idx] & bit);
        if (released) {
            p98__key_raw_down[idx] &= (unsigned char)~bit;
        } else {
            p98__key_raw_down[idx] |= bit;
            if (!was_down) {
                p98__key_edge_down[idx] |= bit;
                if (code == P98_SC_CAPS) p98__mod_caps = (unsigned char)(p98__mod_caps ^ 1);
            }
        }
    }

    if (code == P98_SC_SHIFT) {
        p98__mod_shift = (unsigned char)(released ? 0 : 1);
    } else if (code == P98_SC_CTRL) {
        p98__mod_ctrl = (unsigned char)(released ? 0 : 1);
    }

    if (!released) {
        unsigned char ch = p98__key_to_char(code);
        if (ch) p98__kbuf_push(ch);
    }

    p98__outb(P98_PORT_PIC0_CMD, P98_PIC_EOI);
}

static void p98__key_reset_state(void) {
    int i;
    for (i = 0; i < 16; i++) {
        p98__key_raw_down[i] = 0;
        p98__key_edge_down[i] = 0;
        p98__key_cur_down[i] = 0;
        p98__key_pressed_snap[i] = 0;
    }
    p98__kbuf_head = 0;
    p98__kbuf_tail = 0;
    p98__mod_shift = 0;
    p98__mod_ctrl = 0;
    p98__mod_caps = 0;
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

    /* キーボード(IRQ1=INT09h、実測)を奪う。ベクタとPICマスクを退避してから
     * 差し替える。差し替えとマスク変更の間はcliで割り込みを止め、半端な
     * ハンドラ(旧ベクタのまま新マスク、等)が実行されないようにする。 */
    p98__key_reset_state();
    p98__saved_int09_off = p98__get_vector_off(0x09);
    p98__saved_int09_seg = p98__get_vector_seg(0x09);
    handler_addr = (unsigned long)(void*)p98__key_isr;
    handler_seg = (unsigned)(handler_addr >> 4);
    handler_off = (unsigned)(handler_addr & 0xFUL);
    asm("cli");
    p98__set_vector(0x09, handler_seg, handler_off);
    p98__saved_pic0_mask = p98__inb(P98_PORT_PIC0_MASK);
    p98__outb(P98_PORT_PIC0_MASK, (unsigned char)(p98__saved_pic0_mask & (unsigned char)~P98_IRQ1_MASKBIT));
    asm("sti");

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

    /* キーボードのベクタとPICマスクを元へ戻す。マスクを戻し損なうと
     * (あるいはベクタを戻さないままマスクだけ戻すと)以後の割り込みが
     * DOS/BIOS側のハンドラでない場所へ来てハングしうるため、cliで囲んで
     * 「マスクを戻す→ベクタを戻す」の順に不可分に行う。 */
    asm("cli");
    p98__outb(P98_PORT_PIC0_MASK, p98__saved_pic0_mask);
    p98__set_vector(0x09, p98__saved_int09_seg, p98__saved_int09_off);
    asm("sti");

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

/* =====================================================================
 * キーボード公開API
 * ===================================================================== */

void p98_poll(void) {
    int i;
    asm("cli");
    for (i = 0; i < 16; i++) {
        p98__key_pressed_snap[i] = p98__key_edge_down[i];
        p98__key_edge_down[i] = 0;
        p98__key_cur_down[i] = p98__key_raw_down[i];
    }
    asm("sti");
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
    int result = 0;
    asm("cli");
    if (p98__kbuf_head != p98__kbuf_tail) {
        result = p98__kbuf[p98__kbuf_tail];
        p98__kbuf_tail = (unsigned char)((p98__kbuf_tail + 1) % P98_KBUF_SIZE);
    }
    asm("sti");
    return result;
}
