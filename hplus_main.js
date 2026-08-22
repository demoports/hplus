// hplus port — main (0xe1ba..0xe466): startup, data helpers, the part sequencer.
// External: fn_29a, fn_2c2c8; engine: fn_28f4a (engine init), fn_2c1e6 (print), fn_2cd46 (restore video),
// fn_2c6xx (set video mode, via fn_231ca of part F); player: fn_d5b (sound init), fn_f50 (start), fn_f80 (stop),
// fn_c51/fn_c7a (keyboard IRQ install/remove — no-ops in JS); parts: fn_15922/fn_15c18 (A), fn_1816a/fn_182fc (B),
// fn_1b5eb/fn_1b8c0 (C), fn_1d39f/fn_1d566 (D), fn_1fde5/fn_1ffe5 (E), fn_231ca/fn_236ef (F).
(function (root) {
  'use strict';
  const HP = root.HP;
  const { rd8, rd16, rd32, rds32, wr8, wr16, wr32 } = HP;

  // fn_e1ba(edi): decrypt 0xbc08 bytes: b = rol(b,1) + 0x85
  HP.fn_e1ba = function (edi) {
    const M = HP.M;
    for (let n = 0xbc08; n > 0; n--, edi++) { const b = M[edi]; M[edi] = ((((b << 1) | (b >> 7)) & 0xff) + 0x85) & 0xff; }
  };
  // fn_e2bc: second stage (ror 5) on the same block, applied after the precalcs (before the player starts)
  HP.fn_e2bc = function () {
    const M = HP.M;
    for (let n = 0xbc08, edi = 0x1090; n > 0; n--, edi++) { const b = M[edi]; M[edi] = ((b >> 5) | (b << 3)) & 0xff; }
  };
  // fn_e1cc: build the 64x64 "K" table at [0xe1b6] (0x130a bytes) from the 0x30a bytes at 0xd3a2
  HP.fn_e1cc = function () {
    const M = HP.M;
    let eax = HP.fn_29a(0x130a); wr32(0xe1b6, eax);
    let esi = 0xd3a2, edi = eax;
    HP.copy(edi, esi, 0x30a); edi += 0x30a; esi += 0x30a;
    wr16(edi - 0x306, 0x40); wr16(edi - 0x304, 0x40);
    // 32 rows: each expands 31 source bytes into 62 (value, avg with next), + wrap pair; row stride 0x80
    for (let edx = 0x20; edx > 0; edx--) {
      for (let ecx = 0x1f; ecx > 0; ecx--) {
        const a = M[esi]; M[edi] = a;
        M[edi + 1] = (a + M[esi + 1]) >> 1;
        esi++; edi += 2;
      }
      const a = M[esi]; M[edi] = a;
      M[edi + 1] = (a + M[esi - 0x1f]) >> 1;
      esi++; edi += 0x42;
    }
    edi -= 0xfc0;
    // 31 interpolated rows between the 32 (rows 1,3,5,...) and the last wrap row
    for (let edx = 0x1f; edx > 0; edx--) {
      for (let ecx = 0x40; ecx > 0; ecx--) { M[edi] = (M[edi - 0x40] + M[edi + 0x40]) >> 1; edi++; }
      edi += 0x40;
    }
    for (let ecx = 0x40; ecx > 0; ecx--) { M[edi] = (M[edi - 0x40] + M[edi - 0xfc0]) >> 1; edi++; }
  };
  // fn_e27a(ebx, ecx, edx): data-stream callback for the object builder ([0x2438a]): bh!=0 selects the stream by
  // bl ('C' = 0xcc98, 'K' = the table at [0xe1b6], else 0xdaac); copies ecx bytes from the stream to edx.
  // Called by the engine as HP.fn_e27a({bh, bl, ecx, edx, ...}) (see hplus_engine.js callTexGen); positional (ebx, ecx, edx) also accepted.
  HP.fn_e27a = function (ebx, ecx, edx) {
    let bh, bl;
    if (typeof ebx === 'object') { const r = ebx; bh = r.bh & 0xff; bl = r.bl & 0xff; ecx = r.ecx; edx = r.edx; }
    else { bh = (ebx >> 8) & 0xff; bl = ebx & 0xff; }
    if (bh !== 0) {
      wr32(0x108c, 0xcc98);
      if (bl !== 0x43) {
        wr32(0x108c, rd32(0xe1b6));
        if (bl !== 0x4b) wr32(0x108c, 0xdaac);
      }
    }
    const esi = rd32(0x108c);
    HP.copy(edx, esi, ecx);
    wr32(0x108c, esi + ecx);
  };

  // keyboard (what the IRQ handler at 0xbe0 does with a scancode; bit 7 = release)
  HP.key = function (scancode) {
    const sc = scancode & 0x7f, pressed = (scancode & 0x80) ? 0 : 1;
    wr8(0x9c8 + sc, pressed); wr8(0xa48 + sc, rd8(0xa48 + sc) | pressed);
  };
  HP.SC_ESC = 1; HP.SC_SPACE = 0x39; HP.SC_BACKTICK = 0x29; HP.SC_F = 0x21; // etc.

  // ---- startup (0xe2d3 .. 0xe391), without the parts of it that are the player's/engine's
  HP.mainInit = function (opts) {
    opts = opts || {};
    if (HP.fn_2c1e6) HP.fn_2c1e6(0x1054);   // "hplus loading" (no-op in the browser)
    wr32(0x2438a, 0xe27a);           // object builder data callback (engine calls HP.fn_e27a)
    HP.fn_e1cc();
    HP.fn_28f4a();                   // engine init
    HP.fn_d5b();                     // sound init (player; allocs 0x3740 state etc., sets [0xe20])
    HP.fn_e1ba(0x1090);
    // 256x256 word multiplication table
    let eax = HP.fn_29a(0x20010); eax = (eax | 0xf) + 1; wr32(0x1088, eax);
    const dv = HP.DV;
    for (let b = 0, p = eax; b < 0x100; b++) for (let c = 0; c < 0x100; c++, p += 2) dv.setUint16(p, (b * c) & 0xffff, true);
    wr32(0x28ed4, 0);
    if (!opts.skipPrecalc) {
      HP.fn_15922(); HP.fn_1816a(); HP.fn_1b5eb(); HP.fn_1d39f(); HP.fn_1fde5();
      wr32(0x28ed4, 1);
      HP.fn_231ca();
    }
    HP.fn_e2bc();
    // fn_c51: keyboard IRQ install — host feeds HP.key()
    HP.fn_f50(0x1090, 0x3f);         // start the music (esi=module, eax=volume)
    wr32(0x1084, 0);
  };

  // ---- the part sequence (0xe39b .. 0xe448) as a generator of frames
  // the parts in order: [name, run function, args, check ESC after?]
  HP.SEQUENCE = [
    ['A', 'fn_15c18', [9, 0x14], true], ['B', 'fn_182fc', [3, 0x3a], true], ['C', 'fn_1b8c0', [0, 0x3d], false],
    ['B', 'fn_182fc', [1, 0], false], ['C', 'fn_1b8c0', [4], true], ['D', 'fn_1d566', [4], true],
    ['E', 'fn_1ffe5', [4, 2], true], ['F', 'fn_236ef', [], true], ['A', 'fn_15c18', [0xffffffff, 0x64], false]];
  HP.mainSequence = function* (from) {
    const esc = () => rds32(0x1084) === 1;
    for (let i = from || 0; i < HP.SEQUENCE.length; i++) {
      const [name, fn, args, chk] = HP.SEQUENCE[i];
      HP.part = name; HP.partIndex = i; HP.partRun = (HP.partRun || 0) + 1;   // partRun identifies this run of the part
      if (HP.onPartEntry) HP.onPartEntry(i);          // (seeking: snapshot taken here, before the part's prologue)
      yield* HP[fn](...args);
      if (chk && esc()) return;
    }
  };
  // 0xe448: shutdown
  HP.mainExit = function () {
    if (HP.fn_f80) HP.fn_f80();      // stop music
    if (HP.fn_2cd46) HP.fn_2cd46();  // restore video
    if (HP.fn_2c1e6) HP.fn_2c1e6(0x1064);
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
