#!/usr/bin/env python3
"""2-layer maze autorouter for multi_i2c_bridge.kicad_pcb.
Reads pads+nets from the pcb file, routes all non-GND nets (A* on 0.1mm grid,
F.Cu/B.Cu with vias), adds GND stitching vias for SMD GND pads + RP2040 EP,
writes tracks/vias back into the pcb file."""
import re, math, heapq, uuid as uuidlib
import numpy as np

PCB = "/home/j0901413/etc/multi_i2c_bridge/kicad/multi_i2c_bridge.kicad_pcb"

GRID = 0.1
X0, Y0, X1, Y1 = 100.0, 100.0, 150.0, 150.0
NX = int(round((X1 - X0) / GRID)) + 1  # 501
CL = 0.15
W_SIG, W_PWR = 0.2, 0.25
PWR = {"3V3", "5V_IN", "VBUS", "HOST_5V", "DVDD_1V1"}
VIA_D, VIA_DRILL = 0.6, 0.3
VIA_COST = 45
EDGE = 0.4

def u(): return str(uuidlib.uuid4())
def f(v):
    s = f"{v:.4f}".rstrip("0").rstrip(".")
    return s if s else "0"

# ---------- parse pcb ----------
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

text = open(PCB).read()
doc = parse(text)

netname = {}
for el in kids(doc, 'net'):
    netname[int(el[1])] = unq(el[2])

pads = []  # dict: ref,num,net(str|None),x,y,sx,sy,kind,drill
for fp in kids(doc, 'footprint'):
    at = kid(fp, 'at')
    fx, fy = float(at[1]), float(at[2])
    frot = float(at[3]) if len(at) > 3 else 0.0
    ref = [unq(p[2]) for p in kids(fp, 'property') if unq(p[1]) == 'Reference'][0]
    for pd in kids(fp, 'pad'):
        num = unq(pd[1]); kind = pd[2]
        pat = kid(pd, 'at')
        px, py = float(pat[1]), float(pat[2])
        prot = float(pat[3]) if len(pat) > 3 else 0.0
        sz = kid(pd, 'size'); sx, sy = float(sz[1]), float(sz[2])
        dr = kid(pd, 'drill')
        drill = float(dr[1]) if dr else 0.0
        nt = kid(pd, 'net')
        net = unq(nt[2]) if nt else None
        # rotate offset by footprint rot (KiCad: pad angle in file = frot+prot already)
        r = math.radians(frot)
        gx = fx + px * math.cos(r) - py * math.sin(r)
        gy = fy + px * math.sin(r) + py * math.cos(r)
        # pad absolute rotation
        arot = prot % 180  # written as frot+prot in generator
        if arot == 90:
            sx, sy = sy, sx
        pads.append(dict(ref=ref, num=num, net=net, x=gx, y=gy, sx=sx, sy=sy,
                         kind=kind, drill=drill))

# ---------- grid maps ----------
# classes: 0=signal(h=0.1) 1=power(h=0.175) 2=via(h=0.3)
HQ = [W_SIG / 2, W_PWR / 2, VIA_D / 2]
# base[cls][layer]: board-level blocks (edges). pad_obst: pads (own-net carved at query).
# netblk[net][cls][layer]: copper placed for that net -> obstacle only for OTHER nets.
base = np.zeros((3, 2, NX, NX), dtype=bool)
pad_obst = np.zeros((3, 2, NX, NX), dtype=bool)
netblk = {}
def blk(net):
    if net not in netblk:
        netblk[net] = np.zeros((3, 2, NX, NX), dtype=bool)
    return netblk[net]
def foreign(cls, L, net):
    e = base[cls, L].copy()
    for m, arr in netblk.items():
        if m != net:
            e |= arr[cls, L]
    return e

def gi(x): return int(round((x - X0) / GRID))
def gx(i): return X0 + i * GRID

