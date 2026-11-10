# 공식 경기 오케스트레이터 설계

작성일: 2026-11-10
상태: **1단계(엔진 분리·동일성 테스트)·2단계(DB migration, 원격 적용) 완료, 3단계 이후 미구현.** 결정 사항은 맨 아래 "결정할 것"에 기록했다. 오케스트레이터와 실제 KBO 일정 공급원은 아직 연결되지 않았다.

## 목표

- 공식 팬볼 경기 하나를 **서버에서 정확히 한 번** 진행한다. 브라우저 탭을 닫거나 여러 명이 동시에 접속해도 결과는 하나다.
- 타석마다 필요한 경우 양 팀 작전 투표(공통 15초)를 열고, 확정된 두 작전을 다음 타석 계산에 넣는다.
- 모든 사용자(공격 팬·수비 팬·관전자)가 같은 타석 결과를 같은 순서로 본다.
- 결과를 다시 계산하거나 기록을 바꾸는 기능은 **만들지 않는다.** 시작된 경기는 끝까지 한 방향으로만 진행한다.

## 왜 "한 번에 한 걸음(tick)" 구조인가

| 제약 | 값 (Supabase 문서, 2026-11-10 확인) | 설계에 주는 영향 |
|---|---|---|
| Edge Function 실행 시간 | Free 150초 / Paid 400초 | 20분 경기를 함수 하나로 끝까지 돌릴 수 없다 |
| Edge Function CPU 시간 | 요청당 2초 (비동기 I/O 제외) | 한 번 호출에 타석 1개 정도만 계산한다 (100,000회 표본은 수십 ms 수준으로 예상, 구현 때 측정) |
| Edge Function 호출 수 | Free 월 500,000회 | 1초마다 무조건 호출하면 월 약 260만 회라 초과한다 |
| Supabase Cron | 초 단위 일정 가능, 동시 8개·10분 이하 권장 | 1초마다 가벼운 SQL 검사는 가능하다 |
| Free 프로젝트 | 1주일 비활동 시 일시 정지 | 실제 서비스는 Pro($25/월) 또는 주기적 활동이 필요하다 |

그래서 **경기 상태 전체를 DB에 저장**하고, 서버가 짧은 호출로 "지금 할 차례인 한 걸음"만 진행한다. 함수가 중간에 죽어도 다음 호출이 DB 상태에서 이어받는다.

## 전체 흐름

```
pg_cron (1초마다)
  └─ SQL 함수 orchestrator_due_games()   ← 매우 가벼움, 호출 수 제한 없음
        할 차례(next_action_at <= now)인 경기가 있을 때만
        └─ pg_net으로 Edge Function `orchestrator-tick` 호출 (Secret key는 Vault에서 읽음)
              ├─ 경기 상태 읽기
              ├─ 한 걸음 계산 (타석 1개 / 라운드 열기 / 라운드 마감)
              └─ RPC commit_orchestrator_step(...) 로 원자적 저장 (버전 비교)
```

- 호출 수는 "실제 할 일이 있을 때"만 생긴다. 경기당 약 96타석 + 투표 약 35회 × (열기·마감) ≈ 170회, 하루 5경기 × 30일 ≈ **월 2.5만 회**.
- 기존 `open-tactical-round`의 `waitUntil` 15초 대기 마감은 tick이 대신한다. 대기 마감이 실패하면 라운드가 `open`으로 남는 현재의 약점도 해결된다(다음 tick이 다시 마감).

## 경기 상태 머신

`fanball_games.status`: `scheduled → running → final` (`cancelled`는 시작 전에만)

`running` 경기의 다음 할 일 `next_action` (DB에 저장):

| next_action | 실행 시각 | 하는 일 | 다음 상태 |
|---|---|---|---|
| `play_pa` | 이전 타석 연출이 끝난 뒤 | 확정 작전(없으면 기본)으로 타석 1개 계산·저장 | 경기 종료면 `final`, 투표 상황이면 `open_round`, 아니면 `play_pa` |
| `open_round` | 방금 타석 연출이 끝난 뒤 | 상황별 선택지로 라운드 개설(공통 15초) | `resolve_round` (`closes_at`에) |
| `resolve_round` | 라운드 `closes_at` | 기존 `resolve_tactical_round` 호출, 확정 작전을 상태에 기록 | `play_pa` (즉시) |

- **연출 시간을 서버가 정한다.** 타석을 계산하면 투구 수 × 2초 + 결과 2초 뒤를 `next_action_at`으로 잡는다. 브라우저는 저장된 투구 목록을 그 시간 동안 보여 준다. 그래서 모든 사용자가 같은 장면을 같은 시각에 본다.
- 투표는 지금 데모와 같이 **타석 연출이 끝난 뒤** 열리고, 확정 작전은 **다음 타석**에 적용된다.
- 밀린 경우(서버 장애 등) 다음 시각은 "원래 예정 + 간격"이 아니라 "지금 + 간격"으로 잡는다. 한꺼번에 여러 타석이 몰려 나오지 않는다.

