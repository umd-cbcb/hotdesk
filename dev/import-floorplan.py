#!/usr/bin/env python3
"""
Turn the facilities floor-plan PDF into the board's map and desk list.

    python3 dev/import-floorplan.py ~/Downloads/ThirdFloor-Room-3112.pdf

Writes docs/assets/floorplan.svg and docs/assets/desks.tsv. Re-run it whenever
facilities sends an updated plan; nothing here is hand-maintained.

How it works: Inkscape converts the PDF to SVG and, helpfully, keeps the
original text in aria-label. The desk numbers are the only red-filled paths, so
each desk's number and position come straight out of the drawing — no clicking,
no guessing which desk is which.

Requires Inkscape (brew install --cask inkscape).
"""
import json, math, os, re, subprocess, sys, tempfile

RED, TITLE = '#fb0207', '#231f20'
LINE_COLOUR = '#21242b'          # the colour Illustrator drew the linework in
PAGE = (816.0, 1056.0)           # SVG user units of a US-letter page at 96dpi
MARGIN = 8                       # units of breathing room around the crop
PRECISION = 3

# Roughly a third of the CAD paths are shorter than this on a ~800-unit-wide
# drawing — sub-pixel geometry that cannot be read at any size the board renders
# at. They are not free: stroke-linecap:square paints a zero-length path as a
# visible dot, so they show up as speckle over the linework. Dropped by default;
# pass --detail 0 to keep everything.
MIN_DETAIL = 2.0

# Facilities numbers the desks 0-28. These are the groupings the room reads as,
# used for the list view's headings.
def group_for(n):
    if n <= 4:  return 'Left wall'
    if n <= 14: return 'Row 1'
    if n <= 24: return 'Row 2'
    return 'Right wall'

NUM = re.compile(r'[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?')
CMD = re.compile(r'([MmZzLlHhVvCcSsQqTtAa])')


def mul(m, n):
    a, b, c, d, e, f = m; A, B, C, D, E, F = n
    return (a*A + c*B, b*A + d*B, a*C + c*D, b*C + d*D, a*E + c*F + e, b*E + d*F + f)


def parse_transform(text):
    mat = (1, 0, 0, 1, 0, 0)
    for name, args in re.findall(r'(\w+)\s*\(([^)]*)\)', text or ''):
        v = [float(x) for x in NUM.findall(args)]
        if name == 'matrix':      m = tuple(v[:6])
        elif name == 'translate': m = (1, 0, 0, 1, v[0], v[1] if len(v) > 1 else 0)
        elif name == 'scale':     m = (v[0], 0, 0, v[1] if len(v) > 1 else v[0], 0, 0)
        elif name == 'rotate':
            r = math.radians(v[0])
            m = (math.cos(r), math.sin(r), -math.sin(r), math.cos(r), 0, 0)
        else: continue
        mat = mul(mat, m)
    return mat


def path_points(d):
    """On-curve endpoints of a path. Control points are skipped: they overshoot
    a glyph outline slightly and we only want bounding boxes and centres."""
    toks = [t for t in CMD.split(d) if t.strip()]
    pts, cur, start, i = [], (0.0, 0.0), (0.0, 0.0), 0
    while i < len(toks):
        cmd = toks[i]; i += 1
        args = []
        while i < len(toks) and not CMD.fullmatch(toks[i]):
            args += [float(x) for x in NUM.findall(toks[i])]; i += 1
        rel, c = cmd.islower(), cmd.upper()
        def step(n):
            for k in range(0, len(args) - n + 1, n): yield args[k:k+n]
        if c == 'M':
            for a in step(2):
                cur = (cur[0]+a[0], cur[1]+a[1]) if rel else (a[0], a[1])
                pts.append(cur); start = cur
        elif c == 'L':
            for a in step(2):
                cur = (cur[0]+a[0], cur[1]+a[1]) if rel else (a[0], a[1]); pts.append(cur)
        elif c == 'H':
            for a in step(1):
                cur = (cur[0]+a[0], cur[1]) if rel else (a[0], cur[1]); pts.append(cur)
        elif c == 'V':
            for a in step(1):
                cur = (cur[0], cur[1]+a[0]) if rel else (cur[0], a[0]); pts.append(cur)
        elif c in 'CSQTA':
            n = {'C': 6, 'S': 4, 'Q': 4, 'T': 2, 'A': 7}[c]
            for a in step(n):
                cur = (cur[0]+a[-2], cur[1]+a[-1]) if rel else (a[-2], a[-1]); pts.append(cur)
        elif c == 'Z':
            cur = start
    return pts


