#!/usr/bin/env python3
# Generate KiCad 8 project (schematic) for multi_i2c_bridge
# All symbols embedded -> opens without external libraries.
import uuid as uuidlib
import os

OUT = "/home/j0901413/etc/multi_i2c_bridge/kicad"
PROJ = "multi_i2c_bridge"
ROOT_UUID = str(uuidlib.uuid4())

def u():
    return str(uuidlib.uuid4())

def f(v):
    s = f"{v:.4f}".rstrip("0").rstrip(".")
    return s if s else "0"

FONT = "(effects (font (size 1.27 1.27)))"

# ---------------- lib symbols ----------------
lib_symbols = []

def pin_s(etype, x, y, ang, length, name, num, hide=False):
    h = " hide" if hide else ""
    return (f'(pin {etype} line (at {f(x)} {f(y)} {ang}) (length {f(length)}){h} '
            f'(name "{name}" {FONT}) (number "{num}" {FONT}))')

BOXDIMS = {}

def box_symbol(name, ref_prefix, pins_left, pins_right, w):
    """pins_*: list of (num,name,etype) or None (gap). Returns pin offset dict num->(x,y)."""
    n = max(len(pins_left), len(pins_right))
    span = (n - 1) * 2.54
    ytop = span / 2.0
    h2 = ytop + 2.54
    BOXDIMS[name] = (w, h2)
    body = []
    offs = {}
    body.append(f'(rectangle (start {f(-w/2)} {f(h2)}) (end {f(w/2)} {f(-h2)}) '
                '(stroke (width 0.254) (type default)) (fill (type background)))')
    pins = []
    for i, p in enumerate(pins_left):
        if p is None:
            continue
        num, nm, et = p
        y = ytop - i * 2.54
        pins.append(pin_s(et, -w/2 - 2.54, y, 0, 2.54, nm, num))
        offs[num] = (-w/2 - 2.54, y)
    for i, p in enumerate(pins_right):
        if p is None:
            continue
        num, nm, et = p
        y = ytop - i * 2.54
        pins.append(pin_s(et, w/2 + 2.54, y, 180, 2.54, nm, num))
        offs[num] = (w/2 + 2.54, y)
    sym = f'''    (symbol "{name}" (exclude_from_sim no) (in_bom yes) (on_board yes)
      (property "Reference" "{ref_prefix}" (at {f(-w/2)} {f(h2+1.27)} 0) (effects (font (size 1.27 1.27)) (justify left)))
      (property "Value" "{name.split(':')[1]}" (at {f(-w/2)} {f(-h2-1.27)} 0) (effects (font (size 1.27 1.27)) (justify left)))
      (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (symbol "{name.split(':')[1]}_0_1"
        {body[0]}
      )
      (symbol "{name.split(':')[1]}_1_1"
        {chr(10).join("        " + p for p in pins)}
      )
    )'''
    lib_symbols.append(sym)
    return offs

def twopin_symbol(name, ref_prefix, graphics, pin1_len, pin2_len, etype="passive",
                  p1name="~", p2name="~", p1et=None, p2et=None, nums=("1", "2")):
    """Vertical 2-pin part: nums[0] top at (0,3.81), nums[1] bottom at (0,-3.81)."""
    p1et = p1et or etype
    p2et = p2et or etype
    pins = [
        pin_s(p1et, 0, 3.81, 270, pin1_len, p1name, nums[0]),
        pin_s(p2et, 0, -3.81, 90, pin2_len, p2name, nums[1]),
    ]
    sym = f'''    (symbol "{name}" (exclude_from_sim no) (in_bom yes) (on_board yes)
      (property "Reference" "{ref_prefix}" (at 2.032 1.27 0) (effects (font (size 1.27 1.27)) (justify left)))
      (property "Value" "{name.split(':')[1]}" (at 2.032 -1.27 0) (effects (font (size 1.27 1.27)) (justify left)))
      (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (symbol "{name.split(':')[1]}_0_1"
        {graphics}
      )
      (symbol "{name.split(':')[1]}_1_1"
        {pins[0]}
        {pins[1]}
      )
    )'''
    lib_symbols.append(sym)
    return {nums[0]: (0, 3.81), nums[1]: (0, -3.81)}

STK = '(stroke (width 0.254) (type default)) (fill (type none))'

R_offs = twopin_symbol("bridge:R", "R",
    f'(rectangle (start -1.016 2.54) (end 1.016 -2.54) (stroke (width 0.254) (type default)) (fill (type none)))',
    1.27, 1.27)
