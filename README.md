# hplus (browser port)

A JavaScript port of **halcyon(+)hplus** by Halcyon (64k intro, The Party 1998), reconstructed
by unpacking and disassembling `HPLUS.EXE`. The .nfo credits the intro to blitz, ren, shrine, ember,
placidity and croaker, with brothomstates (music) and the module player by digisnap / matrix.

Files:

| file | what |
|---|---|
| `index.html` | launcher (over a frame of the intro rendered live by the port) · the 320×240 image is fitted to the window with whole pixels (no smoothing) · `space` pauses · `←` / `→` skip 5 s · `f` fullscreen · `` ` `` the original's fps overlay · `esc` stops |
| `hplus.js` | browser glue: the frame loop (real time fed to the original's 1 kHz timer / per-frame ms counter), WebAudio streaming of the player with the song position taken from the audio clock, keyboard |
| `hplus_core.js` | the "memory image" (one `Uint8Array` mirroring the original's 32-bit segment and heap), PMODE allocators, RNG, integer/x87 helpers, the timer-callback scheduler |
| `hplus_engine.js` | the 3D engine: object loader (chunk format), textures/shade tables, transforms, clipping, polygon/line/particle rasterizers, camera splines, present + fps overlay |
| `hplus_player.js` | the module player (loader, XM-style tick/effects, envelopes, the SB16 mixer) |
| `hplus_sound.js` | glue between the memory image and the player |
| `hplus_fxA.js` … `hplus_fxF.js` | the six parts of the intro |
| `hplus_main.js` | startup (table building, module decryption, precalcs), the part sequencer, the object loader's data-stream callback |
| `hplus_data.js` | the intro's data (the WWPACK-unpacked 32-bit image of `HPLUS.EXE`), gzip + base64 — the page needs no DOS exe or unpacker at runtime, and works from `file://` |
| `notes/` | conventions of the port and the reverse-engineering notes of each subsystem (engine, player, parts B–F) |
| `tools/` | the unpacker/disassembler/emulator/validation scripts (Python + Unicorn/Capstone, node) |

Works from `file://` (the data is embedded and unzipped with `DecompressionStream`); needs WebAudio and a 2D canvas. Runs at the display
refresh rate (capped at 60 fps, `?fps=`); like the original, the parts step their animation in 14 ms
units per presented frame. The one exception is the ray-cast tunnel (part D), which the original
advances a fixed three steps per frame — its speed is the frame rate of the machine — so the port
presents that part at 30 fps (`?dfps=`), about what a fast 1998 PC managed there.

## How the original works

`HPLUS.EXE` is a WWPACK-compressed MZ executable (65,403 bytes → 196,326 bytes unpacked). The
WWPACK stub copies the packed stream to the top of the program's memory and decompresses it back
to the load address: an LZ coder with 2-bit opcodes (literal run · "recent distinct byte" — a 4-bit
index into the distinct byte values most recently seen in the output · length-2 match · length ≥3
match with 5–15-bit offsets and a multi-level length code) fed from a 16-bit, MSB-first bit buffer;
then it applies the MZ relocations and jumps into the program.

The program is Tran's **PMODE v3** (raw/VCPI/DPMI 32-bit extender; here raw): a 16-bit stub checks
for a 386, enables A20, takes extended memory from `int 15h/88h`, builds GDT/IDT and jumps to the
32-bit flat code (selectors 08/10 based at the 32-bit segment, 18 zero-based). Real-mode services
are reached through PMODE's `int 33h` (al = interrupt number, registers in the `v86r_*` block at
offset 0xac of the segment); IRQ handlers are installed with `_setirqvect`; low/high memory come
from bump allocators (`_getlomem`/`_getmem`).

Startup: prints "hplus loading", builds a 64×64 texture from 32×32 source data, initialises the
engine tables, detects the sound card from the `BLASTER` environment (GUS or SB16; nosound
otherwise), decrypts the 48 KB music module (`rol 1; add 0x85`, then `ror 5` after the precalcs),
builds a 256×256 word multiplication table (used by all the blends), runs the six parts' precalcs
(≈10 MB of heap: objects, textures, buffers), selects the video mode — 320×240×32 with a linear
framebuffer (`-v0…-v6` forces a mode), double-buffered with VBE display-start — installs a
keyboard IRQ handler, starts the music and runs the parts, each until the song reaches a given
order/row:

1. part A (9 orders + 20 rows): wireframe grid floor, flat-shaded cube structures and blue
   wireframe objects along camera paths, fade from black;
2. part B (3 orders + 58 rows): textured tunnel objects with blue particles and a blue-channel
   glow smear; part C (to row 61): a textured twisted tube with particles on splines; part B again
   (1 order); part C again (4 orders);
