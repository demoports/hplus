# recursive descent disassembler for image32.bin (flat 32-bit, base 0)
import sys, struct
from capstone import *
from capstone.x86 import *
img = open('image32.bin','rb').read()
md = Cs(CS_ARCH_X86, CS_MODE_32); md.detail = True
starts = [int(x,16) for x in sys.argv[1:]] or [0x234]
seen = {}; queue = list(starts); calls = set(); datarefs = {}
def addr_ok(a): return 0 <= a < len(img)
while queue:
    a = queue.pop()
    if a in seen or not addr_ok(a): continue
    while addr_ok(a) and a not in seen:
        ins = next(md.disasm(img[a:a+16], a, 1), None)
        if ins is None:
            seen[a] = ('db', img[a:a+1].hex(), a+1); break
        seen[a] = (ins.mnemonic, ins.op_str, a+ins.size, ins.bytes.hex())
        # branch targets
        if ins.group(CS_GRP_JUMP) or ins.group(CS_GRP_CALL):
            op = ins.operands[0]
            if op.type == X86_OP_IMM:
                t = op.imm
                if addr_ok(t):
                    queue.append(t)
                    if ins.group(CS_GRP_CALL): calls.add(t)
        for op in ins.operands:
            if op.type == X86_OP_MEM and op.mem.base == 0 and op.mem.index == 0 and addr_ok(op.mem.disp):
                datarefs.setdefault(op.mem.disp, []).append(a)
            if op.type == X86_OP_MEM and op.mem.disp and addr_ok(op.mem.disp) and (op.mem.base or op.mem.index):
                datarefs.setdefault(op.mem.disp, []).append(a)
        if ins.mnemonic in ('ret','retf','iret','iretd','jmp','ljmp','hlt') and not (ins.mnemonic=='jmp' and False):
            break
        if ins.mnemonic == 'jmp': break
        a += ins.size
out = open('code32.asm','w')
for a in sorted(seen):
    e = seen[a]
    if e[0] == 'db': out.write("%06x: db %s\n" % (a, e[1])); continue
    lab = ("\n%06x: ; ---- func (calls: %d)\n" % (a, 0)) if a in calls else ""
    out.write("%s%06x: %-20s %s %s\n" % (lab, a, e[3], e[0], e[1]))
print("instructions:", len(seen), "funcs:", len(calls))
# coverage ranges
cov = sorted(seen)
rs=[]; s=cov[0]; p=cov[0]
for a in cov[1:]:
    e = seen[p][2]
    if a > e + 0: rs.append((s, e)); s = a
    p = a
rs.append((s, seen[p][2]))
for s,e in rs: print("code %06x..%06x (%d)" % (s, e, e-s))
import json
json.dump({hex(k): [hex(x) for x in v] for k,v in datarefs.items()}, open('datarefs.json','w'))
json.dump(sorted(calls), open('funcs.json','w'))
