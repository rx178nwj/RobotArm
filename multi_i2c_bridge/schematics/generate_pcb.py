#!/usr/bin/env python3
"""Generate 50x50mm .kicad_pcb for multi_i2c_bridge.
Nets extracted from the schematic; footprints generated inline; placement done,
routing left for KiCad. Board origin (100,100)-(150,150)."""
import re, uuid as uuidlib

SCH = "/home/j0901413/etc/multi_i2c_bridge/kicad/multi_i2c_bridge.kicad_sch"
OUT = "/home/j0901413/etc/multi_i2c_bridge/kicad/multi_i2c_bridge.kicad_pcb"

def u(): return str(uuidlib.uuid4())
def f(v):
    s = f"{v:.4f}".rstrip("0").rstrip(".")
    return s if s else "0"

# ---------- parse schematic ----------
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
def unq(s): return s[1:-1].replace('\\"', '"').replace("\\n", "\n") if s.startswith('"') else s

doc = parse(open(SCH).read())

libpins = {}
for sym in kid(doc, 'lib_symbols')[1:]:
    name = unq(sym[1]); pins = {}
    for sub in kids(sym, 'symbol'):
        for it in kids(sub, 'pin'):
            at = kid(it, 'at')
            pins[unq(kid(it, 'number')[1])] = (float(at[1]), float(at[2]))
    libpins[name] = pins

# union-find over points
parent = {}
def find(p):
    parent.setdefault(p, p)
    while parent[p] != p:
        parent[p] = parent[parent[p]]; p = parent[p]
    return p
def union(a, b): parent[find(a)] = find(b)
def pt(x, y): return (round(x, 2), round(y, 2))

pinof = {}   # (ref, num) -> point
values = {}  # ref -> value
fpnames = {} # ref -> schematic footprint string
for el in kids(doc, 'symbol'):
    lib = unq(kid(el, 'lib_id')[1])
    at = kid(el, 'at'); x0, y0 = float(at[1]), float(at[2])
    props = {unq(p[1]): unq(p[2]) for p in kids(el, 'property')}
    ref = props['Reference']
    values[ref] = props.get('Value', '')
    fpnames[ref] = props.get('Footprint', '')
    for num, (px, py) in libpins[lib].items():
        p = pt(x0 + px, y0 - py)
        pinof[(ref, num)] = p
        find(p)
for el in kids(doc, 'wire'):
    pts = [pt(float(p[1]), float(p[2])) for p in kid(el, 'pts')[1:]]
    union(pts[0], pts[1])
netname_of_group = {}
for el in kids(doc, 'global_label'):
    at = kid(el, 'at')
    netname_of_group[find(pt(float(at[1]), float(at[2])))] = unq(el[1])

# synthesize names for label-less nets that join >=2 pins (e.g. LED-R series links)
from collections import defaultdict
group_pins = defaultdict(list)
for (ref, num), p in pinof.items():
    group_pins[find(p)].append((ref, num))
for g, plist in group_pins.items():
    if g not in netname_of_group and len(plist) >= 2:
        r, n = sorted(plist)[0]
        netname_of_group[g] = f"Net-({r}-Pad{n})"

def net_of(ref, num):
    p = pinof.get((ref, num))
    if p is None: return None
    return netname_of_group.get(find(p))

# ---------- footprint generators ----------
# pad: (num, kind, shape, x, y, rot, sx, sy, drill)  kind: smd|tht|npth
def two(px, sx, sy):
    return [("1", "smd", "roundrect", -px, 0, 0, sx, sy, 0),
            ("2", "smd", "roundrect", px, 0, 0, sx, sy, 0)]

def qfn56():
    pads = []
    for i in range(1, 15):   # left, top->bottom
        pads.append((str(i), "smd", "roundrect", -3.4375, -2.6 + (i - 1) * 0.4, 0, 0.875, 0.2, 0))
    for i in range(15, 29):  # bottom, left->right
        pads.append((str(i), "smd", "roundrect", -2.6 + (i - 15) * 0.4, 3.4375, 0, 0.2, 0.875, 0))
    for i in range(29, 43):  # right, bottom->top
        pads.append((str(i), "smd", "roundrect", 3.4375, 2.6 - (i - 29) * 0.4, 0, 0.875, 0.2, 0))
    for i in range(43, 57):  # top, right->left
        pads.append((str(i), "smd", "roundrect", 2.6 - (i - 43) * 0.4, -3.4375, 0, 0.2, 0.875, 0))
    pads.append(("57", "smd", "rect", 0, 0, 0, 3.2, 3.2, 0))
    return pads

