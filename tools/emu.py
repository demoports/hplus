# Headless emulation of HPLUS.EXE (WWPACK stub -> PMODE v3 -> 32-bit intro) in Unicorn.
# Provides: DOS (PSP/env), PMODE's int 31h/33h services (real-mode int simulation:
# int 10h VESA, int 21h DOS, int 16h), I/O ports (PIT, PIC, SB16, VGA), IRQ injection,
# VESA LFB capture.
import struct, sys, time, os
from unicorn import *
from unicorn.x86_const import *

BASE32 = 0x10f70          # linear base of the 32-bit segment (selector 08/10)
PSP = 0x1000; LOAD = PSP + 0x10
LFB_PHYS = 0x04000000     # where we put the linear framebuffer (64 MB)
LFB_SIZE = 0x00400000

V86 = dict(edi=0xac, esi=0xb0, ebp=0xb4, ebx=0xbc, edx=0xc0, ecx=0xc4, eax=0xc8, flags=0xcc, es=0xce, ds=0xd0, fs=0xd2, gs=0xd4)

class Emu:
    def __init__(self, cmdline="", env="BLASTER=A220 I5 D1 H5 T6 P330", log=print, instr_per_sec=50_000_000):
        self.log = log
        self.verbose = 1
        self.mu = mu = Uc(UC_ARCH_X86, UC_MODE_16)
        mu.mem_map(0, 0x1100000)   # 1MB + 16MB extended
        mu.mem_map(LFB_PHYS, LFB_SIZE)
        data = open(os.path.join(os.path.dirname(__file__), 'HPLUS.EXE'),'rb').read()
        (magic, cblp, cp, crlc, cparhdr, minalloc, maxalloc, e_ss, e_sp, csum, e_ip, e_cs, lfarlc, ovno) = struct.unpack('<14H', data[:28])
        hdr = cparhdr*16; size = (cp-1)*512 + cblp if cblp else cp*512
        img = data[hdr:size]
        # environment block at segment 0x0F00
        ENVSEG = 0x0F00
        envb = env.encode() + b'\0\0' + b'\x01\x00' + b'C:\\HPLUS.EXE\0'
        mu.mem_write(ENVSEG*16, envb)
        psp = bytearray(256); psp[0:2] = b'\xcd\x20'; psp[2:4] = struct.pack('<H', 0x9FFF)
        psp[0x2c:0x2e] = struct.pack('<H', ENVSEG)
        tail = (" " + cmdline) if cmdline else ""
        psp[0x80] = len(tail); psp[0x81:0x81+len(tail)] = tail.encode(); psp[0x81+len(tail)] = 13
        mu.mem_write(PSP*16, bytes(psp)); mu.mem_write(LOAD*16, img)
        # BIOS data area bits
        mu.mem_write(0x46c, struct.pack('<I', 0))
        mu.reg_write(UC_X86_REG_CS, LOAD + e_cs); mu.reg_write(UC_X86_REG_IP, e_ip)
        mu.reg_write(UC_X86_REG_SS, LOAD + e_ss); mu.reg_write(UC_X86_REG_SP, e_sp)
        mu.reg_write(UC_X86_REG_DS, PSP); mu.reg_write(UC_X86_REG_ES, PSP)
        self.entry = (LOAD+e_cs)*16 + e_ip
        self.instr_per_sec = instr_per_sec
        self.exited = False
        self.ticks = 0            # instructions executed (approx, via slices)
        self.pit_divisor = 65536; self.pit_mode = 0; self.pit_latch = None; self.pit_lsb = True
        self.pic_mask = 0xb8; self.pic_mask2 = 0x8f
        self.irq_pending = []
        self.in_pmode = False
        self.ports = {}
        self.vga_retrace = 0
        self.video_mode = None
        self.sb = dict(reset=0, cmd=[], out=[], dsp_ver=(4,5), dma_run=False, irq=5, dma8=1, dma16=5, rate=22050, stereo=False, bits16=False)
        self.dma = {}             # channel -> dict(addr, count, page, mode, flip)
        self.dma_flip = {0:False, 1:False}
        self.frames = []
        self.key_queue = []
        self.pmode_entered_cb = None
        self.on_vbe_flip = None
        self.stats = {}
        mu.hook_add(UC_HOOK_INTR, self.hook_intr)
        mu.hook_add(UC_HOOK_INSN, self.hook_in, None, 1, 0, UC_X86_INS_IN)
        mu.hook_add(UC_HOOK_INSN, self.hook_out, None, 1, 0, UC_X86_INS_OUT)
        mu.hook_add(UC_HOOK_MEM_UNMAPPED, self.hook_unmapped)
        self.trace = None
        self.coverage = None
        self.pcm = bytearray()
    def enable_trace(self, n=64):
        import collections
        self.trace = collections.deque(maxlen=n)
        self.mu.hook_add(UC_HOOK_BLOCK, lambda uc, addr, size, user: self.trace.append((self.r(UC_X86_REG_CS), addr)))
    def dump_trace(self):
        if not self.trace: return
        for cs, a in self.trace:
            self.log("  block cs=%04x lin=%06x off=%06x" % (cs, a, a - BASE32 if cs == 8 else a))

    # ---------------- helpers
    def r(self, reg): return self.mu.reg_read(reg)
    def w(self, reg, v): self.mu.reg_write(reg, v)
    def rd32(self, off): return struct.unpack('<I', self.mu.mem_read(BASE32+off, 4))[0]
    def rd16(self, off): return struct.unpack('<H', self.mu.mem_read(BASE32+off, 2))[0]
    def wr32(self, off, v): self.mu.mem_write(BASE32+off, struct.pack('<I', v & 0xffffffff))
    def wr16(self, off, v): self.mu.mem_write(BASE32+off, struct.pack('<H', v & 0xffff))
    def wr8(self, off, v): self.mu.mem_write(BASE32+off, bytes([v & 0xff]))
    def lin(self, addr, n): return self.mu.mem_read(addr, n)
    def v86(self, name): return self.rd32(V86[name]) if name not in ('es','ds','fs','gs','flags') else self.rd16(V86[name])
    def setv86(self, name, v):
        if name in ('es','ds','fs','gs','flags'): self.wr16(V86[name], v)
        else: self.wr32(V86[name], v)
    def hook_unmapped(self, uc, access, addr, size, value, user):
        eip = self.r(UC_X86_REG_EIP); cs = self.r(UC_X86_REG_CS)
        self.log("UNMAPPED access %d at %08x size %d value %x  cs=%04x eip=%08x (off %x)" % (access, addr, size, value, cs, eip, eip - (BASE32 if cs==8 else 0) if cs==8 else eip))
        return False

    # ---------------- interrupts
    def hook_intr(self, uc, intno, user):
        cs = self.r(UC_X86_REG_CS); eip = self.r(UC_X86_REG_EIP)
        if cs == 8:
            self.in_pmode = True
            if intno == 0x31:   # PMODE: IF control. al=0 cli, 1 sti, 2 get; returns al=old IF
                al = self.r(UC_X86_REG_AL); fl = self.r(UC_X86_REG_EFLAGS)
                old = (fl >> 9) & 1
                if al == 0: self.w(UC_X86_REG_EFLAGS, fl & ~0x200)
                elif al == 1: self.w(UC_X86_REG_EFLAGS, fl | 0x200)
                self.w(UC_X86_REG_AL, old)
                return
            if intno == 0x33:
                self.real_int(self.r(UC_X86_REG_AL), eip - BASE32)
                return
            self.log("pmode INT %02x at off %x -> unexpected (PMODE would exit)" % (intno, eip))
            self.dump_trace()
            self.mu.emu_stop(); self.exited = True; return
        # real mode (stub) ints
        ax = self.r(UC_X86_REG_AX)
        if intno == 0x15 and (ax >> 8) == 0x88: self.w(UC_X86_REG_AX, 16384); return
        if intno == 0x21:
            self.dos_int(self.r(UC_X86_REG_EAX), real=True); return
        if intno in (0x67, 0x2f): return   # no VCPI/DPMI/XMS
        self.log("real INT %02x at %04x:%04x ax=%04x" % (intno, cs, eip, ax))

    def real_int(self, n, off):
        ax = self.v86('eax')
        if self.verbose >= 2: self.log("int33: real int %02x ax=%04x bx=%04x cx=%04x dx=%04x from %06x" % (n, ax & 0xffff, self.v86('ebx') & 0xffff, self.v86('ecx') & 0xffff, self.v86('edx') & 0xffff, off))
        if n == 0x10: self.video_int(off)
        elif n == 0x21: self.dos_int(ax, real=False)
        elif n == 0x16:
            ah = (ax >> 8) & 0xff
            if ah in (1, 0x11):   # check key
                self.setv86('flags', self.v86('flags') | 0x40)  # ZF=1 no key
            elif ah in (0, 0x10):
                self.setv86('eax', 0)
            else: self.log("int16 ah=%02x" % ah)
        elif n == 0x33:
            self.setv86('eax', 0)   # no mouse
        else:
            self.log("int33 -> real int %02x ax=%04x (unhandled)" % (n, ax))

    def dos_int(self, eax, real):
        ah = (eax >> 8) & 0xff
        getv = self.v86 if not real else (lambda nm: self.r({'eax':UC_X86_REG_EAX,'edx':UC_X86_REG_EDX,'ds':UC_X86_REG_DS,'ebx':UC_X86_REG_EBX,'ecx':UC_X86_REG_ECX}[nm]))
        if ah == 9:
            a = getv('ds')*16 + (getv('edx') & 0xffff)
            s = b''
            while True:
                c = self.mu.mem_read(a, 1); a += 1
                if c == b'$' or len(s) > 400: break
                s += c
            self.log("DOS print: %r" % s.decode('latin1'))
        elif ah == 0x4c:
            self.log("DOS exit code %d" % (eax & 0xff)); self.exited = True; self.mu.emu_stop()
        elif ah == 0x30:
            if real: self.w(UC_X86_REG_AX, 0x0005)
            else: self.setv86('eax', 0x0005)
        elif ah == 0x2c:   # get time
            if not real: self.setv86('ecx', 0); self.setv86('edx', 0)
        else:
            self.log("DOS int21 ah=%02x (unhandled) real=%s" % (ah, real))

    # ---------------- VESA / video BIOS
    MODES = {
        # mode: (w, h, bpp, memmodel)
        0x113: (320, 240, 32, 6),   # custom: 320x240x32 (intro's -v0)
        0x112: (640, 480, 32, 6),   # 640x480x32 (intro's -v2)
        0x13:  (320, 200, 8, 4),
    }
    def video_int(self, off):
        ax = self.v86('eax'); ah = ax >> 8 & 0xff; al = ax & 0xff
        if ah == 0x4f:
            bx = self.v86('ebx') & 0xffff
            if al == 0:   # controller info -> es:di
                a = self.v86('es')*16 + (self.v86('edi') & 0xffff)
                info = bytearray(512)
                info[0:4] = b'VESA'; info[4:6] = struct.pack('<H', 0x200)
                # oem string ptr, caps, mode list ptr (inside block at +0x100), total memory
                seg = self.v86('es'); di = self.v86('edi') & 0xffff
                info[6:10] = struct.pack('<HH', di+0x80, seg); info[0xa:0xe] = struct.pack('<I', 0)
                info[0xe:0x12] = struct.pack('<HH', di+0x100, seg)
                info[0x12:0x14] = struct.pack('<H', LFB_SIZE // 65536)
                info[0x80:0x90] = b'unicorn vesa\0\0\0\0'
                modes = list(self.MODES.keys())
                info[0x100:0x100+2*len(modes)+2] = struct.pack('<%dH' % (len(modes)+1), *(modes+[0xffff]))
                self.mu.mem_write(a, bytes(info))
                self.setv86('eax', 0x4f)
                self.log("VBE get info -> %04x:%04x" % (seg, di))
            elif al == 1:   # mode info
                mode = self.v86('ecx') & 0xffff
                a = self.v86('es')*16 + (self.v86('edi') & 0xffff)
                if mode not in self.MODES:
                    self.setv86('eax', 0x014f); return
                w, h, bpp, mm = self.MODES[mode]
                mi = bytearray(256)
                attr = 0x1b | (0x80 if mm == 6 else 0)
                mi[0:2] = struct.pack('<H', attr)
                mi[2] = 7; mi[3] = 7   # window attrs
                mi[4:6] = struct.pack('<H', 64); mi[6:8] = struct.pack('<H', 64)
                mi[8:10] = struct.pack('<H', 0xA000); mi[10:12] = struct.pack('<H', 0xA000)
                bpl = w * (bpp // 8)
                mi[0x10:0x12] = struct.pack('<H', bpl)
                mi[0x12:0x14] = struct.pack('<H', w); mi[0x14:0x16] = struct.pack('<H', h)
                mi[0x16] = 8; mi[0x17] = 16; mi[0x18] = 1; mi[0x19] = bpp; mi[0x1a] = 1
                mi[0x1b] = mm; mi[0x1c] = 0
                mi[0x1d] = (LFB_SIZE // (bpl*h)) - 1 if bpl*h else 0   # image pages
                mi[0x1e] = 1
                if bpp == 32:
                    mi[0x1f:0x27] = bytes([8,16, 8,8, 8,0, 8,24])   # R,G,B,Rsvd mask size/pos
                    mi[0x27] = 0
                mi[0x28:0x2c] = struct.pack('<I', LFB_PHYS)
                self.mu.mem_write(a, bytes(mi))
                self.setv86('eax', 0x4f)
                self.log("VBE mode info %03x -> %dx%dx%d" % (mode, w, h, bpp))
            elif al == 2:   # set mode
                mode = bx & 0x3fff
                self.log("VBE set mode %04x (bx=%04x)" % (mode, bx))
                self.video_mode = mode if mode in self.MODES else None
                self.setv86('eax', 0x4f if self.video_mode else 0x14f)
                self.display_start = 0
            elif al == 5:   # bank
                self.setv86('eax', 0x4f)
            elif al == 7:   # display start
                bl = bx & 0xff
                if bl in (0, 0x80):
                    x = self.v86('ecx') & 0xffff; y = self.v86('edx') & 0xffff
                    self.display_start = (x, y)
                    self.nflips = getattr(self, 'nflips', 0) + 1
                    if self.on_vbe_flip: self.on_vbe_flip(self, x, y)
                self.setv86('eax', 0x4f)
            elif al == 6:   # scanline length
                self.setv86('eax', 0x4f)
            elif al == 8 or al == 9:
                self.setv86('eax', 0x4f)
            else:
                self.log("VBE fn %02x unhandled" % al); self.setv86('eax', 0x14f)
        else:
            if ah == 0:
                self.log("BIOS set video mode %02x" % al); self.video_mode = al
            elif ah == 0x0f:
                self.setv86('eax', 0x5003)
            else:
                self.log("int10 ah=%02x al=%02x" % (ah, al))

    # ---------------- I/O ports
    def hook_in(self, uc, port, size, user):
        v = self.port_in(port, size)
        if self.verbose > 2: self.log("IN  %04x -> %x" % (port, v))
        return v
    def hook_out(self, uc, port, size, value, user):
        if self.verbose > 2: self.log("OUT %04x <- %x" % (port, value))
        self.port_out(port, size, value)

    def port_in(self, port, size):
        if port == 0x3da:
            self.vga_retrace ^= 0x09
            return self.vga_retrace | 0x01 if (self.vga_retrace & 8) else 0
        if port == 0x21: return self.pic_mask
        if port == 0xa1: return self.pic_mask2
        if port == 0x60: return self.key_queue.pop(0) if self.key_queue else 0
        if port == 0x64: return 0x14 | (1 if self.key_queue else 0)
        if port == 0x61: return 0
        if port in (0x40, 0x41, 0x42):
            if self.pit_latch is None: self.pit_latch = (self.pit_counter() & 0xffff)
            if self.pit_lsb: v = self.pit_latch & 0xff; self.pit_lsb = False
            else: v = self.pit_latch >> 8; self.pit_lsb = True; self.pit_latch = None
            return v
        if 0x220 <= port <= 0x22f: return self.sb_in(port)
        if port <= 0x07 or 0xc0 <= port <= 0xce: return self.dma_in(port)
        if 0x388 <= port <= 0x38b: return 0
        if port in (0x3c6, 0x3c7, 0x3c8, 0x3c9): return 0
        if port == 0x3cc: return 0x67
        if port == 0x3c5 or port == 0x3c4: return 0
        self.stats['in_%04x' % port] = self.stats.get('in_%04x' % port, 0) + 1
        return 0xff
    def pit_counter(self):
        return (self.ticks // 40) & 0xffff
    def port_out(self, port, size, value):
        if port == 0x43:
            self.pit_mode = value; self.pit_lsb = True
            if (value & 0xc0) == 0 and (value & 0x30) == 0: self.pit_latch = self.pit_counter() & 0xffff
            return
        if port == 0x40:
            if self.pit_lsb: self._pit_tmp = value & 0xff; self.pit_lsb = False
            else:
                self.pit_divisor = ((value & 0xff) << 8) | self._pit_tmp
                if self.pit_divisor == 0: self.pit_divisor = 65536
                self.pit_lsb = True
                self.log("PIT divisor = %d (%.1f Hz)" % (self.pit_divisor, 1193182.0/self.pit_divisor))
            return
        if port in (0x41, 0x42): return
        if port == 0x21: self.pic_mask = value; return
        if port == 0xa1: self.pic_mask2 = value; return
        if port == 0x20 or port == 0xa0: return   # EOI
        if 0x220 <= port <= 0x22f: self.sb_out(port, value); return
        if port <= 0x0f or 0xc0 <= port <= 0xdf or 0x80 <= port <= 0x8f: self.dma_out(port, value); return
        if port in (0x3c8, 0x3c9, 0x3c6, 0x3c4, 0x3c5, 0x3ce, 0x3cf, 0x3d4, 0x3d5, 0x3c0, 0x3c2):
            return
        if port in (0x388, 0x389, 0x38a, 0x38b): return
        self.stats['out_%04x' % port] = self.stats.get('out_%04x' % port, 0) + 1

    # ---------------- DMA controller
    def dma_out(self, port, value):
        d = self.dma
        if port <= 0x07:
            ch = port >> 1
            c = d.setdefault(ch, dict(addr=0, count=0, page=0, mode=0))
            flip = self.dma_flip.get(0, False)
            key = 'addr' if (port & 1) == 0 else 'count'
            if not flip: c[key] = (c[key] & 0xff00) | value
            else: c[key] = (c[key] & 0x00ff) | (value << 8)
            self.dma_flip[0] = not flip
        elif port == 0x0c: self.dma_flip[0] = False
        elif port == 0x0b:
            ch = value & 3; d.setdefault(ch, dict(addr=0, count=0, page=0, mode=0))['mode'] = value
            self.log("DMA8 ch%d mode %02x" % (ch, value))
        elif port == 0x0a:
            ch = value & 3
            self.log("DMA8 mask ch%d %s" % (ch, 'set' if value & 4 else 'clear'))
            if not (value & 4): self.dma_started(ch)
        elif 0xc0 <= port <= 0xce:
            ch = 4 + ((port - 0xc0) >> 2)
            c = d.setdefault(ch, dict(addr=0, count=0, page=0, mode=0))
            flip = self.dma_flip.get(1, False)
            key = 'addr' if ((port - 0xc0) & 2) == 0 else 'count'
            if not flip: c[key] = (c[key] & 0xff00) | value
            else: c[key] = (c[key] & 0x00ff) | (value << 8)
            self.dma_flip[1] = not flip
        elif port == 0xd8: self.dma_flip[1] = False
        elif port == 0xd6:
            ch = 4 + (value & 3); d.setdefault(ch, dict(addr=0, count=0, page=0, mode=0))['mode'] = value
            self.log("DMA16 ch%d mode %02x" % (ch, value))
        elif port == 0xd4:
            ch = 4 + (value & 3)
            self.log("DMA16 mask ch%d %s" % (ch, 'set' if value & 4 else 'clear'))
            if not (value & 4): self.dma_started(ch)
        elif 0x80 <= port <= 0x8f:
            pages = {0x87:0, 0x83:1, 0x81:2, 0x82:3, 0x8b:5, 0x89:6, 0x8a:7}
            if port in pages: d.setdefault(pages[port], dict(addr=0, count=0, page=0, mode=0))['page'] = value
    def dma_pos(self):
        # current transfer position (in transfer units: bytes for ch0-3, words for ch4-7) of the active channel
        d = getattr(self, 'dma_active', None)
        if not d or not self.sb.get('dma_run'): return 0
        rate = self.sb['rate']; bps = (2 if self.sb['bits16'] else 1) * (2 if self.sb['stereo'] else 1)
        frames = int((self.ticks - d['start_tick']) * rate / self.instr_per_sec)
        nbytes = frames * bps
        units = nbytes // (2 if d['ch'] >= 4 else 1)
        total_units = d['length'] // (2 if d['ch'] >= 4 else 1)
        return units % total_units, total_units
    def dma_in(self, port):
        if port <= 0x07: ch = port >> 1; is_count = port & 1; fk = 0
        else: ch = 4 + ((port - 0xc0) >> 2); is_count = ((port - 0xc0) & 2) != 0; fk = 1
        c = self.dma.get(ch)
        d = getattr(self, 'dma_active', None)
        if c is None or d is None or d['ch'] != ch: v = 0
        else:
            pos, total = self.dma_pos()
            if is_count: v = (total - 1 - pos) & 0xffff
            else: v = (c['addr'] + pos) & 0xffff
        flip = self.dma_flip.get(fk, False)
        self.dma_flip[fk] = not flip
        return (v >> 8) & 0xff if flip else v & 0xff
    def dma_started(self, ch):
        c = self.dma[ch]
        if ch < 4: base = (c['page'] << 16) | c['addr']; length = c['count'] + 1
        else: base = (c['page'] << 16) | (c['addr'] << 1); length = (c['count'] + 1) * 2
        self.log("DMA ch%d started: phys %06x len %d mode %02x" % (ch, base, length, c['mode']))
        self.dma_active = dict(ch=ch, base=base, length=length, pos=0, start_tick=self.ticks)

    # ---------------- Sound Blaster
    def sb_in(self, port):
        sb = self.sb
        if port == 0x22e:   # read status: bit7 = data available
            return 0x80 if sb['out'] else 0x00
        if port == 0x22a:
            return sb['out'].pop(0) if sb['out'] else 0xff
        if port == 0x22c:   # write status bit7 = busy
            return 0x00
        if port == 0x22f:   # 16-bit ack
            return 0
        if port == 0x225:   # mixer data
            return 0
        return 0xff
    def sb_out(self, port, value):
        sb = self.sb
        if port == 0x226:
            if value == 1: sb['reset'] = 1
            elif value == 0 and sb['reset']:
                sb['reset'] = 0; sb['out'] = [0xaa]; sb['cmd'] = []
                self.log("SB DSP reset")
            return
        if port == 0x22c:
            sb['cmd'].append(value); self.sb_cmd()
            return
        if port == 0x224: sb['mixreg'] = value; return
        if port == 0x225:
            self.log("SB mixer reg %02x <- %02x" % (sb.get('mixreg', 0), value)); return
    def sb_cmd(self):
        sb = self.sb; c = sb['cmd']
        op = c[0]
        need = {0xe1:1, 0xd1:1, 0xd3:1, 0xd0:1, 0xd4:1, 0xd5:1, 0xd6:1, 0xda:1, 0xd9:1, 0x40:2, 0x41:3, 0x42:3, 0x48:3, 0x14:3, 0x1c:1, 0x90:1, 0x91:1,
                0xb0:4, 0xb2:4, 0xb4:4, 0xb6:4, 0xb8:4, 0xba:4, 0xbc:4, 0xbe:4, 0xc0:4, 0xc2:4, 0xc4:4, 0xc6:4, 0xc8:4, 0xca:4, 0xcc:4, 0xce:4,
                0xe0:2, 0xe4:2, 0xe8:1, 0x10:2, 0xf2:1, 0xf3:1, 0x45:1, 0x47:1}.get(op, 1)
        if len(c) < need: return
        sb['cmd'] = []
        if op == 0xe1: sb['out'] += list(sb['dsp_ver']); self.log("SB get version")
        elif op == 0xd1: self.log("SB speaker on")
        elif op == 0xd3: self.log("SB speaker off")
        elif op == 0xd0 or op == 0xd5: self.log("SB DMA pause")
        elif op == 0xd4 or op == 0xd6: self.log("SB DMA continue")
        elif op == 0xda or op == 0xd9: self.log("SB exit autoinit"); sb['dma_run'] = False
        elif op == 0x40: sb['rate'] = 1000000 // (256 - c[1]); self.log("SB time const %d -> %d Hz" % (c[1], sb['rate']))
        elif op == 0x41 or op == 0x42: sb['rate'] = (c[1] << 8) | c[2]; self.log("SB rate %d Hz" % sb['rate'])
        elif op == 0x48: sb['blk'] = ((c[2] << 8) | c[1]) + 1; self.log("SB block size %d" % sb['blk'])
        elif op == 0x1c: sb['dma_run'] = True; sb['bits16'] = False; self.log("SB start 8-bit autoinit DMA (1C)"); self.sb_start()
        elif op == 0x90: sb['dma_run'] = True; sb['bits16'] = False; self.log("SB start 8-bit HS autoinit (90)"); self.sb_start()
        elif op == 0x14: sb['dma_run'] = True; self.log("SB single cycle 8-bit len %d" % (((c[2] << 8) | c[1]) + 1))
        elif 0xb0 <= op <= 0xcf:
            mode = c[1]; length = ((c[3] << 8) | c[2]) + 1
            sb['bits16'] = op < 0xc0; sb['stereo'] = bool(mode & 0x20); sb['signed'] = bool(mode & 0x10)
            sb['blk'] = length; sb['dma_run'] = True
            self.log("SB16 DMA start op=%02x mode=%02x len=%d (%s %s %s)" % (op, mode, length, '16bit' if sb['bits16'] else '8bit', 'stereo' if sb['stereo'] else 'mono', 'auto' if op & 4 else 'single'))
            self.sb_start()
        elif op == 0xe0: sb['out'].append((~c[1]) & 0xff)
        elif op == 0xe8: sb['out'].append(0xaa)
        elif op == 0xf2 or op == 0xf3: self.raise_irq(sb['irq'])
        else: self.log("SB DSP cmd %02x args %s" % (op, c[1:]))
    def sb_start(self):
        sb = self.sb
        # samples per IRQ block
        bytes_per_sample = (2 if sb['bits16'] else 1) * (2 if sb['stereo'] else 1)
        sb['block_bytes'] = sb['blk'] * (2 if sb['bits16'] else 1)
        sb['frames_per_block'] = sb['block_bytes'] // bytes_per_sample
        sb['next_irq_tick'] = self.ticks + int(self.instr_per_sec * sb['frames_per_block'] / sb['rate'])
        self.log("SB: %d bytes per IRQ block, IRQ every %.2f ms" % (sb['block_bytes'], 1000.0*sb['frames_per_block']/sb['rate']))
        self.sb_blocks = 0

    # ---------------- IRQ injection
    def raise_irq(self, irq):
        if irq not in self.irq_pending: self.irq_pending.append(irq)
    def deliver_irq(self, irq):
        # deliver through the IDT (protected mode only)
        if not self.in_pmode: return False
        fl = self.r(UC_X86_REG_EFLAGS)
        if not (fl & 0x200): return False
        mask = self.pic_mask if irq < 8 else self.pic_mask2
        if mask & (1 << (irq & 7)): return False
        vec = (8 + irq) if irq < 8 else (0x70 + irq - 8)
        idtr = self.r(UC_X86_REG_IDTR)
        e = self.mu.mem_read(idtr[1] + vec*8, 8)
        lo, sel, attr, hi = struct.unpack('<HHHH', e)
        off = lo | (hi << 16)
        esp = self.r(UC_X86_REG_ESP); cs = self.r(UC_X86_REG_CS); eip = self.r(UC_X86_REG_EIP)
        ss_base = 0  # ss selector 0x10 base is BASE32; esp is relative to it
        ssel = self.r(UC_X86_REG_SS)
        base = BASE32 if ssel in (0x08, 0x10) else 0
        esp -= 12
        self.mu.mem_write(base + esp, struct.pack('<III', eip, cs, fl))
        self.w(UC_X86_REG_ESP, esp)
        self.w(UC_X86_REG_EFLAGS, fl & ~0x200)
        self.w(UC_X86_REG_CS, sel); self.w(UC_X86_REG_EIP, off)
        self.stats['irq%d' % irq] = self.stats.get('irq%d' % irq, 0) + 1
        return True

    # ---------------- main loop
    BLOCK_INSTR = 4   # assumed instructions per basic block (for the time base)
    def run(self, max_seconds=10.0, until=None, check_every=64):
        mu = self.mu
        t0 = time.time()
        self.max_ticks = int(max_seconds * self.instr_per_sec)
        self.until = until
        self._nblk = 0; self._check_every = check_every
        self._bh = mu.hook_add(UC_HOOK_BLOCK, self._block_hook)
        try:
            mu.emu_start(self.entry, -1, count=0)
        except UcError as e:
            cs = self.r(UC_X86_REG_CS); eip = self.r(UC_X86_REG_EIP)
            self.log("UcError %s at cs=%04x eip=%08x" % (e, cs, eip))
            self.dump_trace()
        self.exited = True
        self.log("run done: %.1fs wall, %d ticks (%.2f emu-s) stats=%s" % (time.time()-t0, self.ticks, self.ticks/self.instr_per_sec, self.stats))
    def _block_hook(self, uc, addr, size, user):
        self._nblk += 1
        if self.coverage is not None: self.coverage.add(addr)
        if not self.in_pmode and self.r(UC_X86_REG_CS) == 8: self.in_pmode = True
        if self._nblk < self._check_every: return
        self.ticks += self._nblk * self.BLOCK_INSTR; self._nblk = 0
        self.on_slice()
        if self.ticks >= self.max_ticks or (self.until and self.until(self)):
            uc.emu_stop()

    def on_slice(self):
        if self.verbose >= 1 and self.ticks >= getattr(self, '_next_report', 0):
            self._next_report = self.ticks + self.instr_per_sec
            self.log("[t=%.1f] eip=%06x stats=%s" % (self.ticks / self.instr_per_sec, self.r(UC_X86_REG_EIP), self.stats))
        # timer IRQ0
        if self.in_pmode:
            period = int(self.instr_per_sec * self.pit_divisor / 1193182.0)
            if not hasattr(self, 'next_timer'): self.next_timer = self.ticks + period
            if self.ticks >= self.next_timer:
                self.next_timer += period
                self.raise_irq(0)
            sb = self.sb
            if sb.get('dma_run') and 'next_irq_tick' in sb and self.ticks >= sb['next_irq_tick']:
                sb['next_irq_tick'] += int(self.instr_per_sec * sb['frames_per_block'] / sb['rate'])
                self.raise_irq(sb['irq'])
            if sb.get('dma_run') and getattr(self, 'dma_active', None):
                self.dma_capture()
            while self.irq_pending:
                irq = self.irq_pending[0]
                if self.deliver_irq(irq): self.irq_pending.pop(0)
                else: break
    def dma_capture(self, force=False):
        d = self.dma_active
        pos, total = self.dma_pos()
        last = d.get('cap_pos', 0)
        unit = 2 if d['ch'] >= 4 else 1
        adv = (pos - last) % total
        if adv < 512 and not force: return
        if pos >= last:
            self.pcm += self.mu.mem_read(d['base'] + last*unit, (pos-last)*unit)
        else:
            self.pcm += self.mu.mem_read(d['base'] + last*unit, (total-last)*unit)
            self.pcm += self.mu.mem_read(d['base'], pos*unit)
        d['cap_pos'] = pos
    def on_sb_block(self):
        # the card has consumed one block of the DMA buffer: record it
        d = getattr(self, 'dma_active', None)
        sb = self.sb
        if not d: return
        n = sb['block_bytes']
        pos = (self.sb_blocks * n) % d['length']
        self.pcm += self.mu.mem_read(d['base'] + pos, n)
        self.sb_blocks += 1

    def grab_frame(self):
        if self.video_mode not in self.MODES: return None
        w, h, bpp, mm = self.MODES[self.video_mode]
        x, y = self.display_start if isinstance(self.display_start, tuple) else (0, 0)
        pitch = w * bpp // 8
        return w, h, bytes(self.mu.mem_read(LFB_PHYS + y*pitch + x*bpp//8, pitch*h))
    def save_wav(self, path):
        import wave
        sb = self.sb
        wf = wave.open(path, 'wb'); wf.setnchannels(2 if sb['stereo'] else 1); wf.setsampwidth(2 if sb['bits16'] else 1); wf.setframerate(sb['rate'])
        data = bytes(self.pcm)
        if sb['bits16'] and not sb.get('signed', False):
            import array
            a = array.array('h'); a.frombytes(data[:len(data)//2*2])
            for i in range(len(a)): a[i] = ((a[i] & 0xffff) ^ 0x8000) - 0x10000 if ((a[i] & 0xffff) ^ 0x8000) >= 0x8000 else ((a[i] & 0xffff) ^ 0x8000)
            data = a.tobytes()
        wf.writeframes(data); wf.close()

def write_png(path, w, h, bgra):
    import zlib
    raw = bytearray()
    for yy in range(h):
        raw.append(0)
        row = bgra[yy*w*4:(yy+1)*w*4]
        # BGRA -> RGB
        raw += bytes(b for i in range(0, len(row), 4) for b in (row[i+2], row[i+1], row[i]))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(bytes(raw), 6)) + chunk(b'IEND', b'')
    open(path, 'wb').write(png)

if __name__ == '__main__':
    e = Emu(cmdline=sys.argv[1] if len(sys.argv) > 1 else "", instr_per_sec=30_000_000)
    e.verbose = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    if e.verbose >= 2: e.enable_trace(80)
    e.coverage = set()
    outdir = sys.argv[4] if len(sys.argv) > 4 else 'frames'
    os.makedirs(outdir, exist_ok=True)
    every = int(sys.argv[5]) if len(sys.argv) > 5 else 1
    def flip(em, x, y):
        if em.nflips % every: return
        fr = em.grab_frame()
        if fr: write_png("%s/f%05d_t%06.2f.png" % (outdir, em.nflips, em.ticks/em.instr_per_sec), *fr)
    e.on_vbe_flip = flip
    e.run(max_seconds=float(sys.argv[2]) if len(sys.argv) > 2 else 2.0)
    print("video mode:", e.video_mode, "pcm bytes:", len(e.pcm), "flips:", getattr(e, 'nflips', 0))
    e.save_wav(outdir + '/audio.wav')
    open(outdir + '/mem.bin', 'wb').write(e.mu.mem_read(0, 0x110000))
    d = getattr(e, 'dma_active', None)
    if d: print("dma buffer head:", e.mu.mem_read(d['base'], 32).hex(), "lomem:", hex(e.rd32(0)), hex(e.rd32(4)), "himem:", hex(e.rd32(8)), hex(e.rd32(0xc)))
    open(outdir + '/coverage.txt', 'w').write('\n'.join('%x' % a for a in sorted(e.coverage)))