3. part D (4 orders): a ray-cast textured cylinder with a sphere and 2000 light-darkening
   particles, zoom/cross-fade transitions; part E (4 orders + 2 rows): a textured object with
   stamped marks, particles and light rays; part F: rings, an additive light blob, an explosion
   and camera-path switches, ending at order 33;
4. part A again (fade-out variant with a random noise "glitch" and the logo) until its own timer
   runs out (≈ 28 s), then exit.

All motion is time-based: a 1 kHz timer IRQ counts milliseconds; each presented frame records the
elapsed ms and the part runs `floor((ms+1)/14)` update steps, so the speed depends on the frame
rate the way it did on a 1998 PC (the emulated reference ran at ~25 fps at 30 MIPS). The timer IRQ
also drives up to four scheduled callbacks (16.16 Hz rates): the player's tick, the SB16 mixing
slots, and a random "glitch" trigger (every 30 ms: master volume 12 or 0) used by the ending.

Sound: SB16, 44.1 kHz 16-bit stereo (unsigned), auto-init DMA into a 64 KB buffer at a 64 KB
boundary of a 128 KB low-memory block; the mixer runs in 140 Hz timer slots ahead of the DMA
position (polled on port 0xC4). The module is a compact XM-derived format (36 orders, 33 patterns,
20 instruments with volume/panning envelopes and auto-vibrato, linear frequencies, speed 6,
138 BPM); every sample is a tiny chip-style waveform.

## Port notes

* `HPLUS.EXE` is unpacked once (with `wwpack.js`, in `tools/`) and the resulting 193 KB data image is
  shipped gzipped in `hplus_data.js` (65 KB, the same size as the packed exe); the page loads that, so
  it needs neither the DOS executable nor the WWPACK decompressor at runtime. (`HPLUS.EXE` — the
  original release — is not included here; drop it in to run the `tools/`.)
* The port keeps the original's memory layout: one `Uint8Array` holds the unpacked 32-bit segment
  (data, tables, the music) plus the original heap; every global stays at its original offset and
  the PMODE bump allocators are mirrored, so the port can be diffed against memory snapshots of the
  original running in an emulator (a headless Unicorn setup providing DOS, PMODE's services, the
  VESA LFB, SB16/DMA and the PIT was written for this — `tools/`). Functions are named after their
  original offsets (`fn_15c18` …) with readable aliases and comments; each part's run loop is a
  generator that yields once per presented frame.
* x87 code is transliterated with intermediates as doubles and rounding at every `fstp dword`
  (`Math.fround`); `fistp` rounds half-to-even — except in the engine's draw loop, which the
  original runs with the x87 set to truncate. Integer code (fixed point, the multiplication-table
  blends, the rasterizers, the mixer) is exact.
* Validation: the port was replayed frame by frame with the emulator's per-frame inputs (elapsed
  ms, RNG state, the song position at every sync read) and compared pixel for pixel with the
  emulator's 4287 frames of the whole intro: 3954 frames are identical, 154 differ by at most 33
  pixels (last-bit rounding of texture coordinates, 80-bit x87 vs doubles), and the remaining 179
  are in the "glitch" ending, whose random brightness flicker is decided by the 30 ms timer
  callback between frames (same effect, a different random pattern). The music is tick-exact with
  the emulator's SB16 DMA stream over the whole intro.
* In the browser the song position the effects see is the one audible now (the player renders
  ahead into WebAudio; `positionAtFrame` on the audio clock), so the visual sync follows the sound.
  The first part's prologue runs before the audio starts, so — as in the original, which enters it
  microseconds after starting the music — it latches start order 0 (the player jumps to order 1 on
  its first tick); getting this wrong cuts the first camera shot and shifts every part by an order.
* Frame pacing: parts A, B, C, E, F run `floor((ms+1)/14)` update steps per presented frame (so at
  any frame rate ≥ 25 fps they advance 50–70 steps/s, as on period hardware; the reference emulation
  ran them at 9–26 fps); part D calls its update exactly three times per frame, so the port paces
  that part at 30 fps rather than letting a modern display run its camera 2–4× faster.
* Seeking: the intro is a running program, not a function of time, so `→` fast-forwards the
  simulation (frames are computed, not shown; the music is advanced in lockstep) and `←` restores
  a snapshot — program memory as blocks differing from the post-init baseline plus the player's
  state, taken at every part entry and every 10 s — and fast-forwards from there; a restart from a
  part's entry re-runs its prologue exactly as the original did.
* Kept as in the original: the 0.12 % tempo rounding of the player (integer frames per tick), the
  bump-allocator overflow of part C's path block (harmless, mirrored), NaNs stored as the x87
  indefinite, and the engine's 1-ulp texture rounding quirks.

This port was made with Claude Fable 5.