def tssop24():
    pads = []
    for i in range(1, 13):
        pads.append((str(i), "smd", "roundrect", -2.9, -3.575 + (i - 1) * 0.65, 0, 1.5, 0.4, 0))
    for i in range(13, 25):
        pads.append((str(i), "smd", "roundrect", 2.9, 3.575 - (i - 13) * 0.65, 0, 1.5, 0.4, 0))
    return pads

def soic8w():  # 208mil W25Q128
    pads = []
    for i in range(1, 5):
        pads.append((str(i), "smd", "roundrect", -3.55, -1.905 + (i - 1) * 1.27, 0, 1.9, 0.6, 0))
    for i in range(5, 9):
        pads.append((str(i), "smd", "roundrect", 3.55, 1.905 - (i - 5) * 1.27, 0, 1.9, 0.6, 0))
    return pads

def sot235():
    return [("1", "smd", "roundrect", -0.95, 1.3, 0, 0.6, 1.2, 0),
            ("2", "smd", "roundrect", 0, 1.3, 0, 0.6, 1.2, 0),
            ("3", "smd", "roundrect", 0.95, 1.3, 0, 0.6, 1.2, 0),
            ("4", "smd", "roundrect", 0.95, -1.3, 0, 0.6, 1.2, 0),
            ("5", "smd", "roundrect", -0.95, -1.3, 0, 0.6, 1.2, 0)]

def xtal3225():
    return [("1", "smd", "roundrect", -1.1, 0.8, 0, 1.4, 1.15, 0),
            ("2", "smd", "roundrect", 1.1, 0.8, 0, 1.4, 1.15, 0),
            ("3", "smd", "roundrect", 1.1, -0.8, 0, 1.4, 1.15, 0),
            ("4", "smd", "roundrect", -1.1, -0.8, 0, 1.4, 1.15, 0)]

def usb_micro():
    pads = []
    for i in range(5):
        pads.append((str(i + 1), "smd", "roundrect", -1.3 + i * 0.65, -1.05, 0, 0.4, 1.35, 0))
    for sx, sy in ((-3.6, -1.0), (3.6, -1.0), (-3.6, 1.7), (3.6, 1.7)):
        pads.append(("6", "smd", "roundrect", sx, sy, 0, 1.6, 1.8, 0))
    pads.append(("", "npth", "circle", -2.5, 0.55, 0, 0.85, 0.85, 0.85))
    pads.append(("", "npth", "circle", 2.5, 0.55, 0, 0.85, 0.85, 0.85))
    return pads

def xh(n):
    pads = []
    start = -(n - 1) * 2.5 / 2
    for i in range(n):
        shape = "rect" if i == 0 else "circle"
        pads.append((str(i + 1), "tht", shape, start + i * 2.5, 0, 0, 1.8, 1.8, 1.0))
    return pads

def ph(n):
    pads = []
    start = -(n - 1) * 2.0 / 2
    for i in range(n):
        shape = "rect" if i == 0 else "circle"
        pads.append((str(i + 1), "tht", shape, start + i * 2.0, 0, 0, 1.4, 1.4, 0.8))
    return pads

def hdr(n):
    pads = []
    start = -(n - 1) * 2.54 / 2
    for i in range(n):
        shape = "rect" if i == 0 else "circle"
        pads.append((str(i + 1), "tht", shape, start + i * 2.54, 0, 0, 1.7, 1.7, 1.0))
    return pads

def sw2():
    return [("1", "smd", "roundrect", -3.5, 0, 0, 1.8, 1.8, 0),
            ("2", "smd", "roundrect", 3.5, 0, 0, 1.8, 1.8, 0)]

def hole():
    return [("", "npth", "circle", 0, 0, 0, 2.7, 2.7, 2.7)]

