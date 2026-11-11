"""Reads each squad player's 2026 regular-season AVG and OPS from Namu Wiki and saves them.

Where: the player's season page "<name>/선수 경력/2026년", table under "페넌트 레이스 총평".
Players without that page fall back to the "연도별 성적" table on their main page (2026 row).
Namesakes: tries "<name>", then "<name>(야구선수)" and the disambiguation links on the name page
that mention the player's team.

Namu Wiki allows /w/ pages in robots.txt. Content is CC BY-NC-SA 2.0 KR: keep the source URL with
every value. Requests are spaced out (DELAY seconds) and results are cached so reruns refetch nothing.

Usage: python3 -I tools/namu-batting-stats.py <squads.json> <out.json> [cache_dir]
  squads.json: {"tigers": {"name": "KIA 타이거즈", "players": [["김도영", "IF", "5"], ...]}, ...}
"""
import html, json, os, re, sys, time, urllib.parse, urllib.request, urllib.error

DELAY = 2.5
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'
BASE = 'https://namu.wiki/w/'
_last = [0.0]


def fetch(title, cache_dir):
    path = os.path.join(cache_dir, urllib.parse.quote(title, safe='') + '.html')
    if os.path.exists(path):
        with open(path, encoding='utf8') as f:
            body = f.read()
        return None if body == '' else body
    wait = DELAY - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait)
    url = BASE + urllib.parse.quote(title)
    body = None
    attempt = 0
    while True:
        attempt += 1
        _last[0] = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=30) as r:
                body = r.read().decode('utf8', 'replace')
            break
        except urllib.error.HTTPError as e:
            if e.code == 404:
                body = ''
                break
            if (e.code == 429 or e.code >= 500) and attempt < 4:
                time.sleep(30 * attempt)
                continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            # Network down (e.g. Wi-Fi dropped): wait and try again until it comes back.
            print('network error, retrying in 30s:', title, e, flush=True)
            time.sleep(30)
    with open(path, 'w', encoding='utf8') as f:
        f.write(body)
    return None if body == '' else body


def text_lines(page):
    s = re.sub(r'<(script|style)[^>]*>.*?</\1>', '', page, flags=re.S)
    t = html.unescape(re.sub(r'<[^>]+>', '\n', s))
    out = []
    for x in t.split('\n'):
        x = x.strip()
        if not x:
            continue
        m = re.match(r'^(-?[\d.]+(?:/\d+)?)\s*(\(.*\))$', x)  # "144 (1위)": value and rank in one cell
        out.extend([m.group(1), m.group(2)] if m else [x])
    return out


NUM = re.compile(r'^(-?\d*\.?\d+(/\d+)?|-)$')
NOTE = re.compile(r'^\(.*\)$|^\[.*\]$')  # rank notes like "(1위)" and footnote marks


def values_after(lines, j, n):
    """(n numeric cells from lines[j], index after them), skipping rank notes and footnote marks."""
    vals = []
    while j < len(lines) and len(vals) < n:
        x = lines[j]
        if NOTE.match(x):
            j += 1; continue
        if not NUM.match(x):
            return None, j
        vals.append(x); j += 1
    return (vals if len(vals) == n else None), j


HEADING = re.compile(r'^\d+(\.\d+)*\.$')


def read_table(lines, i):
    """Label block then value block, repeated: some pages split one row over two header rows."""
    row = {}
    while i < len(lines) and len(row) < 40:
        labels, j = [], i
        while j < len(lines) and not NUM.match(lines[j]) and not NOTE.match(lines[j]) and len(labels) < 30:
            labels.append(lines[j]); j += 1
        if not labels:
            break
        vals, k = values_after(lines, j, len(labels))
        if not vals:
            # Sub-header cells (e.g. WAR split into "스탯티즈 / 네이버") make the label block longer than
            # the values; the leading labels still line up with the leading values.
            got, k = [], j
            while k < len(lines) and len(got) < len(labels) and (NUM.match(lines[k]) or NOTE.match(lines[k])):
                if NUM.match(lines[k]):
                    got.append(lines[k])
                k += 1
            if len(got) < 4:
                break
            vals = got
        row.update(zip(['경기' if x == '경기수' else x for x in labels], vals)); i = k
        if '타율' in row and 'OPS' in row:
            break
    return row if '타율' in row and 'OPS' in row and NUM.match(row['타율']) and row['타율'] != '-' else None


def table_after(lines, start):
    """First stat table in the section that starts at lines[start] (stops at the next numbered heading)."""
    own = lines[start - 1] if start > 0 and HEADING.match(lines[start - 1]) else None
    for i in range(start + 1, min(len(lines), start + 400)):
        # Subsections ("4.1. 정규시즌") belong to this section; a sibling or parent heading ends it.
        if HEADING.match(lines[i]) and (own is None or lines[i].count('.') <= own.count('.')):
            return None
        if lines[i] in ('경기', '경기수') or (lines[i] == '타석' and lines[i - 1] not in ('경기', '경기수')):
            row = read_table(lines, i)
            if row:
                return row
    return None


