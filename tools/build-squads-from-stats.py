"""Writes data/namu-2026-batting.json and dist/squads.js from the collector's output.

Keeps in the lineup squads only players with a 2026 first-team season: a stat line, or a 2026 season
page without a table (they use league-average placeholders). Usage:
  python3 -I tools/build-squads-from-stats.py <squads-all.json> <stats.json> [namu cache dir]
"""
import importlib.util, json, os, re, sys

squads_path, stats_path = sys.argv[1], sys.argv[2]
cache_dir = sys.argv[3] if len(sys.argv) > 3 else None

# Fielding positions from the player's Namu Wiki infobox ("포지션 3루수, 유격수"), in the order listed
# (the first is the main one). Uses the collector's page cache; pages not cached are fetched politely.
_spec = importlib.util.spec_from_file_location('namu', os.path.join(os.path.dirname(__file__), 'namu-batting-stats.py'))
namu = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(namu)
POS_WORDS = {'포수': 'C', '1루수': '1B', '2루수': '2B', '3루수': '3B', '유격수': 'SS', '좌익수': 'LF', '중견수': 'CF', '우익수': 'RF',
             '지명타자': 'DH', '내야수': 'IF', '외야수': 'OF'}
STOP = ('투타', '신체', '학력', '프로 입단', '소속팀', '연봉', '등번호')


SEASON_POS = re.compile(r'(?:\d+번\s*(?:타자\s*)?|선발\s*)(포수|1루수|2루수|3루수|유격수|좌익수|중견수|우익수|지명타자)'
                        r'|(포수|1루수|2루수|3루수|유격수|좌익수|중견수|우익수|지명타자)(?:로|으로)\s*(?:선발|교체|출전|출장|나서)')


def season_positions(source):
    """Positions the player actually took in 2026, most used first, from the game notes on his 2026
    season page ("3번 우익수로 선발 출전"). Keeps positions with 2+ mentions and 10%+ of his mentions.
    Empty when the page is missing or has fewer than 3 mentions."""
    if not cache_dir or not source:
        return []
    title = source.split('/w/', 1)[1].split('/선수 경력')[0]
    page = namu.fetch(title + '/선수 경력/2026년', cache_dir)
    if not page:
        return []
    counts = {}
    for m in SEASON_POS.finditer(' '.join(namu.text_lines(page))):
        code = POS_WORDS[m.group(1) or m.group(2)]
        counts[code] = counts.get(code, 0) + 1
    total = sum(counts.values())
    if total < 3:
        return []
    return [k for k, v in sorted(counts.items(), key=lambda kv: -kv[1]) if v >= 2 and v >= 0.1 * total]


def positions_2026(source):
    """2026 positions when the season page shows them, else the infobox's career positions."""
    return season_positions(source) or positions(source)


def positions(source):
    if not cache_dir or not source:
        return []
    title = source.split('/w/', 1)[1].split('/선수 경력')[0]
    page = namu.fetch(title, cache_dir)
    if not page:
        return []
    lines = namu.text_lines(page)
    for i, x in enumerate(lines):
        if x != '포지션':
            continue
        out = []
        for y in lines[i + 1:i + 12]:
            if y in STOP:
                break
            # Utility players: "내야 유틸리티" (any infield spot), "내·외야 유틸리티", or
            # "유틸리티 플레이어" followed by bracketed positions like "[2루수]".
            if '유틸리티' in y:
                for code in (['IF'] if '내야' in y or '내·외야' in y else []) + (['OF'] if '외야' in y else []):
                    if code not in out:
                        out.append(code)
                continue
            for word in re.split(r'[,/·\s]+', y.strip('[]')):
                code = POS_WORDS.get(word)
                if code and code not in out:
                    out.append(code)
        return out
    return []
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
        # Batting side from the roster's 투타 ("우투좌타" -> L; 양타 -> S), when the roster has it.
        hand = e[3] if len(e) > 3 and e[3] else ''
        bats = {'좌': 'L', '우': 'R', '양': 'S'}.get(hand[2:3], None) if len(hand) == 4 else None
        if v['avg'] not in (None, '-') and v['how'] in ('season_page', 'yearly_table'):
            whole = lambda x: int(x) if x and str(x).isdigit() else None
            bb, k, hbp = whole(v.get('bb')), whole(v.get('k')), whole(v.get('hbp'))
            pa = whole(v.get('pa'))
            if pa is None and whole(v.get('ab')) is not None:
                pa = whole(v['ab']) + (bb or 0) + (hbp or 0)  # tables without 타석: AB + BB + HBP (sacrifices left out)
            if pa is None and whole(v.get('games')):
                pa = whole(v['games']) * 3  # rough plate appearances when the table has neither
            rows.append([e[0], e[1], number, num(v['avg']), num(v['obp']), num(v['slg']), num(v['ops']), pa, bb, k, ','.join(positions_2026(v['source'])), bats])
        elif v['how'] == 'season_page_no_table':
            rows.append([e[0], e[1], number, None, None, None, None, None, None, None, ','.join(positions_2026(v['source'])), bats])
    keep[t] = {'source': oldjs.get(t, {}).get('source') or info.get('source'), 'players': rows}
    print(t, len(rows), {g: sum(1 for r in rows if r[1] == g) for g in ('C', 'IF', 'OF')})
head = '''/* Position-player squads per team, from each team's Namu Wiki "<team>/선수단" page (2026-11-11;
   the earlier Wikipedia lists missed players such as LG 홍창기). Only players with a 2026 first-team season are kept (user decision
   2026-11-11). Entries: [name, group C|IF|OF, uniform number, AVG, OBP, SLG, OPS, PA, BB, K, positions, bats R|L|S];
   positions: positions the player took in 2026, most used first, counted from the game notes on his
   2026 Namu Wiki season page; the infobox's career positions when there are no 2026 notes. the 2026 regular-season
   numbers come from each player's Namu Wiki page (CC BY-NC-SA 2.0 KR, see data/namu-2026-batting.json for
   the page of every value). Entries without numbers played in 2026 but their page has no stat table;
   they use league-average placeholders. Rebuild: tools/namu-batting-stats.py, then
   tools/build-squads-from-stats.py. */
'''
open('dist/squads.js', 'w', encoding='utf8').write(head + 'window.FANBALL_SQUADS=' + json.dumps(keep, ensure_ascii=False) + ';\n')
print('total', sum(len(v['players']) for v in keep.values()))
