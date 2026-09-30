"""Radial Wheel — a customizable radial launcher/menu for Windows.

Press the configured hotkey and a radial menu spawns at the mouse pointer.
Click a segment to run it. Everything (hotkey, segments, colors, actions)
is configured in wheel_config.json sitting next to this file.

Action types per segment:
  "app"     -> launch a program / file / URL          {"type":"app","value":"notepad.exe"}
  "macro"   -> synthesize keystrokes                  {"type":"macro","value":"ctrl+c, ctrl+v"}
  "command" -> run a shell command                    {"type":"command","value":"taskkill /f /im foo.exe"}
  "sys"     -> built-in system action                 {"type":"sys","value":"lock"}
            lock | sleep | mute | volup | voldown | screenshot | taskmgr |
            show_desktop | wifi | bluetooth | settings | explorer | exit

Macro syntax: comma-separated steps; '+' combines a chord.
  "ctrl+alt+del"             one chord
  "ctrl+c, wait=0.3, ctrl+v" sequence with pause
  "type:hello world"         literal typing

Run:  pythonw radial_wheel.py     (no console window)
Self-check without Windows:  python radial_wheel.py --selftest
"""
import json
import math
import os
import queue
import subprocess
import sys
import threading
import time
import webbrowser

try:
    import tkinter as tk
except ImportError:
    print("tkinter missing — reinstall Python and tick 'tcl/tk and IDLE'.")
    sys.exit(1)

IS_WIN = sys.platform == "win32"
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wheel_config.json")

if IS_WIN:
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.windll.user32
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # crisp geometry on scaled displays
    except Exception:
        user32.SetProcessDPIAware()

DEFAULTS = {
    "hotkey": "ctrl+alt+space",
    "inner_radius": 95,
    "ring_split": 0.5,       # where ring1 ends and ring2 begins (fraction of the span)
    "outer_radius": 210,
    "start_angle": 90,       # 90 = first segment centred near the top
    "center_label": "",
    "colors": {"bg": "#101418", "ring1": "#1b2733", "ring2": "#16202b",
               "hover": "#2e7dd1", "text": "#e8eef4", "center": "#0a0e12"},
    "font": ("Segoe UI", 10, "bold"),
    "items": [
        {"label": "Notepad", "type": "app", "value": "notepad.exe"},
        {"label": "Browser", "type": "app", "value": "https://google.com"},
        {"label": "Lock", "type": "sys", "value": "lock"},
        {"label": "Mute", "type": "sys", "value": "mute", "ring": 2},
        {"label": "Copy/Paste", "type": "macro", "value": "ctrl+c, wait=0.2, ctrl+v", "ring": 2},
    ],
}

# ----------------------------------------------------------------- config ---
def load_config():
    cfg = json.loads(json.dumps(DEFAULTS))  # deep copy
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            user = json.load(f)
        cfg.update({k: v for k, v in user.items() if k != "colors"})
        if "colors" in user:
            cfg["colors"].update(user["colors"])
    else:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(DEFAULTS, f, indent=2)
    return cfg

# ------------------------------------------------------------- hotkey (win) ---
VK = {"space": 0x20, "enter": 0x0D, "tab": 0x09, "esc": 0x1B, "backspace": 0x08,
      "insert": 0x2D, "delete": 0x2E, "home": 0x24, "end": 0x23,
      "pgup": 0x21, "pgdn": 0x22, "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28}
for _i in range(1, 13):
    VK[f"f{_i}"] = 0x6F + _i

def parse_hotkey(spec):
    mods, key = 0, None
    mod_bits = {"ctrl": 0x2, "alt": 0x1, "shift": 0x4, "win": 0x8}
    for tok in [t.strip().lower() for t in spec.split("+") if t.strip()]:
        if tok in mod_bits:
            mods |= mod_bits[tok]
        else:
            key = tok
    if key is None:
        raise ValueError(f"hotkey '{spec}': no key after modifiers")
    vk = VK.get(key)
    if vk is None:
        if len(key) == 1:
            vk = ord(key.upper())
        else:
            raise ValueError(f"hotkey: unknown key '{key}'")
    return mods | 0x4000, vk  # MOD_NOREPEAT

class HotkeyThread(threading.Thread):
    """Hidden thread that owns a RegisterHotKey message loop."""
    def __init__(self, spec, fire):
        super().__init__(daemon=True)
        self.spec = spec
        self.mods, self.vk = parse_hotkey(spec)
        self.fire = fire
        self.id = 0xC0DE
        self.ready = threading.Event()
        self.error = None

    def run(self):
        if not user32.RegisterHotKey(None, self.id, self.mods, self.vk):
            self.error = (f"RegisterHotKey failed for '{self.spec}' (err {ctypes.GetLastError()})"
                          f" — combo taken or invalid; try another in wheel_config.json")
            self.ready.set()
            return
        self.ready.set()
        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0):
            if msg.message == 0x0312 and msg.wParam == self.id:
                self.fire()
        user32.UnregisterHotKey(None, self.id)

