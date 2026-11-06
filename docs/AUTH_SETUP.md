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
5. FanBall의 공개 클라이언트 설정에 Supabase 프로젝트 URL과 anon/publishable key를 입력한다. 현재 코드 설정 지점은 `dist/account.js`의 `window.FANBALL_AUTH_CONFIG`다. 브라우저에 공개되는 키에는 RLS가 필수다.
6. 배포 후 Google 로그인, 동의 화면, 콜백 복귀와 로그아웃을 확인한다.

## 비밀 키와 데이터 보안

- Google Client Secret, Apple private key, Supabase service-role key는 브라우저 코드·정적 파일·GitHub에 저장하지 않는다.
- Supabase anon/publishable key는 공개 클라이언트 키지만, 사용자 데이터 테이블에 RLS를 적용하기 전에는 민감한 데이터를 저장하지 않는다.
- 로그인만 연결해도 라인업·투표가 서버에 자동 저장되지는 않는다. 계정 프로필·라인업·투표 테이블, RLS 정책, 중복 제출 제한 및 서버 측 검증이 별도로 필요하다.
- OAuth provider 설정과 DB 영구 저장은 별도 작업이다. 지금의 FanBall은 자격 증명이 설정되지 않아 계정 연결 전에는 닉네임과 응원팀을 현재 브라우저에 저장한다.
- 테스트 초기화는 경기/샘플 참여 데이터를 지우며 현재 브라우저의 닉네임과 응원팀은 보존한다.

## 현재 구현 상태

프로필 설정 UI와 Supabase OAuth 연결 코드가 저장소에 있다. 작전 투표용 DB/RLS migration과 RPC 기반도 준비했지만, 실제 프로젝트 URL·키·Google provider 값이 설정되지 않았고 migration도 미적용이다. 따라서 지금은 로그인과 공유 투표가 활성화된 상태가 아니다.

## FanBall 서버 작전 투표 연결 (구현 기반)

서버 투표용 SQL migration, 계정별 응원팀 프로필 RPC, 역할 검증 투표 RPC, 서버 전용 라운드 개설/마감 Edge Function 코드가 `supabase/`에 추가되어 있다. 프런트에서는 `dist/server-voting.js`가 로그인 사용자와 활성 라운드를 읽고 역할별 UI를 표시한다. 아직 Supabase 프로젝트에 적용·배포하지 않았으므로 실제 팬들의 투표는 현재 공유되지 않는다.

1. Supabase 프로젝트에서 CLI를 연결한다.
2. `supabase/migrations/202611060001_server_tactical_voting.sql`을 검토한 뒤 `supabase db push`로 적용한다.
3. `supabase functions deploy open-tactical-round` 및 `supabase functions deploy resolve-tactical-round`를 배포한다. 두 함수는 오케스트레이터/서버용 service-role 인증만 허용한다.
4. `dist/config.js`에 Supabase Project URL과 anon/publishable key를 넣는다. 둘 다 브라우저 공개 값이며 RLS가 필수다. Service-role key는 이 파일, 브라우저, GitHub에 절대 넣지 않는다.
5. Google OAuth provider와 리디렉션 주소를 설정하고 로그인, 프로필 RPC, 경기 참가 스냅샷을 확인한다.
6. 서버 오케스트레이터가 경기 행을 `running`으로 만들고 작전 상황에서 `open-tactical-round`를 호출해야 투표 라운드가 열린다. Edge Function은 서버 기준 15초 마감 뒤 역할별 득표·동률·무표를 확정한다.

현재 브라우저 경기 엔진과 KBO 일정 공급은 서버 오케스트레이터에 연결되어 있지 않다. SQL/Edge 코드를 추가한 것만으로는 공식 다중 사용자 경기나 투표가 시작되지 않는다. 홈 경기표는 Supabase `kbo_games`에 공급원 일정이 있으면 해당 날짜 일정을 표시하고, 연결 전에는 구별 표시된 5개 샘플 경기만 보여준다.
