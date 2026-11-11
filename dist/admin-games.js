/* Admin game management page (?admin=1, admin accounts only): schedule, reschedule and delete
   server games. The page is only a front end; the server functions admin_schedule_fanball_game,
   admin_reschedule_fanball_game and admin_delete_fanball_game check is_admin() themselves.
   Games made here are test games (provider 'demo') with the site's sample rosters. */
(function(){
  const api=()=>window.FANBALL_SERVER_CLIENT;
  const STATUS={scheduled:'예정',running:'진행 중',final:'종료',cancelled:'중단'};
  const A={rows:null,loading:false,error:null,busy:false,editing:null};

  // KST date/time <-> ISO. Inputs are always read as Korea time, whatever the browser's zone.
  const kstParts=d=>{const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(d),v=k=>p.find(x=>x.type===k)?.value;return {date:`${v('year')}-${v('month')}-${v('day')}`,time:`${v('hour')==='24'?'00':v('hour')}:${v('minute')}`}};
  const kstIso=(date,time)=>date&&time?new Date(`${date}T${time}:00+09:00`).toISOString():null;
  const kstLabel=iso=>new Date(iso).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false});

  // Same sample roster the server tools use (tools/browser-sandbox.mjs sampleRoster).
  function rosterSnapshot(ids){
    return {teams:Object.fromEntries(ids.map(id=>{const t=team(id);return [id,{players:t.players,pitcher:t.pitcher,bullpen:t.bullpen||[],order:(t.defaultOrder||t.players.map((_,i)=>i)).slice(0,9)}]}))};
  }
  const errorText=e=>{const m=e?.message||String(e);return ({'admin only':'관리자 계정만 할 수 있습니다.','pick two teams':'두 팀을 골라 주세요.','start time must be in the future':'시작 시각은 지금 이후여야 합니다.','start time must be within 60 days':'시작 시각은 60일 이내로 정해 주세요.','only a game that has not started can be rescheduled':'시작 전 경기만 시간을 바꿀 수 있습니다.','a running game cannot be deleted':'진행 중인 경기는 삭제할 수 없습니다. 끝난 뒤 삭제해 주세요.','official game records cannot be deleted':'공식 경기 기록은 삭제할 수 없습니다.','game not found':'경기를 찾을 수 없습니다.','official games cannot be stopped':'실제 KBO 일정 경기는 중단할 수 없습니다.','only a running game can be stopped':'진행 중인 경기만 중단할 수 있습니다.'})[m]||m};

  async function load(){
    const client=api();if(!client||A.loading)return;
    A.loading=true;
    try{
      const since=new Date(Date.now()-3*86400000).toISOString();
      const {data,error}=await client.from('fanball_games').select('id,status,score,started_at,ended_at,kbo_games!inner(id,scheduled_at,away_team_id,home_team_id,status,provider)').gte('kbo_games.scheduled_at',since).limit(200);
      if(error)throw error;
      A.rows=(data||[]).map(r=>({...r,k:r.kbo_games})).sort((a,b)=>new Date(a.k.scheduled_at)-new Date(b.k.scheduled_at));
      A.error=null;
    }catch(e){A.error=errorText(e)}
    finally{A.loading=false;if(page==='admin')render()}
  }
  async function afterChange(message){
    notify(message);
    await load();
    await window.FANBALL_REMOTE_VOTING?.refreshSchedule?.(true);
  }
  async function call(fn,args,message){
    if(!ADMIN_MODE)return notify('관리자 계정에서만 쓸 수 있습니다.');
    if(A.busy)return;A.busy=true;render();
    try{const {error}=await api().rpc(fn,args);if(error)throw error;A.editing=null;await afterChange(message)}
    catch(e){notify('실패: '+errorText(e))}
    finally{A.busy=false;render()}
  }

  window.adminQuickTime=function(minutes){
    const p=kstParts(new Date(Date.now()+minutes*60000));
    document.querySelector('#admin-date').value=p.date;document.querySelector('#admin-time').value=p.time;
  };
  window.adminScheduleGame=function(){
    const away=document.querySelector('#admin-away').value,home=document.querySelector('#admin-home').value;
    const at=kstIso(document.querySelector('#admin-date').value,document.querySelector('#admin-time').value);
    if(!at)return notify('시작 날짜와 시각을 입력해 주세요.');
    if(new Date(at)<=new Date())return notify('시작 시각은 지금 이후여야 합니다.');
    call('admin_schedule_fanball_game',{p_away_team_id:away,p_home_team_id:home,p_scheduled_at:at,p_lineup_snapshot:rosterSnapshot([away,home])},`${team(away).short} vs ${team(home).short}${away===home?' 이벤트':''} 경기를 ${kstLabel(at)}에 예약했습니다.`);
  };
  window.adminEditGame=function(id){A.editing=A.editing===id?null:id;render()};
  window.adminRescheduleGame=function(id){
    const at=kstIso(document.querySelector('#admin-edit-date').value,document.querySelector('#admin-edit-time').value);
    if(!at)return notify('새 날짜와 시각을 입력해 주세요.');
    if(new Date(at)<=new Date())return notify('시작 시각은 지금 이후여야 합니다.');
    call('admin_reschedule_fanball_game',{p_game_id:id,p_scheduled_at:at},`시작 시각을 ${kstLabel(at)}로 바꿨습니다.`);
  };
  window.adminDeleteGame=function(id){
    const r=A.rows?.find(x=>x.id===id);if(!r)return;
    const label=`${team(r.k.away_team_id)?.short||r.k.away_team_id} vs ${team(r.k.home_team_id)?.short||r.k.home_team_id} (${kstLabel(r.k.scheduled_at)})`;
    const extra=r.status==='final'?'\n경기 기록(타석, 투구, 투표)도 함께 지워지며 되돌릴 수 없습니다.':'\n제출된 라인업 투표도 함께 지워집니다.';
    if(!confirm(`${label} 경기를 삭제할까요?${extra}`))return;
    call('admin_delete_fanball_game',{p_game_id:id},'경기를 삭제했습니다.');
  };
  // Stop a running test game (server: admin_stop_fanball_game). It can be deleted afterwards.
  window.adminStopGame=function(id,label){
    if(!ADMIN_MODE)return notify('관리자 계정에서만 쓸 수 있습니다.');
    const r=A.rows?.find(x=>x.id===id),name=label||(r?`${team(r.k.away_team_id)?.short} vs ${team(r.k.home_team_id)?.short}`:'이 경기');
    if(!confirm(`${name} 경기를 지금 중단할까요?\n중단한 경기는 다시 이어서 할 수 없습니다. 기록은 남고, 필요하면 경기 관리에서 삭제할 수 있습니다.`))return;
    call('admin_stop_fanball_game',{p_game_id:id},'경기를 중단했습니다.').then(()=>window.FANBALL_SERVER_GAME?.load?.(true)).then(()=>{if(typeof render==='function')render()});
  };
  window.adminOpenGame=function(id){
    const r=A.rows?.find(x=>x.id===id);if(!r)return;
    const i=todayFixtures().findIndex(f=>f.id===r.k.id);
    if(i<0)return notify('오늘(한국 시간) 경기만 경기 센터에서 열 수 있습니다.');
    selectHomeFixture(i);go('game');
  };

  function canDelete(r){return r.status!=='running'&&!(r.status==='final'&&r.k.provider!=='demo')}
  function gameRow(r){
    const away=team(r.k.away_team_id),home=team(r.k.home_team_id),today=r.k.scheduled_at&&kstParts(new Date(r.k.scheduled_at)).date===kstParts(new Date()).date;
    const score=r.status==='scheduled'?'':` · ${r.score?.away??0}:${r.score?.home??0}`;
    const tagClass={scheduled:'gold',running:'red',final:'',cancelled:''}[r.status]||'';
    const edit=A.editing===r.id?(()=>{const p=kstParts(new Date(r.k.scheduled_at));return `<div class="admin-edit"><input type="date" id="admin-edit-date" value="${p.date}"><input type="time" id="admin-edit-time" value="${p.time}"><button class="btn btn-primary" ${A.busy?'disabled':''} onclick="adminRescheduleGame('${r.id}')">시간 저장</button><button class="btn btn-soft" onclick="adminEditGame('${r.id}')">취소</button></div>`})():'';
    return `<div class="admin-game"><div class="admin-game-main"><span class="admin-game-time">${kstLabel(r.k.scheduled_at)}</span><strong>${safe(away?.name||r.k.away_team_id)} <i>vs</i> ${safe(home?.name||r.k.home_team_id)}</strong><span class="tag ${tagClass}">${STATUS[r.status]||r.status}${score}</span>${r.k.provider==='demo'?'<span class="tag">테스트</span>':'<span class="tag blue">KBO 일정</span>'}</div><div class="admin-game-actions">${today?`<button class="btn btn-soft" onclick="adminOpenGame('${r.id}')">경기 센터</button>`:''}${r.status==='scheduled'?`<button class="btn btn-soft" ${A.busy?'disabled':''} onclick="adminEditGame('${r.id}')">시간 변경</button>`:''}${r.status==='running'&&r.k.provider==='demo'?`<button class="btn btn-danger" ${A.busy?'disabled':''} onclick="adminStopGame('${r.id}')">경기 중단</button>`:''}${canDelete(r)?`<button class="btn btn-danger" ${A.busy?'disabled':''} onclick="adminDeleteGame('${r.id}')">삭제</button>`:''}</div>${edit}</div>`;
  }

  window.adminGamesPage=function(){
    if(!ADMIN_MODE)return header('ADMIN','경기 관리','관리자 계정으로 로그인해야 열립니다.')+'<div class="card empty">관리자 확인 중이거나 관리자 계정이 아닙니다.</div>';
    if(!api())return header('ADMIN','경기 관리','서버 연결 설정이 필요합니다.');
    if(A.rows===null&&!A.loading)load();
    const p=kstParts(new Date(Date.now()+10*60000)),options=sel=>TEAMS.map(t=>`<option value="${t.id}" ${t.id===sel?'selected':''}>${t.name}</option>`).join('');
    const defaults=[MATCH.away,MATCH.home];
    const form=`<section class="card admin-form"><div class="card-head"><h2>새 경기 예약</h2><span class="tag gold">테스트 경기 · 샘플 선수단</span></div><div class="admin-form-grid"><label>원정팀<select id="admin-away">${options(defaults[0])}</select></label><label>홈팀<select id="admin-home">${options(defaults[1])}</select></label><label>날짜 (한국 시간)<input type="date" id="admin-date" value="${p.date}"></label><label>시작 시각 (한국 시간)<input type="time" id="admin-time" value="${p.time}"></label></div><div class="admin-form-foot"><div class="admin-quick"><span>빠른 설정</span><button class="btn btn-soft" onclick="adminQuickTime(2)">2분 뒤</button><button class="btn btn-soft" onclick="adminQuickTime(10)">10분 뒤</button><button class="btn btn-soft" onclick="adminQuickTime(60)">1시간 뒤</button></div><button class="btn btn-primary" ${A.busy?'disabled':''} onclick="adminScheduleGame()">경기 예약</button></div><p class="tiny muted admin-note">같은 팀끼리도 이벤트 매치로 예약할 수 있습니다(양쪽 라인업이 같아도 그대로 진행). 예약한 시각이 되면 서버가 경기를 자동으로 시작합니다. 시작 전까지 팬들은 라인업 투표를 할 수 있고, 시작 때 대표 라인업이 정해집니다.</p></section>`;
    const list=A.error?`<div class="empty">불러오기 실패: ${safe(A.error)}</div>`:A.rows===null?'<div class="empty">불러오는 중…</div>':A.rows.length?A.rows.map(gameRow).join(''):'<div class="empty">최근 3일 이후 경기가 없습니다.</div>';
    return header('ADMIN','경기 관리','관리자 전용 · 서버 경기 예약, 시간 변경, 삭제')+form+`<section class="card admin-list"><div class="card-head"><div><h2>경기 목록</h2><small class="muted tiny">최근 3일부터 · 시간순</small></div><button class="btn btn-soft" onclick="adminReloadGames()">새로고침</button></div>${list}<p class="tiny muted admin-note">진행 중인 테스트 경기는 먼저 "경기 중단"한 뒤 삭제할 수 있습니다. 실제 KBO 일정 경기는 중단하거나 끝난 기록을 지울 수 없습니다.</p></section>`+patchNotesCard();
  };
  window.adminReloadGames=function(){A.rows=null;render()};
  // Patch notes (dist/patch-notes.js), admins only: one line per update, newest day first. Older days fold up.
  function patchNotesCard(){
    const days=window.FANBALL_PATCH_NOTES||[];if(!days.length)return '';
    const total=days.reduce((n,d)=>n+d.items.length,0);
    const day=(d,i)=>`<details class="patch-day" ${i===0?'open':''}><summary><b>${d.date.replace(/^(\d{4})-(\d\d)-(\d\d)$/,'$1.$2.$3')}</b><span class="tag">${d.items.length}건</span></summary><ul>${d.items.map(x=>`<li>${safe(x)}</li>`).join('')}</ul></details>`;
    return `<section class="card patch-notes"><div class="card-head"><div><h2>패치노트</h2><small class="muted tiny">관리자 전용 · 날짜별 업데이트 ${total}건 · 최신순</small></div></div>${days.map(day).join('')}</section>`;
  }

  // Show the nav entry only once the server confirms this account is an admin.
  const nav=document.querySelector('#nav');
  if(nav&&!nav.querySelector('[data-page="admin"]'))nav.insertAdjacentHTML('beforeend','<button data-page="admin" hidden><i>⚙</i>경기 관리</button>');
  window.FANBALL_ADMIN_NAV=function(){const b=document.querySelector('#nav [data-page="admin"]');if(b)b.hidden=!ADMIN_MODE;if(!ADMIN_MODE&&page==='admin')go('home')};
})();
