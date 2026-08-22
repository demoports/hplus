# hplus music player — port notes

Files (scratchpad):

* `hplus_player.js` — the player (node + browser, no deps). `HPlusPlayer.create(moduleBytes)`,
  `HPlusPlayer.decrypt(bytes)`, `HPlusPlayer.extractModule(image32Bytes)`.
* `music_dec.bin` — the decrypted module (0xbc08 bytes) = `image32[0x1090..0x1090+0xbc08]` decrypted.
* `test_player.js` — tick-by-tick comparison against an emulator reference (`snd_ref*/ticks.bin`,
  `events.txt`), sample-exact; `dbg_chans.js` — per-tick channel-struct diff (`chans.bin`).
* `emu_snd.py` — instrumented emulator run producing the reference (`ticks.bin`: per tick output words;
  `chans.bin`; `events.txt`: start/setvol/underrun events with tick index and mixing-slot info).
* `hplus_music_js.wav` — 250 s rendered by the JS player.

## API

```js
const p = HPlusPlayer.create(moduleBytes);      // moduleBytes = decrypted module (music_dec.bin)
p.render(int16Array, nframes [, offset]);       // interleaved L,R signed 16-bit, 44100 Hz
p.tickOnce();                                   // run one player tick; returns Int16Array of the frames of the PREVIOUS tick
p.position();        // {order,row,tick,speed,bpm,ticks,frames,framesPerTick,playState,globalVolume,looped,pattern}
p.positionAtFrame(f) // {order,row,tick,tickIndex,tickFrame} audible at output frame f (binary search over a tick log)
p.channel(i)         // {flags,note,period,volume,pan,finalVolume,finalPan,envVolume,instrument,sample,active,keyOn}
p.channels           // 20
p.setMasterVolume(v) // driver master volume D+0x70 (the intro: 12 = normal, 0 = muted by the glitch effect)
p.setGlobalVolume(v) // state+0x1e (0..64); the intro starts the song with 0x3f (0xf50), the song itself fades in from 0
p.jumpOrder(delta)   // 0x2d161 (stop, wait 2 ticks, order += delta, resume) — not used by the intro as far as seen
p.stop()             // 0xf80 semantics (voices ramp out over the next ticks)
p.glitch = N; p.timerGlitchStep()   // the intro's dropout effect, see below
p.hooks.beforeTick / afterTick / beforeMixChannel(api, ch)   // instrumentation
p.mem, p.S, p.D, p.CHN, p.u8/s8/u16/s16/u32/s32/w8/w16/w32   // raw access (offsets as in the original)
```

Output timeline: the first rendered frame is the single silent frame the original converts before its first
tick (initial `D.64 = 1`); from then on each tick produces `framesPerTick` = `(44100<<16) / (bpm*0x6666)`
frames (integer: 798 at 138 BPM, i.e. 55.26 ticks/s — the integer division makes the song 0.12 % fast vs. XM).
In the original the DMA stream additionally starts with 5512 frames of the 0x8080 buffer fill (1/8 s of +128 DC)
and the player runs idle (882-frame silent ticks) from sound init until the intro calls "start" after its precalc
(119 idle ticks in the emulator run) — the JS output starts at the first real tick.

Performance: 60 s of audio renders in ~1.1 s in node (55x real time).

## Validation

`emu_snd.py` hooks the original at the output-conversion call (`0x2e88c/0x2e88f`: writes one tick's words into
the DMA buffer) and dumps each tick's words + player position, and the 20 channel structs after each tick.
`test_player.js` runs the JS tick by tick and compares the words (after XOR 0x8000) sample for sample, replaying
the master-volume events at the exact mixing slot (the original's 140 Hz mixer callback mixes one channel per
slot; a `setvol` between slots affects the remaining channels of that tick only).

Results:

* 75 s run (`snd_ref`, 4121 records): 4001/4001 ticks bit-exact (all of the first 58 s of music).
* 260 s run (`snd_ref2`, the intro exits by itself at 248.5 s, 13710 records, 1097 master-volume events in the
  last part): **13590/13590 ticks bit-exact** (`node test_player.js snd_ref2`), i.e. the whole song as played by
  the intro, including the dropout section. 5 of those ticks match only with the alternative placement of a
  master-volume event (see below); no underruns, no order jumps, the intro never calls anything but
  init/start/stop.
* Whole DMA stream of the uninstrumented full run (`node test_player_wav.js full/audio.wav`): sample-exact from
  the start to 213.9 s; the rest differs only by the random master-volume dropouts of the last part (that run
  has no event log): in 213.9–245.7 s the reference is 69.5 % silent (muted), 19.6 % identical to the JS, and
  the remaining 10.9 % are the partially-muted ticks around the toggles.

