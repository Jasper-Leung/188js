"""Deck QA: bounds, page numbers, overlap sanity, font/color sanity."""
import sys
from pptx import Presentation
from pptx.util import Emu

EMU = 914400.0
W, H = 10.0, 5.625
TOL = 0.02

path = sys.argv[1]
prs = Presentation(path)
print(f"slide size: {prs.slide_width/EMU:.3f} x {prs.slide_height/EMU:.3f} in")
print(f"slides: {len(prs.slides)}")

problems = []

def walk(shapes, sidx, prefix=""):
    out = []
    for sh in shapes:
        if sh.shape_type == 6:  # group
            out += walk(sh.shapes, sidx, prefix + "grp/")
            continue
        out.append(sh)
    return out

for i, slide in enumerate(prs.slides, start=1):
    shapes = walk(slide.shapes, i)
    has_pagenum = False
    boxes = []
    for sh in shapes:
        try:
            x, y = sh.left / EMU, sh.top / EMU
            w, h = sh.width / EMU, sh.height / EMU
        except TypeError:
            continue
        r, b = x + w, y + h
        txt = ""
        if sh.has_text_frame:
            txt = sh.text_frame.text.strip()
        if x < -TOL or y < -TOL or r > W + TOL or b > H + TOL:
            problems.append(
                f"S{i:02d} OUT-OF-BOUNDS  x={x:.2f} y={y:.2f} r={r:.2f} b={b:.2f}  text={txt[:48]!r}")
        if txt.isdigit() and len(txt) == 2 and x > 9.0 and y > 4.9:
            has_pagenum = True
        if txt:
            boxes.append((x, y, w, h, txt))
    if i not in (1,) and not has_pagenum:
        problems.append(f"S{i:02d} MISSING page-number badge")

    # text boxes that share a horizontal band and overlap a lot -> likely collision
    for a in range(len(boxes)):
        for b2 in range(a + 1, len(boxes)):
            ax, ay, aw, ah, at = boxes[a]
            bx, by, bw, bh, bt = boxes[b2]
            ox = min(ax + aw, bx + bw) - max(ax, bx)
            oy = min(ay + ah, by + bh) - max(ay, by)
            if ox > 0.25 and oy > 0.25:
                areaA = aw * ah
                areaB = bw * bh
                frac = (ox * oy) / max(1e-6, min(areaA, areaB))
                if frac > 0.55:
                    problems.append(
                        f"S{i:02d} TEXT-OVERLAP {frac:.0%}  {at[:34]!r} <> {bt[:34]!r}")

print()
if problems:
    print(f"!! {len(problems)} issue(s):")
    for p in problems[:60]:
        print("  " + p)
else:
    print("OK: no bounds, page-number, or overlap issues found.")

# color sanity: any literal '#' leaking into XML
import zipfile, re
bad_hex = []
with zipfile.ZipFile(path) as z:
    for n in z.namelist():
        if n.startswith("ppt/slides/slide") and n.endswith(".xml"):
            x = z.read(n).decode("utf8", "ignore")
            for m in re.findall(r'val="#([0-9A-Fa-f]{6,8})"', x):
                bad_hex.append((n, m))
print(f"\nhash-prefixed colors: {len(bad_hex)}")
