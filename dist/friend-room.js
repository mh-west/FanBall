/* Friend rooms (user request 2026-11-12): a signed-in fan opens a private 1-on-1 game, gets an 8-digit code
   and sends it to a friend, who enters it to take the other side. Both set their lineup, press 준비 완료, and
   the server plays it like any live game (supabase/migrations/202611130001_friend_rooms.sql). Other people's
   rooms are hidden from the schedule and the live list (enhancements.js todayFixtures, server-game.js). */
(function(){
  const api=()=>window.FANBALL_SERVER_CLIENT,user=()=>window.FANBALL_AUTH_USER?.()||null;
  const MINE='fanball-my-rooms';
  const R={rooms:null,loading:false,error:null,busy:false,form:null,code:''};
  const store={get(){try{return JSON.parse(localStorage.getItem(MINE)||'[]')}catch(e){return []}},set(v){try{localStorage.setItem(MINE,JSON.stringify(v))}catch(e){}}};
  const errorText=m=>({
    'authentication required':'로그인한 뒤 할 수 있어요.','too many tries':'코드를 너무 많이 틀렸어요. 1분 뒤에 다시 해 주세요.',
    'you already have 3 open rooms':'열어 둔 방이 3개예요. 하나를 닫고 다시 만들어 주세요.','room expired':'방이 만료됐어요(24시간).',
    'the game has started':'이미 경기가 시작됐어요.','room not found':'방을 찾지 못했어요.'})[m]||m;
  const rerender=()=>{if(typeof page!=='undefined'&&page==='friend'&&typeof render==='function')render()};

  // Which room games are mine: the schedule shows only these room games (and the lineup page edits my side).
  window.FANBALL_ROOMS={
    isMine:kboId=>store.get().includes(kboId),
    lineupKeyFor:kboId=>(R.rooms||[]).find(r=>r.kbo_game_id===kboId)?.my_key||null,
    refresh:()=>load(),
  };

  async function load(){
    const c=api();if(!c||!user()||R.loading)return;
    R.loading=true;
    try{const {data,error}=await c.rpc('my_friend_rooms');if(error)throw error;R.rooms=data||[];R.error=null;store.set(R.rooms.map(r=>r.kbo_game_id))}
    catch(e){R.error=errorText(e.message||String(e))}
    finally{R.loading=false;rerender()}
  }

  // The lineup snapshot for a new room: each team's squad, the starter picked here, its bullpen and default order.
  function snapshot(ids,starters){
    return {teams:Object.fromEntries([...new Set(ids)].map(id=>{const t=team(id),sp=window.starterFor?window.starterFor(id,starters[id]):t.pitcher;
      return [id,{players:t.players,pitcher:sp,bullpen:window.bullpenFor?window.bullpenFor(id,sp?.[0]):(t.bullpen||[]),order:(t.defaultOrder||t.players.map((_,i)=>i)).slice(0,9)}]}))};
  }
  function form(){return R.form||(R.form={mine:db.favorite||'tigers',theirs:'doosan',side:'home',mySp:null,theirSp:null})}
  window.roomForm=function(k,v){const f=form();f[k]=v;if(k==='mine')f.mySp=null;if(k==='theirs')f.theirSp=null;rerender()};
  window.roomCreate=async function(){
    if(!user())return openAccount();if(R.busy)return;R.busy=true;rerender();
    const f=form();
    try{
      const {data,error}=await api().rpc('create_friend_room',{p_my_team:f.mine,p_their_team:f.theirs,p_my_side:f.side,p_lineup_snapshot:snapshot([f.mine,f.theirs],{[f.mine]:f.mySp,[f.theirs]:f.theirSp})});
      if(error)throw error;
      notify(`방을 만들었어요. 코드 ${data.code}를 친구에게 보내 주세요.`);await load();window.FANBALL_REMOTE_VOTING?.refreshSchedule?.(true);
    }catch(e){notify('방 만들기 실패: '+errorText(e.message||String(e)))}
    finally{R.busy=false;rerender()}
  };
  window.roomCode=function(v){R.code=String(v||'').replace(/\D/g,'').slice(0,8);const b=document.querySelector('#room-join-btn');if(b)b.disabled=R.code.length!==8};
  window.roomJoin=async function(){
    if(!user())return openAccount();if(R.code.length!==8)return notify('8자리 숫자를 넣어 주세요.');if(R.busy)return;R.busy=true;rerender();
    try{
      const {data,error}=await api().rpc('join_friend_room',{p_code:R.code});
      if(error)throw error;
      if(data?.error)return notify(data.error==='full'?'이미 다른 사람이 들어간 방이에요.':'방을 찾지 못했어요. 코드를 다시 확인해 주세요.');
      notify('방에 들어왔어요! 라인업을 짜고 준비 완료를 눌러 주세요.');R.code='';await load();window.FANBALL_REMOTE_VOTING?.refreshSchedule?.(true);
    }catch(e){notify('입장 실패: '+errorText(e.message||String(e)))}
    finally{R.busy=false;rerender()}
  };
  window.roomReady=async function(gameId,on){
    try{const {error}=await api().rpc('set_friend_room_ready',{p_game_id:gameId,p_ready:on});if(error)throw error;await load()}
    catch(e){notify('실패: '+errorText(e.message||String(e)))}
  };
  // Delete a room in any state (2026-11-13): before the game the host deletes it (the guest leaves), during
  // the game either one stops it, after the game it leaves the list.
  window.roomDelete=async function(gameId,status,host){
    const msg=status==='running'?'경기를 그만두고 방을 삭제할까요? 이 경기는 취소돼요.':status==='scheduled'?(host?'방을 삭제할까요? 이 코드로는 더 이상 들어올 수 없어요.':'방에서 나갈까요?'):'목록에서 지울까요?';
    if(!confirm(msg))return;
    try{const {error}=await api().rpc('delete_friend_room',{p_game_id:gameId});if(error)throw error;notify(status==='scheduled'&&!host?'방에서 나왔어요.':'방을 삭제했어요. 새 방을 만들 수 있어요.');await load()}
    catch(e){notify('실패: '+errorText(e.message||String(e)))}
  };
  window.roomCopy=async function(code,link){
    const text=link?`${location.origin}/?room=${code}`:code;
    try{await navigator.clipboard.writeText(text);notify(link?'초대 링크를 복사했어요.':'코드를 복사했어요.')}catch(e){prompt('복사해서 보내 주세요',text)}
  };
  // Open the room's game on the lineup or game screen (it becomes the selected server game).
  window.roomOpen=function(kboId,where){
    db.activeFixtureId=kboId;persist();
    const rv=window.FANBALL_REMOTE_VOTING;
    Promise.resolve(rv?.refreshSchedule?.(true)).then(()=>{rv?.refresh?.();window.FANBALL_SERVER_GAME?.load?.(true);go(where)});
  };

  const sideName=s=>s==='away'?'원정':'홈';
  function teamOptions(sel){return TEAMS.map(t=>`<option value="${t.id}" ${t.id===sel?'selected':''}>${safe(t.name)}</option>`).join('')}
  function starterOptions(id,sel){const rot=team(id)?.rotation?.length?team(id).rotation:[team(id)?.pitcher].filter(Boolean);return rot.map((p,i)=>`<option value="${safe(p[0])}" ${(sel?p[0]===sel:i===0)?'selected':''}>${safe(p[0])} · ${p[6]==='L'?'좌완':'우완'}</option>`).join('')}

  function roomCard(r){
    const away=team(r.away_team_id),home=team(r.home_team_id),mine=r.my_side,host=r.me==='host';
    const meReady=host?r.host_ready:r.guest_ready,otherReady=host?r.guest_ready:r.host_ready;
    const status=r.status==='running'?'<span class="tag red">경기 중</span>':r.status==='final'?'<span class="tag">경기 끝</span>':!r.has_guest?'<span class="tag gold">친구 기다리는 중</span>':'<span class="tag blue">준비 중</span>';
    const people=r.status==='scheduled'?`<div class="room-people"><span>나 · ${sideName(mine)} ${meReady?'✓ 준비 완료':'준비 전'}</span><span>${r.has_guest?`친구 · ${sideName(mine==='away'?'home':'away')} ${otherReady?'✓ 준비 완료':'준비 전'}`:'친구 · 아직 안 들어옴'}</span></div>`:'';
    const actions=r.status==='scheduled'
      ?`<button class="btn btn-soft" onclick="roomOpen('${r.kbo_game_id}','lineup')">내 라인업 짜기</button>${r.has_guest?`<button class="btn ${meReady?'btn-soft':'btn-primary'}" onclick="roomReady('${r.game_id}',${!meReady})">${meReady?'준비 취소':'준비 완료'}</button>`:''}<button class="btn btn-soft room-delete" onclick="roomDelete('${r.game_id}','scheduled',${host})">${host?'방 삭제':'나가기'}</button>`
      :`<button class="btn btn-primary" onclick="roomOpen('${r.kbo_game_id}','game')">${r.status==='final'?'결과 보기':'경기 보러 가기'}</button><button class="btn btn-soft room-delete" onclick="roomDelete('${r.game_id}','${r.status}',${host})">${r.status==='running'?'그만두고 방 삭제':'목록에서 지우기'}</button>`;
    return `<article class="card room-card"><div class="room-head"><div><b>${safe(away?.short||r.away_team_id)} <small>원정</small> vs ${safe(home?.short||r.home_team_id)} <small>홈</small></b><small class="muted">나는 ${sideName(mine)} · ${host?'내가 만든 방':'초대받은 방'}</small></div>${status}</div>
      ${r.status==='scheduled'?`<div class="room-code"><span class="muted tiny">방 코드</span><strong>${r.code.slice(0,4)} ${r.code.slice(4)}</strong><span class="room-code-actions"><button class="btn btn-soft" onclick="roomCopy('${r.code}',false)">코드 복사</button><button class="btn btn-soft" onclick="roomCopy('${r.code}',true)">초대 링크 복사</button></span></div>`:''}
      ${people}<div class="room-actions">${actions}</div>
      ${r.status==='scheduled'&&r.has_guest?'<p class="tiny muted">두 사람 모두 준비 완료를 누르면 바로 경기가 시작돼요. 라인업을 안 내면 기본 라인업으로 해요.</p>':''}</article>`;
  }

  window.friendRoomPage=function(){
    const head=header('FRIEND MATCH','친구와 1대1','방을 만들고 8자리 코드를 친구에게 보내세요');
    if(!api())return head+'<div class="empty">서버 연결 설정이 필요합니다.</div>';
    if(!user())return head+`<section class="card room-login"><h2>로그인하면 친구와 대결할 수 있어요</h2><p class="muted">방을 만들거나 코드로 들어가려면 Google 로그인이 필요해요.</p><button class="btn btn-primary" onclick="openAccount()">로그인</button></section>`;
    if(R.rooms===null&&!R.loading)load();
    const f=form();
    const list=(R.rooms||[]).length?`<h2 class="result-section-title">내 방</h2>${R.rooms.map(roomCard).join('')}`:'';
    const create=`<section class="card room-form"><div class="card-head"><h2>방 만들기</h2></div>
      <div class="room-grid">
        <label>내 팀<select onchange="roomForm('mine',this.value)">${teamOptions(f.mine)}</select></label>
        <label>내 선발<select onchange="roomForm('mySp',this.value)">${starterOptions(f.mine,f.mySp)}</select></label>
        <label>친구 팀<select onchange="roomForm('theirs',this.value)">${teamOptions(f.theirs)}</select></label>
        <label>친구 선발<select onchange="roomForm('theirSp',this.value)">${starterOptions(f.theirs,f.theirSp)}</select></label>
        <label>나는<select onchange="roomForm('side',this.value)"><option value="home" ${f.side==='home'?'selected':''}>홈 (말 공격)</option><option value="away" ${f.side==='away'?'selected':''}>원정 (초 공격)</option></select></label>
      </div>
      <button class="btn btn-primary" ${R.busy?'disabled':''} onclick="roomCreate()">방 만들고 코드 받기</button><p class="tiny muted room-note">방은 동시에 3개까지 열 수 있어요. 필요 없는 방은 위 「방 삭제」로 지우면 새로 만들 수 있어요.</p></section>`;
    const join=`<section class="card room-form"><div class="card-head"><h2>코드로 들어가기</h2></div>
      <label class="room-code-input">친구에게 받은 8자리 숫자<input id="room-code" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="12345678" value="${safe(R.code)}" oninput="roomCode(this.value)"></label>
      <button id="room-join-btn" class="btn btn-primary" ${R.code.length===8&&!R.busy?'':'disabled'} onclick="roomJoin()">들어가기</button></section>`;
    return head+(R.error?`<div class="banner">${safe(R.error)}</div>`:'')+list+`<div class="room-two">${join}${create}</div>`;
  };

  // An entrance on 홈 too (the AI page shows the match instead of its setup while one is running).
  const ENTRY='<section class="card friend-entry"><div><b>친구랑 1대1 해 볼까요?</b><small class="muted">방을 만들고 8자리 코드를 보내면 친구와 바로 붙을 수 있어요.</small></div><button class="btn btn-primary" type="button" onclick="go(\'friend\')">친구와 1대1</button></section>';
  if(typeof window.home==='function'){const baseHome=window.home;window.home=function(){const html=baseHome.apply(this,arguments),i=html.indexOf('<section');return i<0?html+ENTRY:html.slice(0,i)+ENTRY+html.slice(i)}}
  // An invite link (?room=12345678) opens this page with the code filled in.
  const m=/[?&]room=(\d{8})/.exec(location.search);
  if(m){R.code=m[1];setTimeout(()=>{if(typeof go==='function')go('friend')},400)}
  // Keep the room list fresh while the page is open (the friend joining, ready, the game starting).
  setInterval(()=>{if(typeof page!=='undefined'&&page==='friend'&&user())load()},5000);
  setTimeout(()=>{if(user())load()},1500);
})();
