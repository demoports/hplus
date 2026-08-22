# Part F (0x22d30..0x2436b) — port notes

File: `hplus_fxF.js` (attaches `HP.fn_22d30 fn_22e68 fn_23124 fn_231ca fn_236ef fn_23bd0` and the
object-builder helpers `fn_23f34 fn_23f8c fn_23fd4 fn_24018 fn_241be fn_242e3 fn_2432c`).
Tests: `capF.py early|late` (emulator snapshot pairs → `fxF_tests/`), `node test_fxF.js [names]`.

## What the part does
The end part (≈ t 132–192 s in the 30 MIPS reference run; song orders 25..33, state machine keyed on orders 0x20..0x23): a 16-wide grid of
lines and a triangle mesh (both built at init from the descriptor the object builder fills at
0x220a8..0x220f0 / 0x2214c..0x22158 — `[0x220d4]`/`[0x220dc]` = line-vertex count/ptr (stride 0x3c),
`[0x220d8]`/`[0x220e0]` = mesh face count/ptr (faces stride 0x30, vertex ptrs at +0xc/+0x10/+0x14),
`[0x22150]`/`[0x22154]`/`[0x22158]` = mesh tri count / live vertices / per-triangle records with face
normals at +0x18..+0x20, `[0x2214c]` = vertex count) plus 800 particles (4 rings × 200) and an additive
"light blob" sprite. A state machine `[0x22888]` (0..5) driven by the song position explodes the mesh
along its face normals (`[0x228a0]` displacement, `[0x228a4]` velocity, `[0x228a8]/[0x228ac]/[0x2289c]`
accel/decay), turns the light on (`[0x22890]`, distance `[0x22894]`, `[0x2288c]` sub-state), and
finally switches the camera path. Camera: path state block 0x2239c (t, speed `[0x223a0]`, pos
`[0x223a4]`, limit `[0x223a8]`; path tables 0x22408/0x2241c/0x2242c/0x22430 indexed by `[0x22400]`
0..4, advanced when `(order-1)>>1` changes), camera block 0x222d4 (pos/target + 3x3 matrix at
+0x24/+0x34/+0x44 and translation +0x54, as used by fn_22e68), `fn_1570b(0x223c4, 0x222d4)` smoothing.
Angles `[0x223e4..0x223ec]` += `[0x223f0..0x223f8]` per update step.

Init `fn_231ca` (called last by main, with `[0x28ed4]=1`): allocates 3 back buffers `[0x21da0]/[0x21da4]/
[0x21da8]` (0x101010 bytes), builds 4 objects into the object struct 0x21dbc via `fn_29060` (chunks
0x203f4 'Obu!Word Txtr', 0x20e53, 0x213b2 with `[0x23fd0]` = -1700 / 5000 / -1500 set before each
call — the builder reads it; `esi` = float bits `[0x21dac]`=0.9 / `[0x223c0]`=3000), then a 'Line'
chunk (the ring vertices minus `[0x220b0..0x220b8]`, 192 lines (i,i+1),(i,i+16)) and an 'Obu!' chunk
(the mesh triangles), object flags (`[0x21e28]`, `[0x21de4]`, overlapping dword writes at 0x21de8..),
`fn_2a094(0x320, obj)`, 800 particle records (16 bytes: t=rand(100)/100, speed=(rand(5000)+100)/200000,
ring offset rand(6)*0x28, 0xa78), 4 rings of 10+57 points (0x28-byte records, built by `fn_23124` from
the line vertices ×1.01 + center), `fn_28ed8(1,obj)`, texture tweaks (`[0x2224c]`: b=max(2b-20,0) over
64 KB; `[0x22234]`: 256 rows filled with row>>2), `fn_22d30` (light-blob tables), a few float constants
(`[0x22240]/[0x22244]`=128, `[0x22228]`=1, `[0x2222c]`=255, `[0x22210]/[0x22214]`=64).
`[0x2224c]`, `[0x22234]`, `[0x22220]` (background colour ptr) are pointers filled by the builder.

Run `fn_236ef(eax)` (generator; `[0x21d94]` = eax, unused): halves the 0x20000-byte lightmap at
`[0x28e5c]` (byte shr 1), resets 0x2285d..0x22885 from the backup at 0x22835, reads the start order,
builds the 256-entry BGRx palette at 0x29090 (r=0x28·i/256, g=b=0x1e·i/256, fistp), copies the mesh
vertices to `[0x228b0]`, then per frame: clear buffer with `[[0x22220]]`, random flag bit 0 of
`[0x220e8]` (rand(8)==3, only from order 0x1f row 0x30 on, forced on in state 5), displace vertices,
sample the 800 particles with `fn_28ca4` into the object's vertex list (`[0x21dbc+0x514]`, stride 0x2c;
+0x20 = -45.0), `fn_2afd3` camera, smoothing, copy camera pos/target into the object (+0x70/+0x7c),
`fn_2a2ac` render, `fn_22e68` if `[0x22890]`, `fn_2b0a8` present, **yield**, `[0x21d9c]=2`,
`floor((dt+1)/14)` × `fn_23bd0`, exit on ESC (`[0x9c9]` → `[0x1084]=1`) or when state ≥ 5 and
`[0x223a4] >= [0x22418]-200`. On exit: copy the frame to `[0x21da8]` (part A's final run fades from
it), lightmap byte shl 1, palette rebuilt with 0x96 for all channels.

