# hplus → JavaScript port: conventions (shared by all sub-tasks)

## Memory model ("memory-image port")
The original is a flat 32-bit PMODE program. Its 32-bit segment (selector 08/10, linear base
0x10f70) is mirrored 1:1 in JS as one big `Uint8Array` **M** whose indices are exactly the
original's 32-bit offsets. This means every pointer/offset in the disassembly is directly a JS
index, data structures are used in place, and the port can be diffed against emulator memory
snapshots (`emu_trace.py` → `snapshot()` = bytes of offsets `[0, heap_end)`).

* `image32.bin` (0x2f076 bytes) is loaded at M[0]. BSS follows up to 0x32c20 (zero). The
  original stack top is 0x32c20 (not needed in JS).
* Allocators (PMODE API, bump pointers stored in memory, mirror them exactly):
  * low memory:  `fn_27c(eax=size)` → `eax=ptr`: `size=(size+3)&~3; p=[0]; if p+size>[4] fail; [0]+=size; return p`.
    Initial `[0]=0x35048`, `[4]=0x8f080`.
  * high memory: `fn_29a(eax=size)` → same with `[8]`/`[0xc]`. Initial `[8]=0xef090`, `[0xc]=0x10ef090`.
    After the intro's init `[8]=0xabcf2c`, so **M must be ≥ 0xac0000** (use 0xb00000 = 11.5 MB; or 0x1100000 to mirror the full RAM).
  * Callers often align the result themselves (`or eax,0xf; inc eax`) — keep those exact.
* The LFB (screen) is NOT part of M: `fn_2c9f4` (copy buffer → screen) writes to the canvas instead.
  Screen = 320×240, 32 bpp (B,G,R,X byte order in memory = little-endian 0x00RRGGBB dwords).
* Other PMODE data at the start of M: `[0x18]=0x10f70` (linear base; the code converts
  offset↔linear/seg:off with it — only for real-mode calls, irrelevant in JS), `[0x20]=0x18`.

## Access helpers (hplus_core.js)
`rd8(a) rd16(a) rd32(a) rds8 rds16 wr8 wr16 wr32 rdf(a) wrf(a,v)` (little-endian, DataView based;
`rd32` returns **unsigned**, use `rds32` for signed). `rdf/wrf` = float32. Use `Math.fround` on
every value the original stores with `fstp dword` / loads from a float32. The x87 runs in
extended precision; JS doubles are the closest we get — accept rare 1-ulp float32 differences,
but keep every operation order, every truncation/rounding (`fistp` = round-half-even →
`roundHalfEven()`; `fist` same; integer `idiv` = `Math.trunc`), every shift/mask exactly.
Integer helpers: `imul32(a,b)` (Math.imul), `mulhi(a,b)`/`imulhi(a,b)` (high dword of the
64-bit product, for `mul`/`imul` + `shrd`), `rol/ror`, `sar`.

## Functions
Port each original function as a JS function named `fn_<hex offset>` (lower-case hex, no
leading zeros, e.g. `fn_2a2ac`). Register inputs become parameters in the order
eax, ebx, ecx, edx, esi, edi, ebp (only those actually used, document them in a comment
`// fn_2a2ac(esi=object, ebp=matrix, edi=dest buffer)`); register outputs are returned
(single value, or an object `{eax, edx}` / array). Give readable aliases where meaning is
clear (`const renderObject = fn_2a2ac;`). Keep global variables in M (they are!) — do not
hoist them into JS variables unless they are pure temporaries, so that lockstep memory
diffs stay meaningful. Loops that are a per-frame iteration in the original (`ret` only at
exit) become `function*` generators yielding once per presented frame (see "frame loop").

Every sub-task ports a disjoint address range and lists, at the top of its file, the external
functions it calls (by `fn_xxxxx` name) so the integrator can wire them.

## Frame loop / time
* `[0x2ee54]`: ms counter incremented by the 1 kHz timer IRQ; `fn_2b0a8` (present) copies it
  to `[0x28e28]` (= ms of the last frame, "dt") and clears it. Effects call their update step
  `floor(([0x28e28]+1)/14)` times per frame. In the JS main loop the host sets `[0x2ee54]` from the
  real elapsed ms before calling present; in replay/validation mode it is set from the emulator's
  per-frame log (`frames.jsonl`: dt, ms, order,row,tick, rng) so frames can be compared exactly.
* Music sync: player state pointer `[0xe20]` → `+0x30` order, `+0x34` row, `+0x23` tick (see
  PLAYER_NOTES.md from the player sub-task). The timer IRQ also runs the player tick and the
  4 timer callbacks (`0x2ee1d/0x2ee2d/0x2ee3d` tables); timer callback scheduling is ported in
  the core (`timerTick(ms)`).
* Keyboard: `[0x9c9]`=1 → ESC pressed (effects then set `[0x1084]=1` and return); `[0xa01]`=1 →
  pause; `[0x9f1]`=1 → FPS overlay. The key handler (0xbe0) fills these from scancodes.
* RNG `fn_2c2c8(eax=range)`: `s1=[0x28e38], s2=[0x28e3c]; t=rol((s1+s2)>>>0,5)+0x09381277;
  s2=ror((s2+0x82093847)>>>0,8); s1=t; return mulhi(eax, s1)` (all mod 2^32). Seeds 0x49180712, 0x1294792.

## Validation tooling
* `emu_trace.py OUTDIR SECONDS [SNAP_EVERY] [cmdline]` → per-frame PNGs, `frames.jsonl`,
  zlib'd memory snapshots taken at present time (`snapNNNNN.bin.z`, offsets 0..heap_end),
  `audio.wav`, `coverage.txt`. `TEmu.bp(off, cb)` sets a breakpoint at a 32-bit offset;
  `cb(em)` may read regs (`em.regs()`), memory (`em.rd32`, `em.snapshot()`), and set a return
  breakpoint at `em.ret_addr()` to capture a function's output state → function-level
  differential tests: run the JS `fn_x` on the "before" snapshot and diff against "after".
* Frames: `fNNNNN.png` are the pages shown by VBE display-start calls; the JS must produce the
  same pixels for the same frame (given the same dt/ms/rng/player inputs).