C_offs = twopin_symbol("bridge:C", "C",
    f'(polyline (pts (xy -1.905 0.762) (xy 1.905 0.762)) {STK})\n        '
    f'(polyline (pts (xy -1.905 -0.762) (xy 1.905 -0.762)) {STK})',
    3.048, 3.048)
# Diode: A=pin2 top, K=pin1 bottom (graphics: triangle points down to cathode bar / pad1=cathode)
D_offs = twopin_symbol("bridge:D_Schottky", "D",
    f'(polyline (pts (xy -1.27 1.27) (xy 1.27 1.27) (xy 0 -1.27) (xy -1.27 1.27)) {STK})\n        '
    f'(polyline (pts (xy -1.27 -1.27) (xy 1.27 -1.27)) {STK})\n        '
    f'(polyline (pts (xy -1.27 -1.27) (xy -1.778 -0.762)) {STK})\n        '
    f'(polyline (pts (xy 1.27 -1.27) (xy 1.778 -1.778)) {STK})',
    2.54, 2.54, p1name="A", p2name="K", nums=("2", "1"))
LED_offs = twopin_symbol("bridge:LED", "D",
    f'(polyline (pts (xy -1.27 1.27) (xy 1.27 1.27) (xy 0 -1.27) (xy -1.27 1.27)) {STK})\n        '
    f'(polyline (pts (xy -1.27 -1.27) (xy 1.27 -1.27)) {STK})\n        '
    f'(polyline (pts (xy 1.6 0.5) (xy 2.6 1.5)) {STK})\n        '
    f'(polyline (pts (xy 2.1 -0.2) (xy 3.1 0.8)) {STK})',
    2.54, 2.54, p1name="A", p2name="K", nums=("2", "1"))
SW_offs = twopin_symbol("bridge:SW_Push", "SW",
    f'(circle (center 0 2.032) (radius 0.508) {STK})\n        '
    f'(circle (center 0 -2.032) (radius 0.508) {STK})\n        '
    f'(polyline (pts (xy 1.27 2.032) (xy 1.27 -2.032)) {STK})',
    1.27, 1.27)

# PWR_FLAG
lib_symbols.append(f'''    (symbol "bridge:PWR_FLAG" (power) (exclude_from_sim no) (in_bom no) (on_board yes)
      (property "Reference" "#FLG" (at 0 4.5 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (property "Value" "PWR_FLAG" (at 0 4.5 0) {FONT})
      (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (symbol "PWR_FLAG_0_1"
        (polyline (pts (xy 0 0) (xy 0 1.27) (xy -1.016 2.032) (xy 0 2.794) (xy 1.016 2.032) (xy 0 1.27)) {STK})
      )
      (symbol "PWR_FLAG_1_1"
        (pin power_out line (at 0 0 90) (length 0) (name "~" {FONT}) (number "1" {FONT}))
      )
    )''')

RP2040_L = [
    ("1", "IOVDD", "power_in"), ("10", "IOVDD", "power_in"), ("22", "IOVDD", "power_in"),
    ("33", "IOVDD", "power_in"), ("42", "IOVDD", "power_in"), ("49", "IOVDD", "power_in"),
    ("48", "USB_VDD", "power_in"), ("43", "ADC_AVDD", "power_in"),
    ("44", "VREG_VIN", "power_in"), ("45", "VREG_VOUT", "power_out"),
    ("23", "DVDD", "power_in"), ("50", "DVDD", "power_in"),
    None,
    ("20", "XIN", "input"), ("21", "XOUT", "output"),
    ("26", "RUN", "input"), ("24", "SWCLK", "bidirectional"), ("25", "SWDIO", "bidirectional"),
    ("19", "TESTEN", "input"),
    ("46", "USB_DM", "bidirectional"), ("47", "USB_DP", "bidirectional"),
    None,
    ("56", "QSPI_SS_N", "bidirectional"), ("52", "QSPI_SCLK", "bidirectional"),
    ("53", "QSPI_SD0", "bidirectional"), ("55", "QSPI_SD1", "bidirectional"),
    ("54", "QSPI_SD2", "bidirectional"), ("51", "QSPI_SD3", "bidirectional"),
    None,
    ("57", "GND", "power_in"),
]
RP2040_R = [(str(i + (2 if i <= 7 else 11 if i <= 15 else 27 - 16 if False else 0)), "", "") for i in range(0)]
# build GPIO right side explicitly: GPIO0-7 pins2-9, GPIO8-15 pins11-18, GPIO16-21 pins27-32, GPIO22-25 pins34-37, GPIO26-29 pins38-41
gp = []
for g in range(30):
    if g <= 7: num = g + 2
    elif g <= 15: num = g + 3
    elif g <= 21: num = g + 11
    elif g <= 25: num = g + 12
    else: num = g + 12
    nm = f"GPIO{g}"
    if g >= 26: nm += f"/ADC{g-26}"
    gp.append((str(num), nm, "bidirectional"))