`fn_22e68`: transforms the light position (0x220a8+8..+0x10) by the camera block, projects with
`[0x21df0]` (focal) to (sx,sy) (+160/+120), only if camera-space z < 0; intensity
`clamp(-(z+[0x22894])>>4, 0, 256)`; builds a 256-entry |sin| table at 0x22914 from angles
`[0x223e4..]` (step `[0x22d28]`, amp `[0x22d24]`), then adds the 0xa00-entry gradient `[0x22900]`
indexed by `((r + sin[angle]) >> 8) + intensity` from the 320×240 polar table `[0x228fc]` (word r in
8.8, word angle>>8) into the back buffer `[0x21da0]` (plain dword add, no saturation), clipped.
Note: the angle word is `(atan2(x·k, y) (+2π if x≥0)) · 256/π` truncated to 16 bits and then `>>8`,
so it only takes a handful of values — reproduced as is.

## Engine functions needed (register-order args as in the asm)
* `fn_29060(eax, ebx, ecx=0, edx=-1, esi=float bits, edi=chunk, ebp=object)` build object (ecx/edx unused)
* `fn_2a094(ecx, ebp)`, `fn_28ed8(eax=1, ebp)`, `fn_2af3a()`, `fn_2b037(ebx=pathstate|record, ecx=[0x21dac])`
* `fn_28ca4(ebx=record16/walker, ecx=3, edi=ring+0x18)` → `[0x28c74..0x28c7c]`; it reads `[0x28c9c]`=0
* `fn_2afd3(ebx=0x2239c, esi=0x222d4, edi=path data, ebp=0x21dbc)` (reads `[0x28c9c]`)
* `fn_2a2ac(esi=0x222d4, edi=buffer, ebp=0x21dbc)`, `fn_2b0a8(esi=buffer, ebp=0x21dbc)`
* `fn_2438e(ebp)` (from `fn_2432c`)
Also `fn_156ff`, `fn_1570b` from hplus_fxA.js, `fn_29a`, `fn_2c2c8` from the core.

## Object-builder helpers (0x23f34..0x2436b, engine territory by meaning)
`fn_23f34` rsqrt table at `[0x23f30]` (called from engine init 0x28f5c), `fn_23f8c(eax=float bits)→ecx`,
`fn_23fd4(ebp)` per-vertex 1/nfaces (+0x38), `fn_24018(ebp)` face normals ×255/len (+0x18..+0x20, plane d
+0x24) and averaged vertex normals (+0x20..+0x28), `fn_241be(ebp)` bbox centre (+8..+0x10, divisor
`[0x28e68]`) and re-centering, `fn_242e3(ebp)` radius (+0x20), `fn_2432c(edx, ebp)` (allocs `[0x24382]`,
`[0x24386]`, copies 13 bytes to 0x2436b, `[ebp+0x5c]++`, tail-calls `fn_2438e`; used by part D 0x1d418).
Object struct: +0x2c nvertices, +0x30 nfaces, +0x34 vertices (stride 0x3c; xyz +4..+0xc, normal
+0x20..+0x28, 1/n +0x38), +0x38 faces (stride 0x30; vertex ptrs +0xc/+0x10/+0x14, normal +0x18..+0x20,
d +0x24). NaN results are stored as the x87 indefinite 0xffc00000 (`wrfn`) to match memory exactly.

## Validation
Function-level differential tests (memory identical to the emulator, `node test_fxF.js`): `fn_22d30`,
`fn_23124` ×4, `fn_23f34`, `fn_23fd4` ×3, `fn_24018` ×3, `fn_241be` ×3, `fn_242e3` ×3, `fn_23bd0` ×3 (with
hplus_engine.js loaded for fn_2af3a/fn_2b037). `fn_2432c`: own stores OK, the rest is fn_2438e (engine).
`fn_231ca`: validated only through its sub-functions (it interleaves engine builder calls).

Frame replay (`node replay_fxF.js`, needs hplus_engine.js): part F runs from the fn_236ef entry snapshot
with the emulator's per-frame inputs (fxF_tests/F_frames.jsonl, frames 2260..2929 = t 132.0..191.9 s,
song orders 25..33; the intro jumps/ends part F at order 33 row 38) and compares every presented frame with
fullT/fNNNNN.png: **all 670 frames match — 596 pixel-identical, worst frame 11 px (max channel diff 6)**,
covering all states (particles, explosion, light blob fn_22e68, camera path switches), and the generator
returns exactly where the original did (after frame 2929). The remaining ≤11 px are engine rasterization
rounding, not part F logic. Replay protocol that made this exact (useful for the other parts):
`gen.next()` first runs the update steps of the previous frame, then renders — so before `next()` the song
position must be the PREVIOUS flip's (order/row/tick of frames[i-1]); right before the engine's present
`[0x2ee54]` = frames[i+1].dt (the ms the original latched into `[0x28e28]` at that present; note the
run function itself resets `[0x2ee54]` at start, so it must be set inside a present wrapper); right after
present set the RNG state `[0x28e38]/[0x28e3c]` = frames[i].rng.
(The standalone `fn_22e68` snapshot pair in fxF_tests is unusable — the return breakpoint fired late
because of Unicorn TB caching; the replay covers fn_22e68 instead.)

## Engine signature notes (integrator)
hplus_engine.js declares `fn_2a2ac(esi, ebp, edi)`; this file (and hplus_fxA.js) call it in register
order `(esi, edi, ebp)` — one of them must be adapted (replay_fxF.js wraps it). `fn_29060` is declared
with 7 params `(eax, ebx, ecx, edx, esi, edi, ebp)` (ecx/edx unused) — called with ecx=0, edx=-1 here.
`fn_28ca4(ebx, ecx, edi)` and `fn_2438e(ebp)` as in the engine. The object-builder helpers 0x23f34..0x2436b
exist in both files (guarded here: the engine's versions win if loaded first; both are validated).

## Open issues
* `[0x21d94]` gets the caller's eax (garbage in the original); never read.