FPGEN = {
    "R_0603":  (lambda: two(0.7875, 0.875, 0.95), (1.7, 0.9), "smd"),
    "C_0402":  (lambda: two(0.51, 0.59, 0.64), (1.1, 0.6), "smd"),
    "C_0603":  (lambda: two(0.7875, 0.875, 0.95), (1.7, 0.9), "smd"),
    "C_0805":  (lambda: two(0.95, 1.0, 1.45), (2.1, 1.4), "smd"),
    "D_SMA":   (lambda: two(2.05, 2.6, 1.6), (4.4, 2.7), "smd"),
    "QFN56":   (qfn56, (7.0, 7.0), "smd"),
    "TSSOP24": (tssop24, (4.4, 7.8), "smd"),
    "SOIC8W":  (soic8w, (5.3, 5.3), "smd"),
    "SOT235":  (sot235, (1.7, 3.0), "smd"),
    "XTAL3225": (xtal3225, (3.2, 2.5), "smd"),
    "USB_MICRO": (usb_micro, (7.4, 5.0), "smd"),
    "XH4":     (lambda: xh(4), (12.4, 5.75), "tht"),
    "XH5":     (lambda: xh(5), (14.9, 5.75), "tht"),
    "PH5":     (lambda: ph(5), (11.95, 4.5), "tht"),
    "HDR3":    (lambda: hdr(3), (7.62, 2.54), "tht"),
    "SW":      (sw2, (6.2, 6.5), "smd"),
    "HOLE":    (hole, (3.2, 3.2), "npth"),
}

def fp_of(ref):
    s = fpnames.get(ref, "")
    if "R_0603" in s: return "R_0603"
    if "C_0402" in s: return "C_0402"
    if "C_0805" in s: return "C_0805"
    if "C_0603" in s: return "C_0603"
    if "LED_0603" in s: return "C_0603"
    if "D_SMA" in s: return "D_SMA"
    if "QFN-56" in s: return "QFN56"
    if "TSSOP-24" in s: return "TSSOP24"
    if "SOIC-8_5.23" in s: return "SOIC8W"
    if "SOT-23-5" in s: return "SOT235"
    if "Crystal" in s: return "XTAL3225"
    if "USB_Micro" in s: return "USB_MICRO"
    if "B4B-XH" in s: return "XH4"
    if "B5B-XH" in s: return "XH5"
    if "B5B-PH" in s: return "PH5"
    if "PinHeader_1x03" in s: return "HDR3"
    if "TL3342" in s: return "SW"
    raise KeyError(f"{ref}: {s}")

# ---------- placement (board 100,100 - 150,150) ----------
EXCLUDE = {"U5", "U6", "U7", "J5", "J6", "J7", "C20", "C21", "C22"}
PLACE = {
    # 電源 (上辺左)
    "J9":  (125.0, 102.6, 0),
    "R1":  (118.5, 107.0, 90), "R2": (131.5, 107.0, 90),
    "D1":  (108.8, 103.5, 0), "D2": (108.8, 107.0, 0),
    "U4":  (114.5, 105.5, 0),
    "C17": (106.5, 110.8, 0), "C18": (117.0, 104.3, 90), "C19": (117.0, 108.0, 90),
    "LED2": (121.5, 110.5, 0), "R22": (126.5, 110.5, 0),
    # 上流コネクタ (左辺)
    "J1":  (102.9, 125.0, 90),
    "R7":  (108.0, 119.5, 90), "R8": (108.0, 123.0, 90),
    # 状態LED
    "LED1": (105.0, 114.0, 0), "R21": (105.0, 117.0, 0),
    # フラッシュ + 水晶
    "U2":  (113.0, 113.5, 0), "C15": (113.0, 117.8, 0),
    "Y1":  (118.0, 136.6, 0),
    "C13": (117.5, 139.8, 90), "C14": (121.5, 139.8, 90), "R3": (125.0, 139.8, 90),
    # RP2040 + デカップリング
    "U1":  (125.0, 126.0, 0),
    "C1":  (117.5, 122.0, 90), "C2": (117.5, 125.0, 90), "C3": (117.5, 128.0, 90),
    "C4":  (132.5, 122.0, 90), "C5": (132.5, 125.0, 90), "C6": (132.5, 128.0, 90),
    "C11": (122.0, 118.3, 0), "C9": (125.0, 118.3, 0), "C10": (128.0, 118.3, 0),
    "C12": (121.5, 133.7, 0), "C7": (125.0, 133.7, 0), "C8": (128.5, 133.7, 0),
    # TCA9548A + プルアップ
    "U3":  (137.0, 120.0, 0),
    "C16": (133.0, 112.5, 0), "R11": (137.5, 112.5, 0),
    "R9":  (142.6, 108.0, 90), "R10": (142.6, 111.0, 90),
    "R12": (142.6, 114.0, 90), "R13": (142.6, 117.0, 90), "R14": (142.6, 120.0, 90),
    "R15": (142.6, 123.0, 90), "R16": (142.6, 126.0, 90), "R17": (142.6, 129.0, 90),
    "R18": (136.0, 131.5, 0), "R19": (136.0, 135.0, 0), "R20": (136.0, 138.5, 0),
    # センサコネクタ (右辺)
    "J2":  (146.6, 111.0, 90), "J3": (146.6, 126.5, 90), "J4": (146.6, 142.0, 90),
    # ボタン・SWD (下辺)
    "R4":  (104.5, 141.0, 0), "R5": (108.5, 141.0, 0), "R6": (112.5, 141.0, 0),
    "SW1": (112.0, 146.0, 0), "SW2": (124.0, 146.0, 0),
    "J8":  (133.0, 147.2, 0),
}
HOLES = [(103.5, 103.5), (103.5, 146.5), (135.0, 103.5), (140.0, 146.5)]