# ------------------------------------------------------------ key sending ---
class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("btype", wintypes.DWORD), ("wVk", wintypes.WORD),
                ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("ptr", ctypes.c_void_p)]

class INPUTUNION(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("pad", ctypes.c_byte * 32)]

class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", INPUTUNION)]

def _key_event(vk, flags):
    inp = INPUT(type=1)
    inp.u.ki.btype = 1
    inp.u.ki.wVk = vk
    inp.u.ki.dwFlags = flags
    user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))

MOD_VK = {"ctrl": 0x11, "alt": 0x12, "shift": 0x10, "win": 0x5B}

def _vk_for(token):
    token = token.strip().lower()
    if token in MOD_VK:
        return MOD_VK[token]
    if token in VK:
        return VK[token]
    if len(token) == 1:
        scan = user32.VkKeyScanW(token.upper() if token.isalpha() else token)
        if scan == -1:
            raise ValueError(f"cannot type '{token}'")
        return scan & 0xFF
    raise ValueError(f"unknown key '{token}'")

def send_macro(spec):
    if not IS_WIN:
        print(f"(dry-run macro) {spec}")
        return
    for step in spec.split(","):
        step = step.strip()
        if not step:
            continue
        if step.startswith("wait"):
            time.sleep(float(step.split("=", 1)[1]) if "=" in step else 0.2)
            continue
        if step.startswith("type:"):
            for ch in step[5:]:
                vk = _vk_for(ch)
                shift = ch.isupper()
                if shift:
                    _key_event(0x10, 0)
                _key_event(vk, 0)
                _key_event(vk, 0x0002)
                if shift:
                    _key_event(0x10, 0x0002)
                time.sleep(0.01)
            continue
        keys = [_vk_for(t) for t in step.split("+")]
        for vk in keys:
            _key_event(vk, 0)
            time.sleep(0.01)
        for vk in reversed(keys):
            _key_event(vk, 0x0002)
        time.sleep(0.02)

# ------------------------------------------------------------ sys actions ---
def _send_vk(vk):
    _key_event(vk, 0)
    _key_event(vk, 0x0002)

SYS_ACTIONS = {
    "lock":         lambda: subprocess.Popen(["rundll32.exe", "user32.dll,LockWorkStation"]),
    "sleep":        lambda: subprocess.Popen(["rundll32.exe", "powrprof.dll,SetSuspendState", "0,1,0"]),
    "mute":         lambda: _send_vk(0xAD),
    "volup":        lambda: _send_vk(0xAF),
    "voldown":      lambda: _send_vk(0xAE),
    "screenshot":   lambda: send_macro("win+shift+s"),
    "taskmgr":      lambda: subprocess.Popen(["taskmgr.exe"]),
    "show_desktop": lambda: send_macro("win+d"),
    "wifi":         lambda: subprocess.Popen(["ms-activatelink", "ms-settings:network-wifi"]),
    "bluetooth":    lambda: subprocess.Popen(["ms-activatelink", "ms-settings:bluetooth"]),
    "settings":     lambda: subprocess.Popen(["ms-activatelink", "ms-settings:"]),
    "explorer":     lambda: subprocess.Popen(["explorer.exe"]),
    "exit":         lambda: os._exit(0),
}