Event placement caveat (reference side, not the player): the dropout `setvol` runs in the 1 kHz timer IRQ,
which can nest inside the 140 Hz mixer callback. `events.txt` records the mixer's channel countdown `d36`; the
event applies before channel `21-d36` of the tick being mixed, except when the IRQ landed (a) between the
countdown decrement and that channel's volume read (then one channel earlier) or (b) during the output
conversion of the previous tick (logged with `d36=20` and the previous tick's index; then it applies from
the next tick). The harness tries these alternatives when a tick mismatches; 5 ticks of 13590 needed one.

## Module format (custom, converted from XM; linear frequency table)

Header (dwords): songlen(36) restart(33) channels(20) patterns(21) instruments(13) flags(1 = linear) speed(6) bpm(138),
then `songlen` order bytes. Then `patterns` blocks: dword length (incl. 8-byte header), dword rows, then
packed rows: for each row, for each channel: a count byte n, then n words: low byte = effect number (or
0x80|note for a note, recorded as pseudo-effect 0x30 with param = instrument), high byte = parameter.
Effects are evaluated from the last word to the first.
Then `instruments` blocks: byte nsamples, byte flags (1 keymap[96], 2 volume envelope, 4 panning envelope,
8 autovibrato), keymap, volume envelope (npoints, sustain, loopstart, loopend, npoints×(dx,y) words — x is the
*delta* to the previous point, y is 0..256 —, one extra terminal (dx,y) point, fadeout word), panning envelope
(npoints, sus, ls, le, points, extra point), autovibrato (waveform, sweep, depth, rate), then nsamples sample
blocks: dword length (incl. 0x16 header), dword loopstart, dword loopend, dword dataptr (0 in file; set at load),
byte flags (4 = 16-bit, 8 = loop, 0x10 = ping-pong, 0x80 = frequency shift), s8 finetune, s8 relnote, vol, pan,
byte freqshift (octaves; applies when flags&0x80), then the sample data (8-bit signed or 16-bit signed).
All samples are tiny (the biggest 2.5 KB) — chip-style waveforms and short loops.

Effect numbers (jump table 0x2cdb5, flags 0x2cd84: bit0 negate, bit1 signed, bit2 on tick 0, bit3 on other
ticks, bit4 memory, bit5 xy nibble memory): 0 arpeggio, 1/2 porta up/down, 3/4 fine porta, 5/6 extra-fine porta,
7 tone porta, 9 vibrato (a = depth, x nibble in the next slot, waveform in slot 0xb), 0xc set volume,
0xd..0x11 volume slides, 0x12 tremolo (waveform in slot 0x14), 0x15 note cut, 0x16 tremor, 0x17 set global vol,
0x18 global vol slide, 0x19 set pan, 0x1a/0x1b pan slide, 0x1c pattern jump, 0x1d pattern break, 0x1e pattern delay,
0x1f pattern loop, 0x20 set speed, 0x21 set BPM, 0x22 sample offset, 0x23 note delay, 0x24 key off,
0x25 set envelope position, 0x26 retrig, 0x27 retrig+volume, 0x30 note trigger (param = instrument, 1-based).

## Player structure (all offsets relative to the original's 32-bit segment; the JS keeps the module at 0x1090)

State block (0x3740 bytes, pointer at [0xe20] and [0x2cd80]; JS: `S`):
`+0` driver ptr, `+4..+0x18` driver fn table, `+0x1c` play state (4 playing, 3 fading, 2/1 stopping, 0 stopped),
`+0x1e` global volume (dword), `+0x23` tick counter, `+0x27` pattern delay ticks, `+0x2b` jump flag,
`+0x2c` rows to skip, `+0x30` order, `+0x34` row, `+0x38` rows in pattern, `+0x3d` pattern data ptr,
`+0x43` loop row, `+0x47` loop count, `+0x4b` step factor `(0x100<<32)/rate`, `+0x50` header copy
(`+0x58` channels, `+0x68` speed, `+0x6c` bpm, `+0x70` orders), `+0x170` pattern ptrs, `+0x570` instrument ptrs,
`+0x770` sample ptrs, `+0x970` 768-entry frequency table, `+0x1570/0x1670/0x1770/0x1870` waveforms
(sine(parabolic), square, ramp, ramp), `+0x1970` channels (20 × 0xe5), `+0x3679` 16 semitone factors,
`+0x36b9` song-looped flag.

