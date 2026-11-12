/* Friend rooms (user requests 2026-11-12/13). A signed-in fan makes a room and gets an 8-digit code; a friend
   enters it. Each then picks their own team, starter and lineup on the lineup screen (the other sees only that
   it is done), and the host starts the game; the server plays it like any live game.
   DB: supabase/migrations/202611130001 (rooms), 0002 (delete), 0003 (codes only, hidden setups, host start).
   Also here: the lineup screen's "which game" bar (public game or one of my rooms) and the room lineup editor. */
(function(){
  const api=()=>window.FANBALL_SERVER_CLIENT,user=()=>window.FANBALL_AUTH_USER?.()||null;
  const MINE='fanball-my-rooms';
  const R={rooms:null,loading:false,error:null,busy:false,side:'home',code:'',drafts:{}};
  const store={get(){try{return JSON.parse(localStorage.getItem(MINE)||'[]')}catch(e){return []}},set(v){try{localStorage.setItem(MINE,JSON.stringify(v))}catch(e){}}};
  const errorText=m=>({
    'authentication required':'로그인한 뒤 할 수 있어요.','too many tries':'코드를 너무 많이 틀렸어요. 1분 뒤에 다시 해 주세요.',
    'you already have 3 open rooms':'열어 둔 방이 3개예요. 하나를 지우고 다시 만들어 주세요.','room expired':'방이 만료됐어요(24시간).',
    'the game has started':'이미 경기가 시작됐어요.','room not found':'방을 찾지 못했어요.','your friend has not joined':'친구가 아직 안 들어왔어요.',
    'both lineups are needed':'두 사람 모두 팀과 라인업을 저장해야 시작할 수 있어요.','only the host starts the game':'방을 만든 사람만 시작할 수 있어요.',
    'lineup needs 9 batters and each position once':'타자 9명과 수비 위치 9개를 하나씩 정해 주세요.'})[m]||m;
  const rerender=()=>{if(typeof page!=='undefined'&&['friend','lineup'].includes(page)&&typeof render==='function')render()};
  const waiting=()=>(R.rooms||[]).filter(r=>!r.game_id&&r.status==='waiting');
  const find=code=>(R.rooms||[]).find(r=>r.code===code);

  // Which room games are mine (the schedule hides other people's rooms), and my side's key in a started one.
  window.FANBALL_ROOMS={
    isMine:kboId=>store.get().includes(kboId),
    lineupKeyFor:kboId=>(R.rooms||[]).find(r=>r.kbo_game_id===kboId)?.my_key||null,
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
  window.roomCode=v=>{R.code=String(v||'').replace(/\D/g,'').slice(0,8);const b=document.querySelector('#room-join-btn');if(b)b.disabled=R.code.length!==8};
  window.roomJoin=function(){
    if(R.code.length!==8)return notify('8자리 숫자를 넣어 주세요.');
    return call('join_friend_room',{p_code:R.code},d=>{
      if(d?.error){notify(d.error==='full'?'이미 다른 사람이 들어간 방이에요.':'방을 찾지 못했어요. 코드를 다시 확인해 주세요.');return}
      R.code='';notify('방에 들어왔어요! 라인업 투표 화면에서 내 팀과 라인업을 정해 주세요.');
    });
  };
  window.roomSetSide=(code,v)=>call('set_friend_room_side',{p_code:code,p_host_side:v});
  window.roomStart=code=>call('start_friend_room',{p_code:code},d=>{notify('경기를 시작했어요! 경기 센터로 이동해요.');roomOpen(d.kbo_game_id,'game')});
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
    const host=r.me==='host',w=r.status==='waiting';
    let status;
    if(r.status==='running')status='<span class="tag red">경기 중</span>';else if(r.status==='final')status='<span class="tag">경기 끝</span>';
    else status=!r.has_guest?'<span class="tag gold">친구 기다리는 중</span>':(r.my_ready&&r.other_ready)?'<span class="tag green">시작 준비 끝</span>':'<span class="tag blue">라인업 정하는 중</span>';
    const people=w?`<div class="room-people"><span>나 · ${sideName(r.my_side)} · ${r.my_ready?`✓ ${safe(team(r.my_setup?.team)?.short||'')} 라인업 저장`:'라인업 아직'}</span><span>${r.has_guest?`친구 · ${sideName(r.my_side==='away'?'home':'away')} · ${r.other_ready?'✓ 라인업 저장(비공개)':'라인업 아직'}`:'친구 · 아직 안 들어옴'}</span></div>`:'';
    const canStart=host&&r.has_guest&&r.my_ready&&r.other_ready;
    const actions=w
      ?`<button class="btn ${r.my_ready?'btn-soft':'btn-primary'}" onclick="roomLineup('${r.code}')">${r.my_ready?'내 팀·라인업 고치기':'내 팀·라인업 정하기'}</button>`
        +(host?`<label class="room-side">나는<select onchange="roomSetSide('${r.code}',this.value)"><option value="home" ${r.my_side==='home'?'selected':''}>홈</option><option value="away" ${r.my_side==='away'?'selected':''}>원정</option></select></label><button class="btn btn-primary" ${canStart&&!R.busy?'':'disabled'} onclick="roomStart('${r.code}')">경기 시작</button>`:'')
        +`<button class="btn btn-soft room-delete" onclick="roomDelete('${r.code}','waiting',${host})">${host?'방 삭제':'나가기'}</button>`
      :`<button class="btn btn-primary" onclick="roomOpen('${r.kbo_game_id}','game')">${r.status==='final'?'결과 보기':'경기 보러 가기'}</button><button class="btn btn-soft room-delete" onclick="roomDelete('${r.code}','${r.status}',${host})">${r.status==='running'?'그만두고 방 삭제':'목록에서 지우기'}</button>`;
    const vs=r.away_team_id?`<b>${safe(team(r.away_team_id)?.short||'')} <small>원정</small> vs ${safe(team(r.home_team_id)?.short||'')} <small>홈</small></b>`:`<b>친구 대결 방</b>`;
    const hint=w?(host?(canStart?'준비 끝! 「경기 시작」을 누르면 바로 시작돼요.':'친구가 들어와 두 사람 모두 팀·라인업을 저장하면 「경기 시작」을 누를 수 있어요.'):'방장이 「경기 시작」을 누르면 경기가 시작돼요. 상대의 팀·선발·라인업은 시작할 때 공개돼요.'):'';
    return `<article class="card room-card"><div class="room-head"><div>${vs}<small class="muted">나는 ${sideName(r.my_side)} · ${host?'내가 만든 방':'초대받은 방'}</small></div>${status}</div>
      ${w?`<div class="room-code"><span class="muted tiny">방 코드</span><strong>${r.code.slice(0,4)} ${r.code.slice(4)}</strong><span class="room-code-actions"><button class="btn btn-soft" onclick="roomCopy('${r.code}',false)">코드 복사</button><button class="btn btn-soft" onclick="roomCopy('${r.code}',true)">초대 링크 복사</button></span></div>`:''}
      ${people}<div class="room-actions">${actions}</div>${hint?`<p class="tiny muted">${hint}</p>`:''}</article>`;
  }

  window.friendRoomPage=function(){
    const head=header('FRIEND MATCH','친구와 1대1','방을 만들고 8자리 코드를 친구에게 보내세요');
    if(!api())return head+'<div class="empty">서버 연결 설정이 필요합니다.</div>';
    if(!user())return head+`<section class="card room-login"><h2>로그인하면 친구와 대결할 수 있어요</h2><p class="muted">방을 만들거나 코드로 들어가려면 Google 로그인이 필요해요.</p><button class="btn btn-primary" onclick="openAccount()">로그인</button></section>`;
    if(R.rooms===null&&!R.loading)load();
    const list=(R.rooms||[]).length?`<h2 class="result-section-title">내 방</h2>${R.rooms.map(roomCard).join('')}`:'';
    const create=`<section class="card room-form"><div class="card-head"><h2>방 만들기</h2></div>
      <p class="tiny muted room-note">코드만 먼저 만들어요. 팀·선발·라인업은 친구가 들어온 뒤 각자 라인업 투표 화면에서 정해요(상대에게는 시작 전까지 비공개).</p>
      <div class="room-grid"><label>나는<select onchange="roomSide(this.value)"><option value="home" ${R.side==='home'?'selected':''}>홈 (말 공격)</option><option value="away" ${R.side==='away'?'selected':''}>원정 (초 공격)</option></select></label></div>
      <button class="btn btn-primary" ${R.busy?'disabled':''} onclick="roomCreate()">방 만들고 코드 받기</button><p class="tiny muted room-note">방은 동시에 3개까지 열 수 있어요. 필요 없는 방은 「방 삭제」로 지우면 새로 만들 수 있어요.</p></section>`;
    const join=`<section class="card room-form"><div class="card-head"><h2>코드로 들어가기</h2></div>
      <label class="room-code-input">친구에게 받은 8자리 숫자<input id="room-code" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="12345678" value="${safe(R.code)}" oninput="roomCode(this.value)"></label>
      <button id="room-join-btn" class="btn btn-primary" ${R.code.length===8&&!R.busy?'':'disabled'} onclick="roomJoin()">들어가기</button></section>`;
    return head+(R.error?`<div class="banner">${safe(R.error)}</div>`:'')+list+`<div class="room-two">${join}${create}</div>`;
  };

  // ---------- room lineup editor (on the lineup screen) ----------
  const POS=['C','1B','2B','3B','SS','LF','CF','RF','DH'];
  const catcher=p=>p&&((Array.isArray(p[11])&&p[11].includes('C'))||p[1]==='C');
  function draftFor(r){
    if(R.drafts[r.code])return R.drafts[r.code];
    const s=r.my_setup,teamId=s?.team||db.favorite||'tigers',t=team(teamId);
    const order=s?.order?.slice()||(t.defaultOrder||t.players.map((_,i)=>i)).slice(0,9);
    const pos=order.map((i,k)=>s?.positions?.[t.players[i]?.[0]]||t.defaultPos?.[i]||POS[k]);
    return R.drafts[r.code]={team:teamId,sp:s?.pitcher||null,order,pos,dirty:false};
  }
  window.roomDraft=function(code,k,i,v){
    const r=find(code);if(!r)return;const d=draftFor(r);
    if(k==='team'){const t=team(v);R.drafts[code]={team:v,sp:null,order:(t.defaultOrder||t.players.map((_,i)=>i)).slice(0,9),pos:[],dirty:true};const n=R.drafts[code];n.pos=n.order.map((x,j)=>t.defaultPos?.[x]||POS[j]);return rerender()}
    if(k==='sp'){d.sp=v;d.dirty=true;return rerender()}
    if(k==='player'){const x=Number(v),other=d.order.indexOf(x);if(other>=0){d.order[other]=d.order[i];}d.order[i]=x;d.dirty=true;return rerender()}
    if(k==='pos'){const other=d.pos.indexOf(v);if(other>=0)d.pos[other]=d.pos[i];d.pos[i]=v;d.dirty=true;return rerender()}
  };
  window.roomSaveSetup=function(code){
    const r=find(code);if(!r)return;const d=draftFor(r),t=team(d.team);
    if(new Set(d.order).size!==9)return notify('타자 9명을 서로 다르게 골라 주세요.');
    if(new Set(d.pos).size!==9||!POS.every(p=>d.pos.includes(p)))return notify('수비 위치 9개를 하나씩 정해 주세요.');
    const c=d.order[d.pos.indexOf('C')];if(!catcher(t.players[c]))return notify('포수 자리에는 포수만 넣을 수 있어요.');
    const sp=window.starterFor?window.starterFor(d.team,d.sp):t.pitcher;
    const setup={team:d.team,players:t.players,pitcher:sp,bullpen:window.bullpenFor?window.bullpenFor(d.team,sp?.[0]):(t.bullpen||[]),order:d.order,
      positions:Object.fromEntries(d.order.map((i,k)=>[t.players[i][0],d.pos[k]]))};
    // Saved: back to the room's waiting screen (user request 2026-11-13).
    call('set_friend_room_setup',{p_code:code,p_setup:setup},()=>{d.dirty=false;notify('저장했어요. 상대에게는 「저장 완료」만 보여요.');setTimeout(()=>go('friend'),50)});
  };
  function roomEditor(r){
    const d=draftFor(r),t=team(d.team),rot=t.rotation?.length?t.rotation:[t.pitcher].filter(Boolean);
    const sorted=t.players.map((p,i)=>[p,i]).sort((a,b)=>a[0][0].localeCompare(b[0][0],'ko'));
    const rows=d.order.map((idx,k)=>`<tr><td class="slot-number">${k+1}번</td><td><select aria-label="${k+1}번 타자" onchange="roomDraft('${r.code}','player',${k},this.value)">${sorted.map(([p,i])=>`<option value="${i}" ${i===idx?'selected':''}>${safe(p[0])}</option>`).join('')}</select></td><td><select aria-label="${k+1}번 수비" onchange="roomDraft('${r.code}','pos',${k},this.value)">${POS.map(p=>`<option ${p===d.pos[k]?'selected':''}>${p}</option>`).join('')}</select></td><td class="num">${(t.players[idx]?.[6]??t.players[idx]?.[2]??0).toFixed?.(3)?.replace(/^0/,'')||''}</td></tr>`).join('');
    return `<section class="card room-editor"><div class="card-head"><div><h2>내 팀 · 선발 · 라인업</h2><small class="muted tiny">친구 방 ${r.code.slice(0,4)} ${r.code.slice(4)} · 나는 ${sideName(r.my_side)} · 상대에게는 시작 전까지 「저장 완료」만 보여요</small></div>${r.my_ready&&!d.dirty?'<span class="tag green">저장됨</span>':d.dirty?'<span class="tag gold">저장 안 됨</span>':''}</div>
      <div class="room-grid"><label>내 팀<select onchange="roomDraft('${r.code}','team',0,this.value)">${TEAMS.map(x=>`<option value="${x.id}" ${x.id===d.team?'selected':''}>${safe(x.name)}</option>`).join('')}</select></label>
      <label>선발 투수<select onchange="roomDraft('${r.code}','sp',0,this.value)">${rot.map((p,i)=>`<option value="${safe(p[0])}" ${(d.sp?p[0]===d.sp:i===0)?'selected':''}>${safe(p[0])} · ${p[6]==='L'?'좌완':'우완'}</option>`).join('')}</select></label></div>
      <div class="table-scroll"><table class="table room-lineup"><thead><tr><th>타순</th><th>선수</th><th>수비</th><th>타율</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="tiny muted room-note">같은 선수를 다른 타순에 고르면 두 타순이 서로 바뀌어요. 포수 자리에는 포수만 넣을 수 있어요.</p>
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
  const ENTRY='<section class="card friend-entry"><div><b>친구랑 1대1 해 볼까요?</b><small class="muted">방을 만들고 8자리 코드를 보내면 친구와 바로 붙을 수 있어요.</small></div><button class="btn btn-primary" type="button" onclick="go(\'friend\')">친구와 1대1</button></section>';
  if(typeof window.home==='function'){const baseHome=window.home;window.home=function(){return baseHome.apply(this,arguments)+ENTRY}}

  // An invite link (?room=12345678) opens this page with the code filled in.
  const m=/[?&]room=(\d{8})/.exec(location.search);
  if(m){R.code=m[1];setTimeout(()=>{if(typeof go==='function')go('friend')},400)}
  // Keep rooms fresh while the room or lineup page is open (the friend joining, saving, the game starting).
  // While I have a room waiting, check often (wherever I am) so the host's start moves me to 경기 센터.
  setInterval(()=>{if(!user())return;const onRooms=typeof page!=='undefined'&&['friend','lineup'].includes(page);if(onRooms||waiting().length)load()},3000);
  setTimeout(()=>{if(user())load()},1500);
})();