RP2040_R = gp
RP2040_offs = box_symbol("bridge:RP2040", "U", RP2040_L, RP2040_R, 33.02)

FLASH_L = [("1", "~{CS}", "input"), ("6", "CLK", "input"), ("5", "DI/IO0", "bidirectional"),
           ("2", "DO/IO1", "bidirectional"), ("3", "~{WP}/IO2", "bidirectional"), ("7", "~{HOLD}/IO3", "bidirectional")]
FLASH_R = [("8", "VCC", "power_in"), None, None, None, None, ("4", "GND", "power_in")]
FLASH_offs = box_symbol("bridge:W25Q128JVS", "U", FLASH_L, FLASH_R, 20.32)

TCA_L = [("24", "VCC", "power_in"), ("12", "GND", "power_in"), None,
         ("22", "SCL", "input"), ("23", "SDA", "bidirectional"), None,
         ("3", "~{RESET}", "input"), None,
         ("1", "A0", "input"), ("2", "A1", "input"), ("21", "A2", "input")]
TCA_R = [("4", "SD0", "bidirectional"), ("5", "SC0", "bidirectional"),
         ("6", "SD1", "bidirectional"), ("7", "SC1", "bidirectional"),
         ("8", "SD2", "bidirectional"), ("9", "SC2", "bidirectional"),
         ("10", "SD3", "bidirectional"), ("11", "SC3", "bidirectional"),
         ("13", "SD4", "bidirectional"), ("14", "SC4", "bidirectional"),
         ("15", "SD5", "bidirectional"), ("16", "SC5", "bidirectional"),
         ("17", "SD6", "bidirectional"), ("18", "SC6", "bidirectional"),
         ("19", "SD7", "bidirectional"), ("20", "SC7", "bidirectional")]
TCA_offs = box_symbol("bridge:TCA9548APWR", "U", TCA_L, TCA_R, 20.32)

AS_L = [("1", "VDD5V", "power_in"), ("2", "VDD3V3", "power_in"), ("8", "DIR", "input"), ("4", "GND", "power_in")]
AS_R = [("6", "SDA", "bidirectional"), ("7", "SCL", "input"), ("3", "OUT", "output"), ("5", "PGO", "input")]
AS_offs = box_symbol("bridge:AS5600", "U", AS_L, AS_R, 17.78)

LDO_L = [("1", "VIN", "power_in"), ("3", "EN", "input"), ("2", "GND", "power_in")]
LDO_R = [("5", "VOUT", "power_out"), None, ("4", "NC", "no_connect")]
LDO_offs = box_symbol("bridge:AP2112K-3.3", "U", LDO_L, LDO_R, 15.24)

XTAL_L = [("1", "1", "passive"), ("2", "GND", "passive")]
XTAL_R = [("3", "3", "passive"), ("4", "GND", "passive")]
XTAL_offs = box_symbol("bridge:ABM8-12MHz", "Y", XTAL_L, XTAL_R, 12.7)

USB_L = [("1", "VBUS", "passive"), ("2", "D-", "passive"), ("3", "D+", "passive"),
         ("4", "ID", "passive"), ("5", "GND", "passive"), ("6", "SHIELD", "passive")]
USB_offs = box_symbol("bridge:USB_Micro-B", "J", USB_L, [], 15.24)

CONN4_offs = box_symbol("bridge:Conn_1x04", "J",
    [("1", "1", "passive"), ("2", "2", "passive"), ("3", "3", "passive"), ("4", "4", "passive")], [], 10.16)
CONN5_offs = box_symbol("bridge:Conn_1x05", "J",
    [("1", "1", "passive"), ("2", "2", "passive"), ("3", "3", "passive"), ("4", "4", "passive"), ("5", "5", "passive")], [], 10.16)
CONN3_offs = box_symbol("bridge:Conn_1x03", "J",
    [("1", "1", "passive"), ("2", "2", "passive"), ("3", "3", "passive")], [], 10.16)

# ---------------- schematic body ----------------
body = []

def add_wire(x1, y1, x2, y2):
    body.append(f'(wire (pts (xy {f(x1)} {f(y1)}) (xy {f(x2)} {f(y2)})) '
                f'(stroke (width 0) (type default)) (uuid "{u()}"))')

