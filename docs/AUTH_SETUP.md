# FanBall 계정·프로필 설정

## 무료 구성 권장안

현재 FanBall 코드에는 Supabase Auth 연결 지점이 있으므로, **Supabase Free + Google OAuth**를 첫 무료 인증 경로로 권한다. Supabase Free는 현재 $0 플랜이며 OAuth 로그인과 월간 활성 사용자 무료 한도를 제공한다. 다만 무료 프로젝트는 일정 기간 비활성 시 일시 중지될 수 있고, 서비스 한도와 조건은 변경될 수 있으므로 설정 전에 공식 요금 페이지를 확인한다.

**Apple 로그인을 계속 무료로 제공하는 경로는 확인되지 않았다.** 웹 Sign in with Apple 설정에는 Apple Developer Program 멤버십이 필요하며 연회비가 발생한다. 따라서 무료 우선 MVP에서는 Apple 버튼을 로그인 가능하다고 표시하지 말고, Google 로그인만 설정하거나 Apple 항목을 비활성/숨김 처리한다.

- Supabase 가격/플랜: https://supabase.com/pricing
- Supabase 무료 플랜 안내: https://supabase.com/docs/guides/platform/billing-on-supabase
- Supabase Google 로그인: https://supabase.com/docs/guides/auth/social-login/auth-google
- Google OAuth 웹 클라이언트 설정: https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid
- Apple Developer Program 비용: https://developer.apple.com/programs/whats-included/
- Apple 웹 Sign in with Apple 설정: https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web/

Supabase 대신 Firebase Spark도 무료 대안이지만, 현재 Supabase 연결 코드를 Firebase Auth로 바꾸고 데이터/보안 규칙도 다시 구성해야 하므로 기존 MVP에는 변경 비용이 더 크다. Firebase 공식 요금: https://firebase.google.com/pricing

## Supabase Free + Google 설정 순서

1. Supabase에서 Free 프로젝트를 만든다.
2. Google Cloud Console에서 프로젝트와 OAuth 웹 클라이언트를 만든다. 승인된 리디렉션 URI에 Supabase가 안내하는 callback 주소 `https://<project-ref>.supabase.co/auth/v1/callback`를 등록한다.
3. Supabase Dashboard → Authentication → Providers에서 Google을 활성화하고 Google Client ID/Secret을 입력한다. OAuth 클라이언트 시크릿은 Supabase 대시보드 안에만 둔다.
4. Supabase Authentication URL Configuration에서 Site URL을 실제 FanBall 주소로 설정하고, 정확한 배포 및 로컬 개발 redirect URL을 허용 목록에 추가한다.
5. FanBall의 공개 클라이언트 설정에 Supabase 프로젝트 URL과 Publishable key(`sb_publishable_...`)를 입력한다. 설정 지점은 `dist/config.js`의 `window.FANBALL_AUTH_CONFIG`이며 필드 이름은 호환을 위해 `supabaseAnonKey`를 유지한다. 브라우저에 공개되는 키에는 RLS가 필수다.
6. 배포 후 Google 로그인, 동의 화면, 콜백 복귀와 로그아웃을 확인한다.

## 비밀 키와 데이터 보안

- Google Client Secret, Apple private key, Supabase Secret key(`sb_secret_...`)와 legacy service_role key, DB 비밀번호는 브라우저 코드·정적 파일·GitHub·채팅에 넣지 않는다.
- Supabase anon/publishable key는 공개 클라이언트 키지만, 사용자 데이터 테이블에 RLS를 적용하기 전에는 민감한 데이터를 저장하지 않는다.
- 로그인만 연결해도 라인업·투표가 서버에 자동 저장되지는 않는다. 계정 프로필·라인업·투표 테이블, RLS 정책, 중복 제출 제한 및 서버 측 검증이 별도로 필요하다.
- OAuth provider 설정과 DB 영구 저장은 별도 작업이다. 지금의 FanBall은 자격 증명이 설정되지 않아 계정 연결 전에는 닉네임과 응원팀을 현재 브라우저에 저장한다.
- 테스트 초기화는 경기/샘플 참여 데이터를 지우며 현재 브라우저의 닉네임과 응원팀은 보존한다.

## 현재 구현 상태 (2026-11-09)

