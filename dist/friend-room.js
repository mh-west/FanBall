/* Friend rooms (user requests 2026-11-12/13). A signed-in fan makes a room and gets an 8-digit code; a friend
   enters it. Each then picks their own team, starter and lineup on the lineup screen (the other sees only that
   it is done), and the host starts the game; the server plays it like any live game.
   DB: supabase/migrations/202611130001 (rooms), 0002 (delete), 0003 (codes only, hidden setups, host start).
   Also here: the lineup screen's "which game" bar (public game or one of my rooms) and the room lineup editor. */
(function(){
  const api=()=>window.FANBALL_SERVER_CLIENT,user=()=>window.FANBALL_AUTH_USER?.()||null;
  const MINE='fanball-my-rooms';
  const R={rooms:null,loading:false,error:null,busy:false,side:'home',code:'',drafts:{},history:null,historyBusy:false,historyOpen:false};
  const store={get(){try{return JSON.parse(localStorage.getItem(MINE)||'[]')}catch(e){return []}},set(v){try{localStorage.setItem(MINE,JSON.stringify(v))}catch(e){}}};
  const errorText=m=>({
    'authentication required':'로그인한 뒤 할 수 있어요.','too many tries':'코드를 너무 많이 틀렸어요. 1분 뒤에 다시 해 주세요.',
    'you already have 3 open rooms':'열어 둔 방이 3개예요. 하나를 지우고 다시 만들어 주세요.','room expired':'방이 만료됐어요(24시간).',
    'the game has started':'이미 경기가 시작됐어요.','room not found':'방을 찾지 못했어요.','your friend has not joined':'친구가 아직 안 들어왔어요.',
    'both lineups are needed':'두 사람 모두 팀과 라인업을 저장해야 시작할 수 있어요.','only the host starts the game':'방을 만든 사람만 시작할 수 있어요.',
    'lineup needs 9 batters and each position once':'타자 9명과 수비 위치 9개를 하나씩 정해 주세요.'})[m]||m;
  const rerender=()=>{if(typeof page!=='undefined'&&['friend','lineup'].includes(page)&&typeof render==='function')render()};
  const waiting=()=>(R.rooms||[]).filter(r=>!r.game_id&&r.status==='waiting'&&r.role!=='watch');
  const find=code=>(R.rooms||[]).find(r=>r.code===code);

  // Which room games are mine (the schedule hides other people's rooms), and my side's key in a started one.
  window.FANBALL_ROOMS={
    isMine:kboId=>store.get().includes(kboId),
    lineupKeyFor:kboId=>(R.rooms||[]).find(r=>r.kbo_game_id===kboId)?.my_key||null,
    // Spectators watch a room game without joining a side (server-voting.js skips joining for them).
    isWatching:kboId=>(R.rooms||[]).some(r=>r.kbo_game_id===kboId&&r.role==='watch'),
    refresh:()=>load(),
  };

  async function load(){
    const c=api();if(!c||!user()||R.loading)return;
    R.loading=true;
    // Redraw only when something changed, so a select the fan has open is not closed every 5 seconds.
    let changed=true;
    try{const {data,error}=await c.rpc('my_friend_rooms');if(error)throw error;const next=JSON.stringify(data||[]);changed=next!==load.last;load.last=next;
      // The host started a room I was waiting in: go to 경기 센터 (user request 2026-11-13).
      const before=new Map((R.rooms||[]).map(r=>[r.code,r]));
      const startedNow=(data||[]).find(r=>r.kbo_game_id&&before.get(r.code)&&!before.get(r.code).game_id);
      R.rooms=data||[];R.error=null;store.set(R.rooms.map(r=>r.kbo_game_id).filter(Boolean));
      if(startedNow&&!(typeof page!=='undefined'&&page==='game')){notify('경기가 시작됐어요! 경기 센터로 이동해요.');roomOpen(startedNow.kbo_game_id,'game')}}
    catch(e){R.error=errorText(e.message||String(e))}
    finally{R.loading=false;if(changed)rerender()}
  }
  async function call(fn,args,ok){
    if(!user())return openAccount();if(R.busy)return;R.busy=true;rerender();
    try{const {data,error}=await api().rpc(fn,args);if(error)throw error;if(ok)await ok(data);await load()}
    catch(e){notify('실패: '+errorText(e.message||String(e)))}
    finally{R.busy=false;rerender()}
  }

  window.roomSide=v=>{R.side=v==='away'?'away':'home'};
  window.roomCreate=()=>call('create_friend_room',{p_my_side:R.side},d=>notify(`방을 만들었어요. 코드 ${d.code}를 친구에게 보내 주세요.`));
  window.roomCode=v=>{R.code=String(v||'').replace(/\D/g,'').slice(0,8);document.querySelectorAll('#room-join-btn,.room-watch-btn').forEach(b=>b.disabled=R.code.length!==8)};
  // Join as a player (the side with fewer people) or as a spectator (user request 2026-11-13: several people per
  // side, spectators with the code).
  window.roomJoin=function(watch){
    if(R.code.length!==8)return notify('8자리 숫자를 넣어 주세요.');
    return call('join_friend_room',{p_code:R.code,p_side:watch?'watch':null},d=>{
      if(d?.error){notify('방을 찾지 못했어요. 코드를 다시 확인해 주세요.');return}
      R.code='';
      if(d.role==='watch'){notify('관전으로 들어왔어요. 경기가 시작되면 「관전하러 가기」를 누르세요.');if(d.kbo_game_id)store.set([...new Set([...store.get(),d.kbo_game_id])]);return}
      notify(d.status==='running'?`${sideName(d.my_side)} 편으로 들어왔어요. 지금부터 작전 투표에 참여할 수 있어요.`:`${sideName(d.my_side)} 편으로 들어왔어요! 라인업 투표 화면에서 팀과 라인업을 골라 주세요.`);
    });
  };
  window.roomSetSide=(code,v)=>call('join_friend_room',{p_code:code,p_side:v},d=>{if(d?.role==='watch')notify('관전으로 바꿨어요.');else notify(`${sideName(d.my_side)} 편으로 옮겼어요. 라인업은 다시 골라 주세요.`)});
  window.roomStart=code=>call('start_friend_room',{p_code:code},d=>{if(d?.kbo_game_id)store.set([...new Set([...store.get(),d.kbo_game_id])]);notify('경기를 시작했어요! 경기 센터로 이동해요.');roomOpen(d.kbo_game_id,'game')});
  window.roomDelete=function(code,status,host){
    const msg=status==='running'?'경기를 그만두고 방을 삭제할까요? 이 경기는 취소돼요.':status==='waiting'?(host?'방을 삭제할까요? 이 코드로는 더 이상 들어올 수 없어요.':'방에서 나갈까요?'):'목록에서 지울까요?';
    if(!confirm(msg))return;
    call('delete_friend_room_code',{p_code:code},()=>{notify(status==='waiting'&&!host?'방에서 나왔어요.':'방을 지웠어요. 새 방을 만들 수 있어요.');if(db.lineupCtx===code){db.lineupCtx=null;persist()}});
  };
  window.roomCopy=async function(code,link){
    const text=link?`${location.origin}/?room=${code}`:code;
    try{await navigator.clipboard.writeText(text);notify(link?'초대 링크를 복사했어요.':'코드를 복사했어요.')}catch(e){prompt('복사해서 보내 주세요',text)}
  };
  // Open a started room's game on the game screen (it becomes the selected server game).
  window.roomOpen=function(kboId,where){
    db.activeFixtureId=kboId;persist();
    const rv=window.FANBALL_REMOTE_VOTING;
    Promise.resolve(rv?.refreshSchedule?.(true)).then(()=>{rv?.refresh?.();window.FANBALL_SERVER_GAME?.load?.(true);go(where)});
  };
  // Go to the lineup screen with this room chosen.
  window.roomLineup=code=>{db.lineupCtx=code;persist();go('lineup')};

  const sideName=s=>s==='away'?'원정':'홈';
  function roomCard(r){
    const host=r.me==='host',watch=r.role==='watch',w=r.status==='waiting',sd=r.sides||{away:{players:0,ready:0},home:{players:0,ready:0},watch:{players:0}};
    const both=(sd.away?.ready||0)>0&&(sd.home?.ready||0)>0,otherIn=(sd[r.my_side==='away'?'home':'away']?.players||0)>0;
    let status;
    if(r.status==='running')status='<span class="tag red">경기 중</span>';else if(r.status==='final')status='<span class="tag">경기 끝</span>';
    else status=!otherIn&&!watch?'<span class="tag gold">상대 편 기다리는 중</span>':both?'<span class="tag green">시작 준비 끝</span>':'<span class="tag blue">라인업 정하는 중</span>';
    const sideLine=k=>`${sideName(k)} ${sd[k]?.players||0}명${w?` · 저장 ${sd[k]?.ready||0}`:''}`;
    const picks=r.my_side_teams&&Object.keys(r.my_side_teams).length?` · 우리 편이 고른 팀: ${Object.entries(r.my_side_teams).sort((a,b)=>b[1]-a[1]).map(([t,n])=>`${safe(team(t)?.short||t)} ${n}`).join(', ')}`:'';
    const people=`<div class="room-people"><span>${watch?'나 · 관전':`나 · ${sideName(r.my_side)} · ${w?(r.my_ready?`✓ ${safe(team(r.my_setup?.team)?.short||'')} 라인업 저장`:'라인업 아직'):'투표 참여'}`}${picks}</span><span>${sideLine('away')} · ${sideLine('home')} · 관전 ${sd.watch?.players||0}명</span></div>`;
    const canStart=host&&both;
    const sidePick=w?`<label class="room-side">나는<select onchange="roomSetSide('${r.code}',this.value)"><option value="away" ${r.my_side==='away'?'selected':''}>원정 편</option><option value="home" ${r.my_side==='home'?'selected':''}>홈 편</option>${host?'':`<option value="watch" ${watch?'selected':''}>관전</option>`}</select></label>`:'';
    const actions=w
      ?(watch?'':`<button class="btn ${r.my_ready?'btn-soft':'btn-primary'}" onclick="roomLineup('${r.code}')">${r.my_ready?'내 팀·라인업 고치기':'내 팀·라인업 정하기'}</button>`)
        +sidePick+(host?`<button class="btn btn-primary" ${canStart&&!R.busy?'':'disabled'} onclick="roomStart('${r.code}')">경기 시작</button>`:'')
        +`<button class="btn btn-soft room-delete" onclick="roomDelete('${r.code}','waiting',${host})">${host?'방 삭제':'나가기'}</button>`
      :`<button class="btn btn-primary" onclick="roomOpen('${r.kbo_game_id}','game')">${r.status==='final'?'결과 보기':watch?'관전하러 가기':'경기 보러 가기'}</button><button class="btn btn-soft room-delete" onclick="roomDelete('${r.code}','${r.status}',${host})">${r.status==='running'&&host?'그만두고 방 삭제':'목록에서 지우기'}</button>`;
    const vs=r.away_team_id?`<b>${safe(team(r.away_team_id)?.short||'')} <small>원정</small> vs ${safe(team(r.home_team_id)?.short||'')} <small>홈</small></b>`:`<b>친구 대결 방</b>`;
    const hint=w?(watch?'관전 중이에요. 경기가 시작되면 경기를 보고 채팅할 수 있어요(투표는 못 해요).'
      :host?(canStart?'준비 끝! 「경기 시작」을 누르면 바로 시작돼요. 각 편은 저장한 사람들이 가장 많이 고른 팀·선발·타순으로 나가요.':'양쪽 편에서 한 명 이상 팀·라인업을 저장하면 「경기 시작」을 누를 수 있어요. 한 편에 여러 명이면 가장 많이 고른 팀·선발·타순으로 정해져요.')
      :'방장이 「경기 시작」을 누르면 시작돼요. 같은 편 여러 명이 저장하면 가장 많이 고른 팀·선발·타순으로 정해지고, 상대 편 선택은 시작할 때 공개돼요.'):'';
    return `<article class="card room-card"><div class="room-head"><div>${vs}<small class="muted">${watch?'관전':`나는 ${sideName(r.my_side)} 편`} · ${host?'내가 만든 방':'초대받은 방'}</small></div>${status}</div>
      ${w||r.status==='running'?`<div class="room-code"><span class="muted tiny">방 코드</span><strong>${r.code.slice(0,4)} ${r.code.slice(4)}</strong><span class="room-code-actions"><button class="btn btn-soft" onclick="roomCopy('${r.code}',false)">코드 복사</button><button class="btn btn-soft" onclick="roomCopy('${r.code}',true)">초대 링크 복사</button></span></div>`:''}
      ${people}<div class="room-actions">${actions}</div>${hint?`<p class="tiny muted">${hint}</p>`:''}</article>`;
  }

  // Past room games (user request 2026-11-13): finished games leave the room list and pile up here, 10 at a time.
  async function loadHistory(more){
    if(!api()||!user()||R.historyBusy)return;R.historyBusy=true;
    try{const offset=more?(R.history?.rows.length||0):0;const {data,error}=await api().rpc('my_room_history',{p_limit:10,p_offset:offset});if(error)throw error;
      R.history={total:data.total,rows:(more?R.history.rows:[]).concat(data.rows||[])}}
    catch(e){R.history=R.history||{total:0,rows:[],error:true}}
    finally{R.historyBusy=false;rerender()}
  }
  window.roomHistoryMore=()=>loadHistory(true);
  window.roomHistoryToggle=open=>{R.historyOpen=open;if(open&&!R.history)loadHistory(false)};
  function historyCard(){
    const h=R.history,res={win:'<span class="tag green">승</span>',loss:'<span class="tag red">패</span>',draw:'<span class="tag">무</span>'};
    const when=t=>new Date(t).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
    const rows=!h?'<p class="muted tiny">불러오는 중…</p>':h.error?'<p class="muted tiny">기록을 불러오지 못했어요.</p>':!h.rows.length?'<p class="muted tiny">아직 끝난 대결이 없어요.</p>'
      :`<ul class="room-history">${h.rows.map(x=>`<li><span class="rh-when">${when(x.ended_at)}</span><b>${safe(team(x.away_team_id)?.short||x.away_team_id)} ${x.away} : ${x.home} ${safe(team(x.home_team_id)?.short||x.home_team_id)}</b><span class="rh-me">${x.my_side==='watch'?'<span class="tag">관전</span>':`${sideName(x.my_side)} ${res[x.result]||''}`}</span>${x.today?`<button class="btn btn-soft" onclick="roomOpen('${x.kbo_game_id}','game')">결과 보기</button>`:''}</li>`).join('')}</ul>${h.rows.length<h.total?`<button class="btn btn-soft" ${R.historyBusy?'disabled':''} onclick="roomHistoryMore()">더 보기 (${h.total-h.rows.length}개 남음)</button>`:''}`;
    return `<details class="card room-history-card" ${R.historyOpen?'open':''} ontoggle="roomHistoryToggle(this.open)"><summary><b>지난 대결 기록</b><span class="muted tiny">${h?`${h.total}경기`:'열어서 보기'}</span></summary><p class="tiny muted">끝난 대결은 30분 뒤 위 목록에서 빠지고 여기에 남아요. 오늘 경기는 결과 화면도 다시 볼 수 있어요.</p>${rows}</details>`;
  }

  window.friendRoomPage=function(){
    const head=header('FRIEND MATCH','친구와 대결','방을 만들고 8자리 코드를 친구들에게 보내세요. 한 편에 여러 명, 관전도 돼요');
    if(!api())return head+'<div class="empty">서버 연결 설정이 필요합니다.</div>';
    if(!user())return head+`<section class="card room-login"><h2>로그인하면 친구와 대결할 수 있어요</h2><p class="muted">방을 만들거나 코드로 들어가려면 Google 로그인이 필요해요.</p><button class="btn btn-primary" onclick="openAccount()">로그인</button></section>`;
    if(R.rooms===null&&!R.loading)load();
    const list=(R.rooms||[]).length?`<h2 class="result-section-title">내 방</h2>${R.rooms.map(roomCard).join('')}`:'';
    const create=`<section class="card room-form"><div class="card-head"><h2>방 만들기</h2></div>
      <p class="tiny muted room-note">코드만 먼저 만들어요. 팀·선발·라인업은 들어온 사람들이 각자 라인업 투표 화면에서 고르고, 같은 편에서 가장 많이 고른 것으로 정해져요(상대 편에는 시작 전까지 비공개).</p>
      <div class="room-grid"><label>나는<select onchange="roomSide(this.value)"><option value="home" ${R.side==='home'?'selected':''}>홈 (말 공격)</option><option value="away" ${R.side==='away'?'selected':''}>원정 (초 공격)</option></select></label></div>
      <button class="btn btn-primary" ${R.busy?'disabled':''} onclick="roomCreate()">방 만들고 코드 받기</button><p class="tiny muted room-note">방은 동시에 3개까지 열 수 있어요. 필요 없는 방은 「방 삭제」로 지우면 새로 만들 수 있어요.</p></section>`;
    const join=`<section class="card room-form"><div class="card-head"><h2>코드로 들어가기</h2></div>
      <label class="room-code-input">친구에게 받은 8자리 숫자<input id="room-code" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="12345678" value="${safe(R.code)}" oninput="roomCode(this.value)"></label>
      <div class="room-actions"><button id="room-join-btn" class="btn btn-primary" ${R.code.length===8&&!R.busy?'':'disabled'} onclick="roomJoin(false)">선수로 들어가기</button><button class="btn btn-soft room-watch-btn" ${R.code.length===8&&!R.busy?'':'disabled'} onclick="roomJoin(true)">관전하기</button></div>
      <p class="tiny muted room-note">한 편에 여러 명이 들어갈 수 있어요(인원이 적은 편으로 들어가고, 방 카드에서 편을 바꿀 수 있어요). 경기 중인 방에도 들어가 작전 투표에 참여하거나 관전할 수 있어요.</p></section>`;
    return head+(R.error?`<div class="banner">${safe(R.error)}</div>`:'')+list+`<div class="room-two">${join}${create}</div>`+historyCard();
  };

  // ---------- chat (user request 2026-11-13): the two people in a room, while waiting and during the game ----------
  const CH={code:null,open:false,msgs:[],last:0,unread:0,busy:false,draft:''};
  document.body.insertAdjacentHTML('beforeend','<button type="button" id="room-chat-fab" class="room-chat-fab" hidden onclick="roomChatToggle()"></button><section id="room-chat" class="room-chat" hidden aria-label="방 채팅"></section>');
  const fab=document.getElementById('room-chat-fab'),panel=document.getElementById('room-chat');
  // The room the chat belongs to: the one whose game is on the game screen, or the newest waiting/running room on the room screens.
  function chatRoom(){
    if(!user()||!R.rooms?.length)return null;
    const p=typeof page!=='undefined'?page:'';
    if(p==='game')return R.rooms.find(r=>r.kbo_game_id&&r.kbo_game_id===MATCH.id&&r.status!=='final')||null;
    if(p==='friend'||(p==='lineup'&&db.lineupCtx))return (p==='lineup'&&find(db.lineupCtx))||R.rooms.find(r=>r.status==='waiting'||r.status==='running')||null;
    return null;
  }
  async function fetchMsgs(){
    if(!CH.code)return;
    try{const {data,error}=await api().rpc('room_messages_after',{p_code:CH.code,p_after:CH.last});if(error)throw error;
      const fresh=(data||[]).filter(m=>m.id>CH.last);if(fresh.length){CH.msgs=CH.msgs.concat(fresh).slice(-150);CH.last=fresh[fresh.length-1].id;if(!CH.open)CH.unread+=fresh.filter(m=>!m.mine).length;drawChat(true)}}
    catch(e){/* a dropped request is retried on the next poll */}
  }
  function drawChat(scroll){
    const r=chatRoom();
    if(!r){fab.hidden=true;panel.hidden=true;return}
    if(CH.code!==r.code){CH.code=r.code;CH.msgs=[];CH.last=0;CH.unread=0;fetchMsgs()}
    fab.hidden=CH.open;fab.innerHTML=`채팅${CH.unread?` <b>${CH.unread}</b>`:''}`;
    panel.hidden=!CH.open;
    if(!CH.open)return;
    const tag=m=>m.who==='watch'?' · 관전':m.who==='away'?' · 원정':m.who==='home'?' · 홈':'';
    const list=CH.msgs.map(m=>`<li class="${m.mine?'mine':''}"><small>${safe(m.mine?'나':m.nickname)}${tag(m)}</small><span>${safe(m.body)}</span></li>`).join('')||'<li class="empty-chat">아직 메시지가 없어요. 인사해 보세요!</li>';
    const ul=panel.querySelector('ul');
    if(!ul){panel.innerHTML=`<header><b>방 채팅</b><button type="button" onclick="roomChatToggle()" aria-label="채팅 닫기">닫기</button></header><ul>${list}</ul><form onsubmit="event.preventDefault();roomChatSend()"><input id="room-chat-input" maxlength="200" autocomplete="off" placeholder="메시지 (200자까지)"><button class="btn btn-primary" type="submit">보내기</button></form>`;}
    else ul.innerHTML=list;
    if(scroll){const u=panel.querySelector('ul');u.scrollTop=u.scrollHeight}
  }
  window.roomChatToggle=()=>{CH.open=!CH.open;if(CH.open)CH.unread=0;drawChat(true);if(CH.open)setTimeout(()=>document.getElementById('room-chat-input')?.focus(),50)};
  window.roomChatSend=async function(){
    const input=document.getElementById('room-chat-input'),text=(input?.value||'').trim();if(!text||CH.busy||!CH.code)return;
    CH.busy=true;
    try{const {error}=await api().rpc('send_room_message',{p_code:CH.code,p_body:text});if(error)throw error;input.value='';await fetchMsgs()}
    catch(e){notify(e.message==='too many messages'?'메시지를 너무 빨리 보내고 있어요. 잠시 뒤에 보내 주세요.':'보내지 못했어요: '+(e.message||e))}
    finally{CH.busy=false}
  };
  // Draw on page changes, and fetch new messages: every 2 s while open, every 5 s for the unread count.
  setInterval(()=>drawChat(false),700);
  setInterval(()=>{if(CH.code&&CH.open)fetchMsgs()},2000);
  setInterval(()=>{if(CH.code&&!CH.open&&!fab.hidden)fetchMsgs()},5000);

  // ---------- room lineup editor (on the lineup screen) ----------
  const POS=['C','1B','2B','3B','SS','LF','CF','RF','DH'];
  const fmt3=v=>Number.isFinite(v)?v.toFixed(3).replace(/^0/,''):'-';
  const catcher=p=>p&&((Array.isArray(p[11])&&p[11].includes('C'))||p[1]==='C');
  function draftFor(r){
    if(R.drafts[r.code])return R.drafts[r.code];
    const s=r.my_setup,teamId=s?.team||db.favorite||'tigers',t=team(teamId);
    const order=s?.order?.slice()||(t.defaultOrder||t.players.map((_,i)=>i)).slice(0,9);
    const pos=order.map((i,k)=>s?.positions?.[t.players[i]?.[0]]||t.defaultPos?.[i]||POS[k]);
    return R.drafts[r.code]={team:teamId,sp:s?.pitcher||null,order,pos,plan:{offense:s?.plan?.offense||'normal',defense:s?.plan?.defense||'normal'},dirty:false};
  }
  window.roomDraft=function(code,k,i,v){
    const r=find(code);if(!r)return;const d=draftFor(r);
    if(k==='team'){const t=team(v);R.drafts[code]={plan:d.plan,team:v,sp:null,order:(t.defaultOrder||t.players.map((_,i)=>i)).slice(0,9),pos:[],dirty:true};const n=R.drafts[code];n.pos=n.order.map((x,j)=>t.defaultPos?.[x]||POS[j]);return rerender()}
    if(k==='sp'){d.sp=v;d.dirty=true;return rerender()}
    if(k==='player'){const x=Number(v),other=d.order.indexOf(x);if(other>=0){d.order[other]=d.order[i];}d.order[i]=x;d.dirty=true;return rerender()}
    if(k==='pos'){const other=d.pos.indexOf(v);if(other>=0)d.pos[other]=d.pos[i];d.pos[i]=v;d.dirty=true;return rerender()}
  };
  // Team-wide plans for the room game (team-plan.js chips): saved with the setup; changeable in the game too.
  window.roomPlanFor=code=>(role,key)=>{const r=find(code);if(!r)return;const d=draftFor(r);d.plan={...d.plan,[role]:key};d.dirty=true;rerender()};
  window.roomFillAi=async function(code){
    const r=find(code);if(!r)return;const d=draftFor(r),teamId=d.team;
    try{
      const {aiLineupFor}=await import('./ai-manager.js?v=13ba04cae6');
      if(R.drafts[code]!==d||d.team!==teamId)return;
      const lineup=aiLineupFor(team(teamId),'ops');
      if(!Array.isArray(lineup?.order)||lineup.order.length!==9)return notify('이 팀의 AI 추천 라인업을 만들지 못했어요.');
      d.order=lineup.order;d.pos=lineup.order.map(i=>lineup.pos[i]);d.dirty=true;rerender();
      notify('OPS 중심 AI 추천을 채웠어요. 선수와 수비 위치를 확인한 뒤 저장해 주세요.');
    }catch(e){notify('AI 추천 라인업을 불러오지 못했어요. 다시 시도해 주세요.')}
  };
  window.roomSaveSetup=function(code){
    const r=find(code);if(!r)return;const d=draftFor(r),t=team(d.team);
    if(new Set(d.order).size!==9)return notify('타자 9명을 서로 다르게 골라 주세요.');
    if(new Set(d.pos).size!==9||!POS.every(p=>d.pos.includes(p)))return notify('수비 위치 9개를 하나씩 정해 주세요.');
    const c=d.order[d.pos.indexOf('C')];if(!catcher(t.players[c]))return notify('포수 자리에는 포수만 넣을 수 있어요.');
    const sp=window.starterFor?window.starterFor(d.team,d.sp):t.pitcher;
    const setup={team:d.team,players:t.players,pitcher:sp,bullpen:window.bullpenFor?window.bullpenFor(d.team,sp?.[0]):(t.bullpen||[]),order:d.order,
      positions:Object.fromEntries(d.order.map((i,k)=>[t.players[i][0],d.pos[k]])),plan:d.plan};
    // Saved: back to the room's waiting screen (user request 2026-11-13).
    call('set_friend_room_setup',{p_code:code,p_setup:setup},()=>{d.dirty=false;notify('저장했어요. 상대에게는 「저장 완료」만 보여요.');setTimeout(()=>go('friend'),50)});
  };
  // Saved lineups (the same ones as the main lineup screen, per team): load one into the room, or save the room's.
  window.roomLoadSaved=function(code,which){
    const r=find(code);if(!r||typeof savedLineups!=='function')return;const d=draftFor(r),t=team(d.team),all=savedLineups()[t.id]||{};
    const saved=liveSaved(which==='recent'?all.recent:all.slots?.[which]);if(!saved)return;
    const idx=saved.slots.map(x=>t.players.findIndex(p=>p[0]===x.player)),missing=saved.slots.filter((x,j)=>idx[j]<0).map(x=>x.player);
    if(missing.length)return notify('지금 명단에 없는 선수가 있어 불러오지 못했어요: '+missing.join(', '));
    d.order=idx;d.pos=saved.slots.map(x=>x.pos);d.dirty=true;rerender();notify('불러왔어요. 「이 라인업 저장」을 눌러야 방에 반영돼요.');
  };
  window.roomSaveSlot=function(code,n){
    const r=find(code);if(!r||typeof savedLineups!=='function')return;const d=draftFor(r),t=team(d.team),all=savedLineups();
    all[t.id]=all[t.id]||{slots:[null,null,null]};const old=liveSaved(all[t.id].slots[n]);
    if(old&&!confirm(`'${slotName(old,n)}'에 있는 라인업을 지금 라인업으로 바꿀까요?`))return;
    const name=askLineupName(old?.name||'',n);if(name===null)return;
    all[t.id].slots[n]={at:Date.now(),name,slots:d.order.map((i,k)=>({player:t.players[i][0],pos:d.pos[k]}))};writeSavedLineups(all);rerender();notify(`'${slotName({name},n)}'에 저장했어요.`);
  };
  function savedBox(r,d){
    if(typeof savedLineups!=='function')return '';
    const t=team(d.team),mine=savedLineups()[t.id]||{},rows=[];
    if(liveSaved(mine.recent))rows.push(`<button class="btn btn-soft" onclick="roomLoadSaved('${r.code}','recent')">최근 제출 불러오기</button>`);
    [0,1,2].forEach(n=>{const x=liveSaved(mine.slots?.[n]);rows.push(x?`<button class="btn btn-soft" onclick="roomLoadSaved('${r.code}',${n})">${safe(slotName(x,n))} 불러오기</button>`:`<button class="btn btn-soft" onclick="roomSaveSlot('${r.code}',${n})">빈 칸 ${n+1}에 저장</button>`)});
    return `<div class="room-saved"><b>${safe(t.short||t.name)} 저장 라인업</b><div>${rows.join('')}</div></div>`;
  }
  function roomEditor(r){
    const d=draftFor(r),t=team(d.team),rot=t.rotation?.length?t.rotation:[t.pitcher].filter(Boolean);
    // Same player list as the main lineup screen: grouped 포수/내야수/외야수, with the 2026 position under the name.
    const groupOf=p=>p.group||(p[1]==='C'?'C':['LF','CF','RF'].includes(p[1])?'OF':'IF');
    const options=cur=>[['C','포수'],['IF','내야수'],['OF','외야수']].map(([g,label])=>{const list=t.players.map((p,i)=>[p,i]).filter(([p])=>groupOf(p)===g).sort((a,b)=>a[0][0].localeCompare(b[0][0],'ko'));if(!list.length)return '';return `<optgroup label="${label}">${list.map(([p,i])=>{const at=d.order.indexOf(i);return `<option value="${i}" ${i===cur?'selected':''}>${safe(p[0])}${p.number?` #${p.number}`:''}${at>=0&&i!==cur?` · ${at+1}번 타순`:''}</option>`}).join('')}</optgroup>`}).join('');
    const rows=d.order.map((idx,k)=>{const pl=t.players[idx]||{},warn=window.misplacedNote?.(pl,d.pos[k]);return `<tr><td class="slot-number">${k+1}번</td><td><select aria-label="${k+1}번 타자" onchange="roomDraft('${r.code}','player',${k},this.value)">${options(idx)}</select><small class="slot-note">${safe(pl.groupName||'')}${pl.positions?.length&&!['C','IF','OF'].includes(pl.positions[0])?` ${safe(pl.positions.join('·'))}`:''}${pl.real?(pl[8]!=null?` · 2026 ${pl[8]}타석`:' · 2026 기록'):' · 2026 기록 표 없음(리그 평균)'}</small></td><td><select aria-label="${k+1}번 수비" onchange="roomDraft('${r.code}','pos',${k},this.value)">${POS.filter(p=>p!=='C'||window.isCatcher?.(pl)||d.pos[k]==='C').map(p=>`<option ${p===d.pos[k]?'selected':''}>${p}</option>`).join('')}</select>${warn?`<small class="slot-warn">${warn}</small>`:''}</td><td class="num bat-side" title="${{R:'우타',L:'좌타',S:'양타'}[pl[12]]||'타석 정보 없음'}">${{R:'R',L:'L',S:'S'}[pl[12]]||'-'}</td><td class="num">${fmt3(t.players[idx]?.[6]??t.players[idx]?.[2])}</td><td class="num">${fmt3(t.players[idx]?.[7]??((t.players[idx]?.[3]||0)+(t.players[idx]?.[4]||0)))}</td></tr>`}).join('');
    return `<section class="card room-editor"><div class="card-head"><div><h2>내 팀 · 선발 · 라인업</h2><small class="muted tiny">친구 방 ${r.code.slice(0,4)} ${r.code.slice(4)} · 나는 ${sideName(r.my_side)} 편 · 상대 편에는 시작 전까지 저장 인원만 보여요${(r.sides?.[r.my_side]?.players||0)>1?` · 우리 편 ${r.sides[r.my_side].players}명 중 가장 많이 고른 팀·선발·타순으로 나가요`:''}</small></div>${r.my_ready&&!d.dirty?'<span class="tag green">저장됨</span>':d.dirty?'<span class="tag gold">저장 안 됨</span>':''}</div>
      <div class="room-grid"><label>내 팀<select onchange="roomDraft('${r.code}','team',0,this.value)">${TEAMS.map(x=>`<option value="${x.id}" ${x.id===d.team?'selected':''}>${safe(x.name)}</option>`).join('')}</select></label>
      <label>선발 투수<select onchange="roomDraft('${r.code}','sp',0,this.value)">${rot.map((p,i)=>`<option value="${safe(p[0])}" ${(d.sp?p[0]===d.sp:i===0)?'selected':''}>${safe(p[0])} · ${p[6]==='L'?'좌완':'우완'}</option>`).join('')}</select></label></div>
      <div class="room-ai-tools"><span class="tiny muted">현재 팀 선수의 출루율·장타율과 수비 위치를 기준으로 추천해요. 적용 후 직접 바꿀 수 있어요.</span><button class="btn btn-soft" type="button" onclick="roomFillAi('${r.code}')">AI 추천으로 채우기</button></div>
      ${savedBox(r,d)}${window.teamPlanChips?`<div class="room-plan"><b>팀 전술</b><small class="muted tiny">경기 중에도 경기 센터에서 바꿀 수 있어요</small>${window.teamPlanChips({pick:d.plan,action:`roomPlanFor('${r.code}')`})}</div>`:''}<div class="table-scroll"><table class="table room-lineup slot-table"><thead><tr><th>타순</th><th>선수</th><th>수비</th><th title="우타 R · 좌타 L · 양타 S">타석</th><th>타율</th><th>OPS</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="tiny muted room-note">같은 선수를 다른 타순에 고르면 두 타순이 서로 바뀌어요. 포수 자리에는 포수만 넣을 수 있고, 외야수를 내야에(또는 내야수를 외야에) 두면 상대의 실책 출루와 안타가 늘어나요.</p>
      <button class="btn btn-primary room-save" ${R.busy?'disabled':''} onclick="roomSaveSetup('${r.code}')">이 라인업 저장</button></section>`;
  }

  // ---------- lineup screen: which game the lineup is for ----------
  window.lineupContext=v=>{db.lineupCtx=v||null;persist();render()};
  function contextBar(ctx){
    const fixtures=(typeof todayFixtures==='function'?todayFixtures():[]).filter(f=>f.provider!=='room'&&f.status!=='cancelled');
    const pub=fixtures.find(f=>f.id===MATCH.id)||fixtures[0];
    const chips=[`<button class="ctx-chip ${!ctx?'on':''}" onclick="lineupContext(null)"><small>전체 참여 경기</small><b>${pub?`${safe(team(pub.away)?.short||'')} vs ${safe(team(pub.home)?.short||'')} · ${safe(pub.time||'')}`:'오늘은 없어요'}</b></button>`]
      .concat(waiting().map(r=>`<button class="ctx-chip room ${ctx===r.code?'on':''}" onclick="lineupContext('${r.code}')"><small>친구 방</small><b>${r.code.slice(0,4)} ${r.code.slice(4)} · ${sideName(r.my_side)}${r.my_ready?' · ✓':''}</b></button>`));
    return `<div class="lineup-ctx"><span class="lineup-ctx-label">어느 경기 라인업인가요?</span><div class="lineup-ctx-chips">${chips.join('')}</div></div>`;
  }
  function contextBanner(ctx,r){
    if(r)return `<div class="lineup-ctx-banner room"><b>지금 짜는 라인업: 친구 방 ${r.code.slice(0,4)} ${r.code.slice(4)}</b><span>나는 ${sideName(r.my_side)} · 팀과 선발도 여기서 정해요 · 저장하면 방 화면에 「저장 완료」로 보여요</span></div>`;
    return `<div class="lineup-ctx-banner"><b>지금 짜는 라인업: 전체 참여 경기 · ${safe(team(MATCH.away)?.short||'')} vs ${safe(team(MATCH.home)?.short||'')}</b><span>${safe(MATCH.date||'')} ${safe(MATCH.time||'')} · 관리자가 연 경기에 응원팀 팬들과 함께 내는 라인업이에요</span></div>`;
  }
  if(typeof window.lineupPage==='function'){
    const baseLineup=window.lineupPage;
    window.lineupPage=function(){
      if(user()&&R.rooms===null&&!R.loading)load();
      let ctx=db.lineupCtx||null;const r=ctx?find(ctx):null;
      if(ctx&&R.rooms&&(!r||r.status!=='waiting')){ctx=null;db.lineupCtx=null;persist()}
      const showBar=waiting().length>0;
      if(ctx&&r)return header('LINEUP BUILDER','친구 방 라인업','내 팀, 선발 투수, 타순과 수비 위치를 정해요')+(showBar?contextBar(ctx):'')+contextBanner(ctx,r)+roomEditor(r)+`<div class="room-actions" style="margin-top:12px"><button class="btn btn-soft" onclick="go('friend')">방 화면으로</button></div>`;
      return (showBar?contextBar(null):'')+contextBanner(null,null)+baseLineup.apply(this,arguments);
    };
  }

  // An entrance on 홈 (the AI page shows the match while one is running): below the main grid, full width.
  const ENTRY='<section class="card friend-entry"><div><b>친구들과 대결해 볼까요?</b><small class="muted">방을 만들고 8자리 코드를 보내면 친구들과 편을 나눠 붙거나 관전할 수 있어요.</small></div><button class="btn btn-primary" type="button" onclick="go(\'friend\')">친구와 대결</button></section>';
  // On 홈 the card comes first, right under the page title (user request 2026-11-13).
  const afterHead=html=>{const i=html.indexOf('<div class="page-head">');if(i<0)return -1;let depth=0;const re=/<\/?div\b[^>]*>/g;re.lastIndex=i;let m;
    while((m=re.exec(html))){depth+=m[0][1]==='/'?-1:1;if(depth===0)return re.lastIndex}return -1};
  if(typeof window.home==='function'){const baseHome=window.home;window.home=function(){const html=baseHome.apply(this,arguments),at=afterHead(html);return at<0?ENTRY+html:html.slice(0,at)+ENTRY+html.slice(at)}}

  // An invite link (?room=12345678) opens this page with the code filled in.
  const m=/[?&]room=(\d{8})/.exec(location.search);
  if(m){R.code=m[1];setTimeout(()=>{if(typeof go==='function')go('friend')},400)}
  // Keep rooms fresh while the room or lineup page is open (the friend joining, saving, the game starting).
  // While I have a room waiting, check often (wherever I am) so the host's start moves me to 경기 센터.
  setInterval(()=>{if(!user())return;const onRooms=typeof page!=='undefined'&&['friend','lineup'].includes(page);if(onRooms||waiting().length)load()},3000);
  setTimeout(()=>{if(user())load()},1500);
})();
