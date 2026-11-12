"""Finds one pitcher's 2026 line when the yearly table has none: tries the batting collector's namesake
candidates, then the 2026 season page's own tables ("2026 시즌 최종 기록", "2026 시즌 성적", "<이름>의
2026시즌 기록"), and as a last resort the 2025 yearly row. Prints JSON. Network use is polite and cached.
Usage: python3 -I tools/find-pitcher-season.py <team_id> <name> <cache_dir>"""
import importlib.util, json, os, re, sys
_spec = importlib.util.spec_from_file_location('p', os.path.join(os.path.dirname(__file__), 'namu-pitcher-stats.py'))
p = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(p)
VAL = re.compile(r'^(-|\d+(\.\d+)?(⅓|⅔)?|\.\d+|\(\d+\))$')
TITLE = re.compile(r'2026\s*시즌\s*(최종\s*)?(기록|성적)|2026시즌 기록')


def table(L, i):
    row = {}
    while i < len(L) and len(row) < 40:
        labels = []
        while i < len(L) and not VAL.match(L[i]) and len(labels) < 25:
            labels.append(L[i]); i += 1
        if not labels:
            break
        vals = []
        while i < len(L) and VAL.match(L[i]) and len(vals) < len(labels) + 3:
            if not L[i].startswith('('):
                vals.append(L[i])
            i += 1
        if len(vals) < min(4, len(labels)):
            break
        row.update(zip(labels, vals))
        if '이닝' in row and len(vals) < len(labels):
            break
    return row


def season_table(page):
    L = p.namu.text_lines(page)
    for i in reversed([k for k, x in enumerate(L) if TITLE.search(x) and len(x) < 30]):
        r = table(L, i + 1)
        g = r.get('경기') or r.get('출장')
        if '이닝' in r and g not in (None, '0'):
            return r
    return None


def find(team, name, cache):
    words = p.TEAMS[team][1]
    for title in p.namu.candidates(name, words, cache):
        main = p.namu.fetch(title, cache)
        if not main or not p.namu.page_team_ok(main, words):
            continue
        hand, slot = p.hand_and_slot(main)
        for t in (title + '/선수 경력', title):
            page = main if t == title else p.namu.fetch(t, cache)
            r = p.pitching_row(page) if page else None
            if r:
                return title, t, r, hand, slot, 2026
        season = p.namu.fetch(title + '/선수 경력/2026년', cache)
        r = season_table(season) if season else None
        if r:
            return title, title + '/선수 경력/2026년', r, hand, slot, 2026
        for t in (title + '/선수 경력', title):
            page = main if t == title else p.namu.fetch(t, cache)
            r = p.pitching_row(page, '2025') if page else None
            if r:
                return title, t, r, hand, slot, 2025
    return None


if __name__ == '__main__':
    team, name, cache = sys.argv[1:4]
    got = find(team, name, cache)
    if not got:
        print(json.dumps({'team': team, 'name': name, 'found': False}, ensure_ascii=False)); sys.exit()
    title, src, r, hand, slot, season = got
    bb = p.num(r.get('볼넷') or r.get('4구')); hbp = p.num(r.get('사구'))
    if bb is None and r.get('사사구'):
        bb, hbp = p.num(r.get('사사구')), 0.0
    print(json.dumps({'team': team, 'name': name, 'found': True, 'title': title, 'source': p.namu.BASE + src, 'season': season, 'throws': hand, 'slot': slot,
                      'games': p.num(r.get('경기') or r.get('출장') or r.get('경기수')), 'ip': p.innings(r.get('이닝')), 'h': p.num(r.get('피안타')),
                      'hr': p.num(r.get('피홈런')), 'bb': bb, 'hbp': hbp, 'k': p.num(r.get('탈삼진') or r.get('삼진')),
                      'era': p.num(r.get('ERA') or r.get('평균자책점'))}, ensure_ascii=False))
