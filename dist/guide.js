/* How-to guide (user feedback 2026-11-12: "튜토리얼이나 어떻게 하는건지 설명이 있으면 좋겠다").
   - A guide page (page 'guide'), opened from the topbar "가이드" button, the welcome window and the
     "이 화면 가이드" link in each page header (app.js header()).
   - A short welcome window on the first visit (remembered in this browser only).
   Wording follows the live behaviour: engine 2.9, server votes (supabase/functions/_shared/orchestrator.js),
   lineup tally (enhancements.js), AI matches (ai-game.js). Update it when those change. */
(function(){
  // Welcome window (user request 2026-11-12): shown when the fan comes to 홈, once per visit, until they press
  // 「더 이상 보지 않기」 (remembered in this browser). The old 'seen once' flag is no longer used.
  const SEEN='fanball_guide_hide_v2';let shownThisVisit=false;
  const seen=()=>{try{return localStorage.getItem(SEEN)==='1'}catch(e){return true}};
  const markSeen=()=>{try{localStorage.setItem(SEEN,'1')}catch(e){}};

  // Which guide section explains each page.
  const FOR_PAGE={friend:'ai',players:'ai',home:'start',lineup:'lineup',game:'live',records:'faq',ai:'ai',feedback:'faq'};

  const SECTIONS=[
    ['start','처음 시작하기',`
      <p>팬볼은 <b>실제 KBO 선수들의 2026 시즌 기록</b>으로 경기를 한 구씩 시뮬레이션하고, 라인업과 작전을 <b>팬 투표</b>로 정하는 서비스입니다.</p>
      <ol class="guide-steps">
        <li><b>로그인하고 응원팀 고르기</b><span>오른쪽 위 <b>로그인</b> 버튼에서 Google로 로그인하고 닉네임과 응원팀을 저장합니다. 로그인하면 저장한 라인업과 AI 경기가 다른 기기에서도 이어집니다.</span></li>
        <li><b>라인업 투표</b><span>경기 전에 응원팀의 타순 1~9번과 수비 위치를 정해 제출합니다. 팬들이 낸 라인업을 모아 대표 라인업이 정해집니다.</span></li>
        <li><b>경기 센터에서 작전 투표</b><span>경기가 시작되면 중요한 순간마다 작전 투표가 열립니다. 표를 가장 많이 받은 작전이 다음 투구에 적용됩니다.</span></li>
        <li><b>예정된 경기가 없을 때는 AI 대결</b><span>혼자서 AI 감독과 한 경기를 해 볼 수 있습니다. 작전과 투수 교체를 직접 정합니다.</span></li>
      </ol>`],
    ['lineup','라인업 투표',`
      <ul>
        <li>타순마다 선수를 고르고, 선수마다 수비 위치(C, 1B, 2B, 3B, SS, LF, CF, RF, DH)를 정합니다. 포수 자리에는 포수만 넣을 수 있습니다.</li>
        <li>이미 라인업에 있는 선수를 고르면 두 타순이 서로 바뀝니다. 이미 쓰인 수비 위치를 고르면 두 선수의 위치가 바뀝니다.</li>
        <li><b>대표 라인업 정하는 법</b>: 1번부터 차례로, 그 타순에 가장 많이 오른 선수를 뽑습니다(이미 뽑힌 선수는 제외, 동표면 먼저 제출한 쪽). 수비 위치도 선수별 최다 득표로 정합니다.</li>
        <li>경기 시작 전까지는 다시 제출해 바꿀 수 있습니다. 제출이 하나도 없으면 기본 라인업으로 경기합니다.</li>
        <li>자주 쓰는 라인업은 <b>저장 칸 3개</b>에 저장해 두고 불러올 수 있습니다.</li>
        <li>선발투수는 투표하지 않습니다. 관리자가 경기를 만들 때 양 팀 선발을 정합니다.</li>
      </ul>`],
    ['live','경기 센터 · 실시간 작전 투표',`
      <ul>
        <li>경기는 <b>한 구씩</b> 진행됩니다. 투구 2초, 타석 결과 3초, 다음 타자 소개 1초, 공수 교대 2초 간격입니다.</li>
        <li><b>투표가 열리는 순간</b>: 득점권 주자 같은 중요한 상황의 타석 전, 2스트라이크, 3볼이 되었을 때입니다. 공격 팀 팬은 공격 작전을, 수비 팀 팬은 수비·투구 작전을 고릅니다.</li>
        <li><b>투표 알림</b>: 투표가 열리면 화면 위에 알림 띠가 뜨고, 휴대폰은 진동(안드로이드), 탭 제목은 「🔔 투표 중」으로 바뀝니다. 투표 창은 휴대폰에서는 아래 메뉴 바로 위, 노트북에서는 오른쪽에 떠서 스트라이크존을 보면서 바로 고를 수 있습니다. 투표 카드가 지금 화면에 보이지 않을 때만 뜹니다(노트북처럼 넓은 화면에서는 대개 그대로 보입니다). 창의 🔊 버튼으로 알림음을 켜고 끄고, 「다른 탭에 있을 때 알림 받기」를 누르면 다른 탭을 볼 때도 알림이 옵니다.</li>
        <li><b>팀 전술</b>: 공격(초구부터 적극 공략·공 길게 보기·장타 노리기·맞히기 위주)과 수비(공격적 투구·신중한 투구) 전술을 경기 전 라인업 화면에서 정하고, 경기 중에도 경기 센터 위쪽 「팀 전술」에서 언제든 바꿀 수 있습니다. 경기 중에는 경기 센터 위쪽 막대에서 한 번 누르면 바로 바뀌고 다음 공부터 반영되며, 여러 팬이 함께하는 경기에서는 가장 많이 고른 전술이 적용됩니다. 점수판 아래 「투수 기록」을 펼치면 이번 경기 양 팀 투수의 이닝·피안타·실점·볼넷·삼진·투구 수를 볼 수 있습니다. 작전 투표가 열린 타석에서는 투표한 작전이 우선입니다.</li>
        <li>투표 시간 안에는 선택을 바꿀 수 있습니다. 상대 팀의 득표수는 마감 뒤에 공개됩니다. 아무도 투표하지 않으면 기본 작전이 적용됩니다.</li>
        <li><b>투수 교체</b>: 수비 중인 팀 팬은 투구판의 투수 이름 옆 <b>투수 교체 요청</b>을 누를 수 있습니다. 그 팀 참여자의 80% 이상이 요청하면 어떤 구원투수를 올릴지 투표하고, <b>다음 타석부터</b> 바뀝니다. 공격 중에는 투표 영역에서 <b>다음 수비 이닝 투수 예약</b>을 요청할 수 있습니다. 80%가 요청하면 해당 이닝 첫 투구 전에 구원투수 투표가 열립니다. 예약한 이닝이 지나면 요청은 만료됩니다. 투구 수 제한은 없고, 많이 던질수록 제구·구속·구위가 떨어집니다. 우리 쪽에 참여한 팬이 있으면 자동 교체 없이 팬이 정하고, 참여한 팬이 없는 쪽만 자동으로 교체됩니다.</li>
        <li><b>같은 팀끼리 이벤트 매치</b>: 경기 전에 원정 쪽과 홈 쪽 중 한쪽을 골라 참여합니다. 라인업과 작전 투표는 고른 쪽 팬끼리만 모입니다.</li>
        <li>공식 경기의 결과는 한 번만 진행되고 다시 하거나 바꿀 수 없습니다.</li>
      </ul>`],
    ['tactics','작전 설명',`
      <div class="guide-table"><table>
        <thead><tr><th>구분</th><th>작전</th><th>효과</th></tr></thead>
        <tbody>
          <tr><td class="gcat" rowspan="5">공격</td><td>기본 타격</td><td>타자 기록 그대로</td></tr>
          <tr><td>컨택 타격</td><td>헛스윙이 줄고 단타가 늘지만 장타·홈런은 줄어듭니다</td></tr>
          <tr><td>강공</td><td>장타·홈런이 늘지만 헛스윙도 늘어납니다</td></tr>
          <tr><td>기다리기</td><td>스윙을 크게 줄여 볼넷을 노립니다. 스트라이크를 그냥 보낼 수 있습니다</td></tr>
          <tr><td>희생번트</td><td>주자를 한 베이스 보내는 대신 아웃 하나를 내줄 가능성이 큽니다</td></tr>
          <tr><td class="gcat" rowspan="5">수비</td><td>기본 수비</td><td>보통 위치</td></tr>
          <tr><td>병살 대비 수비</td><td>병살이 늘지만 단타가 조금 늘어납니다</td></tr>
          <tr><td>번트 대비</td><td>코너 내야 전진. 번트 성공이 줄어듭니다</td></tr>
          <tr><td>내야 전진 수비</td><td>땅볼 때 3루 주자 득점을 막지만 단타가 늘어납니다</td></tr>
          <tr><td>외야 장타 대비</td><td>2루타·3루타가 줄지만 단타가 늘어납니다</td></tr>
          <tr><td class="gcat" rowspan="3">투구</td><td>기본 투구</td><td>투수 기록 그대로</td></tr>
          <tr><td>정면 승부</td><td>볼넷이 크게 줄고 스트라이크가 늘지만, 맞으면 안타·장타가 늘어납니다</td></tr>
          <tr><td>유인구 승부</td><td>헛스윙·범타가 늘지만 볼(볼넷)이 늘어납니다</td></tr>
        </tbody></table></div>
      <p class="tiny muted">작전은 확률을 바꿀 뿐 결과를 정하지 않습니다. 같은 작전이라도 결과는 매번 다를 수 있습니다.</p>`],
    ['screen','경기 화면 읽는 법',`
      <ul>
        <li><b>전광판</b>: 이닝별 점수와 R(득점), H(안타), E(실책), B(볼넷·몸에 맞는 공)입니다.</li>
        <li><b>투구판</b>: 스트라이크 존과 공이 들어온 위치, 구종과 구속, 볼카운트, 아웃, 주자를 보여 줍니다. <b>이 투구 확률</b>을 누르면 그 공에서 볼·스트라이크·파울·인플레이가 나올 확률을 볼 수 있습니다.</li>
        <li><b>타석 로그</b>: 이닝 탭을 눌러 타석마다 결과(예: 유격수 땅볼, 좌월 홈런)와 결정구를 볼 수 있습니다.</li>
        <li><b>투수</b>: 투수마다 실제 구종과 평균 구속으로 던집니다. 좌우 투수와 팔 각도(오버핸드·스리쿼터·사이드암·언더핸드)에 따라 같은 손 타자가 더 불리해집니다. 선발은 투구 수가 늘면 지칩니다.</li>
        <li><b>주력</b>: 선수마다 주력 등급(1~5)이 있어, 빠른 주자는 단타 때 2루에서 홈까지, 1루에서 3루까지 더 자주 가고, 빠른 타자는 병살이 줄어듭니다. 등급은 통산 도루를 (단타+볼넷)으로 나눈 비율과 3루타 비율로 정했습니다.</li>
        <li>경기가 끝나면 양 팀 타자·투수 기록(타점 포함)이 나옵니다.</li>
      </ul>`],
    ['ai','AI 대결',`
      <ol class="guide-steps">
        <li><b>팀과 선발 고르기</b><span>내 팀과 상대 팀, 양 팀 선발투수(팀당 5명 중)를 고릅니다. 같은 팀끼리도 할 수 있습니다.</span></li>
        <li><b>라인업 정하기</b><span>기본 라인업을 그대로 쓰거나 바꿉니다. 라인업 투표에서 저장한 라인업도 불러올 수 있습니다.</span></li>
        <li><b>경기 시작</b><span>속도(보통 2초 · 빠르게 1초)를 고릅니다. 작전 상황이 오면 실시간 경기처럼 10초(같은 타석의 두 번째 투표부터 8초) 안에 작전을 고릅니다. AI도 상황에 맞춰 작전을 정합니다.</span></li>
        <li><b>투수 교체</b><span>수비 중일 때 투구판의 투수 이름 옆 <b>투수 교체</b>를 누르고 구원투수를 고르면 다음 타석부터 바뀝니다. 공격 중에는 화면 위에서 <b>다음 수비 이닝 투수 예약</b>을 눌러 미리 고를 수 있고, 지정한 이닝의 첫 타석부터 나옵니다. 그 시점을 놓치면 예약은 취소됩니다. 내 팀 투수는 자동으로 바뀌지 않으니, 지친 투수(구속이 떨어지고 볼이 많아짐)는 직접 바꿔 주세요. 교체 창이 열려 있는 동안에는 경기가 잠깐 멈춥니다. 창 위쪽에 다음 타자 3명이 순서대로 우타(R)·좌타(L)·양타(S)와 함께 나옵니다.</span></li>
      </ol>
      <p><b>친구와 대결</b>: 왼쪽 메뉴(휴대폰은 아래 메뉴 「친구」)나 홈 맨 위 카드의 「친구와 대결」에서 방을 만들면 8자리 코드가 나와요. 코드로 「선수로 들어가기」를 하면 사람이 적은 편으로 들어가고(한 편에 여러 명 가능, 방 카드에서 편 변경), 「관전하기」를 하면 경기를 보고 채팅만 해요. 한 편에 여러 명이면 저장한 사람들이 가장 많이 고른 팀·선발·타순(타순별 최다)으로 나가고, 경기 중 작전도 그 편 사람들의 투표로 정해요. 라인업 투표 화면 위쪽에서 그 방을 골라 팀·선발·라인업을 정해 저장해요(상대 편에는 시작 전까지 저장한 인원만 보여요). 양쪽 편에서 한 명 이상 저장하면 방을 만든 사람이 「경기 시작」을 누르고, 모두 경기 센터로 이동해요. 방 경기에서는 투표할 사람이 다 고르면 2초 뒤 바로 진행돼요. 방 화면·라인업·경기 센터 오른쪽 아래 「채팅」 버튼으로 선수와 관전하는 사람 모두 대화할 수 있어요.</p>
      <p><b>지난 대결 기록</b>: 끝난 친구 대결은 30분 뒤 방 목록에서 빠지고, 친구 대결 화면 아래 「지난 대결 기록」에 쌓여요(10개씩, 승·패 표시). 오늘 경기는 결과 화면도 다시 볼 수 있어요.</p>
      <p><b>선수 정보</b>: 왼쪽 메뉴 「선수 정보」(휴대폰은 「선수」)에서 팀별로 선수의 주력 등급(1 매우 느림 ~ 5 매우 빠름)과 도루 성향을 볼 수 있어요. 주력은 추가 진루·병살·2루 포스아웃·번트 안타에 쓰여요.</p>
      <p class="tiny muted">다른 화면으로 나가거나 새로고침하면 그 자리에서 멈췄다가 이어집니다. 로그인하면 진행 중인 경기와 지난 경기가 계정에 저장됩니다.</p>`],
    ['faq','자주 묻는 질문',`
      <dl class="guide-faq">
        <dt>결과는 어떻게 정해지나요?</dt><dd>볼카운트마다 실제 메이저리그 투구 기록(Retrosheet)에서 나온 볼·스트라이크·타격 확률에, 타자와 투수의 2026 시즌 기록, 좌우 상성, 투수 피로도, 고른 작전을 곱해 한 구씩 뽑습니다.</dd>
        <dt>선수 기록은 어디서 왔나요?</dt><dd>나무위키 선수 문서(CC BY-NC-SA 2.0 KR)에서 읽었습니다. 기록이 없거나 부족한 선수는 리그 평균값을 쓰고, 구사율처럼 문서에 없는 값은 추정값입니다.</dd>
        <dt>로그인하지 않아도 되나요?</dt><dd>AI 대결과 라인업 저장은 로그인 없이 이 브라우저에만 저장됩니다. 실시간 경기의 라인업·작전 투표는 로그인해야 참여할 수 있습니다.</dd>
        <dt>빠진 선수가 있거나 기록이 이상해요.</dt><dd><b>건의하기</b>에서 알려 주세요. 운영자가 확인하고 답변을 남깁니다.</dd>
      </dl>`],
  ];

  window.openGuide=function(section){
    document.querySelector('#guide-modal')?.remove();
    window.GUIDE_SECTION=section||null;
    go('guide');
    setTimeout(()=>{const el=section&&document.getElementById('guide-'+section);if(el)el.scrollIntoView({block:'start'});else window.scrollTo(0,0)},60);
  };
  window.guideHelpLink=function(p){
    const s=FOR_PAGE[p];
    return s?`<button type="button" class="guide-help-link" onclick="openGuide('${s}')">이 화면 가이드</button>`:'';
  };
  window.guidePage=function(){
    const toc=SECTIONS.map(([id,title])=>`<button type="button" class="guide-chip" onclick="openGuide('${id}')">${title}</button>`).join('');
    const body=SECTIONS.map(([id,title,html])=>`<section class="card guide-section" id="guide-${id}"><div class="card-head"><h2>${title}</h2></div><div class="guide-body">${html}</div></section>`).join('');
    return `${header('GUIDE','이용 안내','팬볼을 처음 쓰는 분을 위한 사용법')}<div class="guide-toc">${toc}</div>${body}`;
  };

  function welcome(){
    if(seen()||shownThisVisit||document.querySelector('#guide-modal'))return;
    shownThisVisit=true;
    document.body.insertAdjacentHTML('beforeend',`<div class="modal-backdrop" id="guide-modal" onclick="if(event.target===this){this.remove()}"><section class="account-modal guide-welcome" role="dialog" aria-labelledby="guide-welcome-title"><button class="modal-close" aria-label="닫기" onclick="document.querySelector('#guide-modal').remove()">×</button><div class="eyebrow">WELCOME</div><h2 id="guide-welcome-title">팬볼에 오신 것을 환영합니다</h2><p class="muted">실제 KBO 선수 기록으로 한 구씩 진행하는 경기에서, 라인업과 작전을 팬 투표로 정합니다.</p><ol class="guide-steps compact"><li><b>로그인</b><span>오른쪽 위 버튼 · Google 로그인 · 응원팀 선택</span></li><li><b>라인업 투표</b><span>경기 전 타순과 수비 위치 제출</span></li><li><b>경기 센터</b><span>경기 중 작전·투수 교체 투표</span></li><li><b>AI 대결</b><span>경기가 없을 때 혼자 한 경기</span></li></ol><div class="guide-welcome-actions"><button class="btn btn-primary" onclick="openGuide('start')">가이드 자세히 보기</button><button class="btn btn-soft" onclick="document.querySelector('#guide-modal').remove()">바로 시작하기</button></div><div class="guide-hide-row"><button type="button" class="guide-hide" onclick="guideHideForever()">더 이상 보지 않기</button></div></section></div>`);
  }
  window.guideHideForever=function(){markSeen();document.querySelector('#guide-modal')?.remove();notify?.('가이드 안내 창을 다시 띄우지 않습니다. 위쪽 「가이드」 버튼으로 언제든 볼 수 있습니다.')};

  // Topbar button (every page, phone included).
  const right=document.querySelector('.top-right');
  if(right&&!document.querySelector('#guideButton')){
    right.insertAdjacentHTML('afterbegin','<button type="button" class="btn btn-soft guide-button" id="guideButton" onclick="openGuide()" aria-label="이용 안내">가이드</button>');
  }
  // Show it when the fan is on 홈: at load if the page opens on 홈, and on the first move to 홈 otherwise.
  if(!/[?&]admin=1/.test(location.search)){
    const maybe=()=>{if(typeof page!=='undefined'&&page==='home')welcome()};
    setTimeout(maybe,700);
    const prevGo=window.go;window.go=function(p){prevGo(p);if(p==='home')setTimeout(maybe,300)};
  }
})();