def add_glabel(name, x, y, ang, shape="input"):
    just = "left" if ang in (0, 90) else "right"
    body.append(f'(global_label "{name}" (shape {shape}) (at {f(x)} {f(y)} {ang}) '
                f'(effects (font (size 1.27 1.27)) (justify {just})) (uuid "{u()}"))')

def add_nc(x, y):
    body.append(f'(no_connect (at {f(x)} {f(y)}) (uuid "{u()}"))')

def add_text(txt, x, y, size=1.27, bold=False):
    b = " (bold yes)" if bold else ""
    t = txt.replace('"', '\\"').replace("\n", "\\n")
    body.append(f'(text "{t}" (exclude_from_sim no) (at {f(x)} {f(y)} 0) '
                f'(effects (font (size {f(size)} {f(size)}){b}) (justify left bottom)) (uuid "{u()}"))')

def add_rect_note(x1, y1, x2, y2):
    body.append(f'(polyline (pts (xy {f(x1)} {f(y1)}) (xy {f(x2)} {f(y1)}) (xy {f(x2)} {f(y2)}) '
                f'(xy {f(x1)} {f(y2)}) (xy {f(x1)} {f(y1)})) '
                f'(stroke (width 0.3) (type dash)) (uuid "{u()}"))')

def place(lib, ref, value, x, y, offs, footprint=""):
    """Place symbol at (x,y) angle 0. Returns dict pin->(abs_x,abs_y)."""
    pins_xml = "".join(f'\n    (pin "{n}" (uuid "{u()}"))' for n in offs)
    if lib in BOXDIMS:
        w, h2 = BOXDIMS[lib]
        rx, ry = x - w / 2, y - h2 - 1.905
        vx, vy = x - w / 2, y + h2 + 1.905
    else:
        rx, ry = x + 2.286, y - 1.27
        vx, vy = x + 2.286, y + 1.27
    body.append(f'''(symbol (lib_id "{lib}") (at {f(x)} {f(y)} 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
    (uuid "{u()}")
    (property "Reference" "{ref}" (at {f(rx)} {f(ry)} 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "{value}" (at {f(vx)} {f(vy)} 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Footprint" "{footprint}" (at {f(x)} {f(y)} 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Datasheet" "" (at {f(x)} {f(y)} 0) (effects (font (size 1.27 1.27)) (hide yes))){pins_xml}
    (instances (project "{PROJ}" (path "/{ROOT_UUID}" (reference "{ref}") (unit 1))))
  )''')
    return {n: (x + ox, y - oy) for n, (ox, oy) in offs.items()}

def place_v2(lib, ref, value, x, y, offs, top_net, bot_net, footprint):
    """Vertical 2-pin part with stub wires + labels top/bottom. net=None -> no label.
    Returns pin dict plus 'T'/'B' keys for the top/bottom pin positions."""
    p = place(lib, ref, value, x, y, offs, footprint)
    top_num = max(offs, key=lambda n: offs[n][1])
    bot_num = min(offs, key=lambda n: offs[n][1])
    tx, ty = p[top_num]
    bx, by = p[bot_num]
    if top_net:
        add_wire(tx, ty, tx, ty - 2.54)
        add_glabel(top_net, tx, ty - 2.54, 90)
    if bot_net:
        add_wire(bx, by, bx, by + 2.54)
        add_glabel(bot_net, bx, by + 2.54, 270)
    p = dict(p)
    p["T"] = (tx, ty)
    p["B"] = (bx, by)
    return p

R_FP = "Resistor_SMD:R_0603_1608Metric"
C_FP = "Capacitor_SMD:C_0603_1608Metric"
C_FP_BIG = "Capacitor_SMD:C_0805_2012Metric"
C_FP_0402 = "Capacitor_SMD:C_0402_1005Metric"

def flag(net, x, y):
    place("bridge:PWR_FLAG", f"#FLG{flag.n:02d}", "PWR_FLAG", x, y, {"1": (0, 0)})
    flag.n += 1
    add_wire(x, y, x, y + 2.54)
    add_glabel(net, x, y + 2.54, 270)
flag.n = 1

# ===== Title / notes =====
add_text("マルチI2Cブリッジ 制御回路  (design_spec.md v0.1 準拠)", 25, 22, 3, True)
add_text("AS5600×3ch → TCA9548A → RP2040(I2Cターゲット0x42) → 上位コントローラ / 全系3.3V・上下流400kHz", 25, 27, 1.6)

# ===== Power section =====
add_text("電源: 5V入力(USB VBUS / J1) → ダイオードOR → 3.3V LDO", 25, 34, 1.6, True)
p = place("bridge:USB_Micro-B", "J9", "USB_Micro-B", 40, 52, USB_offs,
          "Connector_USB:USB_Micro-B_Molex-105017-0001")
