#!/usr/bin/env python3
"""Independent verification of the routed PCB: connectivity per net + clearance."""
import re, math
from collections import defaultdict

PCB = "/home/j0901413/etc/multi_i2c_bridge/kicad/multi_i2c_bridge.kicad_pcb"
CL_REQ = 0.15 - 1e-4

def parse(s):
    toks = re.findall(r'"(?:[^"\\]|\\.)*"|\(|\)|[^\s()"]+', s)
    def rec(i):
        out = []; i += 1
        while toks[i] != ')':
            if toks[i] == '(':
                sub, i = rec(i); out.append(sub)
            else:
                out.append(toks[i]); i += 1
        return out, i + 1
    return rec(0)[0]
def kids(n, t): return [x for x in n if isinstance(x, list) and x[0] == t]
def kid(n, t):
    k = kids(n, t); return k[0] if k else None
def unq(s): return s[1:-1] if s.startswith('"') else s

doc = parse(open(PCB).read())
netname = {int(e[1]): unq(e[2]) for e in kids(doc, 'net')}

pads = []
for fp in kids(doc, 'footprint'):
    at = kid(fp, 'at'); fx, fy = float(at[1]), float(at[2])
    frot = float(at[3]) if len(at) > 3 else 0.0
    ref = [unq(p[2]) for p in kids(fp, 'property') if unq(p[1]) == 'Reference'][0]
    for pd in kids(fp, 'pad'):
        pat = kid(pd, 'at'); px, py = float(pat[1]), float(pat[2])
        prot = (float(pat[3]) if len(pat) > 3 else 0.0) % 180
        sz = kid(pd, 'size'); sx, sy = float(sz[1]), float(sz[2])
        if prot == 90: sx, sy = sy, sx
        r = math.radians(frot)
        gx = fx + px * math.cos(r) - py * math.sin(r)
        gy = fy + px * math.sin(r) + py * math.cos(r)
        nt = kid(pd, 'net')
        pads.append(dict(ref=ref, num=unq(pd[1]), kind=pd[2], x=gx, y=gy, sx=sx, sy=sy,
                         net=(unq(nt[2]) if nt else None)))

segs = []
for e in kids(doc, 'segment'):
    st = kid(e, 'start'); en = kid(e, 'end')
    segs.append(dict(x1=float(st[1]), y1=float(st[2]), x2=float(en[1]), y2=float(en[2]),
                     w=float(kid(e, 'width')[1]),
                     layer=unq(kid(e, 'layer')[1]),
                     net=netname[int(kid(e, 'net')[1])]))
vias_ = []
for e in kids(doc, 'via'):
    at = kid(e, 'at')
    vias_.append(dict(x=float(at[1]), y=float(at[2]), d=float(kid(e, 'size')[1]),
                      net=netname[int(kid(e, 'net')[1])]))

def seg_pt_dist(x1, y1, x2, y2, px, py):
    dx, dy = x2 - x1, y2 - y1
    L2 = dx * dx + dy * dy
    if L2 == 0: return math.hypot(px - x1, py - y1)
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / L2))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))

def seg_seg_dist(a, b):
    # min distance between two segments (sampled + endpoint exact)
    d = min(seg_pt_dist(a['x1'], a['y1'], a['x2'], a['y2'], b['x1'], b['y1']),
            seg_pt_dist(a['x1'], a['y1'], a['x2'], a['y2'], b['x2'], b['y2']),
            seg_pt_dist(b['x1'], b['y1'], b['x2'], b['y2'], a['x1'], a['y1']),
            seg_pt_dist(b['x1'], b['y1'], b['x2'], b['y2'], a['x2'], a['y2']))
    # crossing check
    def ccw(ax, ay, bx, by, cx, cy): return (cy - ay) * (bx - ax) - (by - ay) * (cx - ax)
    d1 = ccw(a['x1'], a['y1'], a['x2'], a['y2'], b['x1'], b['y1'])
    d2 = ccw(a['x1'], a['y1'], a['x2'], a['y2'], b['x2'], b['y2'])
    d3 = ccw(b['x1'], b['y1'], b['x2'], b['y2'], a['x1'], a['y1'])
    d4 = ccw(b['x1'], b['y1'], b['x2'], b['y2'], a['x2'], a['y2'])
    if d1 * d2 < 0 and d3 * d4 < 0:
        return 0.0
    return d