def block_rect(arr, cx, cy, hx, hy):
    # block cells whose CENTER strictly violates clearance (dist == clearance is legal)
    e = 1e-6
    i1 = max(0, int(math.floor((cx - hx - X0) / GRID + e)) + 1)
    i2 = min(NX - 1, int(math.ceil((cx + hx - X0) / GRID - e)) - 1)
    j1 = max(0, int(math.floor((cy - hy - Y0) / GRID + e)) + 1)
    j2 = min(NX - 1, int(math.ceil((cy + hy - Y0) / GRID - e)) - 1)
    if i1 <= i2 and j1 <= j2:
        arr[j1:j2 + 1, i1:i2 + 1] = True

# board edge margin
for c in range(3):
    for L in range(2):
        m = int(math.ceil((EDGE + HQ[c]) / GRID))
        base[c, L, :m, :] = True; base[c, L, -m:, :] = True
        base[c, L, :, :m] = True; base[c, L, :, -m:] = True

pad_rects = {}  # (ref,num) -> (cx,cy,hx,hy,kind)
for p in pads:
    hx, hy = p['sx'] / 2, p['sy'] / 2
    if p['kind'] in ('thru_hole', 'np_thru_hole'):
        layers = (0, 1)
    else:
        layers = (0,)
    pad_rects[(p['ref'], p['num'])] = (p['x'], p['y'], hx, hy, p['kind'])
    for c in range(3):
        d = CL + HQ[c]
        for L in layers:
            block_rect(pad_obst[c, L], p['x'], p['y'], hx + d, hy + d)

# ---------- geometry placement bookkeeping ----------
segments = []  # (x1,y1,x2,y2,w,layer,net)
vias = []      # (x,y,net)

def place_track(x1, y1, x2, y2, w, L):
    segments_np_block(x1, y1, x2, y2, w, L)

def segments_np_block(x1, y1, x2, y2, w, L, net):
    a3 = blk(net)
    diag = (x1 != x2) and (y1 != y2)
    for c in range(3):
        d = w / 2 + CL + HQ[c]
        a = a3[c, L]
        if diag:
            n = max(2, int(math.hypot(x2 - x1, y2 - y1) / 0.05) + 1)
            for k in range(n + 1):
                t = k / n
                block_rect(a, x1 + t * (x2 - x1), y1 + t * (y2 - y1), d, d)
        elif x1 == x2:
            block_rect(a, x1, (y1 + y2) / 2, d, abs(y2 - y1) / 2 + d)
        else:
            block_rect(a, (x1 + x2) / 2, y1, abs(x2 - x1) / 2 + d, d)

def place_via(x, y, net):
    a3 = blk(net)
    for c in range(3):
        d = VIA_D / 2 + CL + HQ[c]
        for L in range(2):
            block_rect(a3[c, L], x, y, d, d)

# ---------- nets ----------
from collections import defaultdict
netpads = defaultdict(list)
for p in pads:
    if p['net']:
        netpads[p['net']].append(p)

route_nets = [n for n in netpads if n != "GND" and len(netpads[n]) >= 2]
def bbox_size(n):
    xs = [p['x'] for p in netpads[n]]; ys = [p['y'] for p in netpads[n]]
    return (max(xs) - min(xs)) + (max(ys) - min(ys))
def prio(n):
    if n == "RUN":
        return (0, -1)
    if n in ("DVDD_1V1", "3V3"):
        grp = 1
    elif any(p['ref'] == 'U1' for p in netpads[n]):
        grp = 0
    elif n in PWR:
        grp = 3
    else:
        grp = 2
    return (grp, bbox_size(n))
route_nets.sort(key=prio)

