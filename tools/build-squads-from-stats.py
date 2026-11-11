"""Writes data/namu-2026-batting.json and dist/squads.js from the collector's output.

Keeps in the lineup squads only players with a 2026 first-team season: a stat line, or a 2026 season
page without a table (they use league-average placeholders). Usage:
  python3 -I tools/build-squads-from-stats.py <squads-all.json> <stats.json>
"""
import json, sys

squads_path, stats_path = sys.argv[1], sys.argv[2]
d = json.load(open(stats_path, encoding='utf8'))
sq = json.load(open(squads_path, encoding='utf8'))
num = lambda x: float(x) if x not in (None, '-', '') else None
HOW = {'season_page': '<선수>/선수 경력/2026년 총평 표', 'yearly_table': '연도별 성적 표 2026 행',
       'season_page_no_table': '2026 시즌 문서는 있으나 기록 표 없음(라인업 명단 유지, 리그 평균 임시값)',
       'no_first_team_2026': '2026 1군 기록 없음', 'no_2026_row': '연도별 성적 표에 2026 행 없음',
       'not_found_on_page': '문서는 있으나 기록을 찾지 못함', 'page_not_found': '선수 문서를 찾지 못함'}
out = {'collected': '2026-11-11', 'season': 2026,
       'source': '나무위키 선수 문서 (CC BY-NC-SA 2.0 KR). 값마다 source URL. 위키 편집자가 쓴 값이라 공식 기록과 다를 수 있음.',
       'how': HOW, 'players': []}
for v in d.values():
    out['players'].append({'team': v['team'], 'name': v['name'], 'number': v['number'], 'avg': num(v['avg']), 'bb': v.get('bb'), 'k': v.get('k'), 'hbp': v.get('hbp'),
                           'obp': num(v.get('obp')), 'slg': num(v.get('slg')), 'ops': num(v['ops']),
                           'games': v['games'], 'pa': v['pa'], 'ab': v['ab'], 'how': v['how'], 'source': v['source']})
json.dump(out, open('data/namu-2026-batting.json', 'w', encoding='utf8'), ensure_ascii=False, indent=1)

old = open('dist/squads.js', encoding='utf8').read()
oldjs = json.loads(old[old.index('window.FANBALL_SQUADS=') + len('window.FANBALL_SQUADS='):].strip().rstrip(';'))
keep = {}
for t, info in sq.items():
    rows = []
    for e in info['players']:
        v = d[f'{t}:{e[0]}']
        number = e[2] if len(e) > 2 else ''
        if v['avg'] not in (None, '-') and v['how'] in ('season_page', 'yearly_table'):
            whole = lambda x: int(x) if x and str(x).isdigit() else None
            bb, k, hbp = whole(v.get('bb')), whole(v.get('k')), whole(v.get('hbp'))
            pa = whole(v.get('pa'))
            if pa is None and whole(v.get('ab')) is not None:
                pa = whole(v['ab']) + (bb or 0) + (hbp or 0)  # tables without 타석: AB + BB + HBP (sacrifices left out)
            if pa is None and whole(v.get('games')):
                pa = whole(v['games']) * 3  # rough plate appearances when the table has neither
            rows.append([e[0], e[1], number, num(v['avg']), num(v['obp']), num(v['slg']), num(v['ops']), pa, bb, k])
        elif v['how'] == 'season_page_no_table':
            rows.append([e[0], e[1], number])
    keep[t] = {'source': oldjs.get(t, {}).get('source') or info.get('source'), 'players': rows}
    print(t, len(rows), {g: sum(1 for r in rows if r[1] == g) for g in ('C', 'IF', 'OF')})
head = '''/* Position-player squads per team. Names from Wikipedia team pages (2026-11-11; SSG from the Namu
   Wiki "SSG 랜더스/선수단" page). Only players with a 2026 first-team season are kept (user decision
   2026-11-11). Entries: [name, group C|IF|OF, uniform number, AVG, OBP, SLG, OPS, PA, BB, K]; the 2026 regular-season
   numbers come from each player's Namu Wiki page (CC BY-NC-SA 2.0 KR, see data/namu-2026-batting.json for
   the page of every value). Entries without numbers played in 2026 but their page has no stat table;
   they use league-average placeholders. Rebuild: tools/namu-batting-stats.py, then
   tools/build-squads-from-stats.py. */
'''
open('dist/squads.js', 'w', encoding='utf8').write(head + 'window.FANBALL_SQUADS=' + json.dumps(keep, ensure_ascii=False) + ';\n')
print('total', sum(len(v['players']) for v in keep.values()))