- Supabase Free 프로젝트 `FanBall`이 생성되었다. ref는 `hexkrbwgspfturopkebv`, 지역은 ap-southeast-1(Singapore)이다.
- `dist/config.js`에 프로젝트 URL과 Publishable key를 넣었다.
- migration 2개를 원격에 적용했다(`migration list --remote`에서 로컬·원격 일치 확인). Publishable key로 호출해 다음을 확인했다.
  - 공개 테이블 조회: 200
  - `profiles` 조회, 테이블 쓰기, 라운드 개설·마감 RPC, `sync_my_profile`(비로그인): 모두 401 `permission denied`
- Edge Function 2개를 배포했다(ACTIVE, `verify_jwt=false`). 키 없는 호출과 Publishable key 호출이 401로 거부되는 것을 확인했다. Secret key로 성공하는 경로는 아직 원격에서 확인하지 않았다.
- Google provider를 설정했다. Google Cloud OAuth는 테스트 모드이며, 복귀 주소는 배포 주소와 `http://localhost:8000` 두 곳이 등록되어 있다(아래 "배포 주소" 참조).
- `http://localhost:8000`에서 Google 로그인과 프로필 저장을 확인했다. `profiles`에 Google 사용자 행이 생기고, 응원팀이 user metadata와 일치했다. 경기 참가 행은 테스트 경기가 없어 0건이다.
- 양 팀 동시 투표를 수동으로 확인했다(테스트 경기 `manual-vote-test`, `provider='demo'`, 2계정: 두산 공격·KIA 수비).
  - Secret key로 `open-tactical-round`를 호출해 라운드가 열렸다. 원격 Secret key 성공 경로를 확인했다.
  - 서버 기준 15.000초 창이 열렸고, 두 계정 모두 같은 라운드에 역할별로 투표했다(공격 `normal`, 수비 `double_play`).
  - Edge Function의 대기 마감이 마감 0.17초 뒤 라운드를 `resolved`로 확정했다. 득표대로 적용되었고 기본 작전 대체는 없었다.
  - 경기 참가 스냅샷은 각 계정의 응원팀으로 1건씩 생성되었다.
  - 2번 타석에서 다음을 확인했다.
    - 마감 전 재투표: 수비 표 1건이 5초 뒤 `double_play`로 수정되었고, 표 행은 계정당 1건으로 유지되었다.
    - 공격 무표: 기본 작전 `normal`로 확정되었고 `fallback_roles=["offense"]`가 기록되었다.
  - 원격에서 확인하지 않은 것: 관전자(제3팀·로그아웃) 화면과 동률. 이 두 가지는 로컬 PGlite 시나리오로만 검증했다.
  - 확인 뒤 정리 SQL로 테스트 경기와 연결 행을 삭제했다. 경기·라운드·표·참가 행은 0건이고 사용자 프로필은 유지된다.
- 연결 전 프런트에 Apple 로그인 버튼은 표시하지 않는다.

## FanBall 서버 작전 투표 연결 절차 (Supabase CLI 3.x)

서버 투표용 SQL migration, 계정별 응원팀 프로필 RPC, 역할 검증 투표 RPC, 서버 전용 라운드 개설/마감 Edge Function 코드가 `supabase/`에 있다. 프런트에서는 `dist/server-voting.js`가 로그인 사용자와 활성 라운드를 읽고 역할별 UI를 표시한다.

CLI 3.x에서는 `db push`의 기본 대상이 로컬 DB다. 원격에는 반드시 `--remote`를 붙인다. `db reset --remote`처럼 원격 데이터를 지우는 명령은 쓰지 않는다.

1. CLI를 설치하고 로그인한 뒤 `supabase --version`이 3.x인지 확인한다.
   - 설치: `brew install supabase/tap/supabase`
   - Homebrew를 쓸 수 없으면 `npx --yes supabase@3.0.0 <명령>`으로 실행한다. 2026-11-09 작업은 Xcode Command Line Tools가 오래돼 npx로 진행했다.
   - 로그인: `supabase login`
2. 저장소 루트에서 `supabase link hexkrbwgspfturopkebv`를 실행한다. DB 비밀번호를 물으면 터미널에 직접 입력한다. `supabase/.temp/`는 `.gitignore`에 포함되어 있다.
3. `supabase db push --dry-run --remote`로 적용될 migration 목록을 먼저 확인한다. 예상 목록은 `202611060001_server_tactical_voting.sql`과 `202611060002_lock_down_rpc_and_table_privileges.sql`이다. 확인 뒤 `supabase db push --remote`로 적용한다.
4. `supabase functions deploy open-tactical-round resolve-tactical-round --use-api`로 함수를 배포한다. Docker가 없으면 `--use-api`가 필요하다. `supabase/config.toml`에서 두 함수는 `verify_jwt = false`로 설정되어 있다.
5. Google OAuth provider를 설정한다. 위 "Supabase Free + Google 설정 순서"를 따르고, 로컬 테스트 값은 아래와 같다.
   - Google 승인된 JavaScript 원본: `http://localhost:8000`
   - Google 승인된 리디렉션 URI: `https://hexkrbwgspfturopkebv.supabase.co/auth/v1/callback`
   - Supabase Site URL: `http://localhost:8000`
   - Supabase Redirect URLs: `http://localhost:8000/**`
   - 배포 주소를 정하면 해당 주소를 별도로 추가한다.
