# Part C (0x1b4a6..0x1bc72) — hplus_fxC.js

## What it is
Visually (fullT frames ~1370–1560, t≈70–91 s, orders 14–18; plus a ~3-row flash at order 13 row 58): a
dark textured, twisted tube seen from inside/along it with ~255 blue glowing particles streaming along three
lanes through it; the blue glows are smeared horizontally by a slowly varying (sine) amount and, from order 16 row 58, flickers at half
brightness every other frame.

A textured 3D object (two 'Obu!Word' chunks at 0x185d4 (5644 bytes, len at 0x185d0) and 0x19be4
(4159 bytes) built into the object struct at **0x1ac48** with `fn_29060`) plus **255 particles** that ride
three spline paths derived from the object's own vertices. Per frame the 255 instance records of
the object (`[0x1ac48+0x514]` → 0x2c-byte records, same layout as part A's `[0x14a58]`) get their
position from `fn_28ca4` (spline evaluation, ebx = particle record {t, speed, start offset, len=0x2d0},
ecx=3, edi=path+0x18; result in `[0x28c74..0x28c7c]`), z?=`-10.0` at +0x20; the camera follows one of 4
camera paths (`0x1b2ac` table → 0x1b2c0/0x1b338/0x1b3b0/0x1b414, switched on every song-order change via
`[0x1b284]`, like part A), then `fn_2afd3` (camera), `fn_2a2ac` (render), and a sine-driven horizontal
smear of the blue channel (the particle glow streaks): `v = sin(a·k)·sin(c·k)·126+128`, `[0x1b254]=255-v`,
`[0x1b258]=v`, applied with part B's `fn_18135(ecx=v, edx=255-v, edi=buffer)` (per scanline, blue = (v·blue +
(255-v)·prev)>>8 via the word multiplication table). From **order 16 row 58** on, every other frame is halved in brightness (`(pix>>1)&0x7f7f7f`,
toggle `[0x1b280]`). The frame buffer is cleared to the colour dword at `[[0x1b0ac]]` (texture descriptor).

Called by main as `fn_1b8c0(0, 0x3d)` right after B(3,0x3a) — a ~3-row flash — and `fn_1b8c0(4)` (ebx
left over = 0 in practice) after B(1,0): runs until order ≥ start+4. Exit: ESC (`[0x9c9]==1` → `[0x1084]=1`)
or song position (order ≥ `[0x1ac2c]+[0x1ac24]` and row ≥ `[0x1ac28]`), checked after the update steps.

## Functions (hplus_fxC.js)
* `fn_1b4a6(esi=vertices, edi=path)` → edi+0x2d0: builds an 18-record (0x28 B each) path: record 1..16 = centre
  (×0.25 + `[0x1af3c..]` offset) of 4 vertices (x at +4 of each 0x3c-byte vertex, stride 0x3c, group
  stride 0x2d0 = 12 vertices); record 0/17 = extrapolated (`A ∓ |A−B|`). Called 3× (vertex columns 0-3,
  4-7, 8-11 via esi+0, +0xf0, +0x1e0); **edi is carried across the calls** so the three paths are consecutive
  0x2d0 blocks although only 0x2e0 bytes are allocated (`[0x1b4a2]`) — the original overflows into the next
  allocations (parts D/E/F init later); kept verbatim.
* `fn_1b5eb()` init: alloc 0xb6010 (`[0x1ac34]` back buffer, `[0x1ac38]` = +0x4b000), `[0x23fd0]=0`, two
  `fn_29060(eax=0/3, ebx=1/9, edx=-1, esi=[0x1ac3c] (=1.0f bits, a scale), edi=[0x1ac34], ebp=0x1ac48)`;
  texture descriptor fix-up (copies the 2nd 24-byte descriptor 0x1b0b4→0x1b09c keeping `[0x1b0a8]`, size
  64×64.0f); builds texture `[0x1b0a8]` (256×256) from `[0x1b0c0]` (`max(v-11,0)+10+round(10·sin(6π·row/256))`,
  clamped 0..63) and darkens `[0x1b0c0]` in place (−11) and `[0x1b0d8]` (−40); `[0x1ac70..]` bytes; clears the
  buffers; `fn_2a094(ecx=0xff, ebp=0x1ac48)`; 255 particle records at `[0x1b238]` (16 B: t=rand(100)/100,
  speed=(rand(700)+700)/100000, start=rand(15)*0x28, len=0x2d0); `fn_28ed8(eax=1, ebp)`; camera defaults
  `[0x1acd0..]`←`[0x1b23c..]`; the 3 paths.
* `fn_1bb90()` update (one 14 ms step): `fn_2af3a()`, `fn_2b037(ebx=0x1b228 angles, ecx=[0x1ac3c])`, 255×
  `fn_2b037(ebx=particle rec, ecx=[0x1ac3c])`, camera path switch on order change, angle increments.
* `fn_1b8c0*(eax, ebx)` run loop (generator; yields right after `fn_2b0a8(esi=[0x1ac34], ebp=0x1ac48)`).

