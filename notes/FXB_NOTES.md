# Part B (0x1804a..0x185c2) — hplus_fxB.js

Textured tunnel/room (two "Obu!Word Txtr" chunk objects built at precalc: `0x161d4` (tag "K-", 4099 bytes)
and `0x171db` ("LA", 1771 bytes)) seen through camera paths that switch on every song-order change, with a
field of 0xc0 blue particles flying along one axis, and a horizontal smear of the blue channel that gives the
blue glow. In the reference run it is on screen from ≈66 s (order 10 row 20) to ≈92 s (order 13 row 58), and
again for one order after the first part C (`fn_182fc(1,0)`).

## Functions (all in hplus_fxB.js, names = original offsets)
| fn | args (register order) | what |
|---|---|---|
| `fn_1804a(esi, edi, ebp) -> edi` | | randomizes 0x40 particle records (0x2c bytes each) at `edi`: `+8` = rand(0x320)-0x190, `+4` = rand(0x28)+ebp, `+0xc` = rand(0x28)+esi, `+0x20` = -12.0 (floats); returns the advanced edi — the three calls in the init chain it (0xc0 records total at `[0x17e00]`) |
| `fn_180ec(ebp, edi)` | ebp = field offset (8), edi = records | per record i: `v = [edi+ebp] + tbl[i&7]*0.2; if (v-300) >= 0: v += -600` (wraps the particles); tbl at `0x180bc` (8 floats), constants `0x180e0..0x180e8` = 0.2, 300, -600; sign test via float32 store at `0x180dc` |
| `fn_18135(ecx, edx, edi)` | cl, dl = blend weights (sum 255), edi = 320x240x32 buffer | horizontal IIR smear of the BLUE byte only: `b' = (mt[cl][b] + mt[dl][prev]) >> 8`, prev = previous output in the row (0 at row start); `mt` = the 256x256 word multiplication table at `[0x1088]` |
| `fn_1816a()` | | precalc: `[0x178d8]` = buffer (0xb6010 alloc, 16-aligned; `[0x178dc]` = +0x4b000 second page); `[0x23fd0]`=0x64 then 0x9c4 (engine param before each object build); builds the two objects into the object block `0x178ec` via `fn_29060(eax=0/3, ebx=1/9, edx=-1, esi=[0x178e0], edi=[0x178d8], ebp=0x178ec)`; `[0x17914]=1, [0x17918]=0x1a, [0x17919]=0x1a, [0x1791a]=0x28` (overlapping dword stores kept); clears 0x25800 dwords of the buffer; `fn_2a094(ecx=0xc0, ebp=0x178ec)`; `fn_28ed8(eax=1, ebp=0x178ec)`; particles: 3×`fn_1804a` at `[0x17e00]` (set by the engine during object build); copies `[0x17e78..0x17e84]` → `[0x17974],[0x17978],[0x1797c],[0x17910]`; `[0x17d58]=1.0`, `[0x17d5c]=255.0`; fills the 256x256 texture at `[0x17d64]` (engine-assigned) with row gradient `y>>2` |
| `fn_184f0()` | | one 14 ms update step: skipped entirely if `[0xa01]` (pause); `fn_2af3a()`, `fn_2b037(ebx=0x17e68, ecx=[0x178e0])`, `fn_180ec(8, [0x17e00])`; on song-order change (`[esi+0x30]` vs `[0x17ebc]`): `[0x17eb8]++`, and if `[0x17ee0+(i&3)*4] != [0x17edc+(i&3)*4]` → new camera path: `[0x17e6c]=[0x17ed0+i*4]`, `[0x17e74]=[0x17ec0+i*4]`, `[0x17e70]=0`, `[0x17e68]=0.0`; angles `[0x17e9c..0x17ea4] += [0x17ea8..0x17eb0]` |
| `fn_182fc*(eax, ebx)` | eax = orders to run, ebx = row | run loop (generator, yields after present): init `[0x178c8]=eax, [0x178cc]=ebx, [0x17ebc]=[0x178d0]=start order, [0x17eb8]=0`, first camera path, `[0x2ee54]=0`, fill buffer with color `[[0x17d50]]`; per frame: path=`[0x17ee0+(i&3)*4]`, `[0x28c9c]=1`, `fn_2afd3(ebx=0x17e68, esi=0x17e04, edi=path, ebp=0x178ec)`, copy `[0x17e04..0x17e18]` → `[0x1795c..0x17970]`, `fn_2a2ac(esi=0x17e04, edi=[0x178d8], ebp=0x178ec)`, blend weights `r = fistp(sin(a·0.412)·sin(c·0.412)·128+128)` → `[0x17e8c]=255-r, [0x17e90]=r`, `fn_18135(255-r, r, [0x178d8])`, `fn_2b0a8(esi=[0x178d8], ebp=0x178ec)` (present) → yield; `[0x178d4]=2`; `floor(([0x28e28]+1)/14)` × `fn_184f0()`; refill buffer with `[[0x17d50]]`; ESC (`[0x9c9]`) → `[0x1084]=1` return; else loop until `order >= start+eax && row >= ebx` |