def pad_pt_dist(p, px, py):
    dx = max(abs(px - p['x']) - p['sx'] / 2, 0.0)
    dy = max(abs(py - p['y']) - p['sy'] / 2, 0.0)
    return math.hypot(dx, dy)

def pad_seg_dist(p, s):
    # sample along segment
    n = max(2, int(math.hypot(s['x2'] - s['x1'], s['y2'] - s['y1']) / 0.05) + 1)
    best = 1e9
    for k in range(n + 1):
        t = k / n
        best = min(best, pad_pt_dist(p, s['x1'] + t * (s['x2'] - s['x1']),
                                     s['y1'] + t * (s['y2'] - s['y1'])))
    return best

# ---------- clearance ----------
viol = []
mind = 1e9
for i in range(len(segs)):
    a = segs[i]
    for j in range(i + 1, len(segs)):
        b = segs[j]
        if a['net'] == b['net'] or a['layer'] != b['layer']:
            continue
        if min(a['x1'], a['x2']) > max(b['x1'], b['x2']) + 2: continue
        if max(a['x1'], a['x2']) < min(b['x1'], b['x2']) - 2: continue
        if min(a['y1'], a['y2']) > max(b['y1'], b['y2']) + 2: continue
        if max(a['y1'], a['y2']) < min(b['y1'], b['y2']) - 2: continue
        d = seg_seg_dist(a, b) - (a['w'] + b['w']) / 2
        mind = min(mind, d)
        if d < CL_REQ:
            viol.append(("seg-seg", a['net'], b['net'], round(a['x1'], 1), round(a['y1'], 1), round(d, 3)))
for v in vias_:
    for s in segs:
        if s['net'] == v['net']: continue
        d = seg_pt_dist(s['x1'], s['y1'], s['x2'], s['y2'], v['x'], v['y']) - v['d'] / 2 - s['w'] / 2
        if d < CL_REQ:
            viol.append(("via-seg", v['net'], s['net'], v['x'], v['y'], round(d, 3)))
    for w in vias_:
        if w is v or w['net'] == v['net']: continue
        d = math.hypot(v['x'] - w['x'], v['y'] - w['y']) - (v['d'] + w['d']) / 2
        if d < CL_REQ:
            viol.append(("via-via", v['net'], w['net'], v['x'], v['y'], round(d, 3)))
for p in pads:
    for s in segs:
        if p['net'] == s['net']: continue
        if p['kind'] == 'smd' and s['layer'] != 'F.Cu': continue
        if abs(p['x'] - (s['x1'] + s['x2']) / 2) > 3 + abs(s['x2'] - s['x1']) / 2: continue
        if abs(p['y'] - (s['y1'] + s['y2']) / 2) > 3 + abs(s['y2'] - s['y1']) / 2: continue
        d = pad_seg_dist(p, s) - s['w'] / 2
        if d < CL_REQ:
            viol.append(("pad-seg", f"{p['ref']}.{p['num']}({p['net']})", s['net'],
                         round(p['x'], 1), round(p['y'], 1), round(d, 3)))
    for v in vias_:
        if p['net'] == v['net']: continue
        d = pad_pt_dist(p, v['x'], v['y']) - v['d'] / 2
        if d < CL_REQ:
            viol.append(("pad-via", f"{p['ref']}.{p['num']}({p['net']})", v['net'],
                         round(p['x'], 1), round(p['y'], 1), round(d, 3)))

print("clearance violations:", len(viol))
for v in viol[:20]:
    print("  ", v)

# ---------- connectivity ----------
class DSU:
    def __init__(self): self.p = {}
    def find(self, a):
        self.p.setdefault(a, a)
        while self.p[a] != a:
            self.p[a] = self.p[self.p[a]]; a = self.p[a]
        return a
    def union(self, a, b): self.p[self.find(a)] = self.find(b)