def run_action(item):
    kind, value = item.get("type", "app"), item.get("value", "")
    if kind == "sys":
        action = SYS_ACTIONS.get(value.lower())
        if not action:
            raise ValueError(f"unknown sys action '{value}'")
        action()
    elif kind == "macro":
        send_macro(value)
    elif kind == "command":
        subprocess.Popen(value, shell=True)
    else:  # app
        if value.startswith(("http://", "https://")):
            webbrowser.open(value)
        elif os.path.exists(value):
            os.startfile(value)
        else:
            subprocess.Popen(value, shell=True)

# ------------------------------------------------------------------ wheel ---
class Segment:
    __slots__ = ("canvas_id", "item", "ring", "color", "r0", "r1", "a1", "a2")
    def __init__(self, canvas_id, item, ring, color, r0, r1, a1, a2):
        self.canvas_id, self.item, self.ring, self.color = canvas_id, item, ring, color
        self.r0, self.r1, self.a1, self.a2 = r0, r1, a1 % 360, a2 % 360

class RadialWheel:
    def __init__(self, cfg):
        self.cfg = cfg
        self.ring1 = [i for i in cfg["items"] if int(i.get("ring", 1)) == 1]
        self.ring2 = [i for i in cfg["items"] if int(i.get("ring", 1)) == 2]
        self.inner = cfg["inner_radius"]
        self.outer = cfg["outer_radius"]
        self.mid = (self.inner + (self.outer - self.inner) * cfg["ring_split"]
                    if self.ring2 else self.outer)
        self.size = self.outer * 2 + 8
        self.root = tk.Tk()
        self.root.withdraw()
        self.top = None
        self.canvas = None
        self.segs = []
        self.hover_id = None
        self.q = queue.Queue()

    def cursor_pos(self):
        if IS_WIN:
            pt = wintypes.POINT()
            user32.GetCursorPos(ctypes.byref(pt))
            return pt.x, pt.y
        return self.root.winfo_pointerxy()

    # ---- build -------------------------------------------------------------
    def open_at_cursor(self):
        if self.top is not None:
            return
        cx, cy = self.cursor_pos()
        s = self.size
        top = tk.Toplevel(self.root)
        top.overrideredirect(True)
        top.attributes("-topmost", True)
        top.geometry(f"{s}x{s}+{int(cx - s // 2)}+{int(cy - s // 2)}")
        top.configure(bg=self.cfg["colors"]["bg"])
        c = tk.Canvas(top, width=s, height=s, highlightthickness=0,
                      bg=self.cfg["colors"]["bg"], bd=0)
        c.pack()
        self.top, self.canvas = top, c
        ccx = ccy = s / 2.0
        self.segs = []
        start = self.cfg["start_angle"]
        for items, ring, r0, r1 in [(self.ring1, 1, self.inner, self.mid),
                                    (self.ring2, 2, self.mid, self.outer)]:
            n = len(items)
            if not n:
                continue
            step = 360.0 / n
            for i, item in enumerate(items):
                a1 = start - (i + 1) * step
                a2 = start - i * step
                color = item.get("color") or self.cfg["colors"][f"ring{ring}"]
                pie = c.create_arc(ccx - r1, ccy - r1, ccx + r1, ccy + r1,
                                   start=a1, extent=step, style="pie", fill=color,
                                   outline=self.cfg["colors"]["bg"], width=2)
                mid_a = math.radians((a1 + a2) / 2)
                lr = (r0 + r1) / 2
                c.create_text(ccx + lr * math.cos(mid_a), ccy - lr * math.sin(mid_a),
                              text=item.get("label", "?"), width=int(r1 - r0 - 14),
                              fill=self.cfg["colors"]["text"], font=self.cfg["font"])
                self.segs.append(Segment(pie, item, ring, color, r0, r1, a1, a2))
        c.create_oval(ccx - self.inner, ccy - self.inner, ccx + self.inner, ccy + self.inner,
                      fill=self.cfg["colors"]["center"], outline=self.cfg["colors"]["bg"], width=2)
        if self.cfg["center_label"]:
            c.create_text(ccx, ccy, text=self.cfg["center_label"],
                          fill=self.cfg["colors"]["text"], font=self.cfg["font"])
        c.bind("<Motion>", self.on_motion)
        c.bind("<Button-1>", self.on_click)
        c.bind("<Button-3>", lambda e: self.close())
        top.bind("<Escape>", lambda e: self.close())
        top.grab_set()
        top.focus_force()
        self.prime_hover()

    def prime_hover(self):
        x, y = self.cursor_pos()
        self.highlight(x - self.top.winfo_x() - self.size / 2,
                       y - self.top.winfo_y() - self.size / 2)

    # ---- geometry ----------------------------------------------------------
    def _segment_at(self, dx, dy):
        dist = math.hypot(dx, dy)
        if dist < self.inner or dist > self.outer:
            return None
        ang = math.degrees(math.atan2(-dy, dx)) % 360
        for sgm in self.segs:
            if not (sgm.r0 - 0.5 <= dist <= sgm.r1 + 0.5):
                continue
            a1, a2 = sgm.a1, sgm.a2
            if (a1 <= ang < a2) if a1 < a2 else (ang >= a1 or ang < a2):
                return sgm.canvas_id
        return None

    def highlight(self, dx, dy):
        hit = self._segment_at(dx, dy)
        if hit == self.hover_id:
            return
        for sgm in self.segs:
            if sgm.canvas_id == self.hover_id:
                self.canvas.itemconfig(sgm.canvas_id, fill=sgm.color)
        self.hover_id = hit
        if hit is not None:
            self.canvas.itemconfig(hit, fill=self.cfg["colors"]["hover"])

    # ---- events ------------------------------------------------------------
    def on_motion(self, e):
        self.highlight(e.x - self.size / 2, e.y - self.size / 2)

    def on_click(self, e):
        dx, dy = e.x - self.size / 2, e.y - self.size / 2
        if math.hypot(dx, dy) < self.inner:
            self.close()
            return
        pie = self._segment_at(dx, dy)
        if pie is not None:
            for sgm in self.segs:
                if sgm.canvas_id == pie:
                    try:
                        run_action(sgm.item)
                    except Exception as ex:
                        print("action failed:", ex)
        self.close()

    def close(self):
        if self.top is not None:
            try:
                self.top.grab_release()
            except Exception:
                pass
            self.top.destroy()
            self.top, self.canvas, self.hover_id = None, None, None

    # ---- loop --------------------------------------------------------------
    def _trigger(self):
        self.q.put(None)

    def pump(self):
        try:
            got = False
            while not self.q.empty():
                self.q.get_nowait()
                got = True
            if got:
                self.open_at_cursor()
        except Exception as e:
            print(e)
        self.root.after(40, self.pump)

    def run(self):
        hk = HotkeyThread(self.cfg["hotkey"], self._trigger)
        hk.start()
        hk.ready.wait(5)
        if hk.error:
            print("HOTKEY ERROR:", hk.error)
            sys.exit(1)
        print(f"Radial Wheel ready — hotkey: {self.cfg['hotkey']} "
              f"({len(self.ring1)} + {len(self.ring2)} segments). Close: Esc or right-click.")
        self.root.after(100, self.pump)
        self.root.mainloop()

