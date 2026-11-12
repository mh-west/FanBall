"""Shared by tools/build-rotations.py and tools/build-bullpens.py: pitch repertoires and arm slots.

- data/pitcher-repertoire-namu.json: pitches, average speeds and shares read from each pitcher's Namu Wiki
  play-style page (2026-11-12). A speed the page does not give is estimated from the fastball (OFFSET below).
- data/pitcher-slots.json: arm slot over / three (three-quarter) / side / under, from the roster's 투타 token
  (우사, 우언) or the page's own wording; the repertoire file can override it (e.g. 좌완 스리쿼터).
"""
import json, os

OFFSET = {'포심': 0, '투심': -2, '싱커': -2, '커터': -6, '슬라이더': -12, '스위퍼': -16, '커브': -27, '너클커브': -22,
          '체인지업': -15, '포크': -13, '스플리터': -11}
FASTBALL = ('포심', '투심', '싱커')


def load(path):
    return json.load(open(path, encoding='utf8')) if os.path.exists(path) else {}


REP = load('data/pitcher-repertoire-namu.json').get('pitchers', {})
SLOTS = load('data/pitcher-slots.json')


def slot_for(key, fallback='over'):
    r = REP.get(key) or {}
    return r.get('slot') or (SLOTS.get(key) or {}).get('slot') or fallback


def mix_for(key):
    """{type: [[min, max], share]} from the Namu repertoire, or None. Average speed +-3 km/h."""
    r = REP.get(key)
    if not r:
        return None
    fast = next((s for t, s, _ in r['pitches'] if t in FASTBALL and s), None) or 145
    out = {}
    for t, speed, share in r['pitches']:
        avg = speed if speed else fast + OFFSET.get(t, -12)
        avg = round(avg)
        out[t] = [[avg - 3, avg + 3], share]
    return out


def mix_note(key):
    r = REP.get(key)
    if not r:
        return None
    est_speed = any(s is None for _, s, _ in r['pitches'])
    share = {'namu': '구사율 나무위키', 'part': '구사율 일부 나무위키·나머지 추정', 'est': '구사율 추정(문서 서술 기준)',
             'like': f"구사율은 비슷한 유형({r.get('like', '')}) 기준"}[r['share_src']]
    return f"나무위키 구종{' · 구속 일부 추정' if est_speed else ' · 평균 구속'} · {share}"
