# hplus part D — port notes (`hplus_fxD.js`)

Code range **0x1cbb4 .. 0x1dcaf**. Init `fn_1d39f`, run `fn_1d566(eax)`.
Called by main once: `fn_1d566(4)` (run until song order == start+4), after the second part C.
Runs ~t≈130–158 s (song order 0x13–0x14). Reference frame: `full/f02388_t145.17.png`.

## What it draws
A **ray-cast textured cylinder ("tunnel")** the camera flies through, with a low-poly
**sphere object** (mesh `0x1bcdc`, "K-sein…2.scx") and a **2000-point particle object**
(`0x1c1f4`) that darken the tunnel rays where they occlude. Plus zoom / cross-fade
transitions and a couple of music-position-triggered fades and a brightness pulse.

Per presented frame (`fxD_render`):
1. `fn_2afd3` (camera/path) + `fn_2a2ac` render the sphere mesh into the frame buffer `[0x1bcbc]`.
2. `fn_1cd19` casts a **41×31 grid of rays** at the cylinder; for each sample it stores
   `(u,v,z)` (16.16) into the sample buffer `[0x1ca6c]` (stride 0xc, 0x29 cols × row pad `[0x1cb04]`).
   The intersection math is `fn_1cbb4` (reached indirectly via `[0x1cba8]`), using a table-based
   inverse-sqrt `fn_23f8c` (table `[0x23f30]`, built by `fn_23f34` — part F's range; a fallback
   copy is defined in this file guarded by `if (!HP.fn_23f8c)`).
3. The particle object is rendered to a small buffer `[0x1bcc0]` and its 0x4f7 bytes subtract
   from each sample's `z` (`<<15`, clamped to 0x20000) → the dark rays.
4. `fn_1d09f` fills the 40×30 cells with **8×8 bilinear interpolation** of `(u,v,shade)`, looking
   each pixel up in a **256×256 dword colour LUT `[0x1c140]`** indexed by `[shade][texel]`, where
   the texel comes from the 256×256 byte texture `[0x1c13c]`. (Self-modifying in the original:
   the LUT/texture base addresses are patched into the inner loop at 0x1d1fa/0x1d209; the port
   passes them as `lutBase`/`texBase`.)
5. `fn_2a2ac` renders the sphere again (now over the tunnel).
6. Zoom transitions `zoomCopy` (order 0x13 row≥0x24 → `[0x1bc9c]`=1/2 zoom `[0x1bca0]`; and the
   `[0x1bca4]` cross-fade that swaps `[0x1bcbc]`↔`[0x1bcc8]`), a `sin·sin` brightness flash via
   part B's `fn_18135` (order 0x14 row 0x34–0x38), and part A's `fn_1574e` global fade `[0x1bc90]`.

`fxD_post` (3× per frame @14 ms is **not** how it works here — it calls `fn_1dab0` exactly 3× per
frame unconditionally): advances the camera path/angles, handles the buffer swap, and every frame
has a 3/8-ish chance (`fn_2c2c8(5)==3`) of regenerating the tunnel **texture** with rolled-LCG
noise added to the base texture `[0x1bcc4]`; otherwise restores the base texture if it had been
dirtied. Exit when song order ≥ start+`[0x1bcb0]` or ESC (`[0x9c9]`→`[0x1084]`=1).

## Key state / data (offsets into M)
| addr | meaning |
|---|---|
| `[0x1bcbc]`,`[0x1bcc8]` | two 320×240×32 frame buffers (swapped for cross-fade / double-buffer) |
| `[0x1bcc0]` | particle render buffer (41×31 dwords, 0x4f7) |
| `[0x1bcc4]` | base tunnel texture backup (0x10000 bytes) |
| `[0x1bcdc]` | sphere mesh object |
| `[0x1c1f4]` | particle object (2000 pts); records at `[0x1c708]`, 0x2c bytes each |
| `[0x1c1f0]` | 3×0x55 drifting light-record particles (`fn_1d2bd`, moved by `fn_1d35c`) |
| `[0x1c13c]` | 256×256 texture (bytes); `[0x1c140]` 256×256 colour LUT (dwords) |
| `[0x1ca6c]` | ray sample buffer (41×31 × (u,v,z) 16.16) |
| `[0x1c70c]` | camera block; `[0x1c770..]` euler angles / path state; path tables `[0x1c7c0/0x1c7d0/0x1c7e0]` |
| `[0x1cb20..0x1cb40]` | cylinder constants: k=0.125, fov 2/-2/4, radius²=100, 65535, feed 200000, 0.2, -10 |
| `[0x1bc90]` global fade, `[0x1bc9c]`/`[0x1bca0]` zoom, `[0x1bca4]` cross-fade, `[0x1bccc]` texture-dirty flag |

`fistp` = round-half-to-even, x87-indefinite (0x80000000) on overflow/NaN. x87 intermediates are
kept as JS doubles and only rounded to float32 at `fst/fstp dword` (`wrf`). Integer ops use the
exact shifts/`Math.imul`; the `>>3` deltas in `fn_1d09f` and the `>>11` sub-steps are arithmetic.

## External functions needed (register-order args)
- core: `fn_29a(eax)`, `fn_2c2c8(eax)`; `fn_23f8c(eax)` (part F, fallback provided here)
- engine (`hplus_engine.js`): `fn_2432c(edx,ebp)`, `fn_2a094(ecx,ebp)`, `fn_28ed8(eax,ebp)`,
  `fn_2afd3(ebx,esi,edi,ebp)`, `fn_2a2ac(esi,edi,ebp)`, `fn_2af3a()`, `fn_2b037(ebx,ecx)`, `fn_2b0a8(esi,ebp)`
- part A: `fn_1574e(ebp,edi)`; part B: `fn_18135(ecx,edx,edi)`

## Validation status
**Validated bit-exact** (`test_fxD3.js` vs `emu_fxD2.py`'s recording of the real emulator run).
All eight captured sessions — `fn_1d39f` (precalc), `fxD_init`, and 3×(`fxD_render`,`fxD_post`) —
reproduce the emulator's memory **identically, frame buffers included**, with the correct external
call sequence and register arguments, once the following are masked (all are emulation-runtime or
faithful behavioral differences, not port errors):
- audio DMA double buffer `0x3f000..0x4f200` (phys 0x50000) — filled by the SB16 mixer during
  emulation; the isolated JS replay doesn't run audio.
- player state `0x1283b0..0x12e000`, timer/callback accumulators `0x2ee00..0x2ef00`, keyboard
  flags `0x9c0..0xb10`, player/kbd BSS scratch `0x32b00..0x32c20` — all IRQ-driven.
- the two self-modifying-code sites `0x1d1fa`/`0x1d209`: the original patches the texture/LUT base
  addresses into `fn_1d09f`'s instruction stream; the port passes them as `texBase`/`lutBase` args,
  so those 6+4 code bytes differ while the rendered result is identical.
- leftover bytes above the in-snapshot heap pointer (only present in the emulator's RAM).

`test_fxD2.js` shows the same sessions unmasked (to see exactly which bytes are the runtime state).

## Files
- `hplus_fxD.js` — the port (all of 0x1cbb4..0x1dcaf; `fn_1d566` = generator; also exposes
  `fxD_init`/`fxD_render`/`fxD_post` for testing).
- `emu_fxD2.py` — session recorder (precalc + render/post + init), writes `fxD_rec/`.
- `test_fxD2.js` — session replay differential test (unmasked).
- `test_fxD3.js` — masked session replay: the bit-exact validation (frame buffers + control state).
- `emu_fxD.py`/`test_fxD.js` — earlier per-function capture (superseded by the session recorder).