# ---------- A* ----------
def own_carve(plist, net, cls):
    """cells inside own pads' clearance dilation but NOT inside any foreign pad's dilation"""
    own = np.zeros((2, NX, NX), dtype=bool)
    d = CL + HQ[cls]
    for q in plist:
        Ls = (0, 1) if q['kind'] in ('thru_hole', 'np_thru_hole') else (0,)
        for L in Ls:
            block_rect(own[L], q['x'], q['y'], q['sx'] / 2 + d, q['sy'] / 2 + d)
    keys = set((q['ref'], q['num']) for q in plist)
    fm = np.zeros((2, NX, NX), dtype=bool)
    for q in pads:
        if (q['ref'], q['num']) in keys or q['net'] == net:
            continue
        Ls = (0, 1) if q['kind'] in ('thru_hole', 'np_thru_hole') else (0,)
        for L in Ls:
            block_rect(fm[L], q['x'], q['y'], q['sx'] / 2 + d, q['sy'] / 2 + d)
    own &= ~fm
    return own

def astar(starts, targets, cls, own_masks, net, wnd, ignore_tracks=False):
    """starts: list[(L,j,i)], targets: set[(L,j,i)]. Returns path list[(L,j,i)] or None."""
    j1, j2, i1, i2 = wnd
    own_c, own_v = own_masks
    eff = [None, None]
    veff = [None, None]
    if ignore_tracks:
        for L in range(2):
            eff[L] = base[cls, L] | (pad_obst[cls, L] & ~own_c[L])
            veff[L] = base[2, L] | (pad_obst[2, L] & ~own_v[L])
    else:
        for L in range(2):
            eff[L] = foreign(cls, L, net) | (pad_obst[cls, L] & ~own_c[L])
            veff[L] = foreign(2, L, net) | (pad_obst[2, L] & ~own_v[L])
    tset = targets
    # heuristic vs representative subset (keeps it fast; still terminates on full set)
    tarr = list(targets)
    if len(tarr) > 400:
        tarr = tarr[::len(tarr) // 400 + 1]
    tj = np.array([t[1] for t in tarr]); ti = np.array([t[2] for t in tarr])
    def h(j, i):
        return int(np.min(np.abs(tj - j) + np.abs(ti - i)))
    openq = []
    g = {}
    came = {}
    for s in starts:
        g[s] = 0
        heapq.heappush(openq, (h(s[1], s[2]), 0, s, None))
    seen = set()
    while openq:
        _, gc, node, prev = heapq.heappop(openq)
        if node in seen:
            continue
        seen.add(node)
        came[node] = prev
        if node in tset:
            path = [node]
            while came[path[-1]] is not None:
                path.append(came[path[-1]])
            return path[::-1]
        L, j, i = node
        for dj, di in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nj, ni = j + dj, i + di
            if not (j1 <= nj <= j2 and i1 <= ni <= i2):
                continue
            nn = (L, nj, ni)
            if nn in seen: continue
            if eff[L][nj, ni] and nn not in tset:
                continue
            ng = gc + 1
            if ng < g.get(nn, 1 << 30):
                g[nn] = ng
                heapq.heappush(openq, (ng + h(nj, ni), ng, nn, node))
        # via
        oL = 1 - L
        nn = (oL, j, i)
        if nn not in seen and not veff[0][j, i] and not veff[1][j, i]:
            ng = gc + VIA_COST
            if ng < g.get(nn, 1 << 30):
                g[nn] = ng
                heapq.heappush(openq, (ng + h(j, i), ng, nn, node))
    return None

def pad_cells(p):
    """centerline-enterable cells of a pad (on its layer(s)), shrunk a bit."""
    hx = max(0.0, p['sx'] / 2 - 0.05)
    hy = max(0.0, p['sy'] / 2 - 0.05)
    i1, i2 = gi(p['x'] - hx), gi(p['x'] + hx)
    j1, j2 = gi(p['y'] - hy), gi(p['y'] + hy)
    Ls = (0, 1) if p['kind'] == 'thru_hole' else (0,)
    out = []
    for L in Ls:
        for j in range(max(0, j1), min(NX, j2 + 1)):
            for i in range(max(0, i1), min(NX, i2 + 1)):
                out.append((L, j, i))
    out += fanout_cells.get((p['ref'], p['num']), [])
    return out

def emit_path(path, w, net):
    """convert grid path to segments+vias, register obstacles, return dyn cells."""
    dyn = []
    runs = []
    cur = [path[0]]
    for n in path[1:]:
        if n[0] != cur[-1][0]:
            runs.append(cur); runs.append('VIA'); cur = [n]
        else:
            cur.append(n)
    runs.append(cur)
    prev_end = None
    for r in runs:
        if r == 'VIA':
            continue
        # simplify colinear
        pts = [r[0]]
        for a, b in zip(r[1:], r[2:] if len(r) > 2 else []):
            pass
        simp = [r[0]]
        for k in range(1, len(r) - 1):
            (L, j0, i0), (_, j1_, i1_), (_, j2_, i2_) = r[k - 1], r[k], r[k + 1]
            if (j1_ - j0, i1_ - i0) != (j2_ - j1_, i2_ - i1_):
                simp.append(r[k])
        if len(r) > 1:
            simp.append(r[-1])
        L = r[0][0]
        for a, b in zip(simp, simp[1:]):
            x1, y1 = gx(a[2]), gx(a[1]) - X0 + Y0
            x2, y2 = gx(b[2]), gx(b[1]) - X0 + Y0
            segments.append((x1, y1, x2, y2, w, L, net))
            segments_np_block(x1, y1, x2, y2, w, L, net)
        dyn.extend(r)
    # vias at layer changes
    for a, b in zip(path, path[1:]):
        if a[0] != b[0]:
            x, y = gx(a[2]), gx(a[1]) - X0 + Y0
            vias.append((x, y, net))
            place_via(x, y, net)
            dyn.append((0, a[1], a[2])); dyn.append((1, a[1], a[2]))
    return dyn

# ---------- staircase fanout: U1 west pins 2-9 (0.4mm pitch -> 0.9mm, via to B) ----------
FAN = {'2': (121.9, 120.3), '3': (122.8, 119.9), '4': (123.7, 119.5), '5': (124.6, 119.1),
       '6': (126.1, 119.1), '7': (127.0, 119.5), '8': (127.9, 119.9), '9': (128.8, 120.3)}
FAN_VIA_X = 118.5
fanout_cells = {}
def cells_of_seg(x1, y1, x2, y2):
    out = []
    if x1 == x2:
        for j in range(min(gi(y1), gi(y2)), max(gi(y1), gi(y2)) + 1):
            out.append((gi(x1), j))
    else:
        for i in range(min(gi(x1), gi(x2)), max(gi(x1), gi(x2)) + 1):
            out.append((i, gi(y1)))
    return out
for num, (Y, xk) in FAN.items():
    p = next(q for q in pads if q['ref'] == 'U1' and q['num'] == num)
    net = p['net']
    x, y = p['x'], p['y']
    segs = [(x, y, xk, y), (xk, y, xk, Y), (xk, Y, FAN_VIA_X, Y)]
    cl = []
    for (x1, y1, x2, y2) in segs:
        if (x1, y1) != (x2, y2):
            segments.append((x1, y1, x2, y2, W_SIG, 0, net))
            segments_np_block(x1, y1, x2, y2, W_SIG, 0, net)
            cl += [(0, j, i) for (i, j) in cells_of_seg(x1, y1, x2, y2)]
    vias.append((FAN_VIA_X, Y, net))
    place_via(FAN_VIA_X, Y, net)
    cl.append((0, gi(Y), gi(FAN_VIA_X)))
    cl.append((1, gi(Y), gi(FAN_VIA_X)))
    fanout_cells[('U1', num)] = cl
# pre-stub: U1 pin22 (3V3, bottom side) straight south before neighbours seal it
p22 = next(q for q in pads if q['ref'] == 'U1' and q['num'] == '22')
stub = (p22['x'], p22['y'], p22['x'], 131.8)
segments.append((stub[0], stub[1], stub[2], stub[3], W_PWR, 0, p22['net']))
segments_np_block(stub[0], stub[1], stub[2], stub[3], W_PWR, 0, p22['net'])
fanout_cells[('U1', '22')] = [(0, j, gi(p22['x'])) for j in range(gi(p22['y']), gi(131.8) + 1)]
print("fanout pre-routed for U1 pins", sorted(FAN), "+ 3V3 stub pin22")

# ---------- route ----------
failed = []
remaining_failed_pads = {}
net_state = {}

def rip(net):
    """remove all placed geometry of a net"""
    global segments, vias
    segments = [g for g in segments if g[6] != net]
    vias = [v for v in vias if v[2] != net]
    if net in netblk:
        del netblk[net]
    if net in net_state:
        del net_state[net]
    # re-place staircase fanout geometry for this net (it is fixed pre-routing)
    for num, (Y, xk) in FAN.items():
        q = next(z for z in pads if z['ref'] == 'U1' and z['num'] == num)
        if q['net'] != net:
            continue
        x, y = q['x'], q['y']
        for (x1, y1, x2, y2) in ((x, y, xk, y), (xk, y, xk, Y), (xk, Y, FAN_VIA_X, Y)):
            segments.append((x1, y1, x2, y2, W_SIG, 0, net))
            segments_np_block(x1, y1, x2, y2, W_SIG, 0, net)
        vias.append((FAN_VIA_X, Y, net))
        place_via(FAN_VIA_X, Y, net)
    if net == "3V3":
        segments.append((stub[0], stub[1], stub[2], stub[3], W_PWR, 0, "3V3"))
        segments_np_block(stub[0], stub[1], stub[2], stub[3], W_PWR, 0, "3V3")
def route_net(net, only_pads=None):
    cls = 1 if net in PWR else 0
    w = W_PWR if net in PWR else W_SIG
    plist = netpads[net] if only_pads is None else only_pads
    full = netpads[net]
    own_masks = (own_carve(full, net, cls), own_carve(full, net, 2))
    if net in net_state:
        own_dyn, routed_cells, routed_pts = net_state[net]
        remaining = list(plist)
    else:
        own_dyn = np.zeros((2, NX, NX), dtype=bool)
        for q in plist:
            for (L, j, i) in fanout_cells.get((q['ref'], q['num']), []):
                own_dyn[L, j, i] = True
        remaining = list(plist)
        remaining.sort(key=lambda p: (p['x'], p['y']))
        seed = remaining.pop(0)
        routed_cells = set(pad_cells(seed))
        routed_pts = [(seed['x'], seed['y'])]
        net_state[net] = (own_dyn, routed_cells, routed_pts)
    while remaining:
        # nearest remaining pad to routed set
        def dmin(p):
            return min(abs(p['x'] - qx) + abs(p['y'] - qy) for qx, qy in routed_pts)
        remaining.sort(key=dmin)
        p = remaining.pop(0)
        starts = [c for c in pad_cells(p)]
        targets = routed_cells
        # window
        xs = [p['x']] + [q for q, _ in routed_pts]
        ys = [p['y']] + [q for _, q in routed_pts]
        for margin in (8.0, 30.0, 60.0):
            i1 = max(0, gi(min(xs) - margin)); i2 = min(NX - 1, gi(max(xs) + margin))
            j1 = max(0, gi(min(ys) - margin)); j2 = min(NX - 1, gi(max(ys) + margin))
            path = astar(starts, targets, cls, own_masks, net, (j1, j2, i1, i2))
            if path:
                break
        if not path:
            failed.append((net, p['ref'], p['num']))
            remaining_failed_pads.setdefault(net, []).append(p)
            continue
        dyn = emit_path(path, w, net)
        for c in dyn:
            own_dyn[c[0], c[1], c[2]] = True
            routed_cells.add(c)
        routed_pts.append((p['x'], p['y']))
        routed_cells.update(pad_cells(p))

# ---------- GND stitching ----------
gnd_vias = []
# RP2040 EP: 4 vias inside EP
ep = next(p for p in pads if p['ref'] == 'U1' and p['num'] == '57')
for dx, dy in ((-0.8, -0.8), (0.8, -0.8), (-0.8, 0.8), (0.8, 0.8)):
    gnd_vias.append((ep['x'] + dx, ep['y'] + dy))
    place_via(ep['x'] + dx, ep['y'] + dy, "GND")

gnd_stubs = []
for p in pads:
    if p['net'] != 'GND' or p['kind'] != 'smd' or (p['ref'] == 'U1' and p['num'] == '57'):
        continue
    # find free via spot near pad
    best = None
    for rad in (0.7, 0.9, 1.1, 1.4, 1.8, 2.2, 2.6):
        angs = sorted(range(0, 360, 15), key=lambda a: -math.hypot(
            p['x'] + rad * math.cos(math.radians(a)) - 125.0,
            p['y'] + rad * math.sin(math.radians(a)) - 126.0))
        for ang in angs:
            vx = p['x'] + rad * math.cos(math.radians(ang))
            vy = p['y'] + rad * math.sin(math.radians(ang))
            i, j = gi(vx), gi(vy)
            if not (0 <= i < NX and 0 <= j < NX):
                continue
            # must be clear of everything except this pad itself
            ok = True
            gveff = [foreign(2, 0, "GND"), foreign(2, 1, "GND")]
            for L in range(2):
                if gveff[L][j, i]:
                    ok = False; break
                # pad_obst excluding own pad
                if pad_obst[2, L][j, i]:
                    cx, cy, hx, hy = p['x'], p['y'], p['sx'] / 2, p['sy'] / 2
                    d = CL + HQ[2]
                    if not (abs(vx - cx) <= hx + d and abs(vy - cy) <= hy + d):
                        ok = False; break
            if ok:
                # must not violate any non-GND pad (0.06 margin for coordinate rounding)
                for q in pads:
                    if q['net'] == 'GND':
                        continue
                    dq = CL + HQ[2] + 0.06
                    if abs(vx - q['x']) <= q['sx'] / 2 + dq and abs(vy - q['y']) <= q['sy'] / 2 + dq:
                        ok = False; break
            if ok:
                # corridor from pad to via must be free on F.Cu (signal class)
                cxp, cyp, hxp, hyp = p['x'], p['y'], p['sx'] / 2, p['sy'] / 2
                d0 = CL + HQ[0]
                fg = foreign(0, 0, "GND")
                for t in (0.2, 0.4, 0.6, 0.8):
                    sxp = p['x'] + (vx - p['x']) * t
                    syp = p['y'] + (vy - p['y']) * t
                    ii, jj = gi(sxp), gi(syp)
                    inside_own = abs(sxp - cxp) <= hxp + d0 and abs(syp - cyp) <= hyp + d0
                    if fg[jj, ii] or (pad_obst[0, 0][jj, ii] and not inside_own):
                        ok = False; break
                    for q in pads:
                        if q['net'] == 'GND':
                            continue
                        dq = CL + 0.125 + 0.125
                        if abs(sxp - q['x']) <= q['sx'] / 2 + dq and abs(syp - q['y']) <= q['sy'] / 2 + dq:
                            ok = False; break
                    if not ok:
                        break
            if ok:
                best = (round(vx, 2), round(vy, 2))
                break
        if best:
            break
    if best:
        gnd_vias.append(best)
        place_via(best[0], best[1], "GND")
        gnd_stubs.append((p['x'], p['y'], best[0], best[1]))
    else:
        # fallback: maze-route this pad to the nearest GND via already placed
        own_masks_g = (own_carve(netpads['GND'], 'GND', 0), own_carve(netpads['GND'], 'GND', 2))
        targets = set()
        for (vx, vy) in gnd_vias:
            for L in range(2):
                targets.add((L, gi(vy), gi(vx)))
        starts = pad_cells(p)
        path = None
        for margin in (6.0, 15.0, 40.0):
            i1 = max(0, gi(p['x'] - margin)); i2 = min(NX - 1, gi(p['x'] + margin))
            j1 = max(0, gi(p['y'] - margin)); j2 = min(NX - 1, gi(p['y'] + margin))
            path = astar(starts, targets, 0, own_masks_g, "GND", (j1, j2, i1, i2))
            if path:
                break
        if path:
            for (x1, y1, x2, y2, w, L, net) in []:
                pass
            dyn = emit_path(path, 0.25, "GND")
            print("GND routed via track:", p['ref'], p['num'])
        else:
            print("STILL no GND connection for", p['ref'], p['num'])


for net in route_nets:
    route_net(net)
# retry pass: leftover space may now allow previously failed drops
if failed:
    retry = failed; failed = []
    remaining_failed_pads = {}
    for net, ref, num in retry:
        p = next(q for q in netpads[net] if q['ref'] == ref and q['num'] == num)
        route_net(net, only_pads=[p])

# rip-up & reroute
rip_budget = 14
while failed and rip_budget > 0:
    net, ref, num = failed[0]
    p = next(q for q in netpads[net] if q['ref'] == ref and q['num'] == num)
    cls = 1 if net in PWR else 0
    full = netpads[net]
    own_masks = (own_carve(full, net, cls), own_carve(full, net, 2))
    own_dyn0, routed_cells, routed_pts = net_state[net]
    starts = pad_cells(p)
    i1, i2, j1, j2 = 0, NX - 1, 0, NX - 1
    ideal = astar(starts, routed_cells, cls, own_masks, net, (j1, j2, i1, i2), ignore_tracks=True)
    if not ideal:
        print("rip-up: no ideal path for", net, ref, num)
        failed.pop(0)
        continue
    blockers = set()
    for (L, j, i) in ideal:
        for m, arr in netblk.items():
            if m != net and arr[cls, L][j, i]:
                blockers.add(m)
    blockers -= {"GND"}
    if not blockers:
        print("rip-up: no rippable blockers for", net, ref, num)
        failed.pop(0)
        continue
    print(f"rip-up: {net} blocked by {sorted(blockers)}; ripping")
    for m in blockers:
        rip(m)
        rip_budget -= 1
    failed = []
    remaining_failed_pads = {}
    route_net(net, only_pads=[p])
    for m in sorted(blockers, key=bbox_size):
        route_net(m)

print("routed nets:", len(route_nets) - len(set(n for n, _, _ in failed)), "/", len(route_nets))
print("failed:", failed)
print("segments:", len(segments), "vias:", len(vias))

# EP fan: connect EP via stub? vias are inside EP pad - fine, no stub needed.
print("GND vias:", len(gnd_vias), "stubs:", len(gnd_stubs))

# ---------- write back ----------
netid = {v: k for k, v in netname.items()}
add = []
for (x1, y1, x2, y2, w, L, net) in segments:
    layer = "F.Cu" if L == 0 else "B.Cu"
    add.append(f'  (segment (start {f(x1)} {f(y1)}) (end {f(x2)} {f(y2)}) (width {f(w)}) '
               f'(layer "{layer}") (net {netid[net]}) (uuid "{u()}"))')
for (x, y, net) in vias:
    add.append(f'  (via (at {f(x)} {f(y)}) (size {f(VIA_D)}) (drill {f(VIA_DRILL)}) '
               f'(layers "F.Cu" "B.Cu") (net {netid[net]}) (uuid "{u()}"))')
g = netid["GND"]
for (x, y) in gnd_vias:
    add.append(f'  (via (at {f(x)} {f(y)}) (size {f(VIA_D)}) (drill {f(VIA_DRILL)}) '
               f'(layers "F.Cu" "B.Cu") (net {g}) (uuid "{u()}"))')
for (x1, y1, x2, y2) in gnd_stubs:
    add.append(f'  (segment (start {f(x1)} {f(y1)}) (end {f(x2)} {f(y2)}) (width 0.25) '
               f'(layer "F.Cu") (net {g}) (uuid "{u()}"))')

new = text.rstrip()
assert new.endswith(')')
new = new[:-1] + "\n".join(add) + "\n)\n"
open(PCB, "w").write(new)
print("written", PCB)
