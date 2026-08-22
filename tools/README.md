# hplus port — reverse-engineering / validation tooling

These scripts were used to unpack, disassemble, emulate and validate the port (kept for reference;
they need Python 3 with `unicorn`, `capstone`, `keystone` and node ≥ 18).

* `unpack.py`, `unpack2.py` — run the WWPACK stub of `HPLUS.EXE` in Unicorn (16-bit real mode) and dump the
  unpacked image (`unpacked.bin`, `image32.bin` = the 32-bit segment = what the port loads).
* `wwpack.js` — the WWPACK decompressor in JS (verified byte-exact); used to regenerate the page's
  embedded data blob (`hplus_data.js`) from the original `HPLUS.EXE`.
* `dis32.py`, `lin.py`, `lin16.py` — recursive-descent / linear disassembly (capstone) of the 32-bit image.
* `emu.py` — headless emulation of the whole intro: PMODE's `int 33h` real-mode services (DOS, VESA VBE 2.0 with
  a linear framebuffer), SB16 + DMA + PIT + PIC, IRQ injection, VESA page flips → frames, DMA stream → PCM.
  `python emu.py "" SECONDS VERBOSITY OUTDIR EVERY_N_FRAMES`.
* `readlog4.py` — the same plus the RNG/glitch state at the noise routine.
* `emu_trace.py` — adds breakpoints, per-frame metadata (`frames.jsonl`: dt/ms/order/row/tick/RNG), memory
  snapshots; `readlog3.py` — reference run that also logs the song position at every sync read of the effects
  (the 34 `mov esi,[0xe20]` sites are patched to `int 0F0h` traps).
* `replay.js` — runs the JS port frame by frame with the emulator's per-frame inputs and compares every
  presented frame with the reference PNGs (`node replay.js REFDIR --readlog REFDIR/readlog.bin --exitonly`);
  `snapdiff.js` attributes memory differences to allocations; `png.js` a tiny PNG codec.
* `difftest_A.py` / `difftest_A.js`, `test_engine.js`, `test_fxB.js` … — function-level differential tests
  (emulator snapshot before/after a call vs the JS function on the same memory).
* `browser_test.js` — headless-Chrome smoke test of `index.html` (playwright-core).
