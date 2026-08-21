#!/usr/bin/env python3
"""
Generate a placeholder floor plan and the matching Desks rows from one layout
description, so the image and the coordinates can never drift apart.

    python3 dev/make-floorplan.py

Writes docs/assets/floorplan.svg and docs/assets/demo-desks.tsv.

Tweak LAYOUT below when you learn the real room; re-run; paste the new TSV into
the Desks tab. Once you have a real floor plan photo or CAD export, drop that in
as docs/assets/floorplan.png instead and place desks with tools/desk-mapper.html.
"""

import pathlib

ROOM_NAME = 'IRB 3112'      # prefixes every deskId, so a second room can be added later

W, H = 1100, 730           # viewBox; desk coordinates are emitted as % of these
ROOM = (40, 66, 1060, 660)  # x0, y0, x1, y1 of the interior walls

DESK_W, DESK_H = 80, 85
ROW_PITCH = 105             # vertical spacing of a 5-desk column
BAND_TOP = 110              # top of the 5-desk band

# Each entry: label prefix, group name, desk x-range, how many, which side the
# chair goes on, and whether the column is centred against a shorter wall.
LAYOUT = [
    dict(prefix='L', group='Left wall',  x0=46,  count=4, chair='right'),
    dict(prefix='A', group='Row 1',      x0=300, count=5, chair='left'),
    dict(prefix='B', group='Row 1',      x0=380, count=5, chair='right'),
    dict(prefix='C', group='Row 2',      x0=640, count=5, chair='left'),
    dict(prefix='D', group='Row 2',      x0=720, count=5, chair='right'),
    dict(prefix='R', group='Right wall', x0=974, count=5, chair='left'),
]

BAND_BOTTOM = BAND_TOP + 5 * ROW_PITCH - (ROW_PITCH - DESK_H)


def column_tops(count):
    """Vertical positions for `count` desks, centred on the 5-desk band."""
    span = count * ROW_PITCH - (ROW_PITCH - DESK_H)
    top = BAND_TOP + (BAND_BOTTOM - BAND_TOP - span) / 2
    return [top + i * ROW_PITCH for i in range(count)]


def build():
    desks, shapes = [], []
    for col in LAYOUT:
        for i, top in enumerate(column_tops(col['count']), start=1):
            x, y = col['x0'], top
            label = f"{col['prefix']}{i}"
            desks.append(dict(
                # deskId is the stable key; label is what people say out loud.
                deskId=f"{ROOM_NAME.replace(' ', '')}-{label}",
                label=label, room=col['group'],
                x=round((x + DESK_W / 2) / W * 100, 2),
                y=round((y + DESK_H / 2) / H * 100, 2),
            ))
            shapes.append(f'    <rect x="{x:g}" y="{y:g}" width="{DESK_W}" height="{DESK_H}" rx="4"/>')
            cx = x - 17 if col['chair'] == 'left' else x + DESK_W + 17
            shapes.append(
                f'    <circle class="chair" cx="{cx:g}" cy="{y + DESK_H / 2:g}" r="13"/>')
    return desks, shapes


def svg(shapes):
    x0, y0, x1, y1 = ROOM
    spine_a, spine_b = 380, 720
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}"
     role="img" aria-label="Placeholder plan of {ROOM_NAME}: 29 desks">
  <style>
    /* var() first so the plan follows the page theme once inlined; the literal
       fallback keeps it readable when the file is opened on its own. */
    .wall   {{ fill: none; stroke: var(--plan-wall, #8d95a1); stroke-width: 6; }}
    .spine  {{ fill: none; stroke: var(--plan-edge, #ccd2da); stroke-width: 3; }}
    .desk   {{ fill: var(--plan-desk, #eef1f5); stroke: var(--plan-edge, #c8cfd8); stroke-width: 2; }}
    .chair  {{ fill: none; stroke: var(--plan-edge, #c8cfd8); stroke-width: 2; }}
    .zone   {{ fill: var(--plan-text, #7b8391); font: 600 17px ui-sans-serif, Helvetica, Arial, sans-serif; }}
    .room   {{ fill: var(--plan-text, #7b8391); font: 700 22px ui-sans-serif, Helvetica, Arial, sans-serif; }}
    .note   {{ fill: var(--plan-text, #7b8391); opacity: .7;
               font: 14px ui-sans-serif, Helvetica, Arial, sans-serif; }}
    .window {{ fill: none; stroke: var(--plan-edge, #b9c6d6); stroke-width: 7; }}
    .door   {{ fill: none; stroke: var(--plan-edge, #c8cfd8); stroke-width: 2; }}
  </style>

  <rect width="{W}" height="{H}" fill="var(--plan-paper, #ffffff)"/>

  <!-- walls: one open span, so the doorway gap is not painted back over -->
  <path class="wall" d="M {x0 + 150} {y1} L {x0} {y1} L {x0} {y0} L {x1} {y0} L {x1} {y1} L {x0 + 240} {y1}"/>
  <line class="window" x1="{x0 + 180}" y1="{y0}" x2="{x0 + 400}" y2="{y0}"/>
  <line class="window" x1="{x0 + 560}" y1="{y0}" x2="{x0 + 780}" y2="{y0}"/>
  <path class="door" d="M {x0 + 240} {y1} L {x0 + 240} {y1 - 88} A 88 88 0 0 1 {x0 + 152} {y1}"/>

  <!-- back-to-back spines of the two central rows -->
  <line class="spine" x1="{spine_a}" y1="{BAND_TOP - 12}" x2="{spine_a}" y2="{BAND_BOTTOM + 12}"/>
  <line class="spine" x1="{spine_b}" y1="{BAND_TOP - 12}" x2="{spine_b}" y2="{BAND_BOTTOM + 12}"/>

  <g class="desk">
{chr(10).join(shapes)}
  </g>

  <text class="room" x="{x0 + 8}" y="{y0 - 12}">{ROOM_NAME}</text>

  <g class="zone">
    <text x="{x0 + 8}" y="{y0 + 42}">Left wall</text>
    <text x="300" y="{y0 + 42}">Row 1</text>
    <text x="640" y="{y0 + 42}">Row 2</text>
    <text x="945" y="{y0 + 42}">Right wall</text>
  </g>
  <text class="note" x="{x0 + 152}" y="{y1 + 26}">door</text>
  <text class="note" x="{W / 2}" y="{H - 8}" text-anchor="middle">
    Placeholder plan of {ROOM_NAME} — 29 desks. Replace with the real floor plan and re-place desks with tools/desk-mapper.html
  </text>
</svg>
'''


def tsv(desks):
    head = ['deskId', 'label', 'room', 'x', 'y', 'status', 'reservedFor', 'notes']
    lines = ['\t'.join(head)]
    for d in desks:
        lines.append('\t'.join([
            d['deskId'], d['label'], d['room'], f"{d['x']:g}", f"{d['y']:g}", 'active', '', '']))
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    out = pathlib.Path(__file__).resolve().parent.parent / 'docs' / 'assets'
    desks, shapes = build()
    (out / 'floorplan.svg').write_text(svg(shapes))
    (out / 'demo-desks.tsv').write_text(tsv(desks))
    print(f'{len(desks)} desks ->  {out / "floorplan.svg"}')
    print(f'{" ":>{len(str(len(desks)))}}       {out / "demo-desks.tsv"}')
