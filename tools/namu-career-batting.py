"""Career (KBO 통산) batting lines from Namu Wiki, for runner speed and steal tendency (user decision
2026-11-12: judge how often a player runs from his career steals against times he reached first).

For each batter in the stats file, reads the '연도별 성적' table on '<title>/선수 경력' (or the main page when the
table is there) and takes the 'KBO 통산' row, plus the per-year rows. Requests go through the shared fetcher
(2.5 s apart, cached).

Usage: python3 -I tools/namu-career-batting.py <stats.json> <cache_dir> <out.json>
"""
import importlib.util, json, os, re, sys, urllib.parse

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('b', os.path.join(here, 'namu-batting-stats.py'))
b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
YEAR = re.compile(r'^(19|20)\d\d$')
NOTE = re.compile(r'^\((최소|최다)?\s*\d+위\)$|^\[\d+\]$|^\(\d+시즌\)$')
NUMV = re.compile(r'^-?\d*\.?\d+$|^-$')
KEYS = {'경기': 'G', '경기수': 'G', '타석': 'PA', '타수': 'AB', '안타': 'H', '2루타': '2B', '3루타': '3B', '홈런': 'HR', '득점': 'R',
        '도루': 'SB', '도루자': 'CS', '도루실패': 'CS', '볼넷': 'BB', '4사구': 'BB4', '사구': 'HBP', '몸에 맞는 공': 'HBP', '삼진': 'K', '병살': 'GDP', '병살타': 'GDP'}


def values(lines, j, n):
    out = []
    while j < len(lines) and len(out) < n:
        x = lines[j].strip()
        if NOTE.match(x) or x == '':
            j += 1; continue
        if NUMV.match(x):
            out.append(x); j += 1; continue
        break
    return out, j


def table(lines):
    """(labels, career dict, {year: dict}) of the first by-year batting table with a 도루 column."""
    for s, x in enumerate(lines):
        if x != '연도' or s + 1 >= len(lines) or lines[s + 1] not in ('소속', '팀', '소속팀'):
            continue
        labels, k = [], s + 2
        while k < len(lines) and not YEAR.match(lines[k]) and len(labels) < 30:
            labels.append(lines[k]); k += 1
        if '도루' not in labels or '안타' not in labels:
            continue
        years, career, i = {}, None, k
        while i < len(lines) and i < k + 6000:
            x = lines[i]
            if YEAR.match(x):
                j = i + 1
                while j < len(lines) and not NUMV.match(lines[j]) and not YEAR.match(lines[j]) and lines[j] not in ('KBO', '통산') and j < i + 4:
                    j += 1
                vals, j2 = values(lines, j, len(labels))
                if len(vals) == len(labels):
                    years[x] = dict(zip(labels, vals))
                i = max(j2, i + 1); continue
            if x == '통산':
                vals, _ = values(lines, i + 1, len(labels))
                if len(vals) == len(labels):
                    career = dict(zip(labels, vals))
                break
            if x.startswith('이 문서의 내용') or x == '분류':
                break
            i += 1
        return labels, career, years
    return None, None, None


def norm(row):
    out = {}
    for k, v in (row or {}).items():
        if k in KEYS and v not in ('-', ''):
            try:
                out[KEYS[k]] = float(v)
            except ValueError:
                pass
    return out


stats, cache, out_path = json.load(open(sys.argv[1], encoding='utf8')), sys.argv[2], sys.argv[3]
out = json.load(open(out_path, encoding='utf8')) if os.path.exists(out_path) else {}
for key, v in stats.items():
    if key in out:
        continue
    src = v.get('source') or ''
    title = urllib.parse.unquote(src.split('/w/', 1)[1]).split('/선수 경력')[0].split('#')[0] if '/w/' in src else v['name']
    got = None
    for t in (title + '/선수 경력', title):
        page = b.fetch(t, cache)
        if not page:
            continue
        labels, career, years = table(b.text_lines(page))
        if labels:
            got = {'page': t, 'url': 'https://namu.wiki/w/' + urllib.parse.quote(t), 'career': norm(career),
                   'years': {y: norm(r) for y, r in years.items()}, 'labels': labels}
            break
    out[key] = got or {'page': title, 'career': None}
    json.dump(out, open(out_path, 'w', encoding='utf8'), ensure_ascii=False)
    c = (got or {}).get('career') or {}
    print(key, (got or {}).get('page'), int(c.get('G', 0)), 'SB', int(c.get('SB', 0)), flush=True)
json.dump(out, open(out_path, 'w', encoding='utf8'), ensure_ascii=False)