**Sync: the intro's effects read only `order` (`state+0x30`) and `row` (`state+0x34`)** (e.g. `cmp [esi+0x30],0x13`,
`cmp [esi+0x34],0x24` in part D at 0x1d728; parts A/B/C/D/E/F all compare order against thresholds; part A
also stores the order at 0x1530c/0x14514). Use `position()` / `positionAtFrame()`.

Channel struct (0xe5 bytes): `+0` flags (bit0 key on, bit1 ramp out old voice, bit2 active, bit3 new note,
bit7 volume set), `+1` pending note, `+3` base period, `+7` period (note*64 + finetune + 0x600 in linear mode),
`+0xb` period offset this tick, `+0xf` volume, `+0x13` volume delta (tremolo/tremor), `+0x17` fadeout (0x8000),
`+0x1b` pan, `+0x1f` retrig counter, `+0x23` new-row flag, `+0x24/0x26` vol env pos/point, `+0x2a/0x2c` pan env,
`+0x30` porta target, `+0x34/0x35/0x36` vibrato/tremolo/autovib pos, `+0x37` autovib sweep, `+0x3b` instrument hdr,
`+0x3f` sample hdr, `+0x43` sample flags, `+0x44/0x48/0x4c` sample start/loop start/loop end (absolute; word index
for 16-bit samples), `+0x50` step (16.16), `+0x54` final volume (0..256), `+0x58` final pan (0..256),
`+0x5c/0x60` mixer vol L/R, `+0x64..0x6c` previous values (for the 64-sample ramps), `+0x70..0x82` mixer voice
(flags, loop start/end, direction/ended, position, fraction, step), `+0x8e` envelope volume, `+0x92` envelope pan,
`+0x9e` number of row effects, `+0x9f..` effect numbers, `+0xa7..` params, `+0xaf+e` effect memory,
`+0xe0` arpeggio offset, `+0xe4` frequency shift.

Tick (0x2d1d0, at `0.4*bpm` Hz): bookkeeping (copy previous volumes, clear flags), on tick 0 read the next row
(0x2d28e), effects (0x2d342), voice parameters (0x2d80e: volume×global>>4, envelopes (0x2d9cf) with fadeout,
panning envelope, autovibrato, frequency = table[(period+offset) mod 768] << 8 >> (12 - (period+offset)/768 +
freqshift), step = freq·(2^40/rate)>>32).

Mixer (SB16 16-bit stereo path, 0x2eb6a): per tick and channel, `volL = ((vol·master>>3)·(0x10000-pan²))>>16`,
`volR` likewise with `(pan-0x100)²`; new notes ramp in from 0 and volume changes ramp over 64 samples
(0x2ed09, re-entering with the remaining count when a loop point splits the run); voices that ended ramp out;
linear interpolation (8-bit: `(s0<<8) + ((s1-s0)·frac16>>8)`, 16-bit: `s0 + ((s1-s0)·frac15>>15)` with a 15-bit
fraction that drops the lowest step bit); products accumulate into a dword stereo accumulator initialised to
0x2000000 (reset to 0x2000001 after the first conversion); output = `acc>>10` clamped to 0..0xffff, unsigned
(XOR 0x8000 for signed). Voices that reach the end of a non-looping sample hold the end sample (step 0) for the
rest of the tick, then ramp out. Master volume (D+0x70) is 12.

Timing glitch effect: the timer IRQ (1000 Hz, 0x2ee64) keeps `[0x2ee58]`; when non-zero, every 30 ms it draws
`random(0x400)` (LCG at 0x2c2c8, state 0x28e38/0x28e3c, shared with the whole intro) and sets the master volume
to 12 if `r >= [0x2ee58]` else 0 (part A uses thresholds 1, 0x44c, 0x7d0). `p.glitch = threshold;
p.timerGlitchStep()` every 30 ms reproduces it (pass `opts.random` to share the RNG with the port).

## Quirks worth knowing

* Tempo: integer frames per tick (798 @ 138 BPM); the intro's sync is to order/row, so timeline = audio clock.
* The note pseudo-effect only acts when the instrument byte is non-zero (a note without instrument is ignored).
* The mixing slot scheduler spreads channels over 140 Hz slots; only master-volume changes can land inside a
  tick (between channels) — otherwise the per-tick order is irrelevant to the result.
* The original's DMA stream: 5512 frames of 0x8080 fill, then 1 silent frame, then idle 882-frame ticks until the
  intro starts the song (after its precalc, ~2 s), then the music.