State: `0x1ac24` eax arg, `0x1ac28` ebx arg, `0x1ac2c` start order, `0x1ac30` flag, `0x1ac34/38` buffers,
`0x1ac3c` scale(1.0f), `0x1ac44` int temp, `0x1ac48` object, `0x1ac7c` saved around the particle loop,
`0x1acb8..0x1accc` ← camera `0x1b160..0x1b174`, `0x1b09c..0x1b0d8` texture descriptors, `0x1b160` camera block,
`0x1b228` angles + `0x1b22c/30/34` path params, `0x1b238` particles, `0x1b254/58` fade, `0x1b25c..0x1b27c`
sine constants (126, 128, phases, increments, k=0.14245), `0x1b280` flicker toggle, `0x1b284` path idx,
`0x1b288` last order, `0x1b28c/0x1b29c/0x1b2ac` path tables, `0x1b4a0` word→`[0xbc]`, `0x1b4a2` path block,
`0x1af68` = object vertex array ptr (set by the builder), `0x1af3c..44` path offset (0,0,0), `0x1b250` 0.25.

## External functions needed (register-order args)
core `fn_29a`, `fn_2c2c8`; part A `fn_156ff(esi, edi)`; part B `fn_18135(ecx, edx, edi)`; engine
`fn_29060(eax,ebx,edx,esi,edi,ebp)`, `fn_2a094(ecx,ebp)`, `fn_28ed8(eax,ebp)`, `fn_28ca4(ebx,ecx,edi)`,
`fn_2afd3(ebx,esi,edi,ebp)`, `fn_2a2ac(esi,edi,ebp)`, `fn_2b0a8(esi,ebp)`, `fn_2af3a()`, `fn_2b037(ebx,ecx)`.
`[0x28c9c]` is set to 0 before `fn_28ca4` and 1 before `fn_2afd3` (engine flag).

## Validation
* `test_fxC_init.js` (snapshots in `fxC_tests/`, captured by `cap_fxC_init.py`): runs `fn_1b5eb` on the
  emulator's entry snapshot with the 4 engine calls stubbed (diff M against the "before-call" snapshot,
  then load the "after-call" snapshot) and diffs the final state against the emulator's return snapshot.
  **PASS — byte-identical** everywhere except asynchronous state (timer IRQ counters 0x2ee2d.., stack, sound
  driver memory), including the sine-biased texture, the particle records and the 3 paths.
* `test_fxC_run.js` (frame-level sync) / `test_fxC_run2.js` (step-level sync) replay the run loop from the emulator's entry snapshots (`fxC_run/entryN.bin.z`,
  per-frame meta + PNGs from `cap_fxC_run.py`) feeding the recorded dt/RNG/song position per frame and
  compares every presented frame with the reference PNG — needs `hplus_engine.js` (and `hplus_fxB.js` for
  `fn_18135`). Results (with the engine port as of its first drop): **all part-C/engine state is byte-identical**
  to the emulator snapshots at frames 1320 and 1360 (camera block, angles, instance records, particle
  records, engine scratch); the presented frames differ in only ~20 isolated pixels/frame (≈40–80 bytes, max
  Δ≈16) whose R/G already differ before the smear → single-texel rounding in the engine's texture mapper
  (x87 extended vs double), not part C. From the order 13→14 change on, the camera angle is off by one
  frame's batch of update steps because the song order flips asynchronously mid-frame and frames.jsonl
  only gives per-frame positions — hence `cap_fxC_steps.py` + `test_fxC_run2.js`, which apply the song
  position exactly where the original read it (per update step / flicker check / exit check).
* **`test_fxC_run2.js` (precise replay, call 2 = 190 frames): generator runs/exits at exactly the same frame as
  the original; 138/190 frames pixel-identical, the other 52 differ by ≤14 bytes (max Δ 11, isolated texels)
  — i.e. part C is exact; the remaining texel-level noise belongs to the engine's rasterizer.** Call 1 (the
  2-frame flash) replays with the frame-level harness (`test_fxC_run.js 1`): see its output.
* Harness pitfall (fixed): the run loop's prologue clears `[0x2ee54]`, so the replay must inject the frame's
  dt inside a `fn_2b0a8` hook, right before present (not before resuming the generator).

## Files
hplus_fxC.js (the port), FXC_NOTES.md, cap_fxC_init.py + test_fxC_init.js (init differential test, data in
fxC_tests/), cap_fxC_run.py + cap_fxC_steps.py (run-loop capture: fxC_run/entryN.bin.z, returnN.bin.z,
frames.jsonl, steps.jsonl, fNNNNN.png, snapNNNNN.bin.z), test_fxC_run.js / test_fxC_run2.js / test_fxC_mem.js
(replays: pixel compare / memory diff at a snapshot frame), png_util_fxC.js (PNG read/write helpers).

## Open issues / notes
* `fistp`/`fsin` differences between x87 extended precision and JS doubles can shift the texture bias
  (`round(10·sin(...))`) or the fade value by 1 in rare ties — none observed in the init test.
* The 0x2e0-byte path allocation overflow (see above) means parts D/E/F's first allocations alias the
  2nd/3rd path data; identical in the port as long as allocation order/sizes match (they are mirrored).