SUMMARY_HEADINGS = ('페넌트 레이스 총평', '페넌트레이스 총평', '정규 시즌 총평', '정규시즌 총평', '시즌 후 총평', '시즌 총평', '총평')


def season_summary(page):
    """Season stat table under the regular-season summary heading (wording differs by page).
    Headings appear in the table of contents first; the section is the last occurrence."""
    lines = text_lines(page)
    for heading in SUMMARY_HEADINGS:
        idx = [i for i, x in enumerate(lines) if x == heading]
        if idx:
            row = table_after(lines, idx[-1])
            if row:
                return row
    # Otherwise a table titled like "2026 정규시즌 기록" / "2026 시즌 최종 기록", the last one on the page.
    title = re.compile(r'^2026\s?(정규\s?)?시즌 (최종 )?(기록|성적)$')
    for i in reversed([i for i, x in enumerate(lines) if title.match(x)]):
        row = read_table(lines, i + 1) if i + 1 < len(lines) and lines[i + 1] in ('경기', '경기수', '타석') else None
        if row:
            return row
    return None


MONTH_TABLE = re.compile(r'^(\d{1,2})월\s*(?:월간\s*)?(?:기록|성적)$')


def num(row, *keys):
    for k in keys:
        v = row.get(k)
        if v not in (None, '', '-') and NUM.match(v):
            return float(v)
    return 0.0


def monthly_sum(page):
    """Season line added up from the month tables ("3월 기록", "4월 월간 기록", ...) on 2026 season pages
    that have no season-total table. PA = AB + BB + HBP + SF (sacrifice bunts are not in these tables)."""
    lines = text_lines(page)
    seen, tot = set(), {}
    for i, x in enumerate(lines):
        m = MONTH_TABLE.match(x)
        if not m or not 3 <= int(m.group(1)) <= 10 or m.group(1) in seen:
            continue
        if i + 1 >= len(lines) or lines[i + 1] not in ('경기', '경기수', '타석', '타수'):
            continue
        row = read_table(lines, i + 1)
        if not row:
            continue
        seen.add(m.group(1))
        bb, k = walks_strikeouts(row)
        for key, val in (('G', num(row, '경기')), ('AB', num(row, '타수')), ('H', num(row, '안타')), ('2B', num(row, '2루타')),
                         ('3B', num(row, '3루타')), ('HR', num(row, '홈런')), ('BB', float(bb) if bb and NUM.match(bb) else 0.0),
                         ('HBP', num(row, '사구', '몸에 맞는 공')), ('SF', num(row, '희비', '희생플라이')), ('K', float(k) if k and NUM.match(k) else 0.0)):
            tot[key] = tot.get(key, 0.0) + val
    if not seen or tot.get('AB', 0) <= 0:
        return None
    ab, h = tot['AB'], tot['H']
    tb = h + tot['2B'] + 2 * tot['3B'] + 3 * tot['HR']
    pa = ab + tot['BB'] + tot['HBP'] + tot['SF']
    avg, obp, slg = h / ab, (h + tot['BB'] + tot['HBP']) / pa, tb / ab
    f = lambda v: f'{v:.3f}'
    return {'경기': str(int(tot['G'])), '타석': str(int(pa)), '타수': str(int(ab)), '안타': str(int(h)), '홈런': str(int(tot['HR'])),
            '볼넷': str(int(tot['BB'])), '사구': str(int(tot['HBP'])), '삼진': str(int(tot['K'])),
            '타율': f(avg), '출루율': f(obp), '장타율': f(slg), 'OPS': f(round(obp, 3) + round(slg, 3)), '_months': ','.join(sorted(seen, key=int))}


YEAR = re.compile(r'^(19|20)\d\d$')


