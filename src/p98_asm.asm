; p98_asm.asm - p98.c から抽出した最初の低レベルプリミティブ(out port,val)。
;
; unityビルド廃止(docs/design.md参照)にあたり、少なくとも1つのasm()プリミティブを
; 「本物の別ファイルのNASM→ELFオブジェクト化→リンク」経路へ移した。これは
; WorkbenchNP2 の toolchain/compile-core.mjs に追加された opts.extraLinkInputs
; (WorkbenchNP2 docs/smallerc-wasm.md参照)を使い、p98lib のCソース(ライブラリ側/
; ユーザー側)とは別にNASMでアセンブルし、リンク段だけで合流させる。
;
; 呼び出し規約(SmallerC huge model、実測で確認):
;   - 引数はスタック上、型によらず各4バイトスロットを占める。関数プロローグは
;     常に push ebp / movzx ebp, sp。呼び出し側は smlrc が生成する
;     "db 0x9A" + section .relot 経由の遠隔(far)呼び出しを自動で作るため、
;     呼ばれる側であるこのファイルは特別なことをする必要はなく、
;     プロローグ/エピローグをsmlrc生成コードに合わせるだけでよい。
;   - エピローグは "o32 leave" (0x66プレフィクス付きleave) + far return(retf)。
;     retfなのは huge model では全呼び出しがセグメントをまたぐ可能性がある
;     far callだから(WorkbenchNP2 toolchain/smallerc-src/v0100/cgx86.c の
;     コード生成を実際にコンパイルして確認した; 詳細はp98lib docs/design.md)。
;   - 引数オフセット([bp+8]=port(unsigned=2byteスロットだが型はword)、
;     [bp+12]=val(unsigned char))は、元のasm()ブロック時代にSmallerC自身が
;     出す "; loc x : (@N)" コメントを実測して決めた値をそのまま使っている。
;
; WorkbenchNP2側の実行検証(toolchain/verify-link-multi-object.mjs)で
; 「別ファイルのCとasmをhuge modelでリンクして実行し、末端の値を確認する」
; 経路自体は動作確認済み。p98lib側の検証は tools/verify.mjs (18項目)。

bits 16

section .text

    global _p98__outb
_p98__outb:
    push    ebp
    movzx   ebp, sp
    mov     dx, [bp+8]
    mov     al, [bp+12]
    out     dx, al
    o32 leave
    retf

; p98__blend_bits(seg, off, bits, mask) : void
;   dst = (dst & ~mask) | (bits & mask)   (1回のES:[bx]読み書きで実施)
;
; スプライト描画(p98_draw_sprite, src/p98.c)の速度が要る内側ループ用に追加した
; プリミティブ。引数の並び([bp+8]=seg, [bp+12]=off, [bp+16]=bits, [bp+20]=mask)は
; 既存の p98__fillmem と同じ4引数パターン(型によらず各4バイトスロット)を
; そのまま踏襲しており、新規に確認すべき事項は無い。VRAMセグメントをESへ直接
; ロードする点も既存プリミティブ(p98__peekb/pokeb)と同じで、DS正規化に依存しない。
;
; ビット選択は (old ^ ((old ^ bits) & mask)) という定石で計算する
; (mask=1の位置はbitsの値、mask=0の位置はoldの値になる)。
    global _p98__blend_bits
_p98__blend_bits:
    push    ebp
    movzx   ebp, sp
    mov     ax, [bp+8]      ; seg
    mov     es, ax
    mov     bx, [bp+12]     ; off
    mov     al, [es:bx]     ; old
    mov     cl, [bp+16]     ; bits
    mov     dl, [bp+20]     ; mask
    mov     ah, al
    xor     ah, cl          ; ah = old ^ bits
    and     ah, dl          ; ah = (old ^ bits) & mask
    xor     al, ah          ; al = old ^ ((old ^ bits) & mask)
    mov     [es:bx], al
    o32 leave
    retf

; p98__egc_row(seg, srcOff, dstOff, wordCount) : void
;   EGC有効中に呼ぶ想定。seg:srcOff から seg:dstOff へ wordCount ワードを
;   rep movsw で転送する(「転送元をワードで読む→書き込み先へワードで書く」の
;   対を1行ぶんまとめて行うプリミティブ、src/p98.c の p98_draw_sprite_vram 参照)。
;   読み・書きとも同じセグメント(同一プレーンのVRAM。転送元はオフセット
;   32000以降の余り、転送先は通常の画面オフセット)なので引数は1つでよい。
;   引数は他のプリミティブと同じ4バイトスロット([bp+8]=seg, [bp+12]=srcOff,
;   [bp+16]=dstOff, [bp+20]=wordCount)。
    global _p98__egc_row
_p98__egc_row:
    push    ebp
    movzx   ebp, sp
    push    ds
    mov     ax, [bp+8]      ; seg
    mov     ds, ax
    mov     es, ax
    mov     si, [bp+12]     ; srcOff
    mov     di, [bp+16]     ; dstOff
    mov     cx, [bp+20]     ; wordCount
    cld
    rep     movsw
    pop     ds
    o32 leave
    retf

; 2026-09、_p98__egc_row_masked(EGCマスクレジスタを毎ワード書き直す
; 1パス転送方式用)と_p98__copy_far_to_vram(Cのポインタをfar pointer化して
; VRAMへrep movsbするプリミティブ)はいずれも撤去した。
;
; _p98__egc_row_masked: 1パス方式(絵だけをVRAMへ置き、透明ドットの選別を
; EGCマスクレジスタ側で行う)自体を、2パス方式(現存のp98_vram_upload/
; p98_draw_sprite_vram)の約0.27倍(約3.7倍遅い)という実測(毎ワードの
; OUTが挟まるため rep movsw が使えなくなるのが主因)により不採用と
; 判断し、p98.c/include/p98.h側の呼び出し元ごと削除したため不要になった。
;
; _p98__copy_far_to_vram: Cの大きい静的配列のアドレスをhuge modelの
; far pointerへ変換してVRAMへ渡す処理が、ライブラリ内の無関係な静的
; データの増減で配置が変わると壊れる(無関係なメモリを読む)ことが
; 分かったため撤去した(docs/design.md「配置依存の不具合」節参照)。
; 呼び出し元(p98.cのVRAMアップロード全経路)はp98__pokeb()による
; 1バイトずつの直接書き込みへ置き換えてあり、Cのポインタをこのファイルへ
; far pointerとして渡す経路はこのライブラリから無くなっている。
;
; 経緯の詳細はdocs/design.md・docs/verify-log.md参照。