for num, net in (("1", "VBUS"), ("2", "USB_DM_J"), ("3", "USB_DP_J"), ("5", "GND"), ("6", "GND")):
    x, y = p[num]
    add_glabel(net, x, y, 180)
add_nc(*p["4"])

pd1 = place_v2("bridge:D_Schottky", "D1", "SS14", 75, 48, D_offs, "VBUS", "5V_IN", "Diode_SMD:D_SMA")
pd2 = place_v2("bridge:D_Schottky", "D2", "SS14", 88, 48, D_offs, "HOST_5V", "5V_IN", "Diode_SMD:D_SMA")

p = place("bridge:AP2112K-3.3", "U4", "AP2112K-3.3", 112, 50, LDO_offs, "Package_TO_SOT_SMD:SOT-23-5")
x, y = p["1"]; add_glabel("5V_IN", x, y, 180)
x, y = p["3"]; add_glabel("5V_IN", x, y, 180)
x, y = p["2"]; add_glabel("GND", x, y, 180)
x, y = p["5"]; add_glabel("3V3", x, y, 0)
add_nc(*p["4"])

place_v2("bridge:C", "C17", "10uF", 132, 50, C_offs, "5V_IN", "GND", C_FP_BIG)
place_v2("bridge:C", "C18", "10uF", 142, 50, C_offs, "3V3", "GND", C_FP_BIG)
place_v2("bridge:C", "C19", "10uF", 152, 50, C_offs, "3V3", "GND", C_FP_BIG)
pl = place_v2("bridge:LED", "LED2", "PWR(GRN)", 168, 44, LED_offs, "3V3", None, "LED_SMD:LED_0603_1608Metric")
pr = place_v2("bridge:R", "R22", "1k", 168, 56, R_offs, None, "GND", R_FP)
add_wire(pl["B"][0], pl["B"][1], pr["T"][0], pr["T"][1])

flag("VBUS", 185, 44)
flag("HOST_5V", 195, 44)
flag("5V_IN", 205, 44)
flag("GND", 215, 44)

# ===== Host connector =====
add_text("上流I2C (Controller側, 0x42 / 400kHz)  ※電源は5V供給・3.3VロジックはLDO生成", 25, 72, 1.6, True)
p = place("bridge:Conn_1x04", "J1", "HOST_I2C", 40, 84, CONN4_offs,
          "Connector_JST:JST_XH_B4B-XH-A_1x04_P2.50mm_Vertical")
for num, net in (("1", "HOST_5V"), ("2", "GND"), ("3", "I2C0_SCL_HOST"), ("4", "I2C0_SDA_HOST")):
    x, y = p[num]
    add_glabel(net, x, y, 180)
place_v2("bridge:R", "R7", "2.2k", 70, 84, R_offs, "3V3", "I2C0_SDA_HOST", R_FP)
place_v2("bridge:R", "R8", "2.2k", 80, 84, R_offs, "3V3", "I2C0_SCL_HOST", R_FP)
add_text("上流プルアップ2.2k (design_spec §6.2)\nホスト側実装時はDNP", 90, 80, 1.27)

# ===== QSPI flash =====
add_text("QSPIフラッシュ", 25, 110, 1.6, True)
p = place("bridge:W25Q128JVS", "U2", "W25Q128JVSIQ", 45, 124, FLASH_offs,
          "Package_SO:SOIC-8_5.23x5.23mm_P1.27mm")
for num, net in (("1", "QSPI_SS_N"), ("6", "QSPI_SCLK"), ("5", "QSPI_SD0"),
                 ("2", "QSPI_SD1"), ("3", "QSPI_SD2"), ("7", "QSPI_SD3")):
    x, y = p[num]
    add_glabel(net, x, y, 180)
x, y = p["8"]; add_glabel("3V3", x, y, 0)
x, y = p["4"]; add_glabel("GND", x, y, 0)
place_v2("bridge:C", "C15", "100nF", 72, 124, C_offs, "3V3", "GND", C_FP)

# ===== Crystal =====
add_text("12MHz水晶 (CL=10pF級, 27pF+1k: RP2040 HW design guide)", 25, 144, 1.6, True)
p = place("bridge:ABM8-12MHz", "Y1", "ABM8-272-T3 12MHz", 45, 150, XTAL_offs,
          "Crystal:Crystal_SMD_3225-4Pin_3.2x2.5mm")