## 중복 실행 방지 (정확히 한 번)

1. **경기 시작:** `update fanball_games set status='running' ... where status='scheduled' and 시작시각<=now()` — 조건부 갱신 한 줄이라 두 호출이 동시에 와도 하나만 성공한다.
2. **한 걸음 저장:** 비공개 테이블의 `state_version`을 둔다. Edge Function은 읽은 버전을 함께 보내고, `commit_orchestrator_step`은 버전이 같을 때만 저장하고 +1 한다. 다르면 아무것도 하지 않는다(다른 호출이 먼저 진행함).
3. **타석:** 기존 `plate_appearances (game_id, pa_no)` 기본키가 마지막 안전장치다.
4. **라운드:** 기존 `tactical_rounds (game_id, pa_no)` 고유 제약과 `resolve_tactical_round`의 재실행 안전성을 그대로 쓴다.
5. **기록 불변:** `plate_appearances`, `tactical_resolutions`는 UPDATE/DELETE 권한을 주지 않고, 트리거로 수정도 막는다. 재실행·정정 기능은 두지 않는다.

## 난수와 공정성 (중요)

경기 엔진 코드는 브라우저에 공개되어 있다. 만약 시드가 미리 공개되면, 누군가 "번트를 고르면 무슨 결과가 나오는지" 미리 계산해 투표를 조작할 수 있다. 그런데 지금 `fanball_games.seed`는 누구나 읽을 수 있는 테이블에 있다.

- 시드는 경기 시작 때 서버가 무작위로 만들고, **비공개 테이블**(`fanball_game_private`, anon/authenticated 권한 없음)에 둔다.
- 시작 시 시드의 SHA-256 해시만 공개하고, **경기 종료 뒤 시드를 공개**한다. 이렇게 하면 누구나 "결과를 바꾸지 않았다"는 것을 사후에 확인할 수 있다.
- 타석별 난수는 지금처럼 `시드 + 타석 번호`에서 만든다. 작전이 바뀌면 확률이 바뀌므로 결과도 달라질 수 있다(의도된 동작).

## 엔진을 서버로 옮기는 방법

- 지금 실제로 쓰이는 엔진은 `dist/enhancements.js`의 `playPA`, `plateOutcomeProbabilities`, `shouldOfferStrategy`, `makeStrategyBallot`, `pitchSequence`와 `dist/app.js`의 `rng`, `hash`, 진행 규칙(`advanceMatch`)이다. 화면 코드(`db`, `render`, `localStorage`)와 섞여 있다.
- 이것을 화면과 무관한 **순수 함수 모듈** `supabase/functions/_shared/fanball-engine.js`로 분리한다. 입력은 (경기 상태, 양 팀 명단·라인업 스냅샷, 시드, 작전 2개), 출력은 (타석 결과, 다음 상태, 투구 목록, 투표 필요 여부·선택지)다.
- 브라우저도 같은 파일을 쓰도록 `dist/fanball-engine.js`로 복사해 둔다(Cloudflare는 빌드 단계 없이 `dist/`만 배포하므로). 두 파일이 같은지 테스트로 확인한다.
- **동일성 테스트:** 같은 시드·라인업·작전으로 기존 브라우저 엔진과 새 모듈이 경기 전체에서 같은 타석 결과를 내는지 비교한다. 분리 과정에서 규칙이 바뀌지 않았음을 보장하기 위해서다.
- 경기 규칙(9회, 홈 리드 시 9회 말 생략, 끝내기, 12회 종료 무승부)은 `docs/GAME_RULES.md` 그대로다.

## 명단·라인업과 데이터 공급원

- 서버 경기 시작 시 양 팀 명단·라인업·선발투수를 **스냅샷으로 고정 저장**한다(`fanball_games`의 새 열 `lineup_snapshot`). 경기 중에 바뀌지 않는다.
- 공급원은 교체 가능한 인터페이스로 둔다: `getSchedule(date)`, `getLineups(gameId)`.
  - 지금은 **데모 공급원**만 있다: 샘플 명단(`dist/app.js`의 `TEAMS`)과 기본 타순. `provider='demo'`로 표시하고 실제 KBO 일정처럼 보이지 않게 한다.
  - 실제 KBO 공급원은 사용 허가 확인 뒤 같은 인터페이스로 붙인다. 이번 범위가 아니다.
- 팬 대표 라인업 투표는 아직 없다. 생기면 스냅샷을 만들 때 그 결과를 쓰면 된다.

## DB 변경 (새 migration, 기존 migration은 수정하지 않음)

구현: `supabase/migrations/202611100001_orchestrator_state.sql` (2단계).