6. 로그인과 프로필 저장을 확인한다. 아래 "단계별 확인"을 따른다.

`supabase/config.toml`은 로컬 개발 기본값이 섞인 파일이다. `supabase config push`를 실행하면 원격 Auth 설정(Site URL 등)이 로컬 기본값으로 바뀔 수 있으므로, Auth 설정은 대시보드에서 관리한다.

### 배포 주소 (Cloudflare Workers)

- 정적 사이트는 Cloudflare Workers(정적 자산)로 배포한다. 주소는 `https://fanball.livevote.workers.dev`다.
- GitHub `main` push 시 자동 빌드된다. 빌드 설정은 Cloudflare 대시보드에만 있으며, 저장소에는 `dist/`만 공개된다(`README.md`·`docs/`·`supabase/`는 404).
- 2026-11-09에 이 주소에서 Google 로그인과 복귀를 확인했다. 복귀 주소 끝에 남는 `#`은 supabase-js가 토큰 조각을 지운 흔적이라 정상이다.
- 등록된 값:
  - Supabase Site URL: `https://fanball.livevote.workers.dev`
  - Supabase Redirect URLs: `https://fanball.livevote.workers.dev/**`, `http://localhost:8000/**`
  - Google 승인된 JavaScript 원본: 위 두 주소의 origin
- workers.dev 계정 서브도메인을 바꾸면 이전 주소는 바로 사라진다. 새 주소의 HTTPS 인증서 발급에는 몇 분이 걸린다.

### 실제 도메인(예: `.kr`)으로 옮길 때 바꿀 곳

1. Cloudflare Worker → Domains → Add custom domain으로 도메인을 연결한다. 도메인 DNS는 Cloudflare에서 관리한다.
2. Supabase Authentication → URL Configuration
   - Site URL을 새 도메인으로 바꾼다.
   - Redirect URLs에 `https://<새 도메인>/**`를 추가한다.
3. Google OAuth 클라이언트
   - 승인된 JavaScript 원본에 `https://<새 도메인>`을 추가한다.
   - 공개 서비스 전에 동의 화면을 프로덕션으로 게시하고, 홈페이지·개인정보처리방침 주소를 등록한다. Google 검토가 필요할 수 있다.
4. (선택, 유료) Supabase 커스텀 도메인을 쓰면 `dist/config.js`의 `supabaseUrl`과 Google 리디렉션 URI도 바꾼다. 이 경우를 빼면 코드 변경은 없다. 로그인 복귀 주소는 현재 페이지 주소를 쓴다.
5. `README.md`의 MVP 링크와 이 문서의 주소 값을 갱신한다.

### Edge Function 인증

- `open-tactical-round`와 `resolve-tactical-round`는 `@supabase/server`의 `withSupabase({ auth: "secret" })`로 보호한다.
- 호출자는 기본(`default`) Secret key를 `apikey` 헤더로 보낸다.
- 예전 방식인 `Authorization: Bearer <service_role>` 비교와 브라우저 CORS 허용은 제거했다.
- 플랫폼의 JWT 검사는 Secret key 호출을 인증하지 않으므로 `verify_jwt = false`로 두고 함수 안에서 검증한다.
- Secret key는 Supabase 대시보드 → Settings → API Keys에서 확인한다.

### 권한 보정 migration

- 기존 migration의 `revoke ... from public`은 Supabase가 기본으로 주는 anon/authenticated 직접 권한을 지우지 못한다.
- 그대로 두면 브라우저 역할이 `open_tactical_round`·`resolve_tactical_round`를 호출할 수 있었다.
- `202611060002_lock_down_rpc_and_table_privileges.sql`이 다음을 보정한다.
  - 라운드 개설·마감 RPC는 service_role만 실행한다.
  - 사용자 RPC는 authenticated만 실행한다.
  - 테이블은 SELECT 외 권한(truncate/references/trigger 포함)을 회수한다.