External: `fn_29a`, `fn_2c2c8`, `fn_156ff` (part A helper), engine `fn_29060, fn_2a094, fn_28ed8, fn_2afd3, fn_2af3a, fn_2b037, fn_2a2ac, fn_2b0a8`; player state `[0xe20]` (+0x30, +0x34).

## Data (image offsets)
* `0x178c8..0x178e8` part globals (eax/ebx params, start order, flags, buffer pointers, `[0x178e0]` = 1.0f, `[0x178e4]` = 0.9f, `[0x178e8]` int→float scratch)
* `0x178ec` object block (engine layout; `[0x17e00]` particle records ptr, `[0x17d50]` ptr to fill color, `[0x17d64]` texture ptr — all filled by `fn_29060`)
* `0x17e04..0x17e18` camera position/target (output of `fn_2afd3`), `0x17e68..0x17e74` path state, `0x17e78..0x17e84` (300, 0.3, 0, -6000) copied into the object, `0x17e94/0x17e98` 128/128, `0x17e9c..0x17ea4` angles, `0x17ea8..0x17eb0` angular speeds, `0x17eb4` 0.412, `0x17eb8` path index, `0x17ebc` last order, `0x17ec0..0x17ecc` ints (0xa0,0xa0,0xc8,0xa0), `0x17ed0..0x17edc` floats (.002,.0013,.004,.0033), `0x17ee0..0x17eec` path pointers (0x17ef4, 0x17fa8, 0x17f44, 0x17ff8)
* `0x180bc` 8 floats (5.517, 6.035, 3.682, 4.213, 4.086, 4.512, 5.124, 4.875), `0x180dc` scratch, `0x180e0` 0.2, `0x180e4` 300, `0x180e8` -600

## Validation (`node test_fxB.js`; snapshot pairs in fxB_tests/ made by emuB.py / emuB2.py with emu_trace.TEmu)
Bit-exact (whole-memory diff, ignoring only the original stack area and the regions the timer IRQ / music
player write asynchronously while the function runs — timer tables 0x2ee3d..0x2ee64, low memory DMA buffer,
player state/mix buffers):
* `init1804a` — the three chained `fn_1804a` calls at precalc (0xc0 particle records + RNG state + returned edi).
* `fn180ec` ×3 — particle movement (three different frames, t≈46 s).
* `fn18135` ×3 — blue-channel smear of the whole 320x240 buffer (three frames, weights 127/128, 90/165, 35/220).
* `run_init` — `fn_182fc_init(3, 0x3a)` from the emulator's state at the fn_182fc entry vs. the state at the first
  loop top: part-B variables + the filled buffer identical.
* `frame_render` blend weights ×3 — `fn_182fc_blend` (fsin/fsin/fistp) gives the same (255-r, r) as the emulator.
* `update_block` ×3 (engine stubbed) — the non-engine part of `n` update steps (particles, order-change path
  switch, angle increments) identical; only `[0x17e68]`, which the engine's `fn_2b037` advances, differs as expected.
Still to run once hplus_engine.js exists (the tests auto-enable): `frame_render` full (camera → render → blend →
smear, diff of the whole memory before the present call) and `update_block` with the real `fn_2af3a/fn_2b037`;
then whole-frame comparisons against fullT PNGs.

## Where part B is in the reference runs
fullT (per-frame PNG/jsonl, 30 MIPS emulation): `fn_182fc(3,0x3a)` entered at t=45.96 s with song position
order 9 row 20 (part A's exit — the order list starts with a jump, so "order 10" of the main sequence is 9 here);
frames 1141..1365 (t 46.05..70.06, ends at order 13 row 58). The second run `fn_182fc(1,0)` is only ~2 frames
(≈1368..1369, t≈70.3–70.5), right after the 3-row first part C.