def attr(el, name):
    # The lookbehind matters: a plain d="..." search also matches the d inside
    # id="path2", which silently hands back the id as path data.
    m = re.search(r'(?<![\w-])' + name + r'="([^"]*)"', el, re.S)
    return m.group(1) if m else ''


def to_svg(pdf_path, out_path):
    # --export-text-to-path=false reads backwards, but empirically this is the
    # form that yields <path> glyphs carrying the original string in aria-label.
    # Without it Inkscape emits <text> at the baseline origin, and recovering a
    # glyph's centre from that needs font metrics we do not have. Centres from
    # the path outlines were cross-checked against `inkscape --query-all` and
    # agree exactly.
    subprocess.run(['inkscape', '--export-type=svg', '--export-plain-svg',
                    '--export-text-to-path=false',
                    '--export-filename=' + out_path, pdf_path],
                   check=True, capture_output=True)


def shrink(d):
    """Drop excess decimals. The paths sit under a ~2.7x transform, so three
    places here is far below a rendered pixel."""
    return NUM.sub(lambda m: ('%.*f' % (PRECISION, float(m.group(0)))).rstrip('0').rstrip('.') or '0', d)


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    pdf = os.path.expanduser(sys.argv[1])
    if not os.path.exists(pdf):
        sys.exit('No such file: ' + pdf)
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    assets = os.path.join(root, 'docs', 'assets')

    with tempfile.TemporaryDirectory() as tmp:
        raw_path = os.path.join(tmp, 'raw.svg')
        to_svg(pdf, raw_path)
        raw = open(raw_path, encoding='utf-8', errors='replace').read()

    elements = re.findall(r'<path\b[^>]*/>', raw, re.S)
    desks, keep, boxes = [], [], []
    dropped = 0
    min_detail = MIN_DETAIL
    if '--detail' in sys.argv:
        min_detail = float(sys.argv[sys.argv.index('--detail') + 1])

    for el in elements:
        d = attr(el, 'd')
        if not d:
            continue
        style = attr(el, 'style')
        mat = parse_transform(attr(el, 'transform'))
        pts = [(mat[0]*x + mat[2]*y + mat[4], mat[1]*x + mat[3]*y + mat[5])
               for x, y in path_points(d)]
        if not pts:
            continue
        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
        box = (min(xs), min(ys), max(xs), max(ys))

        if RED in style:
            label = attr(el, 'aria-label').strip()
            if not label.isdigit():
                sys.exit('A red label was not a number: %r' % label)
            desks.append({'n': int(label),
                          'cx': (box[0] + box[2]) / 2, 'cy': (box[1] + box[3]) / 2})
        elif TITLE in style:
            pass                       # the "Floor: Three / Room: 3112" caption
        else:
            if max(box[2] - box[0], box[3] - box[1]) < min_detail:
                dropped += 1
                continue
            keep.append(el); boxes.append(box)

    if not desks:
        sys.exit('Found no red desk numbers. Either the plan no longer marks\n'
                 'desks in %s, or this Inkscape build ignored\n'
                 '--export-text-to-path=false and emitted <text> instead of\n'
                 'labelled <path> glyphs. Check the intermediate SVG.' % RED)
    desks.sort(key=lambda d: d['n'])
    seen = [d['n'] for d in desks]
    if seen != sorted(set(seen)):
        sys.exit('Duplicate desk numbers in the plan: %s' % seen)

    # Crop to the linework, clamped to the page: anything outside the page was
    # already invisible in the PDF and must not be published.
    x0 = max(0.0, min(b[0] for b in boxes) - MARGIN)
    y0 = max(0.0, min(b[1] for b in boxes) - MARGIN)
    x1 = min(PAGE[0], max(b[2] for b in boxes) + MARGIN)
    y1 = min(PAGE[1], max(b[3] for b in boxes) + MARGIN)
    w, h = x1 - x0, y1 - y0

    # The linework is one uniform stroke repeated ~1800 times; carrying that
    # style string on every path costs more bytes than the geometry does. Hoist
    # it into a single rule and strip the per-path style and id attributes.
    styles = {' '.join(attr(el, 'style').split()) for el in keep}
    hoist = len(styles) == 1
    shared = styles.pop() if hoist else ''

    body = []
    for el in keep:
        if hoist:
            el = re.sub(r'\s(?:style|id)="[^"]*"', '', el)
        else:
            el = el.replace('stroke:' + LINE_COLOUR, 'stroke:var(--plan-ink,#3f4753)')
        body.append('  ' + ' '.join(shrink(el).split()))

    css = ''
    if hoist:
        # Let the page theme drive the ink colour, with a literal fallback so the
        # file still reads correctly when opened on its own.
        rule = shared.replace('stroke:' + LINE_COLOUR, 'stroke:var(--plan-ink,#3f4753)')
        # non-scaling-stroke keeps the linework a true hairline at every size.
        # Scaled strokes render chunky on a wall display and drop below a device
        # pixel on a phone; a technical drawing wants neither.
        rule += ';vector-effect:non-scaling-stroke'
        css = '  <style>path{%s}</style>\n' % rule

    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="%s %s %s %s"\n'
        '     role="img" aria-label="Floor plan of IRB 3112: %d desks">\n'
        '  <!-- Generated by dev/import-floorplan.py from the facilities PDF.\n'
        '       Do not hand-edit: re-run the importer against the new plan. -->\n'
        '%s'
        '  <rect x="%s" y="%s" width="%s" height="%s" fill="var(--plan-paper,#ffffff)"/>\n'
        '%s\n</svg>\n'
    ) % (fmt(x0), fmt(y0), fmt(w), fmt(h), len(desks), css,
         fmt(x0), fmt(y0), fmt(w), fmt(h), '\n'.join(body))

    rows = ['\t'.join(['deskId', 'label', 'room', 'x', 'y', 'status', 'reservedFor', 'notes'])]
    for d in desks:
        rows.append('\t'.join([
            'IRB3112-%02d' % d['n'], str(d['n']), group_for(d['n']),
            '%.2f' % ((d['cx'] - x0) / w * 100),
            '%.2f' % ((d['cy'] - y0) / h * 100),
            'active', '', '']))

    open(os.path.join(assets, 'floorplan.svg'), 'w').write(svg)
    open(os.path.join(assets, 'desks.tsv'), 'w').write('\n'.join(rows) + '\n')

    print('%d desks (%d-%d) -> docs/assets/desks.tsv' % (len(desks), desks[0]['n'], desks[-1]['n']))
    print('%d paths, %.0fKB      -> docs/assets/floorplan.svg' % (len(keep), len(svg) / 1024))
    if dropped:
        print('%d sub-%.3g-unit paths dropped as unrenderable detail' % (dropped, min_detail))
    print('viewBox %s %s %s %s' % (fmt(x0), fmt(y0), fmt(w), fmt(h)))


def fmt(v):
    return ('%.2f' % v).rstrip('0').rstrip('.')


if __name__ == '__main__':
    main()