# ---------- collect nets ----------
netnames = set()
for ref in PLACE:
    gen, _, _ = FPGEN[fp_of(ref)]
    for pad in gen():
        n = net_of(ref, pad[0]) if pad[0] else None
        if n: netnames.add(n)
netlist = sorted(netnames)
netid = {n: i + 1 for i, n in enumerate(netlist)}

# ---------- emit ----------
out = []
out.append('(kicad_pcb (version 20240108) (generator "pcbnew") (generator_version "8.0")')
out.append('  (general (thickness 1.6) (legacy_teardrops no))')
out.append('  (paper "A4")')
out.append('''  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (32 "B.Adhes" user "B.Adhesive")
    (33 "F.Adhes" user "F.Adhesive")
    (34 "B.Paste" user)
    (35 "F.Paste" user)
    (36 "B.SilkS" user "B.Silkscreen")
    (37 "F.SilkS" user "F.Silkscreen")
    (38 "B.Mask" user)
    (39 "F.Mask" user)
    (40 "Dwgs.User" user "User.Drawings")
    (41 "Cmts.User" user "User.Comments")
    (44 "Edge.Cuts" user)
    (45 "Margin" user)
    (46 "B.CrtYd" user "B.Courtyard")
    (47 "F.CrtYd" user "F.Courtyard")
    (48 "B.Fab" user)
    (49 "F.Fab" user)
  )''')
out.append('  (setup (pad_to_mask_clearance 0) (allow_soldermask_bridges_in_footprints no) '
           '(pcbplotparams (layerselection 0x00010fc_ffffffff) (plot_on_all_layers_selection 0x0000000_00000000)))')
out.append('  (net 0 "")')
for n in netlist:
    out.append(f'  (net {netid[n]} "{n}")')

FONT = '(effects (font (size 0.8 0.8) (thickness 0.12)))'

