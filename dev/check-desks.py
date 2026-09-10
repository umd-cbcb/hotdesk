#!/usr/bin/env python3
"""
Sanity-check docs/assets/desks.tsv against docs/assets/floorplan.svg.

The plan is imported from a PDF that does not live in the repo, so CI cannot
regenerate it. It can still check that the desk list and the map agree, which is
what actually breaks if someone hand-edits one of them.
"""
import os, re, sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tsv = os.path.join(root, 'docs', 'assets', 'desks.tsv')
svg = os.path.join(root, 'docs', 'assets', 'floorplan.svg')
problems = []

rows = [l.rstrip('\n').split('\t') for l in open(tsv) if l.strip()]
header, body = rows[0], rows[1:]
for col in ('deskId', 'label', 'x', 'y', 'status'):
    if col not in header:
        problems.append('desks.tsv is missing the %s column' % col)
if problems:
    print('\n'.join(problems)); sys.exit(1)

idx = {c: header.index(c) for c in header}
seen = set()
for i, r in enumerate(body, start=2):
    did = r[idx['deskId']]
    if did in seen:
        problems.append('line %d: duplicate deskId %s' % (i, did))
    seen.add(did)
    for axis in ('x', 'y'):
        try:
            v = float(r[idx[axis]])
        except ValueError:
            problems.append('line %d: %s is not a number (%r)' % (i, axis, r[idx[axis]]))
            continue
        if not 0 <= v <= 100:
            problems.append('line %d: %s=%s is outside the map (0-100%%)' % (i, axis, v))

text = open(svg).read()
m = re.search(r'aria-label="Floor plan of [^:]+: (\d+) desks"', text)
if not m:
    problems.append('floorplan.svg has no desk count in its aria-label')
elif int(m.group(1)) != len(body):
    problems.append('floorplan.svg says %s desks, desks.tsv has %d'
                    % (m.group(1), len(body)))

if problems:
    print('\n'.join('::error file=docs/assets/desks.tsv::' + p for p in problems))
    sys.exit(1)
print('%d desks, all on the map, ids unique.' % len(body))