x, y = p["1"]; add_glabel("XIN", x, y, 180)
x, y = p["2"]; add_glabel("GND", x, y, 180)
x, y = p["3"]; add_glabel("XOUT_X", x, y, 0)
x, y = p["4"]; add_glabel("GND", x, y, 0)
place_v2("bridge:C", "C13", "27pF", 35, 180, C_offs, "XIN", "GND", C_FP_0402)
place_v2("bridge:C", "C14", "27pF", 45, 180, C_offs, "XOUT_X", "GND", C_FP_0402)
place_v2("bridge:R", "R3", "1k", 55, 180, R_offs, "XOUT", "XOUT_X", R_FP)

# ===== Buttons / SWD =====
add_text("リセット・BOOT・SWD", 22, 190.5, 1.6, True)
place_v2("bridge:R", "R4", "10k", 35, 204, R_offs, "3V3", "RUN", R_FP)
place_v2("bridge:SW_Push", "SW1", "RESET", 35, 232, SW_offs, "RUN", "GND", "Button_Switch_SMD:SW_SPST_TL3342")
place_v2("bridge:R", "R5", "10k", 50, 204, R_offs, "3V3", "QSPI_SS_N", R_FP)
place_v2("bridge:R", "R6", "1k", 60, 204, R_offs, "QSPI_SS_N", "BOOTSEL", R_FP)
place_v2("bridge:SW_Push", "SW2", "BOOT", 65, 232, SW_offs, "BOOTSEL", "GND", "Button_Switch_SMD:SW_SPST_TL3342")
p = place("bridge:Conn_1x03", "J8", "SWD", 95, 218, CONN3_offs,
          "Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical")
for num, net in (("1", "SWCLK"), ("2", "GND"), ("3", "SWDIO")):
    x, y = p[num]
    add_glabel(net, x, y, 180)

# USB series resistors
place_v2("bridge:R", "R1", "27R", 118, 204, R_offs, "USB_DM_J", "USB_DM", R_FP)
place_v2("bridge:R", "R2", "27R", 128, 204, R_offs, "USB_DP_J", "USB_DP", R_FP)

# ===== RP2040 =====
p = place("bridge:RP2040", "U1", "RP2040", 165, 140, RP2040_offs,
          "Package_DFN_QFN:QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm")
left_nets = {
    "1": "3V3", "10": "3V3", "22": "3V3", "33": "3V3", "42": "3V3", "49": "3V3",
    "48": "3V3", "43": "3V3", "44": "3V3", "45": "DVDD_1V1", "23": "DVDD_1V1", "50": "DVDD_1V1",
    "20": "XIN", "21": "XOUT", "26": "RUN", "24": "SWCLK", "25": "SWDIO", "19": "GND",
    "46": "USB_DM", "47": "USB_DP",
    "56": "QSPI_SS_N", "52": "QSPI_SCLK", "53": "QSPI_SD0", "55": "QSPI_SD1",
    "54": "QSPI_SD2", "51": "QSPI_SD3", "57": "GND",
}
for num, net in left_nets.items():
    x, y = p[num]
    add_glabel(net, x, y, 180)
gpio_nets = {
    "2": "I2C0_SDA_HOST", "3": "I2C0_SCL_HOST",   # GP0/GP1
    "4": "I2C1_SDA", "5": "I2C1_SCL",             # GP2/GP3
    "6": "MUX_RST_N",                              # GP4
    "7": "DIR0", "8": "DIR1", "9": "DIR2",        # GP5/6/7
    "37": "LED_STAT",                              # GP25
}
for g in range(30):
    if g <= 7: num = str(g + 2)
    elif g <= 15: num = str(g + 3)
    elif g <= 21: num = str(g + 11)
    else: num = str(g + 12)
    x, y = p[num]
    if num in gpio_nets:
        add_glabel(gpio_nets[num], x, y, 0)
    else:
        add_nc(x, y)
add_text("GP8-24, GP26-29: 未使用(将来拡張:\nPIO並列I2C移行用にGPIO 6本予約可 / i2c_architecture §5.6)", 188, 194, 1.27)

# status LED
pl = place_v2("bridge:R", "R21", "1k", 105, 204, R_offs, "LED_STAT", None, R_FP)
pled = place_v2("bridge:LED", "LED1", "STAT(GRN)", 105, 217, LED_offs, None, "GND", "LED_SMD:LED_0603_1608Metric")
add_wire(pl["B"][0], pl["B"][1], pled["T"][0], pled["T"][1])

