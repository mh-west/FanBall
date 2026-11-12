"""Builds dist/bullpens.js and data/bullpen-2026.json from the pitcher collector's output.

Five relievers per team (user decision 2026-11-12: no fixed closer, five each):
- Candidates: 2026 KBO pitchers on the team with 15+ games and at most 2 innings per game (relief usage),
  not the team's designated starter.
- A pitcher whose Namu page has no 2026 row yet (not updated) is rated on his 2025 season (marked season 2025).
- Ranked by relief usage: holds + saves + games/4; the top five are the bullpen. A team's list can be set
  by hand in data/bullpen-overrides.json ({"tigers": ["정해영", ...]}), which wins over the ranking.
- Rates per batter faced, estimated as TBF = 3 x IP + H + BB + HBP (the tables have no TBF column):
  opponent AVG = H / (TBF - BB - HBP), BB/PA = (BB + HBP) / TBF, K/PA = K / TBF.
- Pitch types and speeds: Namu tables do not list them for relievers, so a typical mix by throwing arm and
  slot is used (display only; marked "추정" in the data file).

Usage: python3 -I tools/build-bullpens.py <pitchers-2026.json> [teams, e.g. tigers,lg; default all]
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib; rep = importlib.import_module('repertoire')

STARTERS = {'tigers': '네일', 'samsung': '후라도', 'kt': '고영표', 'lg': '톨허스트', 'doosan': '곽빈', 'ssg': '김광현',
            'nc': '라일리', 'lotte': '로드리게스', 'hanwha': '류현진', 'kiwoom': '안우진'}
MIX = {  # typical reliever repertoire by slot: {type: [[min, max] km/h, share %]}
    'over': {'포심': [[144, 151], 52], '슬라이더': [[131, 137], 26], '포크': [[131, 137], 14], '커브': [[117, 124], 8]},
    'side': {'투심': [[137, 145], 48], '슬라이더': [[124, 131], 32], '체인지업': [[122, 129], 20]},
    'under': {'투심': [[128, 136], 46], '커브': [[108, 116], 26], '체인지업': [[115, 122], 28]},
}

src = json.load(open(sys.argv[1], encoding='utf8'))
# Records the user sent (2026 line, real pitch mix and speeds) win over the Namu values.
manual = json.load(open('data/pitchers-manual-2026.json', encoding='utf8'))['pitchers'] if os.path.exists('data/pitchers-manual-2026.json') else {}
for key, m in manual.items():
    base = src.get(key, {'team': m['team'], 'name': m['name'], 'throws': None, 'slot': 'over'})
    base.update({k: m[k] for k in ('games', 'ip', 'saves', 'holds', 'k', 'h', 'hr', 'bb', 'hbp')}); base.update({'how': 'yearly_table', 'source': m['source']})
    src[key] = base
overrides_path = 'data/bullpen-overrides.json'
overrides = json.load(open(overrides_path, encoding='utf8')) if os.path.exists(overrides_path) else {}


def rates(p):
    ip, h, bb, hbp, k = p['ip'] or 0, p['h'] or 0, p['bb'] or 0, p['hbp'] or 0, p['k'] or 0
    tbf = 3 * ip + h + bb + hbp
    if tbf < 30:
        return None
    ab = max(1.0, tbf - bb - hbp)
    return round(h / ab, 3), round((bb + hbp) / tbf, 3), round(k / tbf, 3), int(round(tbf))


out, data = {}, {'built': 'tools/build-bullpens.py', 'rule': __doc__.split('Usage')[0].strip(), 'teams': {}}
only = set(sys.argv[2].split(',')) if len(sys.argv) > 2 and sys.argv[2] else set(STARTERS)
for team in [t for t in STARTERS if t in only]:
    pool = [p for p in src.values() if p['team'] == team and p['how'] in ('yearly_table', 'yearly_2025') and p['name'] != STARTERS[team]]
    every = {p['name']: p for p in src.values() if p['team'] == team}
    usable = [p for p in pool if (p['games'] or 0) >= 15 and (p['ip'] or 0) <= 2.0 * (p['games'] or 1) and rates(p)]
    usage = lambda p: (p['holds'] or 0) + (p['saves'] or 0) + (p['games'] or 0) / 4
    chosen = sorted(usable, key=usage, reverse=True)[:5]
    if isinstance(overrides.get(team), list):
        by_name = every
        chosen = [by_name[n] for n in overrides[team] if n in by_name][:5]
    pitchers = []
    for p in chosen:
        # A hand-picked pitcher with too little on record gets league-average reliever rates (marked).
        avg, bb, k, tbf = rates(p) or (0.260, 0.095, 0.200, 0)
        key = f"{team}:{p['name']}"
        slot = rep.slot_for(key, p.get('slot') or 'over')
        namu_mix = rep.mix_for(key)
        mix = namu_mix or MIX.get(slot, MIX['over'])
        pitchers.append({'name': p['name'], 'throws': p.get('throws') or 'R', 'slot': slot, 'avg': avg, 'bb': bb, 'k': k,
                         'games': p['games'], 'ip': p['ip'], 'holds': p['holds'], 'saves': p['saves'], 'era': p['era'], 'tbf_est': tbf,
                         'season': 2025 if p['how'] == 'yearly_2025' else 2026, 'speeds': {t: v[0] for t, v in mix.items()}, 'mix': {t: v[1] for t, v in mix.items()},
                         'mix_note': rep.mix_note(key) if namu_mix else '추정(팔 각도별 대표 구성)', 'note': p.get('note') or ('기록 부족: 리그 평균 구원 값' if not rates(p) else None), 'source': p['source']})
    out[team] = {'pitchers': pitchers}
    data['teams'][team] = {'starter': STARTERS[team], 'bullpen': pitchers,
                           'candidates': [{'name': p['name'], 'games': p['games'], 'ip': p['ip'], 'holds': p['holds'], 'saves': p['saves'],
                                           'throws': p.get('throws'), 'slot': p.get('slot')} for p in sorted(usable, key=usage, reverse=True)[:12]]}
    print(team, ', '.join(f"{x['name']}({x['throws']}{'' if x['slot'] == 'over' else '/' + x['slot']} {int(x['games'])}G {int(x['holds'] or 0)}H {int(x['saves'] or 0)}S{' *2025' if x['season'] == 2025 else ''})" for x in pitchers))

json.dump(data, open('data/bullpen-2026.json', 'w', encoding='utf8'), ensure_ascii=False, indent=1)
head = ('/* Generated by tools/build-bullpens.py from Namu Wiki 2026 pitching records (CC BY-NC-SA 2.0 KR; sources in\n'
        '   data/bullpen-2026.json). Five relievers per team; pitch mixes are typical by arm slot (estimated). */\n')
open('dist/bullpens.js', 'w', encoding='utf8').write(head + 'window.FANBALL_BULLPENS=' + json.dumps(out, ensure_ascii=False) + ';\n')
