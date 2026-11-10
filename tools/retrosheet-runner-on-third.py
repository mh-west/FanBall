"""Follow the base-out state through Retrosheet event files and measure what happens on balls in
play with a runner on third and fewer than two outs (sacrifice flies, run-scoring ground outs).

Usage: python3 -I tools/retrosheet-runner-on-third.py <dir with unzipped *.EV? files> [out.json]
Data: https://www.retrosheet.org/events/2025eve.zip (not stored in this repo).
The information used here was obtained free of charge from and is copyrighted by Retrosheet.
Interested parties may contact Retrosheet at "www.retrosheet.org".

The tracker is a simplified reading of the Retrosheet event format: it covers hits, walks, outs
with fielder sequences, force outs, double plays, errors, fielder's choices, stolen bases, caught
stealing, pickoffs and explicit runner advances. It reports how many half-innings ended with
exactly three outs so the reader can judge how well the state was followed.
"""
import glob, json, os, re, sys
from collections import Counter

src = sys.argv[1]
out_path = sys.argv[2] if len(sys.argv) > 2 else None
BASE = {'B': 0, '1': 1, '2': 2, '3': 3, 'H': 4}
NON_BATTER = re.compile(r'^(SB|CS|POCS|PO|WP|PB|BK|DI|OA|NP|FLE|OBS)')


def runner_event(part, dest, outs_from):
    """Stolen bases, caught stealing and pickoffs inside an event (e.g. SB2;SB3, CS2(24), POCS3(1E5))."""
    for item in part.split(';'):
        m = re.match(r'^SB([23H])', item)
        if m:
            to = BASE[m.group(1)]; dest[to - 1] = to
            continue
        m = re.match(r'^(POCS|CS)([23H])(\(([^)]*)\))?', item)
        if m:
            frm = BASE[m.group(2)] - 1
            if m.group(4) and 'E' in m.group(4): dest[frm] = BASE[m.group(2)]
            else: dest[frm] = None; outs_from.add(frm)
            continue
        m = re.match(r'^PO([123])(\(([^)]*)\))?', item)
        if m:
            frm = int(m.group(1))
            if not (m.group(3) and 'E' in m.group(3)): dest[frm] = None; outs_from.add(frm)


def play(bases, event):
    """Apply one event. bases: set of occupied bases {1,2,3}. Returns (new bases, outs, runs, info)."""
    main, _, adv = event.partition('.')
    parts = main.split('/')
    basic, mods = parts[0], parts[1:]
    dest = {b: b for b in bases}   # runner on base b -> destination (None = out)
    outs_from = set()
    batter = None                   # batter destination: 0 out, 1..4, None = not a plate appearance
    if NON_BATTER.match(basic):
        runner_event(basic, dest, outs_from)
    else:
        head, plus, tail = basic.partition('+')
        if plus: runner_event(tail, dest, outs_from)
        b = head
        if b.startswith('K'): batter = 0
        elif b.startswith(('IW', 'HP')) or b == 'I' or b.startswith('W'): batter = 1
        elif b.startswith('HR') or (b.startswith('H') and not b.startswith('HP')): batter = 4
        elif b.startswith('DGR'): batter = 2
        elif re.match(r'^S\d?', b) and not b.startswith('SB'): batter = 1
        elif re.match(r'^D\d?', b) and not b.startswith('DI'): batter = 2
        elif re.match(r'^T\d?', b): batter = 3
        elif b.startswith('E') or b.startswith('FC') or b.startswith('C'): batter = 1
        elif re.match(r'^\d', b):
            for r in re.findall(r'\(([123B])\)', b):
                if r == 'B': batter = 0
                else: dest[int(r)] = None; outs_from.add(int(r))
            if batter is None: batter = 1 if b.endswith(')') else 0
        else:
            return None
    # Explicit advances override the implied ones.
    for item in [x for x in adv.split(';') if x]:
        m = re.match(r'^([B123])([-X])([123H])((\([^)]*\))*)', item)
        if not m: continue
        frm, kind, to, extra = BASE[m.group(1)], m.group(2), BASE[m.group(3)], m.group(4) or ''
        safe = kind == '-' or ('E' in extra and not re.search(r'\(\d*E\d+/TH\)\(\d', extra) and 'E' in extra)
        if frm == 0:
            batter = to if safe else 0
        else:
            dest[frm] = to if safe else None
            if not safe: outs_from.add(frm)
            else: outs_from.discard(frm)
    outs = len(outs_from) + (1 if batter == 0 else 0)
    runs = sum(1 for d in dest.values() if d == 4) + (1 if batter == 4 else 0)
    new = {d for d in dest.values() if d in (1, 2, 3)}
    if batter in (1, 2, 3): new.add(batter)
    return new, outs, runs, {'batter': batter, 'basic': basic, 'mods': mods, 'adv': adv, 'scored3': dest.get(3) == 4}


