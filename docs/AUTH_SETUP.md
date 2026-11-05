# FanBall 계정·프로필 설정

## 제품 동작

상단의 `프로필 설정`에서 닉네임(2~12자)과 응원팀을 저장한다. 인증 프로젝트가 연결되면 Google 또는 Apple로 로그인할 수 있고, 닉네임과 응원팀은 Supabase Auth 사용자 metadata에 저장한다. 프로젝트 설정 전에는 프로필을 현재 브라우저에만 보관한다.

테스트 초기화는 경기·라인업 샘플 데이터를 지우되 닉네임과 응원팀을 보존한다. 계정 간 경기·투표 데이터 동기화와 팀별 대표 라인업 저장은 별도 DB 작업으로 남아 있다.

## Supabase 준비 순서

1. Supabase 프로젝트를 만들고 Authentication에서 Google, Apple 공급자를 활성화한다.
2. Google Cloud에서 OAuth 동의 화면과 웹 OAuth 클라이언트를 만들고, Supabase가 안내하는 callback URL을 등록한다.
3. Apple Developer에서 Sign in with Apple의 Service ID, 도메인, callback URL 및 키를 설정한다. Apple 개발자 계정과 앱 식별자 설정이 필요하다.
4. Supabase Authentication의 URL 설정에 FanBall의 정확한 배포 도메인을 Site URL 및 허용 redirect URL로 추가한다. 로컬 미리보기 주소도 개발 중에는 별도로 허용한다.
5. `dist/account.js`의 `window.FANBALL_AUTH_CONFIG`에 Supabase project URL과 공개 anon/publishable key를 설정한다. 이 공개 클라이언트 키만 브라우저에 둔다. Google client secret, Apple private key는 브라우저 코드나 GitHub에 넣지 않고 Supabase 대시보드의 provider 설정에만 저장한다.
6. Google·Apple 로그인, callback 복귀, 로그아웃, 프로필 metadata 저장을 각각 확인한다.

## 보안 및 출시 전 작업

- 공개 anon/publishable key는 Row Level Security를 대체하지 않는다. 사용자 프로필 테이블과 라인업·투표 테이블을 만들 때는 RLS 정책을 적용하고, 관리자 권한이나 service-role key를 브라우저에 넣지 않는다.
- 로그인만으로 닉네임의 전역 유일성이나 라인업/투표의 서버 저장이 생기지 않는다. 이를 위해 별도 DB schema, RLS, 중복 제출 제약과 서버 검증이 필요하다.
- Apple은 공급자 대시보드의 서명 키/서비스 ID 설정이 필요하고, Google은 OAuth client 설정이 필요하다. 현재 FanBall에는 실제 프로젝트 URL·키가 설정되지 않아 버튼은 비활성 안내 상태다.
- Supabase 사용 요금과 한도는 프로젝트 생성 시점의 공식 요금 안내를 확인한다. 실제 로그인 서비스가 활성화되기 전에는 무료라고 가정하지 않는다.
