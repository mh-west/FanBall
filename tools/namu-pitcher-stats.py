"""Reads each team's pitchers and their 2026 KBO pitching line from Namu Wiki, to pick bullpens.

Where:
- Pitchers: the team's "<team>/선수단" page (entries marked "| P").
- 2026 line: the "연도별 성적" table on "<name>/선수 경력" (KBO table: 경기 승 패 세 홀 이닝 ERA 피안타 ...),
  falling back to the main page. Namesakes are resolved like the batting collector (tools/namu-batting-stats.py).
- Throwing hand from the infobox "투타" ("우투우타", "우언우타" = right-handed underhand);
  arm slot from the page text (사이드암 / 언더핸드 / 스리쿼터 mentions), else overhand.

Namu Wiki allows /w/ pages in robots.txt. Content is CC BY-NC-SA 2.0 KR: every value keeps its source URL.
Requests are spaced out and cached (same cache as the batting collector).

Usage: python3 -I tools/namu-pitcher-stats.py <out.json> <cache_dir>
"""
import importlib.util, json, os, re, sys

_spec = importlib.util.spec_from_file_location('namu', os.path.join(os.path.dirname(__file__), 'namu-batting-stats.py'))
namu = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(namu)

TEAMS = {'tigers': ('KIA 타이거즈', ['KIA 타이거즈', 'KIA']), 'samsung': ('삼성 라이온즈', ['삼성 라이온즈', '삼성']), 'lg': ('LG 트윈스', ['LG 트윈스', 'LG']),
         'doosan': ('두산 베어스', ['두산 베어스', '두산']), 'kt': ('KT 위즈', ['KT 위즈', 'kt wiz', 'KT']), 'ssg': ('SSG 랜더스', ['SSG 랜더스', 'SSG']),
         'lotte': ('롯데 자이언츠', ['롯데 자이언츠', '롯데']), 'hanwha': ('한화 이글스', ['한화 이글스', '한화']), 'nc': ('NC 다이노스', ['NC 다이노스', 'NC']),
         'kiwoom': ('키움 히어로즈', ['키움 히어로즈', '키움'])}
VAL = re.compile(r'^(-|\d+(\.\d+)?(⅓|⅔)?|⅓|⅔)$')


HANDS = re.compile(r'^([우좌])([투사언])([우좌양])타$')


def roster_pitchers(team_name, cache_dir):
    """[(name, hand_token or None)]. Two page layouts: a 투수 table (배번 이름 ... 투타 "우사우타") under the
    "투수" heading, or a grid of cards ("곽도규 / Kwak Do-gyu / | P")."""
    lines = namu.text_lines(namu.fetch(team_name + '/선수단', cache_dir) or '')
    out, seen = [], set()
    starts = [i for i, x in enumerate(lines) if x == '투수' and i + 2 < len(lines) and lines[i + 1] == '[편집]']
    for s in starts:
        name = None
        for k in range(s + 2, min(len(lines), s + 2500)):
            x = lines[k]
            if re.match(r'^\d+\.\d+\.$', x) and k > s + 3:  # next numbered heading ("2.2.")
                break
            if re.match(r'^[가-힣]{2,8}$', x) and k > 0 and re.match(r'^\d{1,3}$', lines[k - 1]):
                name = x
            elif HANDS.match(x) and name and name not in seen:
                out.append((name, x)); seen.add(name); name = None
    if out:
        return out
    for i, x in enumerate(lines):
        if x == '| P' and i >= 2 and re.match(r'^[가-힣]{2,8}$', lines[i - 2]) and lines[i - 2] not in seen:
            out.append((lines[i - 2], None)); seen.add(lines[i - 2])
    return out


def innings(v):
    if not v or v == '-':
        return None
    whole = re.match(r'^(\d+)', v)
    base = float(whole.group(1)) if whole else 0.0
    if '⅓' in v: base += 1 / 3
    if '⅔' in v: base += 2 / 3
    if re.match(r'^\d+\.\d$', v):  # "50.2" written as innings and outs
        base = int(v.split('.')[0]) + int(v.split('.')[1]) / 3
    return round(base, 3)


