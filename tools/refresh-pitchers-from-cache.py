"""Re-reads every collected pitcher's 2026 line from the page cache with the current parser (no network),
e.g. after a parser fix. Usage: python3 -I tools/refresh-pitchers-from-cache.py <in.json> <out.json> <cache_dir>"""
import importlib.util, json, os, sys
_spec = importlib.util.spec_from_file_location('p', os.path.join(os.path.dirname(__file__), 'namu-pitcher-stats.py'))
p = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(p)
src, dst, cache = sys.argv[1:4]
d = json.load(open(src, encoding='utf8'))
changed = 0
for v in d.values():
    if not v.get('source') or v['how'] not in ('yearly_table', 'no_2026_record'):
        continue
    page = p.namu.fetch(v['source'].split('/w/', 1)[1], cache)
    r = p.pitching_row(page) if page else None
    new = {'games': p.num(r.get('경기') or r.get('경기수') or r.get('출장')), 'ip': p.innings(r.get('이닝')), 'saves': p.num(r.get('세') or r.get('세이브')),
           'holds': p.num(r.get('홀') or r.get('홀드')), 'era': p.num(r.get('ERA') or r.get('평균자책점')), 'h': p.num(r.get('피안타')),
           'hr': p.num(r.get('피홈런')), 'bb': p.num(r.get('볼넷') or r.get('4구')), 'hbp': p.num(r.get('사구')), 'k': p.num(r.get('탈삼진') or r.get('삼진')),
           'how': 'yearly_table'} if r else {'games': None, 'ip': None, 'saves': None, 'holds': None, 'era': None, 'h': None, 'hr': None, 'bb': None, 'hbp': None, 'k': None,
                                              'how': 'no_2026_record' if r == {} else v['how']}
    if any(v.get(k) != x for k, x in new.items()):
        v.update(new); changed += 1
json.dump(d, open(dst, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
print('changed', changed)
