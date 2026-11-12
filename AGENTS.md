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
  - `app.js`(기본 화면·팀·로스터 적용), `enhancements.js`(라인업 투표·저장·집계, 경기 로그), `server-game.js`(경기 화면·투구판·결과), `server-voting.js`(서버 투표·일정·원정/홈 쪽 선택), `ai-game.js` + `ai-manager.js`(AI 대결), `local-game.js`(관리자 데모 경기), `admin-games.js`(경기 예약·중단·삭제), `feedback.js`(건의함), `vote-alert.js`(화면 고정 투표 창·투표 알림, 투표 카드 .vote-box.remote-vote 구조에 의존), `guide.js`(이용 안내·첫 방문 안내 창, 동작이 바뀌면 문구도 고칠 것), `account.js`(구글 로그인), `account-sync.js`(계정별 저장: 라인업·AI 경기), `squads.js`(선수단, 도구가 생성), `engine/pitch-engine.js`(투구 엔진)
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

- 엔진(`fanball-engine-2.12`): 투구마다 카운트별 Retrosheet 확률 × log5 타자·투수 보정 × 작전 배율로 결과를 뽑습니다. 결과 확률을 바꾸는 수정은 엔진 버전을 올리고 `docs/PITCH_ENGINE_DESIGN.md`에 적습니다. 진행 중인 서버 경기는 버전이 다르면 멈추니, 경기가 없을 때 배포합니다.
- 표시 전용 값(투구 위치·구종·타구 방향 문구 `playDetail`)은 난수 흐름을 쓰지 않습니다. 같은 시드면 경기 결과가 그대로여야 합니다.
- 진행 템포: 투구 2초, 타석 결과 3초, 다음 타자 소개 1초, 공수 교대 안내 2초, 투표 마감 후 1초.
- 같은 팀끼리 이벤트 매치: 원정 쪽 키는 `<팀>@away`입니다(`fanball_side_key`). 팬은 원정/홈 중 한쪽을 골라 참여합니다.
- 공식(실제 KBO 일정) 경기는 재실행·기록 변경·삭제 기능을 만들지 않습니다. 관리자 테스트 경기(provider `demo`)만 중단·삭제할 수 있습니다.
- 계정 저장(`public.user_state`): 키는 `saved_lineups`, `ai_match`, `ai_history`입니다. 본인 행만 읽고 쓸 수 있고, 로그인하지 않으면 브라우저에만 저장합니다.

## 나무위키 데이터 작업 (선수·투수 기록)

- 수집 캐시와 중간 결과는 `~/Library/Caches/fanball-namu/`에 있습니다(저장소 밖, 약 630MB). `cache/`에 받은 문서가 있어 다시 돌려도 새로 받지 않습니다.
  - 타자: `squads-namu.json`(명단), `stats-v14.json`(기록) → `python3 -I tools/build-squads-from-stats.py ~/Library/Caches/fanball-namu/squads-namu.json ~/Library/Caches/fanball-namu/stats-v14.json ~/Library/Caches/fanball-namu/cache`
  - 투수: `python3 -I tools/namu-pitcher-stats.py ~/Library/Caches/fanball-namu/pitchers-2026.json ~/Library/Caches/fanball-namu/cache` (끊겨도 이어서 수집) → `python3 -I tools/refresh-pitchers-from-cache.py <in> <out> <cache>`(파서 수정 반영, 네트워크 없음) → `python3 -I tools/build-bullpens.py <out> [팀,팀]`
- 불펜을 사람이 바꾸려면 `data/bullpen-overrides.json`에 `{"tigers": ["정해영", ...]}`처럼 적고 `build-bullpens.py`를 다시 돌립니다.

## 2026-11-12 마무리 작업

Claude가 시작한 로컬 변경을 Codex에서 이어 받아 마무리했다. 투수 교체 버튼 위치, 타석 정보, 내야안타 주자 진루, 엔진 2.12 피로와 수동 교체, 경기 종료 안내와 타자 기록표를 반영했다. 엔진 기록은 `docs/PITCH_ENGINE_DESIGN.md`, 관리자 패치 노트는 `dist/patch-notes.js`를 참고한다. `node --test tests/*.test.mjs` 전체 66개 통과. 배포 전 원격 DB에서 `running`·`scheduled` 경기는 조회되지 않았다.

후속 수정(2026-11-12, 배포 완료): AI 대결은 투구 속도와 무관하게 타석 결과를 3초간 유지한다(`dist/ai-game.js`). 원격 공식 경기 DB에서 진행 중인 경기는 보이지 않아, 첨부 화면은 브라우저 전용 AI 대결일 가능성이 높았다. 배포 커밋은 `fb56447`이다.

후속 수정(2026-11-12, 배포 완료): 투구판의 타자 기록은 안타/타수(예: `1/2`, 첫 타석 전 `0/0`)로 표시한다(`dist/server-game.js`). 배포 커밋은 `fb56447`이다.

후속 수정(2026-11-12, 배포 완료): 확률 분포의 인플레이 결과 중 번트 실제 결과가 초록색으로 표시되지 않던 문제를 수정했다. `dist/server-game.js`에서 타석 결과를 번트 분포 키에 대응한다.

## 아직 남은 일 (2026-11-12 기준)

자세한 제안은 `docs/PROPOSALS.md`(중계투수·주력·폭투)에 있습니다. 사용자와 정하기 전에는 구현하지 않습니다. 배포할 때마다 `dist/patch-notes.js`에 그날 날짜로 한 줄 요약을 추가합니다(관리자 화면에만 보임).

- 중계투수(엔진 2.8)와 10개 구단 불펜(팀당 5명)을 배포했습니다(2026-11-12). 삼성·KT는 사용자가 고른 목록(`data/bullpen-overrides.json`). 나무위키에 2026 기록 행이 아직 없는 투수(특히 롯데·NC·키움)는 2025 시즌 기록으로 대체했습니다(`season: 2025`). 사용자가 초안을 보고 바꿀 선수를 말하면 overrides에 넣고 다시 빌드합니다. 투수 수집 결과는 `~/Library/Caches/fanball-namu/pitchers-final2.json`.
- 구원투수 구종·구속은 팔 각도별 대표 구성(추정)입니다. 실제 값으로 바꾸려면 투수 문서 본문에서 읽어야 합니다.
- 폭투·포일: 엔진에 없습니다. 유인구 승부의 대가로 넣을지 사용자 결정을 기다리고 있습니다.
- 주력: 엔진 2.10에 반영(2026-11-12). 등급은 통산 도루÷(단타+볼넷)로 만든 초안(`data/runner-speed.json`)이고, 사용자가 고칠 선수는 `data/runner-speed-overrides.json`에 넣고 `python3 -I tools/build-runner-speed.py ~/Library/Caches/fanball-namu/career-batting.json`. 도루 작전(도루 성향 `player[14]` 사용)과 추가 진루 때 주루사는 아직 없습니다.
- 서호철·권희동·최정원 등 나무위키 2026 시즌 문서에 기록 표가 없는 선수는 리그 평균 임시값입니다.