def batted_type(mods, basic):
    """Batted-ball type from the location modifier (G56, F78XD, L9, P5, FL...). FO (force out) is not F."""
    for m in mods:
        mm = re.match(r'^(BG|BP|BL|FL|G|L|P|F)(?=\d|$|[DSXFLM+-])', m)
        if mm and not m.startswith(('FO', 'FINT')): return 'F' if mm.group(1) == 'FL' else mm.group(1)
    return '?'


stats = Counter()
halves = Counter()
for path in sorted(glob.glob(os.path.join(src, '*.EV?'))):
    bases, outs, key = set(), 0, None
    with open(path, encoding='latin-1') as fh:
        for line in fh:
            if line.startswith('id,'):
                if key is not None: halves['end_' + str(outs)] += 1
                bases, outs, key = set(), 0, None
                continue
            if not line.startswith('play,'): continue
            f = line.rstrip('\n').split(',')
            if len(f) < 7 or f[6] == 'NP': continue
            k = (f[1], f[2])
            if k != key:
                if key is not None: halves['end_' + str(outs)] += 1
                bases, outs, key = set(), 0, k
            before_bases, before_outs = set(bases), outs
            r = play(bases, f[6])
            if r is None: stats['unparsed'] += 1; continue
            bases, o, runs, info = r
            outs += o
            if info['batter'] is None: continue
            if 3 not in before_bases or before_outs >= 2: continue
            # Plate appearance with a runner on third and fewer than two outs.
            stats['pa'] += 1
            basic, mods = info['basic'], info['mods']
            t = batted_type(mods, basic)
            if t in ('BG', 'BP', 'BL') or any(m.startswith('SH') for m in mods):
                stats['bunt'] += 1; continue
            if info['batter'] == 0 and basic.startswith('K'): stats['K'] += 1; continue
            if basic.startswith(('W', 'IW', 'HP')) or basic == 'I': stats['walk_hbp'] += 1; continue
            if info['batter'] in (1, 2, 3, 4) and re.match(r'^(S|D|T|H(?!P)|HR|DGR)', basic) and not basic.startswith('SB'):
                stats['hit'] += 1; continue
            if basic.startswith(('E', 'FC')): stats['error_fc'] += 1; continue
            if not re.match(r'^\d', basic): stats['other'] += 1; continue
            # An out in play (possibly a force out where the batter reaches).
            dp = any(m in ('GDP', 'DP', 'LDP', 'FDP', 'GTP', 'TP') for m in mods)
            sf = any(m.startswith('SF') for m in mods)
            scored = info['scored3'] or sf
            first = basic[0]
            air = t in ('F', 'L', 'P') or sf
            if air and first in '789': cat = 'air_outfield'
            elif air: cat = 'air_infield'
            elif t == 'G' or (t == '?' and not air): cat = 'ground'
            else: cat = 'other_out'
            stats['inplay_out'] += 1
            stats[f'{cat}'] += 1
            stats[f'{cat}_scored'] += 1 if scored and not dp else 0
            if dp: stats['dp'] += 1; stats[f'{cat}_dp'] += 1
            if sf: stats['sf_marked'] += 1
    if key is not None: halves['end_' + str(outs)] += 1

result = {'stats': dict(stats), 'half_innings_by_final_outs': dict(halves)}
print(json.dumps(result, indent=1, ensure_ascii=False))
if out_path:
    with open(out_path, 'w') as fh: json.dump(result, fh, indent=1, ensure_ascii=False)
