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

프로필 설정 UI와 Supabase OAuth 연결 코드가 저장소에 있다. 실제 프로젝트 URL·키·Google provider 값은 아직 설정되지 않았고, 공용 계정/라인업 DB와 RLS도 없다. 따라서 지금은 로그인 서비스가 활성화된 상태가 아니다.
