"""Stamps a content hash on every script and stylesheet the site loads, so browsers can cache them for a year
and still pick up a new deploy at once (2026-11-12: workers.dev serves Korea from Los Angeles, 1-15 s per
file, and with caching off every visit fetched all 26 files again, which looked like endless loading).

- dist/index.html: src="/app.js" / href="/style.css" become "/app.js?v=<hash>" (an old ?v= is replaced).
- Module imports in dist/*.js (ai-game.js, ai-manager.js, local-game.js): './engine/pitch-engine.js' and
  './ai-manager.js' get ?v=<hash> too. The engine's own import of './count-tables.js' is left alone: the engine
  must stay identical to supabase/functions/_shared/pitch-engine.js, and count-tables.js is served no-cache.
- Hashes are of the file content after its own imports are stamped, repeated until nothing changes.

dist/_headers caches *.js and *.css for a year; index.html and count-tables.js are never cached.
Run before every commit that changes dist/: python3 -I tools/stamp-assets.py (a test checks it was run).
"""
import hashlib, os, re, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'dist')
MODULES = ['ai-manager.js', 'local-game.js', 'ai-game.js']  # files whose imports get stamped (leaves first)
IMPORT = re.compile(r"""(from\s+['"])(\./[A-Za-z0-9_./-]+\.js)(\?v=[0-9a-f]+)?(['"])""")
REF = re.compile(r"""((?:src|href)=")(/[A-Za-z0-9_./-]+\.(?:js|css))(\?v=[0-9a-f]+)?(")""")


def digest(rel):
    with open(os.path.join(ROOT, rel), 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()[:10]


def stamp_imports(rel):
    path = os.path.join(ROOT, rel)
    src = open(path, encoding='utf8').read()
    base = os.path.dirname(rel)
    def sub(m):
        target = os.path.normpath(os.path.join(base, m.group(2)))
        if target.endswith('count-tables.js'):
            return m.group(0)
        return f"{m.group(1)}{m.group(2)}?v={digest(target)}{m.group(4)}"
    out = IMPORT.sub(sub, src)
    if out != src:
        open(path, 'w', encoding='utf8').write(out)
    return out != src


def stamp_index():
    path = os.path.join(ROOT, 'index.html')
    src = open(path, encoding='utf8').read()
    out = REF.sub(lambda m: f"{m.group(1)}{m.group(2)}?v={digest(m.group(2).lstrip('/'))}{m.group(4)}", src)
    if out != src:
        open(path, 'w', encoding='utf8').write(out)
    return out != src


def main():
    for _ in range(6):
        changed = False
        for rel in MODULES:
            changed |= stamp_imports(rel)
        if not changed:
            break
    stamp_index()
    if '--check' in sys.argv:
        return
    print('stamped', ', '.join(m.group(2) + m.group(3) for m in REF.finditer(open(os.path.join(ROOT, 'index.html'), encoding='utf8').read()))[:400], '...')


if __name__ == '__main__':
    main()
