# Part E (0x1f87e..0x203ea) — port notes

Files: `hplus_fxE.js` (the port), `test_fxE.js` (differential tests vs. emulator snapshot pairs in
`refE/`, produced by `capE.py`), `capE.py` (targeted emulator capture: init-tail pair, run-entry
snapshot, per-frame PNG+jsonl for part E only, before/after pairs for `fn_1fd0c`, `fn_1f9b0`,
update tail).

## What the part does
Main calls `fn_1fde5()` at startup (precalc) and `fn_1ffe5(eax=4, ebx=2)` after part D: it runs
until the song reaches order (start+4), row 2 (or ESC). One textured 3D object (built from the
chunk data at 0x1dcb4 and 0x1eb1b by the engine's `fn_29060`; object struct at 0x1ef38) is
rendered by the engine (`fn_2a2ac`) from a smoothed camera (`fn_1570b`, 6 floats at 0x1f450:
pos/target; the engine's `fn_2afd3` advances along one of 4 paths `[0x1f544+i*4]`, selected
by `[0x1f51c]` = 0..3 which advances each time the song order changes (`fn_20262`), with new
angles/speeds from the tables `0x1f534`/`0x1f524`). 192 particle records of 0x2c bytes (in the
object's vertex array at `[0x1f44c]`, randomized by `fn_1f87e` ×3 — each call advances `edi`
by 0x40×0x2c, so the three calls fill consecutive blocks) are moved every update step by
`fn_1f92c` along axis +8 (y) with wrap at 200 → −400 (table 0x1f8fc × 0.15 per step), and their
x/z (+4, +0xc) are re-scaled from the pristine copy at `[0x1f8f4]` by −(y−200)×0.0044.
A 16×16 round pattern (0x1f77e) is stamped as an 8×8 brick grid into the 256-wide 8-bit
texture at `[0x1f398]` at init (darkening, saturating) — the dotted look of the object. When
`[0x1f778]==1` (rows 4..12 of the 2nd/3rd order of the part, see update step) `fn_1fd0c` draws
300 "light rays": random start near (160..200 or 140..180, 130..140), stepping `dx` per row
upwards; `fn_1f9b0` walks until a pixel with alpha byte 0xff (a rendered object pixel) then
brightens the pixels along the rest of the ray by `count >> [0x1f9ac]` (saturating table at
0x1facc). Outside order 0x18 (24), at rows <4 or ≥50, the frame is faded through part B's
`fn_18135(ecx, edx, edi)` with weights from `sin([0x1f500])*105+128` (first-order fade in/out).
Page flip: two 320×240×32 buffers `[0x1ef24]`/`[0x1ef28]` swapped after present; the back buffer
is cleared to 0 each frame, except the very first frame which is filled with the colour
`[[0x1f39c]]`.

## Functions (register-order args)
| fn | args | notes |
|---|---|---|
| `fn_1f87e(esi, edi, ebp)` → edi | randomize 0x40 records; y=rand(400)−200, x=(rand(40)+ebp)>>4, z=(rand(40)+esi)>>4, [+0x20]=−4 |
| `fn_1f92c(edi=records, ebp=axis)` | particle step (0xc0 records), uses pristine copy `[0x1f8f4]` |
| `fn_1f9b0()` | one ray; globals 0x1f99c x, 0x1f9a0 y (16.16), 0x1f9a4 dx, 0x1f9a8 count, 0x1f9ac shift (self-modifies byte 0x1fa49, mirrored) |
| `fn_1fa8a()` | table 0x1facc[i]=min(i,255), 0x240 entries |
| `fn_1fd0c()` | rays pass (300 rays); also `[0x1fac4] = round((1+sin[0x1f508])²·0x140000)` (unused elsewhere) |
| `fn_1fde5()` | precalc: allocs 0xb6010 (two buffers), builds the object (engine), then `fn_1fde5_tail()` (pure: particles, pristine copy alloc `[0x1efa0]·0x2c+0x10`, saturation table, **RNG reseed to 0x1010102/0x9192919**, texture stamping) |
| `fn_20240()` | update step: `fn_2af3a()`, `fn_2b037(ebx=0x1f4b4, ecx=[0x1ef2c])`, then `fn_20262()` (pure tail: particles, path switching on order change, `[0x1f774]/[0x1f778]` ray flags on rows 4..12 when `[0x1f51c]` is 1 or 2, object colour words `[0x1efc0/4]` from 0x1f4c8.. or 0x1f4d0.. while rays are on, angle increments 0x1f500..0x1f508 += 0x1f50c.., and from order 24 row 58 on: `[0x1f4e8] += [0x1f4ec]; [0x1f4e4] += [0x1f4e8]` (camera smoothing k ramps up)) |
| `fn_1ffe5*(eax, ebx)` | generator: yields after `fn_2b0a8`; update steps ×⌊([0x28e28]+1)/14⌋; exit when order ≥ start+eax and row ≥ ebx, or ESC (`[0x9c9]` → `[0x1084]=1`) |

External: `fn_29a`, `fn_2c2c8` (core); `fn_156ff`, `fn_1570b` (part A); `fn_18135(ecx, edx, edi)`
(part B — fade of a buffer with weights 255−x / x); engine `fn_29060(eax, ebx, edx=-1, esi=[0x1ef2c], edi=chunk, ebp=0x1ef38)`,
`fn_2a094(ecx=0xc0, ebp)`, `fn_28ed8(eax=1, ebp)`, `fn_2afd3(ebx=0x1f4b4, esi=0x1f450, edi=path, ebp=0x1ef38)`,
`fn_2a2ac(esi=0x1f450, edi=buffer, ebp=0x1ef38)`, `fn_2af3a()`, `fn_2b037(ebx=0x1f4b4, ecx=[0x1ef2c])`,
`fn_2b0a8(esi=buffer, ebp=0x1ef38)`. Engine-written fields read here: `[0x1ef2c]` (matrix ptr),
`[0x1f44c]` (vertex/particle array), `[0x1efa0]` (vertex count), `[0x1f398]` (8-bit texture),
`[0x1f39c]` (pointer to a dword colour used to clear the first frame), `[0x28c9c]` flag for `fn_2afd3`.
The rays rely on the renderer writing 0xff into the alpha byte of object pixels.

## Quirks
* `fn_1fd0c` leaves one value (sin) on the x87 stack per call. Unicorn/QEMU (and DOSBox) treat the
  stack as a ring, so the leak is harmless there; real hardware would produce NaNs after 8 frames
  with rays (masked stack overflow). The port follows the emulator (no effect).
* The RNG is reseeded in the precalc (`fn_1fde5_tail`), which affects every later part's randomness.
* `fn_1f9b0` patches its own `shr esi, imm8` (byte 0x1fa49); the port writes the byte too so memory
  diffs stay clean, and masks the count with 31 like the CPU.
* Overlapping dword stores `[0x1ef64]=0x1a; [0x1ef65]=0x1a; [0x1ef66]=0x28` are kept as is.

## Timeline (emulator, 30 MIPS CPU model, `refE/`)
Part E runs from order 21 row 0 (t = 110.8 s) to order 25 row ~2 (t = 131.8 s): 395 frames in
`refE/fNNNNN.png` (#1865..#2259) + `refE/frames.jsonl`; memory snapshots `refE/run_entry.bin.z`
(entry of `fn_1ffe5`, regs in `run_entry.json`: eax=4, ebx=2) and `refE/frame_NNNNN.bin.z`
every 50 frames. Look: dark scene, a blocky textured structure with the round stamps, blue
particle glows; rays brighten the image near the centre at rows 4..12 of orders 22 and 23
(e.g. frame #1978).

## Validation (`node test_fxE.js`, `node test_fxE_pre.js`)
Differential tests against emulator snapshot pairs, ignoring only the regions written
asynchronously by IRQ handlers (timer accumulators 0x2ee3d..0x2ee64, the stack, the sound
driver/player state, the DMA buffer):
* `init_tail` (0x1feda..ret of `fn_1fde5`, startup): 0 mismatching bytes.
* update tail `fn_20262` (0x20262..ret of `fn_20240`): 3 instances, 0 mismatching bytes each.
* `fn_1f9b0` (single ray): 3 instances, 0 mismatching bytes.
* `fn_1fd0c` preamble (trig → `fistp` shift/scale values, RNG-driven first ray parameters): 0
  mismatching bytes (compared at the first `fn_1f9b0` call of the first rays pass).
* `fn_1fd0c` whole pass (300 rays): 3 instances (re-captured by `capE2.py`, see "Tooling
  caveat"), 0 mismatching bytes each.
* Frame replay (`node replay_fxE.js 400 [dump]`, with hplus_engine.js + hplus_fxB.js): runs the
  generator from `refE/run_entry.bin.z` for all 395 frames of the part, feeding the emulator's
  per-frame dt into `[0x28e28]` after each yield and resyncing RNG state and song position
  (order/row/tick) from `frames.jsonl` at each flip; compares the presented buffer `[0x1ef24]`
  with `refE/fNNNNN.png`. Result: **319 of 395 frames pixel-exact**. The other 76: (a) ~8 frames
  with 1 pixel off by 1..4 (float rounding inside the engine), (b) the frames around the
  fade-in/out (rows ≥50 / <4) and the order changes (frames 188–208, 289–299): these depend on
  the song row read in the middle of a frame (render-time fade decision, per-update-step ray/path
  flags), which the emulator's IRQ advances asynchronously — the replay can only resync it once
  per frame, so fade phase / ray flags / path switch land one frame earlier or later and then
  converge. `node snapdiff_fxE.js` confirms it: at every emulator snapshot (every 50 frames) all of
  part E's state — 192 particle records, camera block, scene struct, path index, ray flags — is
  byte-identical; the only differing variable is the fade phase `[0x1f500]` (off by ~5 update
  steps at frames 100/200, i.e. the fade started ~1 frame earlier in the emulator) and the
  stale fade weights derived from it.

## Integration notes
* Engine signatures differ from the plain register-order convention for two functions and the
  calls here follow the engine as written: `fn_2a2ac(esi=camera, ebp=scene, edi=dest)` and
  `fn_29060(eax, ebx, ecx(unused), edx, esi, edi, ebp)` (7 args). Any other caller written
  with (esi, edi, ebp) / 6 args (e.g. hplus_fxA.js as of this writing) needs the same adjustment.
* `fn_1f87e` (like part A's `fn_1545e`/`fn_15508`) advances `edi` and is called back-to-back: the
  second/third call must continue from the returned `edi` (done here).
* Pause (`[0xa01]`), ESC (`[0x9c9]`), FPS overlay are host-fed flags; the part reads `[0xe20]`
  (player state) only for order/row.

## Tooling caveat (Unicorn)
A code hook added while the emulator runs is only honoured by translation blocks translated
*after* it was added. `TEmu.bp_once(ret_addr, …)` set from inside a function's entry breakpoint
therefore misses returns to an address whose block was already executed (e.g. 0x2012e, reached
by a `jne` in earlier frames). Fix: call `em.mu.ctl_flush_tb()` after installing such a hook
(done in `capE2.py`).