# ===== RP2040 decoupling bank =====
add_text("RP2040 デカップリング (各IOVDDピン近傍に配置)", 120, 240, 1.6, True)
dec = [("C1", "100nF", "3V3"), ("C2", "100nF", "3V3"), ("C3", "100nF", "3V3"),
       ("C4", "100nF", "3V3"), ("C5", "100nF", "3V3"), ("C6", "100nF", "3V3"),
       ("C10", "100nF", "3V3"), ("C11", "100nF", "3V3"), ("C12", "100nF", "3V3"),
       ("C7", "100nF", "DVDD_1V1"), ("C8", "100nF", "DVDD_1V1"), ("C9", "1uF", "DVDD_1V1")]
for i, (ref, val, net) in enumerate(dec):
    place_v2("bridge:C", ref, val, 120 + i * 11, 254, C_offs, net, "GND", C_FP_0402)

# ===== TCA9548A =====
add_text("I2C mux TCA9548A (0x70: A0-A2=GND / 400kHz上限)", 245, 60, 1.6, True)
p = place("bridge:TCA9548APWR", "U3", "TCA9548APWR", 270, 92, TCA_offs,
          "Package_SO:TSSOP-24_4.4x7.8mm_P0.65mm")
for num, net in (("24", "3V3"), ("12", "GND"), ("22", "I2C1_SCL"), ("23", "I2C1_SDA"),
                 ("3", "MUX_RST_N"), ("1", "GND"), ("2", "GND"), ("21", "GND")):
    x, y = p[num]
    add_glabel(net, x, y, 180)
for num, net in (("4", "I2C_CH0_SDA"), ("5", "I2C_CH0_SCL"),
                 ("6", "I2C_CH1_SDA"), ("7", "I2C_CH1_SCL"),
                 ("8", "I2C_CH2_SDA"), ("9", "I2C_CH2_SCL")):
    x, y = p[num]
    add_glabel(net, x, y, 0)
for num in ("10", "11", "13", "14", "15", "16", "17", "18", "19", "20"):
    add_nc(*p[num])
place_v2("bridge:C", "C16", "100nF", 240, 128, C_offs, "3V3", "GND", C_FP)
place_v2("bridge:R", "R11", "10k", 250, 128, R_offs, "3V3", "MUX_RST_N", R_FP)

# pullup banks
add_text("下流プルアップ: mux上流4.7k / 各chセグメント2.2k (10k不可: design_spec §6.2 tr違反)", 240, 183, 1.6, True)
place_v2("bridge:R", "R9", "4.7k", 240, 158, R_offs, "3V3", "I2C1_SDA", R_FP)
place_v2("bridge:R", "R10", "4.7k", 250, 158, R_offs, "3V3", "I2C1_SCL", R_FP)
chpu = [("R12", "I2C_CH0_SDA"), ("R13", "I2C_CH0_SCL"), ("R14", "I2C_CH1_SDA"),
        ("R15", "I2C_CH1_SCL"), ("R16", "I2C_CH2_SDA"), ("R17", "I2C_CH2_SCL")]
for i, (ref, net) in enumerate(chpu):
    place_v2("bridge:R", ref, "2.2k", 265 + i * 12, 158, R_offs, "3V3", net, R_FP)

# DIR pulldowns
add_text("DIRプルダウン(ブート中フロート防止, design_spec §6.4)", 30, 284, 1.6, True)
for i in range(3):
    place_v2("bridge:R", f"R{18+i}", "10k", 52 + i * 12, 262, R_offs, f"DIR{i}", "GND", R_FP)

# ===== Sensor connectors =====
add_text("センサ接続コネクタ (ch0-2)", 345, 60, 1.6, True)
for i in range(3):
    p = place("bridge:Conn_1x05", f"J{2+i}", f"SENSOR_CH{i}", 365, 74 + i * 22, CONN5_offs,
              "Connector_JST:JST_PH_B5B-PH-K_1x05_P2.00mm_Vertical")
    for num, net in (("1", "3V3"), ("2", "GND"), ("3", f"I2C_CH{i}_SCL"),
                     ("4", f"I2C_CH{i}_SDA"), ("5", f"DIR{i}")):
        x, y = p[num]
        add_glabel(net, x, y, 180)

