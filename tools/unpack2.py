import struct, sys
from unicorn import *
from unicorn.x86_const import *
data = open('HPLUS.EXE','rb').read()
(magic, cblp, cp, crlc, cparhdr, minalloc, maxalloc, e_ss, e_sp, csum, e_ip, e_cs, lfarlc, ovno) = struct.unpack('<14H', data[:28])
hdr = cparhdr*16; size = (cp-1)*512 + cblp if cblp else cp*512
img = data[hdr:size]
PSP = 0x1000; LOAD = PSP + 0x10
mu = Uc(UC_ARCH_X86, UC_MODE_16)
mu.mem_map(0, 0x110000)
psp = bytearray(256); psp[0:2] = b'\xcd\x20'; psp[2:4] = struct.pack('<H', 0x9FFF); psp[0x80]=0; psp[0x81]=13
mu.mem_write(PSP*16, bytes(psp)); mu.mem_write(LOAD*16, img)
mu.reg_write(UC_X86_REG_CS, LOAD + e_cs); mu.reg_write(UC_X86_REG_IP, e_ip)
mu.reg_write(UC_X86_REG_SS, LOAD + e_ss); mu.reg_write(UC_X86_REG_SP, e_sp)
mu.reg_write(UC_X86_REG_DS, PSP); mu.reg_write(UC_X86_REG_ES, PSP)
written = bytearray(0x110000)
phase = {'cs': None, 'segs': {}}
def hook_w(uc, access, addr, sz, val, user):
    cs = uc.reg_read(UC_X86_REG_CS)
    ip = uc.reg_read(UC_X86_REG_IP)
    d = phase["segs"].setdefault((cs,ip), [addr, addr, 0])
    d[0] = min(d[0], addr); d[1] = max(d[1], addr+sz-1); d[2] += sz
    for i in range(sz): written[addr+i] = 1
mu.hook_add(UC_HOOK_MEM_WRITE, hook_w)
def hook_intr(uc, intno, user):
    uc.emu_stop()
mu.hook_add(UC_HOOK_INTR, hook_intr)
mu.emu_start((LOAD+e_cs)*16 + e_ip, -1, timeout=20*1000000, count=0)
print("stopped at %04x:%04x" % (mu.reg_read(UC_X86_REG_CS), mu.reg_read(UC_X86_REG_IP)))
for (cs,ip), (lo, hi, n) in sorted(phase["segs"].items()):
    print("writes from %04x:%04x: %06x..%06x (%d bytes)" % (cs, ip, lo, hi, n))
# ranges written
prev = 0; start = 0
for a in range(0x110000+1):
    w = written[a] if a < 0x110000 else 0
    if w and not prev: start = a
    if prev and not w: print("written range %06x..%06x" % (start, a-1))
    prev = w
open('written.bin','wb').write(written)
open('mem_dump2.bin','wb').write(mu.mem_read(0, 0x110000))
