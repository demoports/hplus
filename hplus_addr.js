// hplus port — symbol table for the original's address space.
//
// The port keeps every global where the original kept it: inside the memory image M, at its
// original 32-bit offset (see notes/PORT_CONVENTIONS.md).  Nothing here moves or caches a value —
// these are just names for the addresses, so `rd32(ADDR.playerState)` reads exactly what `rd32(0xe20)`
// read, and the mapping back to the disassembly stays visible in this one file.
//
// Addresses that are still only understood as a number are deliberately left as hex literals at
// the call site: a name here means someone worked out what it is.

export const ADDR = Object.freeze({

  // timer and frame pacing (PORT_CONVENTIONS.md "Frame loop / time")
  timerMs: 0x2ee54,             // incremented by the 1 kHz timer IRQ; present() copies it out and clears it
  frameMs: 0x28e28,             // ms taken by the last presented frame; effects run floor((frameMs+1)/14) update steps
  glitchLevel: 0x2ee58,         // non-zero = the effect-driven random audio "glitch" is armed (see fn_2cf9a)

  // keyboard flags, filled by the key handler at 0xbe0
  keyEsc: 0x9c9,                // 1 = ESC pressed; effects then set partExit and return
  keyPause: 0xa01,              // 1 = paused
  keyFps: 0x9f1,                // 1 = show the original fps overlay
  partExit: 0x1084,             // set to 1 by a part to tell the sequencer it is done

  // music
  playerState: 0xe20,           // pointer to the player state block: +0x30 order, +0x34 row, +0x23 tick

  // RNG (fn_2c2c8), seeds 0x49180712 / 0x1294792
  rngS1: 0x28e38,
  rngS2: 0x28e3c,

  // engine float constants (ENGINE_NOTES.md "Globals worth knowing")
  constHalf: 0x28068,           // 0.5
  const1: 0x28e64,              // 1.0
  const2: 0x28e68,              // 2.0
  const3: 0x28e6c,              // 3.0
  const4: 0x28e70,              // 4.0
  const16: 0x28e74,             // 16.0
  angle16Scale: 0x268e0,        // 65536.0 — 16.16 angle -> float
  fixed16Scale: 0x2806c,        // 65536.0 — float -> 16.16 fixed point
  sortZScale: 0x251b8,          // 4.0 — z scale of the depth sort key

  // engine tables
  clampTable: 0x28070,
  shadeRamp: 0x29090,           // flat-shading ramp, 0x100 entries
  recipTable: 0x26994,          // 1/n
  particleScale: 0x28810,       // particle level scale table
  particleOffset: 0x28910,      // particle level offset table

  // engine scratch: x87 spill slots, not state (written then immediately read back,
  //   often to reinterpret a float as its bits and test the sign)
  tmpF: 0x28e40,
  tmpF2: 0x28e48,
  cullTmp: 0x251d0,             // frustum-cull sign tests (fn_251e0)
  bboxMinX: 0x23fb8,
  clipVertCount: 0x26640,       // vertex count of the ping-pong clip buffers 0x265a0 / 0x265f0
  drawItemCount: 0x2a230,
  listAWrite: 0x2a238,          // current write pointer, draw list A
  listBWrite: 0x2a23c,          // current write pointer, draw list B
});