def yearly_row(page):
    """2026 row of a '연도별 성적' (KBO by year) table. {} when the row says no first-team record."""
    lines = text_lines(page)
    found_table = False
    for s, x in enumerate(lines):
        if x != '연도' or s + 1 >= len(lines) or lines[s + 1] not in ('소속', '팀', '소속팀'):
            continue
        labels, k = [], s + 2
        while k < len(lines) and not YEAR.match(lines[k]) and len(labels) < 30:
            labels.append(lines[k]); k += 1
        if '타율' not in labels or 'OPS' not in labels:
            continue
        found_table = True
        for i in range(k, min(len(lines), k + 4000)):
            if lines[i] in ('KBO', '통산'):
                break
            if lines[i] != '2026':
                continue
            j, team_cell = i + 1, ''
            while j < len(lines) and not NUM.match(lines[j]) and not YEAR.match(lines[j]) and lines[j] not in ('KBO', '통산') and j < i + 4:
                if '기록 없음' in lines[j] or '군 복무' in lines[j]:
                    return {}
                team_cell += lines[j] + ' '
                j += 1
            if j >= len(lines) or YEAR.match(lines[j]) or lines[j] in ('KBO', '통산'):
                return {}
            vals, _ = values_after(lines, j, len(labels))
            if not vals:
                return None
            row = dict(zip(labels, vals))
            row['_team'] = team_cell.strip()  # empty when the team cell spans earlier rows
            return row
    # A by-year table without a 2026 row: the player had no first-team 2026 season (or the page is not updated).
    return 'no_row' if found_table else None


def mentions(page, words):
    return page and any(w in page for w in words)


def page_team_ok(page, words):
    """The page's summary ("KIA 타이거즈 소속 우투우타 포수 ...") names the player's current team.
    Pages whose summary has no "소속" fall back to any mention of the team."""
    m = re.search(r'og:description" content="([^"]*)"', page or '')
    if m and '소속' in m.group(1):
        return any(w in m.group(1) for w in words)
    if m and any(w in m.group(1) for w in words):
        return True
    # Some summaries open with a quote. Then the opening sentence decides ("키움 히어로즈 / 소속 외야수."),
    # else the infobox's 소속팀 list of career teams (current one last).
    lines = text_lines(page or '')
    for i, x in enumerate(lines[:900]):
        if i and (x == '소속' or x.startswith('소속 ')) and any(w in lines[i - 1] for w in words):
            return True
    for i, x in enumerate(lines[:600]):
        if x in ('소속팀', '소속 팀'):
            block = []
            for y in lines[i + 1:i + 16]:
                if y in ('소속사', '포지션', '투타', '연봉', '등번호', '학력', '신체'):
                    break
                block.append(y)
            return any(any(w in y for w in words) for y in block)
    return not m and mentions(page, words)


def short_names(words):
    """'LG 트윈스' -> 'lg', 'kt wiz' -> 'kt': how by-year tables name the team."""
    return {w.split()[0].lower() for w in words}


def same_team(row, words):
    t = row.get('_team', '').lower()
    return not t or any(a in t for a in short_names(words))


def has_record(row):
    """A real line: AVG present, and not an unfilled all-zero template (0 games)."""
    if not row or not NUM.match(row.get('타율', '-') or '-') or row.get('타율') == '-':
        return False
    games = row.get('경기')
    if games and NUM.match(games) and games != '-' and float(games) == 0:
        return False
    if not any(v not in ('0', '.000', '0.000', '-', '0.00') for k, v in row.items() if not k.startswith('_')):
        return False
    # Columns read out of line show up as AVG > OBP, AVG > SLG or OPS != OBP + SLG.
    try:
        avg, obp, slg, ops = (float(row[k]) for k in ('타율', '출루율', '장타율', 'OPS'))
    except (KeyError, ValueError):
        return False
    return obp >= avg - 1e-9 and slg >= avg - 1e-9 and abs(obp + slg - ops) <= 0.006


def candidates(name, team_words, cache_dir):
    """Page titles that may be this player, most likely first.

    Namesake pages list each person under a heading ("NC 다이노스 소속 야구 선수") with
    "자세한 내용은 <name>(1999) 문서를 참고하십시오." The title under this team's heading goes first,
    then "(야구선수)", then other "(year)" titles."""
    titles = [name]
    page = fetch(name, cache_dir)
    # Some names keep the namesake list on its own "(동명이인)" page; read both.
    extra = fetch(name + '(동명이인)', cache_dir) if page and '(동명이인)' in page else None
    for page in [p for p in (page, extra) if p]:
        # Hatnotes ("LG 트윈스 소속 야구선수에 대한 내용은 오스틴 딘 문서를...") and namesake lists.
        lines = text_lines(page)
        # "<name>(1999)", "오스틴 딘" or "빅터 레이예스" (foreign players' full names).
        pat = re.compile(r'^(?:[^\s()]{1,15} )?' + re.escape(name) + r'(?:\([^)]{1,20}\)| [^\s()]{1,15})?$')
        for i, x in enumerate(lines):
            if any(w in x for w in team_words):
                for y in lines[max(0, i - 3):i + 8]:
                    if pat.match(y) and y != name and y not in titles:
                        titles.insert(1, y)
                        break
        # Foreign players' full names listed on the page ("케스턴 히우라"); the team check filters them.
        for y in lines:
            if re.match(r'^[가-힣]{1,8} ' + re.escape(name) + '$', y) and y not in titles:
                titles.append(y)
    page = fetch(name, cache_dir)
    titles.append(name + '(야구선수)')
    for p in [x for x in (page, extra) if x and ('동명이인' in x or '다른 뜻' in x)]:
        # Any "<name>(…)" title on a namesake page: "(1999)", "(1999년 7월)", "(야구선수)" and so on.
        others = sorted(set(re.findall(re.escape(name) + r'\([^)<>"/]{1,20}\)', p)))
        titles += [t for t in others if t not in titles and t != name + '(동명이인)']
    return titles


