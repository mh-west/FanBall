"""Tally pitch outcomes by ball-strike count from Retrosheet event files.

Usage: python3 -I tools/retrosheet-count-tables.py <dir with unzipped *.EV? files> <out.json>
Data: https://www.retrosheet.org/events/2025eve.zip (not stored in this repo).
Only the last play line of each plate appearance is used (lines whose event is a
non-batter event such as SB/CS/WP are skipped; the batter's later line repeats the
full pitch sequence).
"""
import glob, json, os, re, sys
from collections import defaultdict

src, out = sys.argv[1], sys.argv[2]
NON_BATTER = re.compile(r'^(SB|CS|POCS|PO|WP|PB|BK|DI|OA|NP|FLE)')
SKIP_CHARS = set('+*.123>N')  # pickoffs, markers, no-pitch
CODE = {
    'B': 'ball', 'I': 'ball', 'P': 'ball', 'V': 'ball',
    'C': 'called_strike', 'K': 'called_strike',
    'S': 'swinging_strike', 'Q': 'swinging_strike', 'M': 'swinging_strike',
    'T': 'swinging_strike', 'O': 'swinging_strike',   # foul tips count as strikes (caught)
    'F': 'foul', 'R': 'foul', 'L': 'foul',
    'X': 'in_play', 'Y': 'in_play',
    'H': 'hbp',
}
BUNT_PITCH = set('LMO')


def in_play_kind(event):
    e = event.split('/')[0].split('.')[0]
    mods = event.split('.')[0].upper()
    if e.startswith('HR') or (e.startswith('H') and not e.startswith('HP')):
        return 'HR'
    if e.startswith('S') and not e.startswith('SB') and not e.startswith('SF'):
        return '1B'
    if e.startswith('DGR') or (e.startswith('D') and not e.startswith('DI')):
        return '2B'
    if e.startswith('T'):
        return '3B'
    if e.startswith('E') or e.startswith('FC'):
        return 'ROE_FC'
    if '/GDP' in mods or '/GTP' in mods or '/LDP' in mods or '/FDP' in mods or '/BGDP' in mods or '/BPDP' in mods:
        return 'DP'
    if '/SH' in mods:
        return 'SAC_BUNT'
    if '/SF' in mods:
        return 'SAC_FLY'
    return 'OUT'


pitch = defaultdict(lambda: defaultdict(int))     # count -> outcome -> n
inplay = defaultdict(lambda: defaultdict(int))    # count -> kind -> n
bunt_inplay = defaultdict(int)                    # kind -> n (bunted balls in play)
bunt_pitch = defaultdict(int)                     # foul bunt / missed bunt pitches
pa_end = defaultdict(int)
unknown = defaultdict(int)
plate_appearances = 0

files = sorted(glob.glob(os.path.join(src, '*.EV?')))
for path in files:
    with open(path, encoding='latin-1') as fh:
        for line in fh:
            if not line.startswith('play,'):
                continue
            parts = line.rstrip('\n').split(',')
            if len(parts) < 7:
                continue
            seq, event = parts[5], parts[6]
            if event == 'NP' or NON_BATTER.match(event):
                continue
            plate_appearances += 1
            balls = strikes = 0
            last_code = None
            for ch in seq:
                if ch in SKIP_CHARS:
                    continue
                kind = CODE.get(ch)
                if kind is None:
                    unknown[ch] += 1
                    continue
                if balls > 3 or strikes > 2:
                    break
                count = f'{balls}-{strikes}'
                pitch[count][kind] += 1
                if ch in BUNT_PITCH:
                    bunt_pitch[ch] += 1
                last_code = ch
                if kind == 'ball':
                    balls += 1
                elif kind in ('called_strike', 'swinging_strike'):
                    strikes += 1
                elif kind == 'foul':
                    # A foul bunt is a strike even with two strikes; other fouls are not.
                    if strikes < 2 or ch == 'L':
                        strikes += 1
                elif kind == 'in_play':
                    k = in_play_kind(event)
                    inplay[count][k] += 1
                    up = event.upper()
                    if '/B' in up and re.search(r'/(BG|BP|BL|BGDP|BPDP|BF|BINT|SH)', up):
                        bunt_inplay[k] += 1
            ev = event.split('/')[0].split('.')[0]
            if ev.startswith('K'):
                pa_end['K'] += 1
            elif ev.startswith('IW') or ev.startswith('I') and not ev.startswith('IN'):
                pa_end['IBB'] += 1
            elif ev.startswith('W'):
                pa_end['BB'] += 1
            elif ev.startswith('HP'):
                pa_end['HBP'] += 1
            else:
                pa_end['other'] += 1

counts = [f'{b}-{s}' for b in range(4) for s in range(3)]
result = {
    'source': 'Retrosheet 2025 MLB regular-season event files (www.retrosheet.org)',
    'notice': 'The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at "www.retrosheet.org".',
    'files': len(files), 'plate_appearances': plate_appearances,
    'pitch_outcomes_by_count': {c: dict(pitch[c]) for c in counts},
    'in_play_by_count': {c: dict(inplay[c]) for c in counts},
    'bunt_in_play': dict(bunt_inplay), 'bunt_pitch_codes': dict(bunt_pitch),
    'pa_end': dict(pa_end), 'unknown_codes': dict(unknown),
}
with open(out, 'w') as fh:
    json.dump(result, fh, indent=1, ensure_ascii=False)

print(f'files {len(files)}  PAs {plate_appearances}  unknown codes {dict(unknown)}')
print('PA ends', dict(pa_end))
hdr = ['ball', 'called_strike', 'swinging_strike', 'foul', 'in_play', 'hbp']
print('count  pitches  ' + '  '.join(h[:8].rjust(8) for h in hdr))
for c in counts:
    n = sum(pitch[c].values())
    print(f'{c:5} {n:8d}  ' + '  '.join(f'{100*pitch[c].get(h,0)/max(n,1):7.1f}%' for h in hdr))
kinds = ['1B', '2B', '3B', 'HR', 'OUT', 'DP', 'ROE_FC', 'SAC_FLY', 'SAC_BUNT']
print('\nin play by count (% of balls in play)')
print('count  bip     ' + '  '.join(k.rjust(7) for k in kinds))
for c in counts:
    n = sum(inplay[c].values())
    print(f'{c:5} {n:6d}  ' + '  '.join(f'{100*inplay[c].get(k,0)/max(n,1):6.1f}%' for k in kinds))
print('\nbunts in play', dict(bunt_inplay), 'bunt pitch codes', dict(bunt_pitch))
