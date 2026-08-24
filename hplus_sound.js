// hplus port — sound glue between the memory-image port and the standalone player (hplus_player.js):
// fn_d5b (sound init: mirrors the original's allocations so the heap layout stays identical and sets [0xe20]),
// fn_f50 (start: creates the player from the decrypted module in M), fn_f6c (set global volume), fn_f80 (stop),
// fn_2cf9a (driver call: master volume 12/0, used by the timer "glitch").
import { HP } from './hplus_core.js';
import { ADDR } from './hplus_addr.js';
import { HPlusPlayer } from './hplus_player.js';

// functions this file calls from elsewhere (forwarding, so the HP entry stays late-bound
// and tools/replay.js can still swap it at runtime)
const alloc    = (...a) => HP.fn_29a(...a);   // core: fn_29a — high memory
const allocLow = (...a) => HP.fn_27c(...a);   // core: fn_27c — low memory

const P = HPlusPlayer;
const { rd32, wr32 } = HP;
HP.fn_d5b = function () {
  allocLow(0x20000);                                   // 128 KB low-memory DMA block
  const p = alloc(0x3740 + 0x4000 + 0x3c00);        // player state + driver memory (+ alignment slack), as the original's himem advance
  // the original: [0xe20] = 16-byte aligned state ptr; the driver block follows. We only need the pointer for sync fields.
  wr32(ADDR.playerState, (p | 0xf) + 1);
  wr32(0xe10, 0);                                       // sound present
  wr32(0xe14, 2);                                       // card type (SB16)
  HP.player = null;
};
HP.fn_f50 = function (esi, eax) {                       // esi = module (already through both decrypt stages), eax = global volume
  if (!P) throw new Error('player missing');
  const mod = HP.M.slice(esi, esi + P.MODULE_SIZE);
  HP.player = P.create(mod, { random: HP.fn_2c2c8 });   // shares the intro's RNG (used by the glitch effect)
  HP.player.setGlobalVolume(eax);
  const s = HP.DV.getUint32(0xe20, true); wr32(s + 0x30, 0); wr32(s + 0x34, 0); wr32(s + 0x23, 0);
};
HP.fn_f6c = function (eax) { if (HP.player) HP.player.setGlobalVolume(eax); };
HP.fn_f80 = function () { if (HP.player) HP.player.stop(); };
HP.fn_2cf9a = function (eax) { if (HP.player) HP.player.setMasterVolume(eax); };