TOL = 0.05
items = []
for i, s in enumerate(segs):
    items.append(('s', i))
for i, v in enumerate(vias_):
    items.append(('v', i))
for i, p in enumerate(pads):
    if p['net']:
        items.append(('p', i))
dsu = DSU()
bynet = defaultdict(list)
for it in items:
    t, i = it
    net = segs[i]['net'] if t == 's' else vias_[i]['net'] if t == 'v' else pads[i]['net']
    bynet[net].append(it)

def touches(a, b):
    ta, ia = a; tb, ib = b
    if ta == 's' and tb == 's':
        s1, s2 = segs[ia], segs[ib]
        if s1['layer'] != s2['layer']: return False
        # endpoint of one on the other
        for (px, py) in ((s1['x1'], s1['y1']), (s1['x2'], s1['y2'])):
            if seg_pt_dist(s2['x1'], s2['y1'], s2['x2'], s2['y2'], px, py) <= (s2['w'] / 2 + TOL):
                return True
        for (px, py) in ((s2['x1'], s2['y1']), (s2['x2'], s2['y2'])):
            if seg_pt_dist(s1['x1'], s1['y1'], s1['x2'], s1['y2'], px, py) <= (s1['w'] / 2 + TOL):
                return True
        return False
    if ta == 's' and tb == 'v' or ta == 'v' and tb == 's':
        s = segs[ia] if ta == 's' else segs[ib]
        v = vias_[ia] if ta == 'v' else vias_[ib]
        return seg_pt_dist(s['x1'], s['y1'], s['x2'], s['y2'], v['x'], v['y']) <= (v['d'] / 2 + TOL)
    if ta == 's' and tb == 'p' or ta == 'p' and tb == 's':
        s = segs[ia] if ta == 's' else segs[ib]
        p = pads[ia] if ta == 'p' else pads[ib]
        if p['kind'] == 'smd' and s['layer'] != 'F.Cu': return False
        return pad_seg_dist(p, s) <= TOL + s['w'] / 2 * 0  # endpoint must be inside pad
    if ta == 'v' and tb == 'p' or ta == 'p' and tb == 'v':
        v = vias_[ia] if ta == 'v' else vias_[ib]
        p = pads[ia] if ta == 'p' else pads[ib]
        if p['kind'] == 'smd': return pad_pt_dist(p, v['x'], v['y']) <= v['d'] / 2 + TOL
        return pad_pt_dist(p, v['x'], v['y']) <= v['d'] / 2 + TOL
    if ta == 'v' and tb == 'v':
        v, w = vias_[ia], vias_[ib]
        return math.hypot(v['x'] - w['x'], v['y'] - w['y']) <= (v['d'] + w['d']) / 2 + TOL
    return False

split = []
for net, its in bynet.items():
    for i in range(len(its)):
        for j in range(i + 1, len(its)):
            if touches(its[i], its[j]):
                dsu.union(its[i], its[j])
    comps = defaultdict(list)
    for it in its:
        comps[dsu.find(it)].append(it)
    if net == "GND":
        # zones connect GND: require every GND item component to contain a via or THT pad
        bad = []
        for c, lst in comps.items():
            hasplane = any(t == 'v' for t, _ in lst) or \
                       any(t == 'p' and pads[i]['kind'] == 'thru_hole' for t, i in lst)
            if not hasplane:
                bad.append([(t, pads[i]['ref'] + '.' + pads[i]['num'] if t == 'p' else i) for t, i in lst])
        if bad:
            split.append((net, f"{len(bad)} GND groups without plane access: {bad[:3]}"))
        continue
    if len(comps) > 1:
        sizes = sorted((len(v) for v in comps.values()), reverse=True)
        # identify pads in minor components
        det = []
        for c, lst in sorted(comps.items(), key=lambda kv: -len(kv[1]))[1:]:
            det.append([pads[i]['ref'] + '.' + pads[i]['num'] for t, i in lst if t == 'p'])
        split.append((net, f"{len(comps)} components sizes={sizes} minors={det}"))

print("split nets:", len(split))
for s_ in split:
    print("  ", s_)
print("min seg-seg clearance seen:", round(mind, 4))