# ------------------------------------------------------------------- main ---
def main():
    cfg = load_config()
    if "--selftest" in sys.argv:
        print("config OK — hotkey:", cfg["hotkey"])
        for it in cfg["items"]:
            print(f"  ring{it.get('ring',1)}: {it['label']:20s} {it['type']:8s} {it['value']}")
        mods, vk = parse_hotkey(cfg["hotkey"])
        print(f"RegisterHotKey would use mods=0x{mods:04X} vk=0x{vk:02X}")
        # exercise the hit geometry headlessly
        class FakeSeg:
            def __init__(s, cid, r0, r1, a1, a2):
                s.canvas_id, s.r0, s.r1, s.a1, s.a2, s.color, s.ring, s.item = cid, r0, r1, a1 % 360, a2 % 360, "", 1, {}
        w = RadialWheel.__new__(RadialWheel)
        w.inner, w.outer, w.cfg = 95, 210, cfg
        n = len(cfg["items"]); step = 360.0 / n; start = cfg["start_angle"]
        w.segs = [FakeSeg(i, 95, 210, start - (i + 1) * step, start - i * step) for i in range(n)]
        for (dx, dy, expect) in [(0, -150, 0), (150, 0, None), (-150, 0, None)]:
            got = w._segment_at(dx, dy)
            print(f"  hit-test (dx={dx},dy={dy}) -> segment {got}")
        return
    RadialWheel(cfg).run()

if __name__ == "__main__":
    main()
