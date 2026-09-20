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