- **비공개 테이블 `fanball_game_private`** (서버 전용, anon/authenticated 권한 없음): `seed`, `engine_state`(이닝·아웃·주자·타순·점수 등 엔진 상태 전체), `next_action`(`play_pa`/`open_round`/`resolve_round`/`finish`), `next_action_at`, `current_round_id`, `state_version`.
  - 초안에서는 엔진 상태를 공개 `fanball_games`에 두려 했으나, 그러면 타석을 계산하는 순간 점수·주자가 공개되어 `reveal_at`이 의미가 없어진다. 그래서 시드와 함께 비공개로 옮겼다.
  - 경기 종료도 `finish` 단계로 마지막 타석 연출이 끝난 뒤에 공개한다.
- **공개 `fanball_games`에 열 추가:** `lineup_snapshot`, `seed_hash`, `revealed_seed`. `score`는 이미 공개된 타석까지의 점수만 담는다. 쓰지 않던 공개 `seed` 열은 삭제했다.
- **`plate_appearances.reveal_at`:** RLS가 `reveal_at <= now()`인 타석만 공개한다.
- **기록 불변 트리거:** `plate_appearances`, `tactical_resolutions`는 직접 UPDATE/DELETE가 거부된다(DB 소유자도). 경기 전체 삭제 시 연쇄 삭제만 허용한다(테스트 정리용).
- **경기 상태 역행 금지 트리거:** `scheduled → running/cancelled`, `running → final`만 허용한다. 시작 후 라인업·시드 해시 변경, 공개된 시드 변경도 거부한다.
- **RPC (service_role 전용):** `start_due_fanball_games()`, `due_fanball_games()`, `commit_orchestrator_step(...)`.
- **로컬 검증:** `tests/migrations.test.mjs` (PGlite로 Supabase 역할·기본 권한을 흉내 내고 migration 3개 적용, 10개 시나리오). 권한 차단·버전 검사·`reveal_at`·불변 트리거를 일부러 지우면 각각 실패하는 것도 확인했다.
- 확장: `pg_cron`, `pg_net`. Cron이 Edge Function을 부를 때 쓰는 Secret key는 **Supabase Vault**에 사용자가 직접 넣는다. migration·코드·GitHub에는 넣지 않는다.

## 화면 변경

- 서버 경기가 있으면 홈 카드와 경기 센터가 **서버 상태를 Realtime으로 구독**해 보여 준다(점수, 이닝, 투구 연출, 타석 로그, 투표).
- 투구 연출은 서버가 저장한 투구 목록과 시각을 기준으로 재생한다. 늦게 들어온 사용자는 현재 장면부터 본다.
- 로컬 데모 경기(`localStorage`)와 `?admin=1` 개발 실행은 그대로 둔다. 서버 경기와 섞이지 않게 표시를 구분한다.

## 구현 단계 (각 단계 끝에 확인을 받는다)

1. **엔진 분리 + 동일성 테스트** — 화면 변화 없음. 로컬에서만 검증.
2. **DB migration** — 로컬 PGlite 시나리오(시작 1회, 버전 충돌, 기록 불변, 시드 비공개) → dry-run 결과를 보여 드린 뒤 원격 적용.
3. **`orchestrator-tick` Edge Function + Cron** — 데모 테스트 경기로 원격에서 한 경기를 끝까지 진행해 확인. 이 단계에서 Vault에 Secret key를 넣는 작업이 필요하다(사용자 작업).
4. **화면 연결** — 서버 경기 관전·투표·결과 화면.
5. **문서** — CHANGELOG, HANDOFF, ROADMAP, AUTH_SETUP 갱신.

실제 KBO 일정 공급원, 팬 대표 라인업 투표, 랭킹은 이 범위 밖이다.

## 결정할 것

**2026-11-10 사용자 결정: 아래 다섯 항목 모두 제안대로 진행한다.** (1: 20분을 넘어도 끝까지 진행, 2: 시드 비공개 후 종료 시 공개, 3: `reveal_at` 추가, 4: 샘플 기본 타순 고정, 5: 개발 중 Free 유지)

1. **경기 시간 20분 초과:** 지금 연출 속도(투구 간 2초)로는 경기당 약 17~25분이 걸려 18:00–18:20 창을 넘을 수 있다.
   - (가) 그대로 두고 넘어가도 끝까지 진행 — **제안**
   - (나) 투구 간격을 줄임(예: 1.5초)
   - (다) 투표 횟수를 줄임
2. **시드 비공개 + 종료 후 공개(커밋-공개):** 제안대로 진행할지.
3. **연출 중 결과 숨김(`reveal_at`):** 추가할지. API를 직접 보는 사람만 몇 초 먼저 알 수 있는 정도라 영향은 작다 — **제안: 추가(작은 비용)**.
4. **라인업:** 대표 라인업 투표가 생기기 전까지 샘플 기본 타순을 고정해 쓰는 것으로 할지 — **제안: 예**.
5. **운영 비용:** Free는 1주 비활동 시 정지된다. 개발 중에는 Free로 충분하고, 실제 매일 운영 시작 시 Pro 전환을 검토.
