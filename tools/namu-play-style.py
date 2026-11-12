"""Collects the '플레이 스타일' text of each rotation and bullpen pitcher from Namu Wiki (main page section, or the
'<title>/플레이 스타일' sub-page it points to). Output: {team:name: {page, url, text}} for tools/build-repertoire.py.
Requests go through the shared fetcher (2.5 s apart, cached).

Usage: python3 -I tools/namu-play-style.py <data/pitcher-slots.json> <cache_dir> <out.json>
"""
import importlib.util, json, os, re, sys, urllib.parse

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('p', os.path.join(here, 'namu-pitcher-stats.py'))
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
HEAD = re.compile(r'^\d+(\.\d+)*\.$')


def section(lines, title='플레이 스타일'):
    """Body text of the first '플레이 스타일' heading that has a [편집] link (skips the table of contents)."""
    for i in range(len(lines) - 1):
        if lines[i].strip() == title and lines[i + 1].strip() == '[편집]':
            body = []
            for l in lines[i + 2:]:
                if HEAD.match(l.strip()):
                    break
                body.append(l)
            return body
    return None


slots, cache, out_path = json.load(open(sys.argv[1], encoding='utf8')), sys.argv[2], sys.argv[3]
out = json.load(open(out_path, encoding='utf8')) if os.path.exists(out_path) else {}
for key, v in slots.items():
    if key in out:
        continue
    title = v['page']
    page = p.namu.fetch(title, cache) if title else None
    if not page:
        out[key] = {'page': title, 'text': None}; continue
    body = section(p.namu.text_lines(page)) or []
    joined = ' '.join(body)
    sub = None
    m = re.search(r'자세한 내용은\s+(\S.*?/플레이 스타일)\s+문서', joined)
    if m:
        sub = m.group(1).strip()
        sp = p.namu.fetch(sub, cache)
        if sp:
            L = p.namu.text_lines(sp)
            # The whole sub-page body (from its first heading) is the play style.
            start = next((i for i, l in enumerate(L) if l.strip() == '[편집]'), 0)
            body = L[max(0, start - 1):]
    text = ' '.join(x.strip() for x in body if x.strip())
    out[key] = {'page': sub or title, 'url': 'https://namu.wiki/w/' + urllib.parse.quote(sub or title), 'text': text[:60000]}
    json.dump(out, open(out_path, 'w', encoding='utf8'), ensure_ascii=False)
    print(key, sub or title, len(text), flush=True)
json.dump(out, open(out_path, 'w', encoding='utf8'), ensure_ascii=False)