def pitching_row(page):
    """2026 row of a KBO 연도별 성적 pitching table, as {label: value}; None when absent."""
    lines = namu.text_lines(page)
    for s, x in enumerate(lines):
        if x != '연도' or s + 1 >= len(lines) or lines[s + 1] not in ('소속', '팀', '소속팀'):
            continue
        labels, k = [], s + 2
        while k < len(lines) and not re.match(r'^(19|20)\d\d$', lines[k]) and len(labels) < 30:
            labels.append(lines[k]); k += 1
        if '이닝' not in labels or not ({'ERA', '평균자책점'} & set(labels)):
            continue
        for i in range(k, min(len(lines), k + 6000)):
            if lines[i] in ('통산',):
                break
            if lines[i] != '2026':
                continue
            j = i + 1
            while j < len(lines) and not VAL.match(lines[j]) and j < i + 4:
                if '기록 없음' in lines[j] or '군 복무' in lines[j] or lines[j] in ('KBO', '통산'):
                    return {}  # an empty 2026 row is followed by the career totals: never read those
                j += 1
            vals = []
            while j < len(lines) and len(vals) < len(labels) and VAL.match(lines[j]):
                vals.append(lines[j]); j += 1
            if len(vals) < len(labels) - 4:
                return None
            return dict(zip(labels, vals))
    return None


def hand_and_slot(page):
    lines = namu.text_lines(page)
    hand, slot = None, 'over'
    for i, x in enumerate(lines[:1500]):
        if x == '투타' and i + 1 < len(lines):
            v = lines[i + 1]
            if v[:1] in ('우', '좌'):
                hand = 'R' if v[0] == '우' else 'L'
                if '언' in v[1:2]:
                    slot = 'under'
            break
    text = ' '.join(lines[:4000])
    if slot == 'over':
        if text.count('언더핸드') >= 2:
            slot = 'under'
        elif text.count('사이드암') >= 2:
            slot = 'side'
    return hand, slot


def lookup(name, words, cache_dir):
    for title in namu.candidates(name, words, cache_dir):
        main = namu.fetch(title, cache_dir)
        if not main or not namu.page_team_ok(main, words):
            continue
        hand, slot = hand_and_slot(main)
        for page_title in (title + '/선수 경력', title):
            page = main if page_title == title else namu.fetch(page_title, cache_dir)
            row = pitching_row(page) if page else None
            if row:
                return row, page_title, hand, slot
            if row == {}:
                return {}, page_title, hand, slot
        return None, title, hand, slot
    return None, None, None, None


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def main():
    out_path, cache_dir = sys.argv[1], sys.argv[2]
    out = json.load(open(out_path, encoding='utf8')) if os.path.exists(out_path) else {}
    for team_id, (team_name, words) in TEAMS.items():
        for name, token in roster_pitchers(team_name, cache_dir):
            key = f'{team_id}:{name}'
            if key in out:
                continue
            try:
                row, title, hand, slot = lookup(name, words, cache_dir)
            except Exception as e:
                print('ERROR', key, e, flush=True)
                continue
            m = HANDS.match(token or '')
            if m:  # the roster's 투타 is the most reliable: "우사우타" = right-handed sidearm, "좌언" = left underhand
                hand = 'R' if m.group(1) == '우' else 'L'
                slot = {'사': 'side', '언': 'under'}.get(m.group(2), slot if slot != 'over' else 'over')
            r = row or {}
            out[key] = {'team': team_id, 'name': name, 'throws': hand, 'slot': slot,
                        'games': num(r.get('경기') or r.get('경기수') or r.get('출장')), 'ip': innings(r.get('이닝')), 'saves': num(r.get('세') or r.get('세이브')),
                        'holds': num(r.get('홀') or r.get('홀드')), 'era': num(r.get('ERA') or r.get('평균자책점')), 'h': num(r.get('피안타')),
                        'hr': num(r.get('피홈런')), 'bb': num(r.get('볼넷') or r.get('4구')), 'hbp': num(r.get('사구')), 'k': num(r.get('탈삼진') or r.get('삼진')),
                        'how': 'yearly_table' if row else ('no_2026_record' if row == {} else 'not_found'),
                        'source': (namu.BASE + title) if title else None}
            print(key, out[key]['how'], hand, slot, out[key]['games'], out[key]['ip'], out[key]['saves'], out[key]['holds'], flush=True)
            with open(out_path, 'w', encoding='utf8') as f:
                json.dump(out, f, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
