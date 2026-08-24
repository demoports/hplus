# Reading the port

`HPLUS.EXE` is a single flat 32-bit DOS program — no source ever existed. This port was made by
unpacking and disassembling it, so the code is a transliteration, not a rewrite. That explains
almost every unusual thing about it, and it is worth knowing before reading a single line:

* **State lives in one byte array.** `HP.M` mirrors the original's 32-bit segment 1:1, so a pointer
  in the disassembly is literally an index into `M`. Globals are never hoisted into JS variables —
  keeping them in place is what lets the port be diffed against emulator memory snapshots.
* **Functions are named after their address.** `fn_2a2ac` is the routine at offset `0x2a2ac`.
  The name is the map back to the binary, so it never changes.
* **`HP` is the address space, not an app object.** The original could `call 0x2a2ac` from anywhere;
  `HP` is the flat namespace that reproduces that once the code is split across files. Every module
  imports `HP` and hangs its own functions on it, which also lets `tools/replay.js` swap a function
  at runtime to instrument a validation run.
* **Per-frame loops are generators.** A routine that the original ran until `ret` becomes a
  `function*` yielding once per presented frame.

See `PORT_CONVENTIONS.md` for the full rules.

## Where to start

1. **`index.html`** — the launcher, and the shortest file that shows the public surface: `HP.preview`
   and `HP.start`.
2. **`hplus.js`** — browser glue. Real time in, frames and audio out. Read `HP.start`'s frame loop.
3. **`hplus_core.js`** — the memory image and the accessors (`rd32`, `wrf`, …) every other file uses.
   Small, and nothing else makes sense without it.
4. **`hplus_addr.js`** — names for the addresses that are understood. A good index of "what globals
   does this program actually have".
5. **One effect**, e.g. `hplus_fxB.js` — the smallest complete part. Its header states the address
   range it owns and its `const` alias block states exactly what it calls from elsewhere.
6. **`hplus_engine.js`** — the 3D pipeline. Big; read `ENGINE_NOTES.md` alongside it.

## Map

| file | original range | what |
|---|---|---|
| `hplus.js` | — | browser glue: frame loop, WebAudio streaming, keys, seeking |
| `hplus_core.js` | `0x27c`–`0x2ef6e` | memory image, accessors, PMODE allocators, RNG, x87/integer helpers, timer |
| `hplus_addr.js` | — | names for known addresses (no code) |
| `hplus_main.js` | `0xe1ba`–`0xe2bc` | startup, precalcs, the part sequencer |
| `hplus_engine.js` | `0x23f34`–`0x2cd68` | 3D pipeline: object loader, transforms, clipping, rasterizers, present |
| `hplus_player.js` | — | the module player (standalone; no memory image) |
| `hplus_sound.js` | `0xd5b`–`0x2cf9a` | glue between the memory image and the player |
| `hplus_fxA.js` | `0x1545e`–`0x15fb0` | part A — wireframe grid floor, flat-shaded cubes |
| `hplus_fxB.js` | `0x1804a`–`0x184f0` | part B — textured object, particle field, blue smear |
| `hplus_fxC.js` | `0x1b4a6`–`0x1bb90` | part C — textured object, 255 particles on splines |
| `hplus_fxD.js` | `0x1cbb4`–`0x1dcaf` | part D — ray-cast tunnel (the 30 fps one) |
| `hplus_fxE.js` | `0x1f87e`–`0x20262` | part E — textured object, particles, light rays |
| `hplus_fxF.js` | `0x22d30`–`0x2436b` | part F — exploding mesh, 800 ring particles |

Each part file owns a disjoint address range. Anything it calls outside that range appears as a
forwarding alias at the top of the file, so the dependency list is code rather than prose.

## Addresses

`hplus_addr.js` names the globals that have been worked out; everything else stays a hex literal at
the call site. That contrast is deliberate — `rd32(ADDR.playerState)` means someone identified it,
`rd32(0x251d0)` means nobody has yet. Adding a name there is the easiest useful contribution.

Two things worth recognising while reading:

* **Scratch slots.** `ADDR.tmpF`, `ADDR.tmpF2`, `ADDR.cullTmp` are x87 spill slots: written and immediately
  read back, often to reinterpret a float as its bits and test the sign (`sign(ADDR.tmpF2)`). They are
  not program state.
* **Float constants live in memory.** The original loaded constants with `fld`, so `rdf(ADDR.const2)`
  is how it says `2.0`, and `rdf(ADDR.constHalf)` is `0.5`.