def emit_fp(ref, value, fpkey, cx, cy, rot, schfp=""):
    gen, (bw, bh), attr = FPGEN[fpkey]
    pads = gen()
    L = []
    L.append(f'  (footprint "bridge:{fpkey}" (layer "F.Cu") (uuid "{u()}") (at {f(cx)} {f(cy)} {rot})')
    L.append(f'    (property "Reference" "{ref}" (at 0 {f(-bh/2-1.0)} {rot}) (layer "F.SilkS") (uuid "{u()}") {FONT})')
    L.append(f'    (property "Value" "{value}" (at 0 {f(bh/2+1.0)} {rot}) (layer "F.Fab") (uuid "{u()}") {FONT})')
    L.append(f'    (property "Footprint" "{schfp}" (at 0 0 {rot}) (layer "F.Fab") (hide yes) (uuid "{u()}") {FONT})')
    L.append(f'    (property "Datasheet" "" (at 0 0 {rot}) (layer "F.Fab") (hide yes) (uuid "{u()}") {FONT})')
    L.append(f'    (property "Description" "" (at 0 0 {rot}) (layer "F.Fab") (hide yes) (uuid "{u()}") {FONT})')
    if attr == "smd":
        L.append('    (attr smd)')
    elif attr == "tht":
        L.append('    (attr through_hole)')
    else:
        L.append('    (attr exclude_from_pos_files exclude_from_bom)')
    # silk outline
    x2, y2 = bw / 2, bh / 2
    if fpkey != "HOLE":
        for (a, b, c, d) in ((-x2, -y2, x2, -y2), (x2, -y2, x2, y2), (x2, y2, -x2, y2), (-x2, y2, -x2, -y2)):
            L.append(f'    (fp_line (start {f(a)} {f(b)}) (end {f(c)} {f(d)}) '
                     f'(stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "{u()}"))')
        L.append(f'    (fp_circle (center {f(-x2-0.6)} {f(-y2)}) (end {f(-x2-0.35)} {f(-y2)}) '
                 f'(stroke (width 0.15) (type solid)) (fill solid) (layer "F.SilkS") (uuid "{u()}"))')
    for (num, kind, shape, px, py, prot, sx, sy, drill) in pads:
        net = net_of(ref, num) if num else None
        netc = f' (net {netid[net]} "{net}")' if net else ''
        arot = (rot + prot) % 360
        if kind == "smd":
            rr = ' (roundrect_rratio 0.25)' if shape == "roundrect" else ''
            L.append(f'    (pad "{num}" smd {shape} (at {f(px)} {f(py)} {arot}) (size {f(sx)} {f(sy)}) '
                     f'(layers "F.Cu" "F.Paste" "F.Mask"){rr}{netc} (uuid "{u()}"))')
        elif kind == "tht":
            L.append(f'    (pad "{num}" thru_hole {shape} (at {f(px)} {f(py)} {arot}) (size {f(sx)} {f(sy)}) '
                     f'(drill {f(drill)}) (layers "*.Cu" "*.Mask") (remove_unused_layers no){netc} (uuid "{u()}"))')
        else:
            L.append(f'    (pad "" np_thru_hole circle (at {f(px)} {f(py)} {arot}) (size {f(sx)} {f(sy)}) '
                     f'(drill {f(drill)}) (layers "F&B.Cu" "*.Mask") (uuid "{u()}"))')
    L.append('  )')
    out.extend(L)

for ref, (cx, cy, rot) in PLACE.items():
    emit_fp(ref, values.get(ref, ""), fp_of(ref), cx, cy, rot, fpnames.get(ref, ""))
for i, (hx, hy) in enumerate(HOLES, 1):
    emit_fp(f"H{i}", "M2.5", "HOLE", hx, hy, 0)

# board outline
out.append(f'  (gr_rect (start 100 100) (end 150 150) (stroke (width 0.1) (type solid)) (fill none) (layer "Edge.Cuts") (uuid "{u()}"))')
# board name silk
out.append(f'  (gr_text "multi_i2c_bridge v0.1" (at 125 136.5 0) (layer "B.SilkS") (uuid "{u()}") '
           f'(effects (font (size 1.2 1.2) (thickness 0.2)) (justify mirror)))')

# GND zones both layers
gid = netid.get("GND", 0)
for layer in ("F.Cu", "B.Cu"):
    out.append(f'''  (zone (net {gid}) (net_name "GND") (layer "{layer}") (uuid "{u()}") (name "GND_{layer}") (hatch edge 0.5)
    (connect_pads (clearance 0.3))
    (min_thickness 0.25) (filled_areas_thickness no)
    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 100 100) (xy 150 100) (xy 150 150) (xy 100 150)))
  )''')
out.append(')')
open(OUT, "w").write("\n".join(out) + "\n")

# report
from collections import Counter
padnets = Counter()
nc = []
for ref in PLACE:
    gen, _, _ = FPGEN[fp_of(ref)]
    for pad in gen():
        if not pad[0]: continue
        n = net_of(ref, pad[0])
        if n: padnets[n] += 1
        else: nc.append((ref, pad[0]))
print("footprints:", len(PLACE) + len(HOLES), "nets:", len(netlist))
print("pads w/o net (expect NC pins only):", nc)
single = [n for n, c in padnets.items() if c == 1]
print("single-pad nets on board:", single)