def lookup(name, team_words, cache_dir):
    """First candidate page with a 2026 record wins; otherwise the first 'no record' finding."""
    fallback = None
    titles = candidates(name, team_words, cache_dir)
    for title in titles:  # grows while we read: pages may point to the real title
        main = fetch(title, cache_dir)
        if not main or not page_team_ok(main, team_words):
            continue
        # "2026년 활약상에 대한 내용은 윤도현(2003)/선수 경력/2026년 ..." points at the real page.
        for t in re.findall(re.escape(name) + r'\([^)<>/]{1,20}\)(?=/선수 경력)', main):
            if t not in titles:
                titles.append(t)
        season = fetch(title + '/선수 경력/2026년', cache_dir)
        result = None
        # The season page's opening names the player's team ("KIA 타이거즈 소속 내야수 김도영의 2026 시즌").
        if season and any(w in ' '.join(text_lines(season)[:400]) for w in team_words):
            row = season_summary(season)
            if has_record(row):
                return row, title + '/선수 경력/2026년', 'season_page'
            row = monthly_sum(season)
            if has_record(row):
                return row, title + '/선수 경력/2026년', 'season_monthly'
            # A 2026 season page means the player played in 2026, even when it has no stat table.
            result = (None, title + '/선수 경력/2026년', 'season_page_no_table')
        for page_title in (title, title + '/선수 경력'):
            page = main if page_title == title else fetch(page_title, cache_dir)
            row = yearly_row(page) if page else None
            if isinstance(row, dict) and row and not same_team(row, team_words):
                row = None  # a namesake on another team
            if isinstance(row, dict) and has_record(row):
                return row, page_title, 'yearly_table'
            if row == {} and not result:
                result = (None, page_title, 'no_first_team_2026')
            elif row == 'no_row' and not result:
                result = (None, page_title, 'no_2026_row')
        # 'Played, no table' beats 'no 2026 record', which beats 'nothing readable' (often a namesake list).
        rank = {'season_page_no_table': 3, 'no_first_team_2026': 2, 'no_2026_row': 2, 'not_found_on_page': 1}
        if result and (not fallback or rank[result[2]] > rank[fallback[2]]):
            fallback = result
        fallback = fallback or (None, title, 'not_found_on_page')
    return fallback or (None, None, 'page_not_found')


def walks_strikeouts(row):
    """(BB, K) as strings; some tables merge them into one '볼넷/삼진' cell like '58/158'."""
    if not row:
        return None, None
    if '볼넷/삼진' in row and '/' in row['볼넷/삼진']:
        bb, k = row['볼넷/삼진'].split('/', 1)
        return bb, k
    return row.get('볼넷') or row.get('4사구'), row.get('삼진')


def main():
    squads_path, out_path = sys.argv[1], sys.argv[2]
    cache_dir = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(out_path), 'namu-cache')
    os.makedirs(cache_dir, exist_ok=True)
    squads = json.load(open(squads_path, encoding='utf8'))
    out = json.load(open(out_path, encoding='utf8')) if os.path.exists(out_path) else {}
    for team_id, info in squads.items():
        team_words = info['words']
        for entry in info["players"]:
            name, number = entry[0], (entry[2] if len(entry) > 2 else None)
            key = f'{team_id}:{name}'
            if key in out:
                continue
            try:
                row, title, how = lookup(name, team_words, cache_dir)
            except Exception as e:  # keep going; the player stays unrecorded
                print('ERROR', key, e, flush=True)
                continue
            out[key] = {
                'team': team_id, 'name': name, 'number': number,
                'avg': row.get('타율') if row else None, 'ops': row.get('OPS') if row else None,
                'obp': row.get('출루율') if row else None, 'slg': row.get('장타율') if row else None,
                'games': row.get('경기') if row else None, 'pa': row.get('타석') if row else None,
                'ab': row.get('타수') if row else None,
                'bb': walks_strikeouts(row)[0], 'k': walks_strikeouts(row)[1], 'hbp': (row or {}).get('사구') or (row or {}).get('몸에 맞는 공'),
                'how': how, 'source': (BASE + title) if title else None,
            }
            print(key, how, out[key]['avg'], out[key]['ops'], flush=True)
            with open(out_path, 'w', encoding='utf8') as f:
                json.dump(out, f, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
