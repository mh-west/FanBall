# FanBall — 작업 안내 (Codex·Claude 공용)

Claude Code와 OpenAI Codex가 번갈아 이어서 작업할 수 있도록 정리한 기준 문서입니다. Codex는 이 파일(`AGENTS.md`)을 자동으로 읽습니다. 작업을 시작하기 전에 이 파일과 `git log --oneline -20`, `docs/DECISIONS.md`를 먼저 보세요. `PROJECT_HANDOFF.md`는 초기 기록이라 일부 내용이 오래됐습니다. 이 파일과 다르면 이 파일을 따르세요.

## 사용자와 일하는 방식 (반드시 지킬 것)

- 사용자에게 보내는 결과·상태 보고는 **항상 한국어**로 씁니다.
- **배포(push)와 원격 DB 적용은 사용자가 요청할 때만** 합니다. "push해서 배포", "배포해", "적용하고 배포", "둘 다 배포"(= 사이트 push + 서버 함수 배포) 같은 말이 승인입니다. 한 번의 승인은 그 변경에만 해당합니다.
- **배포할 때마다 휴대폰(375×812)과 태블릿(768×1024) 폭에서 바뀐 화면을 확인**합니다. 가로 스크롤이 없는지, 글자와 버튼이 잘 보이는지, 콘솔 오류가 없는지 봅니다.
- 끝낸 일, 확인한 것, 못 한 것을 구분해서 보고합니다. 확인하지 않은 것을 됐다고 하지 않습니다.
- 운영 데이터 삭제처럼 되돌릴 수 없는 작업은 먼저 사용자에게 확인합니다.

## 데이터 출처 규칙

- 선수 기록은 **나무위키**에서만 읽습니다(robots.txt 허용, CC BY-NC-SA 2.0 KR). 값마다 출처 URL을 남기고, 요청 간격은 2.5초 이상 둡니다.
- **KBO 공식 사이트, 네이버, yagoonara.com은 수집하지 않습니다.** yagoonara는 robots.txt로 코딩 에이전트를 명시적으로 막습니다. 사용자가 스크린샷을 주면 그것은 쓸 수 있습니다.
- 볼카운트 기준값은 Retrosheet 데이터입니다. 화면에 출처 문구가 있으니 지우지 마세요.

## 구조

- `dist/` — 정적 사이트. `main`에 push하면 Cloudflare Workers가 자동 배포합니다(약 30~60초).
  - 주소: https://fanball.livevote.workers.dev/ (관리자 화면: `?admin=1`, 관리자 계정 필요)
  - `app.js`(기본 화면·팀·로스터 적용), `enhancements.js`(라인업 투표·저장·집계, 경기 로그), `server-game.js`(경기 화면·투구판·결과), `server-voting.js`(서버 투표·일정·원정/홈 쪽 선택), `ai-game.js` + `ai-manager.js`(AI 대결), `local-game.js`(관리자 데모 경기), `admin-games.js`(경기 예약·중단·삭제), `feedback.js`(건의함), `account.js`(구글 로그인), `account-sync.js`(계정별 저장: 라인업·AI 경기), `squads.js`(선수단, 도구가 생성), `engine/pitch-engine.js`(투구 엔진)
- `supabase/migrations/` — DB 스키마와 RPC. 원격 적용: `npx supabase@3.0.0 db query --remote --yes -f <file>`
- `supabase/functions/orchestrator-tick` — 서버 경기 진행(1초마다 pg_cron이 호출). 배포: `npx supabase@3.0.0 functions deploy orchestrator-tick --remote --yes`
- `supabase/functions/_shared/pitch-engine.js`는 `dist/engine/pitch-engine.js`와 **완전히 같아야** 합니다. 엔진을 고치면 `cp dist/engine/pitch-engine.js supabase/functions/_shared/pitch-engine.js`를 하고, 서버 함수도 다시 배포해야 서버 경기에 반영됩니다(테스트가 두 파일이 같은지 검사합니다).
- `tools/` — `namu-batting-stats.py`(나무위키 수집기, 캐시 사용), `build-squads-from-stats.py`(squads.js와 `data/namu-2026-batting.json` 생성), `browser-sandbox.mjs`(테스트에서 브라우저 코드 실행)
- `docs/` — 결정 기록(`DECISIONS.md`), 엔진 설계와 버전별 변경(`PITCH_ENGINE_DESIGN.md`), 데이터 출처(`DATA_SOURCES.md`) 등

## 확인 방법

- 테스트: `cd tests && npm install && node --test *.test.mjs` (PGlite로 모든 마이그레이션을 올려 서버 로직까지 검사합니다)
- 로컬 미리보기: `python3 -m http.server 8000 --bind 127.0.0.1 --directory dist` 후 http://localhost:8000
  - 로컬에서도 원격 Supabase를 씁니다(`dist/config.js`). 로그인·서버 경기는 배포 주소에서 확인하는 편이 정확합니다.
- 브라우저 캐시 때문에 바뀐 JS가 안 보이면 강력 새로고침하세요.

## 꼭 알아야 할 동작

- 엔진(`fanball-engine-2.7`): 투구마다 카운트별 Retrosheet 확률 × log5 타자·투수 보정 × 작전 배율로 결과를 뽑습니다. 결과 확률을 바꾸는 수정은 엔진 버전을 올리고 `docs/PITCH_ENGINE_DESIGN.md`에 적습니다. 진행 중인 서버 경기는 버전이 다르면 멈추니, 경기가 없을 때 배포합니다.
- 표시 전용 값(투구 위치·구종·타구 방향 문구 `playDetail`)은 난수 흐름을 쓰지 않습니다. 같은 시드면 경기 결과가 그대로여야 합니다.
- 진행 템포: 투구 2초, 타석 결과 3초, 다음 타자 소개 1초, 공수 교대 안내 2초, 투표 마감 후 1초.
- 같은 팀끼리 이벤트 매치: 원정 쪽 키는 `<팀>@away`입니다(`fanball_side_key`). 팬은 원정/홈 중 한쪽을 골라 참여합니다.
- 공식(실제 KBO 일정) 경기는 재실행·기록 변경·삭제 기능을 만들지 않습니다. 관리자 테스트 경기(provider `demo`)만 중단·삭제할 수 있습니다.
- 계정 저장(`public.user_state`): 키는 `saved_lineups`, `ai_match`, `ai_history`입니다. 본인 행만 읽고 쓸 수 있고, 로그인하지 않으면 브라우저에만 저장합니다.

## 아직 남은 일 (2026-11-12 기준)

자세한 제안은 `docs/PROPOSALS.md`(중계투수·주력·폭투)에 있습니다. 사용자와 정하기 전에는 구현하지 않습니다. 배포할 때마다 `dist/patch-notes.js`에 그날 날짜로 한 줄 요약을 추가합니다(관리자 화면에만 보임).

- 폭투·포일: 엔진에 없습니다. 유인구 승부의 대가로 넣을지 사용자 결정을 기다리고 있습니다.
- 주력: 기록만으로 판단하지 않기로 했습니다(예: 김도영은 리그 최상급 주력이지만 부상 관리로 잘 안 뜀). 등급 직접 지정이나 주력·도루 성향 분리안을 사용자와 정하는 중입니다.
- 중계투수: 지금은 선발 1명이 경기 끝까지 던집니다.
- 서호철·권희동·최정원 등 나무위키 2026 시즌 문서에 기록 표가 없는 선수는 리그 평균 임시값입니다.