# ===== AS5600 sensor boards (reference) =====
add_rect_note(230, 200, 412, 270)
add_text("【参考】センサ基板×3 (別基板・ケーブル接続 / 実装は各センサ基板側)", 233, 206, 1.6, True)
add_text("AS5600 3.3V動作: VDD5V-VDD3V3短絡必須 (DS Fig.13) / 100nF近傍 / OTP不使用のため10uF省略", 233, 209.8, 1.27)
for i in range(3):
    bx = 264 + i * 44
    p = place("bridge:Conn_1x05", f"J{5+i}", f"SENS_CH{i}", bx, 224, CONN5_offs,
              "Connector_JST:JST_PH_B5B-PH-K_1x05_P2.00mm_Vertical")
    for num, net in (("1", "3V3"), ("2", "GND"), ("3", f"I2C_CH{i}_SCL"),
                     ("4", f"I2C_CH{i}_SDA"), ("5", f"DIR{i}")):
        x, y = p[num]
        add_glabel(net, x, y, 180)
    p = place("bridge:AS5600", f"U{5+i}", "AS5600", bx + 12, 252, AS_offs,
              "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm")
    for num, net in (("1", "3V3"), ("2", "3V3"), ("8", f"DIR{i}"), ("4", "GND")):
        x, y = p[num]
        add_glabel(net, x, y, 180)
    for num, net in (("6", f"I2C_CH{i}_SDA"), ("7", f"I2C_CH{i}_SCL")):
        x, y = p[num]
        add_glabel(net, x, y, 0)
    add_nc(*p["3"])
    add_nc(*p["5"])
    place_v2("bridge:C", f"C{20+i}", "100nF", bx + 24, 230, C_offs, "3V3", "GND", C_FP)

# ---------------- write files ----------------
os.makedirs(OUT, exist_ok=True)
sch = f'''(kicad_sch (version 20231120) (generator "eeschema") (generator_version "8.0")
  (uuid "{ROOT_UUID}")
  (paper "A3")
  (title_block
    (title "マルチI2Cブリッジ 制御回路")
    (date "2026-07-10")
    (rev "0.1")
    (company "")
    (comment 1 "AS5600×3ch / TCA9548A / RP2040 I2Cブリッジ")
    (comment 2 "design_spec.md v0.1 準拠")
  )
  (lib_symbols
{chr(10).join(lib_symbols)}
  )
  {chr(10).join("  " + b for b in body)}
  (sheet_instances (path "/" (page "1")))
)
'''
with open(f"{OUT}/{PROJ}.kicad_sch", "w") as fp:
    fp.write(sch)

pro = '''{
  "board": { "3dviewports": [], "design_settings": { "defaults": {}, "diff_pair_dimensions": [], "drc_exclusions": [], "rules": {}, "track_widths": [], "via_dimensions": [] }, "layer_presets": [], "viewports": [] },
  "boards": [],
  "cvpcb": { "equivalence_files": [] },
  "libraries": { "pinned_footprint_libs": [], "pinned_symbol_libs": [] },
  "meta": { "filename": "multi_i2c_bridge.kicad_pro", "version": 1 },
  "net_settings": { "classes": [ { "bus_width": 12, "clearance": 0.2, "diff_pair_gap": 0.25, "diff_pair_via_gap": 0.25, "diff_pair_width": 0.2, "line_style": 0, "microvia_diameter": 0.3, "microvia_drill": 0.1, "name": "Default", "pcb_color": "rgba(0, 0, 0, 0.000)", "schematic_color": "rgba(0, 0, 0, 0.000)", "track_width": 0.25, "via_diameter": 0.6, "via_drill": 0.3, "wire_width": 6 } ], "meta": { "version": 3 } },
  "pcbnew": { "last_paths": {}, "page_layout_descr_file": "" },
  "schematic": { "annotate_start_num": 0, "drawing": { "dashed_lines_dash_length_ratio": 12.0, "dashed_lines_gap_length_ratio": 3.0, "default_line_thickness": 6.0, "default_text_size": 50.0, "field_names": [], "intersheets_ref_own_page": false, "intersheets_ref_prefix": "", "intersheets_ref_short": false, "intersheets_ref_show": false, "intersheets_ref_suffix": "", "junction_size_choice": 3, "label_size_ratio": 0.375, "pin_symbol_size": 25.0, "text_offset_ratio": 0.15 }, "legacy_lib_dir": "", "legacy_lib_list": [], "meta": { "version": 1 }, "net_format_name": "", "page_layout_descr_file": "", "plot_directory": "", "spice_current_sheet_as_root": false, "spice_external_command": "spice \\"%I\\"", "spice_model_current_sheet_as_root": true, "spice_save_all_currents": false, "spice_save_all_dissipations": false, "spice_save_all_voltages": false, "subpart_first_id": 65, "subpart_id_separator": 0 },
  "sheets": [ [ "''' + ROOT_UUID + '''", "Root" ] ],
  "text_variables": {}
}
'''
with open(f"{OUT}/{PROJ}.kicad_pro", "w") as fp:
    fp.write(pro)

print("written to", OUT)
print("body items:", len(body))