- 2026-11-09 로컬 PGlite 검증 결과:
  - 기본 권한 자동 부여 여부와 관계없이 17개 시나리오가 모두 통과했다.
  - 시나리오에는 역할 제한, 재투표, 마감 후 거절, 동률·무표 기본 작전, 재실행 멱등성, 브라우저 역할 차단이 포함된다.
  - 실제 Supabase DB 검증은 아니다.

### 단계별 확인

1. **로그인:** `python3 -m http.server 8000 --directory dist`로 띄운 뒤 `http://localhost:8000`에서 프로필 → Google로 계속하기를 누른다. 콜백 후 계정 이메일이 표시되고, 로그아웃이 되는지 확인한다.
2. **프로필 저장:** 닉네임과 응원팀을 저장한 뒤 Supabase Table Editor에서 `profiles` 행이 생기고, 응원팀 변경이 반영되는지 확인한다. 응원팀을 저장하기 전에는 경기 참가(`fanball_game_memberships`)가 만들어지지 않는다.
3. **양 팀 동시 작전 투표:** 공식 경기 오케스트레이터가 없으므로 수동 테스트로 확인한다. 테스트 행은 `provider='demo'`라 홈에 테스트 일정으로 표시되며, 실제 KBO 일정이나 공식 경기로 취급하지 않는다.
   - 계정 3개를 준비한다: 두산 응원(공격), KIA 응원(수비), 다른 팀 응원(관전).
   - SQL Editor에서 테스트 경기를 만든다.

     ```sql
     insert into public.kbo_games(id,game_date,scheduled_at,away_team_id,home_team_id,status,provider)
     values('manual-vote-test',(now() at time zone 'Asia/Seoul')::date,now(),'doosan','tigers','scheduled','demo')
     on conflict(id) do update set game_date=excluded.game_date,scheduled_at=excluded.scheduled_at;
     insert into public.fanball_games(kbo_game_id,status) values('manual-vote-test','running')
     on conflict(kbo_game_id) do nothing;
     select id from public.fanball_games where kbo_game_id='manual-vote-test';
     ```

   - 세 계정 모두 홈에서 테스트 경기 카드를 고르고, 관리자 모드가 아닌 일반 경기 센터 화면을 연다.
   - 터미널에서 라운드를 연다. Secret key는 화면에 보이지 않게 입력하고, `<game id>`는 위 SQL 결과로 바꾼다. 15초 창이 열린다.

     ```bash
     read -rs "FANBALL_SECRET?Secret key: "; echo
     curl -sS -X POST "https://hexkrbwgspfturopkebv.supabase.co/functions/v1/open-tactical-round" \
       -H "apikey: $FANBALL_SECRET" -H "content-type: application/json" \
       -d '{"game_id":"<game id>","pa_no":1,"offense_team_id":"doosan","defense_team_id":"tigers","choices":[{"role":"offense","key":"normal","label":"기본 타격","default":true},{"role":"offense","key":"bunt","label":"번트"},{"role":"defense","key":"standard","label":"기본 수비","default":true},{"role":"defense","key":"double_play","label":"병살 대비"}]}'
     unset FANBALL_SECRET
     ```

   - 다음을 확인한다.
     - 공격 계정에는 공격 선택지, 수비 계정에는 수비 선택지가 같은 카운트다운으로 보인다.
     - 관전 계정에는 `작전 선택 중입니다`가 보인다.
     - 마감 전 재투표가 되고, 마감 후 양측 확정 작전이 같게 표시된다.
     - 같은 확인을 `pa_no` 2, 3으로 반복하며 동률과 무표를 점검한다.
   - 정리 SQL은 테스트 행만 지운다.

     ```sql
     delete from public.fanball_games where kbo_game_id='manual-vote-test';
     delete from public.kbo_games where id='manual-vote-test';
     ```

4. **아직 범위 밖인 것:** 확정 작전을 공식 타석 엔진에 적용하는 일은 서버 오케스트레이터가 생긴 뒤의 작업이다. Edge Function의 15초 대기 마감이 실패하면 라운드는 `open`으로 남는다. 이를 재시도할 서버 스케줄러도 아직 없다.

현재 브라우저 경기 엔진과 KBO 일정 공급은 서버 오케스트레이터에 연결되어 있지 않다. SQL/Edge 코드를 추가한 것만으로는 공식 다중 사용자 경기나 투표가 시작되지 않는다. 홈 경기표는 Supabase `kbo_games`에 공급원 일정이 있으면 해당 날짜 일정을 표시하고, 연결 전에는 구별 표시된 5개 샘플 경기만 보여준다.
