/* MVP interaction refinements. This script loads after app.js so shared screens and engine hooks can be replaced cleanly. */
const PITCH_TYPES=['직구','슬라이더','커브','체인지업','포크'];
const DEFAULT_PITCH_SPEEDS={'직구':[138,148],'슬라이더':[124,136],'커브':[108,122],'체인지업':[120,134],'포크':[125,138]};
// ?admin=1 only asks for the developer tools; they turn on after the server confirms this account
// is an admin (public.is_admin(), checked in account.js). These tools only touch this browser's demo.
const ADMIN_REQUESTED=new URLSearchParams(location.search).get('admin')==='1'||new URLSearchParams(location.search).get('mode')==='admin';
let ADMIN_MODE=false;
let selectedLogInning=1;
db.lineupSubmitted=db.lineupSubmitted||{};
function lineupSubmissionKey(teamId){return `${MATCH.id}:${teamId}`}
const shell=document.querySelector('.shell'),sidebarToggle=document.querySelector('#sidebarToggle');
if(shell){const collapsed=localStorage.getItem('fanball-sidebar-collapsed')==='1';shell.classList.toggle('collapsed',collapsed);if(sidebarToggle)sidebarToggle.setAttribute('aria-expanded',String(!collapsed))}
if(sidebarToggle)sidebarToggle.onclick=()=>{const collapsed=shell.classList.toggle('collapsed');localStorage.setItem('fanball-sidebar-collapsed',collapsed?'1':'0');sidebarToggle.setAttribute('aria-expanded',String(!collapsed));sidebarToggle.setAttribute('aria-label',collapsed?'왼쪽 메뉴 펼치기':'왼쪽 메뉴 접기')};
const resetDemoButton=document.querySelector('#resetDemo');
if(resetDemoButton)resetDemoButton.hidden=!ADMIN_MODE;

function bounded(value,low,high){return Math.max(low,Math.min(high,value))}
function opposingStarter(teamId){return team(teamId===MATCH.away?MATCH.home:MATCH.away)}
function lineupAnnouncementTime(match=MATCH){
  if(match.lineupAnnouncementTime)return match.lineupAnnouncementTime;
  return (match.isWeekend||match.isPublicHoliday)?'13:00':'17:30';
}
function samplePitcherAverage(player,pitcherName){
  const h=hash(player[0]+'|'+pitcherName);
  return bounded(player[2]+((h%31)-15)/1000,.05,.5);
}
function officialLineupFor(teamId){
  return window.FANBALL_OFFICIAL_LINEUPS?.[MATCH.id]?.teams?.[teamId]||null;
}
function officialLineupsPanel(){
  const teamsHtml=[MATCH.away,MATCH.home].map(id=>{
    const t=team(id),official=officialLineupFor(id),hitters=official?.hitters||[];
    if(!hitters.length)return `<section class="official-team"><div class="official-team-head"><b>${t.name}</b><span class="tag gold">공식 데이터 연결 대기</span></div><p>오늘 실제 KBO 선발 라인업은 연결된 공식 데이터 공급원이 확인된 뒤 여기에 표시됩니다. 이 영역은 샘플 선수 명단으로 대체하지 않습니다.</p></section>`;
    return `<section class="official-team"><div class="official-team-head"><b>${t.name}</b><span class="tag blue">${official.confirmedAt||'KBO 발표 확인'}</span></div><ol>${hitters.slice().sort((a,b)=>a.battingOrder-b.battingOrder).map(h=>`<li><span>${h.battingOrder}번</span><b>${safe(h.name)}</b><small>${safe(h.position||'')}</small></li>`).join('')}</ol><button class="btn btn-soft" onclick="loadOfficialLineup('${id}')">이 라인업을 편집 시작점으로 불러오기</button></section>`;
  }).join('');
  return `<section class="card official-reference"><div class="card-head"><div><h2>오늘 실제 KBO 선발 라인업</h2><div class="tiny muted">발표 기준 ${lineupAnnouncementTime()} · 참고용</div></div><span class="tag">${MATCH.date}</span></div><div class="official-grid">${teamsHtml}</div></section>`;
}

// Batting order 1-9 stays fixed; each slot picks a player from the whole squad and a position.
function lineupSlotsTable(t,l,pitcher,id=t.id){
  const groups=[['C','포수'],['IF','내야수'],['OF','외야수']],positions=['C','1B','2B','3B','SS','LF','CF','RF','DH'];
  const options=cur=>groups.map(([g,label])=>{const list=t.players.map((p,i)=>[p,i]).filter(([p])=>(p.group||(p[1]==='C'?'C':['LF','CF','RF'].includes(p[1])?'OF':'IF'))===g).sort((a,b)=>a[0][0].localeCompare(b[0][0],'ko'));if(!list.length)return '';return `<optgroup label="${label}">${list.map(([p,i])=>{const at=l.order.indexOf(i);return `<option value="${i}" ${i===cur?'selected':''}>${safe(p[0])}${p.number?` #${p.number}`:''}${at>=0&&i!==cur?` · ${at+1}번 타순`:''}</option>`}).join('')}</optgroup>`}).join('');
  const rows=l.order.map((i,slot)=>{const p=t.players[i],ops=p[7]??(p[3]+p[4]),v=samplePitcherAverage(p,pitcher);return `<tr><td class="slot-number">${slot+1}번</td><td><select class="slot-player" aria-label="${slot+1}번 타자" onchange="slotPlayer('${id}',${slot},this.value)">${options(i)}</select><small class="slot-note">${p.groupName||''}${p.real?(p[8]!=null?` · 2026 ${p[8]}타석`:' · 2026 기록'):' · 2026 기록 표 없음(리그 평균)'}</small></td><td><select aria-label="${slot+1}번 수비 위치" onchange="slotPosition('${id}',${slot},this.value)">${positions.filter(pos=>pos!=='C'||isCatcher(p)||l.pos[i]==='C').map(pos=>`<option ${l.pos[i]===pos?'selected':''}>${pos}</option>`).join('')}</select>${misplacedNote(p,l.pos[i])?`<small class="slot-warn">${misplacedNote(p,l.pos[i])}</small>`:''}</td><td>${(p[6]??p[2]).toFixed(3).slice(1)}</td><td>${ops.toFixed(3)}</td><td>${v.toFixed(3).slice(1)}</td></tr>`}).join('');
  return `<div style="overflow:auto"><table class="table lineup-table slot-table"><thead><tr><th>타순</th><th>선수</th><th>수비</th><th>AVG</th><th>OPS</th><th>vs 선발 AVG</th></tr></thead><tbody>${rows}</tbody></table></div><p class="tiny muted" style="margin-top:8px">타순 칸은 그대로 두고 선수를 바꿉니다. 다른 타순에 있는 선수를 고르면 두 선수의 타순이 맞바뀌고, 벤치 선수를 고르면 원래 선수의 수비 위치를 이어받습니다. 수비 위치가 겹치면 두 칸의 위치를 맞바꿉니다. 수비 위치는 자유롭게 정할 수 있지만 포수는 포수만 맡을 수 있고, 외야수를 내야에(또는 내야수를 외야에) 두면 경기에서 상대의 실책 출루와 안타가 늘어납니다.</p>`;
}
window.slotPlayer=function(id,slot,value){
  const l=ln(id),t=team(id),i=Number(value),cur=l.order[slot];if(!t.players[i]||i===cur)return;
  // Lineups saved before always have 9 players; start from the default if not.
  if(l.order.length!==9){l.order=(t.defaultOrder||[]).slice(0,9)}
  const other=l.order.indexOf(i);
  if(other<0&&l.pos[cur]==='C'&&!isCatcher(t.players[i]))return notify('포수 자리에는 포수만 넣을 수 있습니다.'),render();
  if(other>=0)l.order[other]=cur;   // swap batting slots; positions stay with the players
  else l.pos[i]=l.pos[cur];          // a bench player takes over the position
  l.order[slot]=i;persist();render();
};
window.slotPosition=function(id,slot,newPosition){
  const l=ln(id),t=team(id),i=l.order[slot],old=l.pos[i],otherSlot=l.order.findIndex(j=>j!==i&&l.pos[j]===newPosition);
  if(newPosition==='C'&&!isCatcher(t.players[i]))return notify('포수 자리에는 포수만 넣을 수 있습니다.'),render();
  if(otherSlot>=0&&old==='C'&&!isCatcher(t.players[l.order[otherSlot]]))return notify('포수가 빠지면 포수 자리를 이어받을 선수가 없습니다. 다른 포수를 먼저 넣어 주세요.'),render();
  if(otherSlot>=0)l.pos[l.order[otherSlot]]=old;
  l.pos[i]=newPosition;persist();render();
};
// Event match (a team against itself): the fan picks which side's lineup to vote on.
function eventSidePicker(where){
  const rv=window.FANBALL_REMOTE_VOTING;if(!rv?.isEventForMe?.())return '';
  const side=rv.mySide(),t=team(MATCH.home),btn=(k,label)=>`<button class="btn ${side===k?'btn-primary':'btn-soft'}" onclick="FANBALL_REMOTE_VOTING.chooseSide('${k}')">${label} ${t.short}${side===k?' · 선택됨':''}</button>`;
  return `<section class="card event-side"><div class="card-head"><div><h2>이벤트 매치 · ${t.short} vs ${t.short}</h2><small class="muted tiny">${where==='game'?'내가 고른 쪽의 작전에 투표합니다. 경기가 시작되면 쪽을 바꿀 수 없습니다.':'원정과 홈 라인업을 따로 뽑습니다. 내가 짤 쪽을 고르세요. 경기 시작 전까지 바꿀 수 있고, 제출한 라인업도 함께 옮겨집니다.'}</small></div><span class="tag gold">이벤트</span></div><div class="event-side-buttons">${btn('away','원정')}${btn('home','홈')}</div></section>`;
}
// Saved lineups (this browser only): the last submitted lineup per team, plus 3 slots the fan saves by
// hand. Stored by player name and position, so they still load after the squad list changes.
const SAVED_KEY='fanball-saved-lineups-v1';
function savedLineups(){try{return JSON.parse(localStorage.getItem(SAVED_KEY)||'{}')}catch(_){return {}}}
function writeSavedLineups(all,{fromSync=false}={}){try{localStorage.setItem(SAVED_KEY,JSON.stringify(all))}catch(_){notify('이 브라우저에서는 저장할 수 없습니다.')}if(!fromSync)window.FANBALL_SYNC?.push('saved_lineups',all)}
// A deleted slot keeps a marker ({deleted:true, at}) so the deletion wins over older copies on other devices.
function liveSaved(x){return x&&!x.deleted&&x.slots?x:null}
function lineupSnapshot(id){const l=ln(id),t=team(id);return {at:Date.now(),slots:l.order.map(i=>({player:t.players[i][0],pos:l.pos[i]}))}}
function rememberSubmittedLineup(id){const all=savedLineups(),k=team(id).id;all[k]=all[k]||{slots:[null,null,null]};all[k].recent=lineupSnapshot(id);writeSavedLineups(all)}
window.saveLineupSlot=function(id,n){
  const all=savedLineups(),k=team(id).id;all[k]=all[k]||{slots:[null,null,null]};
  if(liveSaved(all[k].slots[n])&&!confirm(`저장 ${n+1}에 있는 라인업을 지금 라인업으로 바꿀까요?`))return;
  all[k].slots[n]=lineupSnapshot(id);writeSavedLineups(all);render();notify(`지금 라인업을 저장 ${n+1}에 저장했습니다.`);
};
window.deleteLineupSlot=function(id,n){const all=savedLineups(),k=team(id).id;if(!liveSaved(all[k]?.slots[n]))return;if(!confirm(`저장 ${n+1}을 지울까요?`))return;all[k].slots[n]={deleted:true,at:Date.now()};writeSavedLineups(all);render()};
window.loadSavedLineup=function(id,which){
  const all=savedLineups(),k=team(id).id,saved=liveSaved(which==='recent'?all[k]?.recent:all[k]?.slots[which]);if(!saved)return;
  const t=team(id),idx=saved.slots.map(s=>t.players.findIndex(p=>p[0]===s.player)),missing=saved.slots.filter((s,j)=>idx[j]<0).map(s=>s.player);
  if(missing.length)return notify(`지금 명단에 없는 선수가 있어 불러오지 못했습니다: ${missing.join(', ')}`);
  const l=ln(id);l.order=idx;saved.slots.forEach((s,j)=>{l.pos[idx[j]]=s.pos});persist();render();
  notify(which==='recent'?'최근 제출한 라인업을 불러왔습니다. 제출해야 반영됩니다.':`저장 ${which+1}을 불러왔습니다. 제출해야 반영됩니다.`);
};
function savedLineupsCard(id){
  const k=team(id).id,mine=savedLineups()[k]||{slots:[null,null,null]},when=at=>new Date(at).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const preview=x=>x.slots.slice(0,4).map(s=>safe(s.player)).join(' · ')+(x.slots.length>4?' …':'');
  const recent=liveSaved(mine.recent)?`<div class="saved-row recent"><div><b>최근 제출</b><small>${when(mine.recent.at)} · ${preview(mine.recent)}</small></div><button class="btn btn-soft" onclick="loadSavedLineup('${id}','recent')">불러오기</button></div>`:'<div class="saved-row empty-row"><div><b>최근 제출</b><small>라인업을 제출하면 여기에 자동으로 남습니다.</small></div></div>';
  const slots=[0,1,2].map(n=>{const x=liveSaved(mine.slots?.[n]);return `<div class="saved-row"><div><b>저장 ${n+1}</b><small>${x?`${when(x.at)} · ${preview(x)}`:'비어 있음'}</small></div><span class="saved-actions">${x?`<button class="btn btn-soft" onclick="loadSavedLineup('${id}',${n})">불러오기</button>`:''}<button class="btn btn-soft" onclick="saveLineupSlot('${id}',${n})">${x?'덮어쓰기':'지금 라인업 저장'}</button>${x?`<button class="btn btn-soft saved-del" aria-label="저장 ${n+1} 지우기" onclick="deleteLineupSlot('${id}',${n})">✕</button>`:''}</span></div>`}).join('');
  return `<section class="card saved-lineups"><div class="card-head"><div><h2>내 라인업 저장 · 불러오기</h2><small class="muted tiny">${team(id).short} · ${window.FANBALL_AUTH_USER?.()?'로그인한 계정에 저장돼 다른 기기에서도 보입니다':'이 브라우저에만 저장됩니다 · 로그인하면 계정에 저장됩니다'}</small></div></div>${recent}${slots}</section>`;
}
// Current lineup vote tally for the selected server game (fanball_lineup_tally): what each side's
// representative lineup would be if the game started now. Refreshed every 15 seconds on this page.
const TALLY={gameId:null,at:0,data:null,loading:false};
async function loadLineupTally(){
  const client=window.FANBALL_SERVER_CLIENT;if(!client||TALLY.loading)return;
  TALLY.loading=true;
  try{
    if(!window.FANBALL_SERVER_GAME?.gameRow?.())await window.FANBALL_SERVER_GAME?.load?.(true);
    const row=window.FANBALL_SERVER_GAME?.gameRow?.();
    if(!row){TALLY.gameId=null;TALLY.data=null;TALLY.noGame=true;return}TALLY.noGame=false;
    const {data,error}=await client.rpc('fanball_lineup_tally',{p_game_id:row.id});
    if(!error){TALLY.gameId=row.id;TALLY.data=data}
  }finally{TALLY.at=Date.now();TALLY.loading=false;
    // Update only the tally card, so an open player list on this page is not closed.
    const slot=document.querySelector('#lineup-tally-slot');if(page==='lineup'&&slot)slot.innerHTML=lineupTallyInner(slot.dataset.key)}
}
// Every second: reload the tally when 15 seconds have passed, and update the countdown on the card.
if(typeof setInterval==='function')setInterval(()=>{
  if(page!=='lineup')return;
  if(Date.now()-TALLY.at>=15000)loadLineupTally();
  const el=document.querySelector('#tally-countdown');if(el)el.textContent=tallyClock();
},1000);
function tallyClock(){if(TALLY.loading)return '갱신 중…';if(!TALLY.at)return '';const left=Math.max(0,Math.ceil((15000-(Date.now()-TALLY.at))/1000));return `${new Date(TALLY.at).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})} 갱신 · ${left}초 후 다시 갱신`}
window.refreshLineupTally=()=>{TALLY.at=0;loadLineupTally()};
function lineupTallyCard(myKey){
  if(!window.FANBALL_SERVER_CLIENT)return '';
  const row=window.FANBALL_SERVER_GAME?.gameRow?.();
  if(!TALLY.loading&&(Date.now()-TALLY.at>15000||(row&&TALLY.gameId!==row.id&&Date.now()-TALLY.at>2000)))setTimeout(loadLineupTally,0);
  return `<div id="lineup-tally-slot" data-key="${myKey}">${lineupTallyInner(myKey)}</div>`;
}
function lineupTallyInner(myKey){
  const row=window.FANBALL_SERVER_GAME?.gameRow?.(),d=TALLY.data;if(!d||(row&&TALLY.gameId!==row.id))return '';
  const event=MATCH.away===MATCH.home,keys=[sideKey(MATCH.away,MATCH.home,'away'),MATCH.home];
  const block=key=>{const t=d[key]||{submissions:0},side=key===keys[0]?'away':'home',name=`${team(key)?.short||''}${event?(side==='away'?' 원정':' 홈'):` (${side==='away'?'원정':'홈'})`}`;
    const list=t.players?.length?`<ol class="tally-list">${t.players.map(n=>`<li><b>${safe(n)}</b><span>${t.positions?.[n]||''}</span></li>`).join('')}</ol>`:'<p class="tiny muted">아직 제출이 없습니다. 이대로 시작하면 기본 라인업으로 경기합니다.</p>';
    return `<div class="tally-team ${key===myKey?'mine':''}"><div class="tally-head"><b>${safe(name)}</b><span class="tag ${key===myKey?'blue':''}">${t.submissions||0}명 제출${key===myKey?' · 내 쪽':''}</span></div>${list}</div>`};
  const closed=d.status&&d.status!=='scheduled';
  return `<section class="card lineup-tally"><div class="card-head"><div><h2>${closed?'확정된 대표 라인업':'현재 대표 라인업 (중간 집계)'}</h2><small class="muted tiny">${closed?'경기 시작 때 정해진 라인업입니다.':'지금 시작하면 이 라인업으로 경기합니다 · 누가 냈는지는 공개되지 않습니다'}</small>${closed?'':`<small class="tally-clock" id="tally-countdown">${tallyClock()}</small>`}</div>${closed?'':'<button class="btn btn-soft" onclick="refreshLineupTally()">지금 갱신</button>'}</div><div class="tally-grid">${keys.map(block).join('')}</div></section>`;
}
function lineupPage(){
  const rv=window.FANBALL_REMOTE_VOTING,event=rv?.isEventForMe?.(),side=event?rv.mySide():null;
  if(event&&!lineupPage.asked){lineupPage.asked=true;rv.refresh().then(()=>{if(page==='lineup')render()})}
  const key=event&&side?sideKey(MATCH.away,MATCH.home,side):db.favorite;
  const t=team(key),l=ln(key),opp=opposingStarter(t.id),pitcher=opp.pitcher[0];
  if(l.order.length!==9){l.order=(t.defaultOrder||t.players.map((_,i)=>i)).slice(0,9);persist()}
  // Each of the 9 positions once: a repeated or unknown position takes one that is missing.
  {const all=['C','1B','2B','3B','SS','LF','CF','RF','DH'],seen=new Set(),fix=[];for(const i of l.order){if(all.includes(l.pos[i])&&!seen.has(l.pos[i]))seen.add(l.pos[i]);else fix.push(i)}const missing=all.filter(x=>!seen.has(x));if(fix.length){fix.forEach((i,k)=>{l.pos[i]=missing[k]});persist()}}
  return `${header('LINEUP BUILDER','팬이 만드는 선발 라인업','응원팀 타자 9명과 타순·수비를 정하세요.',`<span class="tag blue">응원팀: ${t.name}${side?` (${side==='away'?'원정':'홈'})`:''}</span>`)}${eventSidePicker('lineup')}
  <div class="banner">팬은 자기 응원팀의 타자 라인업만 구성합니다. 선발투수는 선택하지 않습니다. 라인업 발표 시각은 평일 ${lineupAnnouncementTime()}, 주말·공휴일 ${lineupAnnouncementTime({...MATCH,isWeekend:true})} 기준입니다. 1번부터 9번 타순 칸마다 선수와 수비 위치를 고르세요.</div>
  ${officialLineupsPanel()}
  <div class="lineup-layout"><section class="card"><div class="card-head"><h2>${t.name} · 타자 명단</h2><span class="tag blue">상대 선발 ${pitcher} · 샘플</span></div>
  ${lineupSlotsTable(t,l,pitcher,key)}
  <div class="lineup-controls"><span class="tiny muted">선발투수 · ${pitcher} (KBO 발표 기준)</span><button class="btn btn-primary" onclick="submit('${key}')">라인업 제출하기　→</button></div></section>
  <div class="grid" style="align-content:start">${lineupTallyCard(event&&!side?'':key)}${savedLineupsCard(key)}<section class="card"><div class="card-head"><h2>현재 라인업</h2><span class="tag">${l.order.length}/9</span></div><div class="order-list">${l.order.map((i,j)=>`<div class="order-item"><span class="order-chip">${j+1}</span><b>${t.players[i][0]}</b><span class="muted">${l.pos[i]}</span></div>`).join('')||'<div class="empty">타순을 배치하세요.</div>'}</div></section>
  <section class="card"><div class="card-head"><h2>대표 라인업 선정 방식</h2><span class="tag blue">타순별 최다 득표</span></div><div class="vote-choice"><p class="tiny muted" style="line-height:1.7">경기 시작 전까지 같은 팀 팬들이 제출한 라인업으로 대표 라인업을 정합니다. 1번부터 9번까지 차례로 그 타순에 가장 많이 오른 선수를 뽑고(이미 뽑힌 선수는 제외, 동표면 먼저 제출한 쪽), 수비 위치도 선수별 최다 득표로 정합니다. 제출이 없으면 기본 라인업으로 경기합니다. 다시 제출하면 내 표가 바뀝니다.</p><button class="btn btn-green" style="width:100%" onclick="submit('${t.id}')">이 라인업으로 투표하기</button></div></section></div></div>
  <div class="notice">선수 명단은 구단별 선수단 자료 기준이며, 기록 입력 전 선수의 AVG·OPS는 리그 평균값입니다. 상대 선발 AVG는 샘플 표시값입니다.</div>`;
}

window.positionChange=function(id,index,newPosition){
  const l=ln(id),oldPosition=l.pos[index],other=l.pos.indexOf(newPosition);
  if(other>=0&&other!==index)l.pos[other]=oldPosition;
  l.pos[index]=newPosition;persist();render();
};
window.orderChange=function(id,playerIndex,value){
  const roster=team(id).players.map((_,i)=>i),l=ln(id),target=Number(value);
  l.order=[...new Set(l.order.filter(i=>roster.includes(i)))];
  if(target<0)l.order=l.order.filter(i=>i!==playerIndex);
  else{l.order=l.order.filter(i=>i!==playerIndex);const insertion=Math.max(0,Math.min(target,l.order.length));l.order.splice(insertion,0,playerIndex);l.order=l.order.slice(0,9)}
  persist();render();
};
window.loadOfficialLineup=function(id){
  const official=officialLineupFor(id),roster=team(id),hitters=official?.hitters||[];
  if(hitters.length!==9)return notify('공식 선발 라인업 9명을 확인할 수 없습니다.');
  const indices=hitters.slice().sort((a,b)=>a.battingOrder-b.battingOrder).map(h=>roster.players.findIndex(p=>p[0]===h.name));
  if(indices.some(i=>i<0))return notify('샘플 선수 명단과 실제 선수 명단이 달라 불러오지 못했습니다.');
  const l=ln(id);l.order=indices;l.pos=hitters.slice().sort((a,b)=>a.battingOrder-b.battingOrder).map(h=>h.position);persist();render();notify('실제 라인업을 편집 시작점으로 불러왔습니다.');
};
window.submit=async function(id){
  if(window.FANBALL_REMOTE_VOTING?.isEventForMe?.()&&!window.FANBALL_REMOTE_VOTING.mySide())return notify('이벤트 매치입니다. 원정과 홈 중 내가 짤 쪽을 먼저 골라 주세요.');
  if(ln(id).order.length!==9)return notify('타순에 9명의 선수를 배치해 주세요.');
  const l=ln(id),t=team(id),slots=l.order.map(i=>({player:t.players[i][0],pos:l.pos[i]}));
  if([...slots.map(s=>s.pos)].sort().join()!==['1B','2B','3B','C','CF','DH','LF','RF','SS'].join())return notify('수비 위치 C·1B·2B·3B·SS·LF·CF·RF·DH를 한 명씩 정해 주세요.');
  // A server game that has not started takes the lineup into the representative lineup vote.
  await window.FANBALL_SERVER_GAME?.load?.(true);
  const row=window.FANBALL_SERVER_GAME?.gameRow?.();
  if(row?.status==='scheduled'&&window.FANBALL_SERVER_CLIENT){
    if(!window.FANBALL_AUTH_USER?.())return notify('대표 라인업 투표는 로그인 후 제출할 수 있습니다.');
    // Event match: make sure the server has the side this lineup is for before submitting it.
    if(window.FANBALL_REMOTE_VOTING?.isEventForMe?.()){const side=id.endsWith('@away')?'away':'home';if(!await window.FANBALL_REMOTE_VOTING.chooseSide(side,{quiet:true}))return}
    const {error}=await window.FANBALL_SERVER_CLIENT.rpc('submit_fanball_lineup',{p_game_id:row.id,p_slots:slots});
    if(error)return notify('제출하지 못했습니다: '+(error.message==='lineup voting is closed'?'경기가 이미 시작됐습니다.':error.message==='pick a side first'?'원정과 홈 중 쪽을 먼저 골라 주세요.':error.message));
    TALLY.at=0;rememberSubmittedLineup(id);db.lineupSubmitted[lineupSubmissionKey(id)]=true;persist();page='home';render();
    return notify('대표 라인업 투표에 제출했습니다. 경기 시작 전까지 다시 제출하면 바뀝니다. 타순별 최다 득표 선수로 대표 라인업이 정해집니다.');
  }
  // Server games are on today's schedule but this page is not on one of them: do not pretend it was sent.
  if(window.FANBALL_SERVER_CLIENT&&(window.FANBALL_REMOTE_VOTING?.getSchedule?.()||[]).length){
    if(row)return notify(row.status==='running'?'경기가 이미 시작돼 라인업을 바꿀 수 없습니다.':'이 경기는 라인업 투표가 끝났습니다.');
    return notify('오늘 경기와 연결되지 않았습니다. 홈의 "오늘의 경기"에서 경기를 고른 뒤 다시 제출해 주세요.');
  }
  rememberSubmittedLineup(id);db.lineupSubmitted[lineupSubmissionKey(id)]=true;persist();page='home';render();notify('라인업을 제출했습니다. 홈에서 언제든 수정할 수 있습니다.');
};

window.resetDemo=function(){
  if(!ADMIN_MODE)return notify('관리자 모드에서만 초기화할 수 있습니다.');
  const savedNickname=db.nickname||'',savedTeam=db.favorite||'doosan';localStorage.removeItem(STORAGE);db={favorite:savedTeam,nickname:savedNickname,lineups:{},lineupSubmitted:{},votes:0,game:null,submissions:0,ballot:null};const first=todayFixtures()[0];if(first)applyDemoFixture(first);persist();
  page='home';pickTeam=savedTeam;render();window.updateAccountButton?.();notify('샘플 경기를 초기화했습니다.');
};
document.querySelector('#resetDemo').onclick=window.resetDemo;
window.resetGame=function(){
  if(!ADMIN_MODE)return notify('관리자 모드에서만 경기 초기화가 가능합니다.');
  db.game=null;selectedLogInning=1;persist();page='game';render();notify('현재 경기만 초기화했습니다. 다시 실행할 수 있습니다.');
};
const baseHome=window.home;
const DEMO_FIXTURES=[
  {away:'doosan',home:'tigers',venue:'광주-기아 챔피언스 필드'},
  {away:'lg',home:'kt',venue:'수원KT위즈파크'},
  {away:'ssg',home:'nc',venue:'창원NC파크'},
  {away:'lotte',home:'samsung',venue:'대구삼성라이온즈파크'},
  {away:'hanwha',home:'kiwoom',venue:'고척스카이돔'}
];
function kstToday(){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()),part=k=>parts.find(p=>p.type===k)?.value||'';return{key:`${part('year')}-${part('month')}-${part('day')}`,label:new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',weekday:'short'}).format(new Date())}}
function applyDemoFixture(fixture){
  if(!fixture)return;
  MATCH.id=fixture.id;MATCH.date=fixture.date||'11.06 (금)';MATCH.time='18:00–18:20';MATCH.scheduledStartAt=fixture.scheduledAt||'2026-11-06T18:00:00+09:00';
  MATCH.away=fixture.away;MATCH.home=fixture.home;MATCH.venue=fixture.venue;
}
function todayFixtures(){
  const rows=window.FANBALL_REMOTE_VOTING?.getSchedule?.();
  if(rows?.length)return rows.map(row=>{const date=new Date(row.scheduled_at),parts=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',weekday:'short'}).formatToParts(date),part=k=>parts.find(p=>p.type===k)?.value||'';return{id:row.id,away:row.away_team_id,home:row.home_team_id,scheduledAt:row.scheduled_at,date:`${part('month')}.${part('day')} (${part('weekday')})`,time:date.toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hour12:false}),venue:team(row.home_team_id)?.venue||'구장 정보 대기',status:row.status,provider:row.provider}});
  // No server games today: show none (the five sample matchups in DEMO_FIXTURES are no longer listed).
  return [];
}
applyDemoFixture(todayFixtures().find(f=>f.id===db.activeFixtureId)||todayFixtures().find(f=>f.id===db.demoFixture)||todayFixtures().find(f=>f.away===MATCH.away&&f.home===MATCH.home));
window.selectHomeFixture=function(index){
  if(db.game){notify('현재 경기를 초기화한 뒤 다른 샘플 경기를 선택해 주세요.');return}
  const fixture=todayFixtures()[Number(index)];if(!fixture)return;
  applyDemoFixture(fixture);db.activeFixtureId=fixture.id;if(fixture.provider==='demo')db.demoFixture=fixture.id;db.demoMatch={away:fixture.away,home:fixture.home};persist();render();
};
function homeFixtureList(){
  const fixtures=todayFixtures(),live=fixtures.some(f=>f.provider!=='demo'),statusLabel={scheduled:'예정',live:'진행 중',final:'종료',postponed:'연기',cancelled:'취소'};
  const subtitle=live?`${fixtures.length}경기 · KBO 일정 공급원`:fixtures.length?`${fixtures.length}경기 · 팬볼 테스트 경기`:'예약된 경기가 없습니다';
  return `<section class="card home-fixtures"><div class="card-head"><div><h2>오늘의 경기</h2><small class="fixture-subtitle">${subtitle}</small></div>${fixtures.length?`<span class="tag ${live?'blue':'gold'}">${live?'KBO 일정':'테스트 일정'}</span>`:''}</div>${fixtures.length?`<div class="fixture-grid">${fixtures.map((f,i)=>{const selected=MATCH.id===f.id,away=team(f.away),homeTeam=team(f.home);if(!away||!homeTeam)return '';return `<button class="fixture-card ${selected?'selected':''}" aria-pressed="${selected}" onclick="selectHomeFixture(${i})"><span class="fixture-number">${String(i+1).padStart(2,'0')}</span><span class="fixture-time">${f.time||'시간 확인 중'}</span><strong>${away.short} <i>VS</i> ${homeTeam.short}</strong><small>${away.name} · ${homeTeam.name}</small><span class="fixture-venue">${f.venue}</span><em>${statusLabel[f.status]||'경기 선택'}${selected?' · 선택됨':''}</em></button>`}).join('')}</div>`:'<div class="empty">오늘 예정된 경기가 없습니다. 경기가 예약되면 여기에 나타납니다.<br>그동안 AI 대결에서 경기를 해 볼 수 있습니다. <button class="link" onclick="go(\'ai\')">AI 대결 →</button></div>'}</section>`;
}
function homeLiveCard(){const g=db.game;if(!g)return '';const pending=g.pendingPresentation,inning=pending?.play?.inn||g.inning||1,half=pending?.play?.side||g.half||'away',attackId=half==='away'?g.awayId:g.homeId,label=g.status==='final'?'경기 종료':'실시간 진행 중';return `<section class="home-live-card" id="home-live-match"><div class="home-live-head"><span class="home-live-dot"></span><b>팬볼 경기 ${label}</b><button type="button" onclick="go('game')">경기 보기 →</button></div><div class="home-live-main"><strong>${inning}회 ${half==='away'?'초':'말'}</strong><span>${team(attackId).name} 공격</span><b>${team(g.awayId).short} ${g.away} : ${g.home} ${team(g.homeId).short}</b></div></section>`}
function replaceDivByClass(html,className,replacement){const start=html.indexOf(`<div class="${className}">`);if(start<0)return html;const tags=/<\/?div\b[^>]*>/g;tags.lastIndex=start;let depth=0,match;while((match=tags.exec(html))){if(match[0].startsWith('</'))depth--;else depth++;if(depth===0)return html.slice(0,start)+replacement+html.slice(tags.lastIndex)}return html}
function homeOperationsCard(){const isDemo=todayFixtures().some(f=>f.provider==='demo'),fixtureCount=todayFixtures().length;return `<section class="card vote-card"><div class="eyebrow">TODAY · 18:00–18:20</div><h3>팬볼 경기 운영</h3><p>${!fixtureCount?'오늘 예약된 경기가 없습니다. 경기가 예약되면 라인업 투표와 작전 투표가 열립니다.':isDemo?'팬볼 테스트 경기 일정입니다.':'오늘 편성된 KBO 일정 전체를 표시합니다. 팬볼은 실제 경기 일정에 따라 운영됩니다.'}</p><div class="progress-row"><span>오늘 표시 경기</span><b>${fixtureCount}</b></div><div class="track"><i style="width:${Math.min(100,fixtureCount*20)}%"></i></div><div class="schedule-row"><div class="datebox">${lineupAnnouncementTime()}</div><div class="schedule-desc">선발 라인업 발표 확인<small>평일 17:30 · 휴일 13:00 기준</small></div><span class="tag">라인업</span></div><div class="schedule-row"><div class="datebox">18:00</div><div class="schedule-desc">팬볼 경기 시작<small>중요 상황에서 양 팀 동시 작전 투표</small></div><span class="tag gold">예정</span></div><button class="btn btn-primary" style="width:100%;margin-top:12px" onclick="go('lineup')">내 응원팀 라인업 참여하기 →</button></section>`}
window.home=function(){const fixtures=todayFixtures(),fixtureCount=fixtures.length,hasOfficialSchedule=(window.FANBALL_REMOTE_VOTING?.getSchedule?.()||[]).some(row=>row.provider!=='demo');let html=baseHome().replace('THURSDAY · NOVEMBER 05',`TODAY · ${kstToday().label}`).replace('11.05 (목)',kstToday().label).replaceAll('17:30',lineupAnnouncementTime()).replaceAll('오후 5시 30분',`오후 ${lineupAnnouncementTime()}`);if(db.lineupSubmitted[lineupSubmissionKey(db.favorite)])html=html.replace('라인업 참여하기　→','라인업 수정하기　→');html=html.replace('<div class="stat-num">1</div>',`<div class="stat-num">${fixtureCount}</div>`);html=replaceDivByClass(html,'grid grid-main',`<div class="grid grid-main">${homeFixtureList()}${homeOperationsCard()}</div>`);const originalNotice='현재는 10개 구단 선택이 가능한 샘플 MVP입니다. 두산·KIA 외 8개 팀 명단과 모든 기록값은 가상 샘플이며, 오늘 매치업도 실제 일정이 아닙니다. 실제 KBO 명단·일정 연결은 공급 및 사용 권한 확인 후 진행합니다.';const notice=hasOfficialSchedule?'일정 목록은 연결된 KBO 일정 공급원 자료입니다. 선수단과 실제 경기 전 기록은 별도 사용 권한 확인 및 데이터 연결을 기다리고 있습니다.':'현재는 10개 구단 선택이 가능한 샘플 MVP입니다. 5개 매치업과 선수 기록은 가상 샘플이며 실제 KBO 일정이 아닙니다.';html=html.replace(originalNotice,notice);return html.replace('<div class="grid grid-main">',homeLiveCard()+'<div class="grid grid-main">')};
function refreshHomeLiveCard(){if(page!=='home')return;const old=document.querySelector('#home-live-match');const html=homeLiveCard();if(!html){old?.remove();refreshHomeLiveCard.last='';return}if(old&&refreshHomeLiveCard.last===html)return;refreshHomeLiveCard.last=html;if(old)old.outerHTML=html;else app.insertAdjacentHTML('afterbegin',html)}
if(typeof setInterval==='function')setInterval(refreshHomeLiveCard,1000);
window.addEventListener?.('storage',e=>{if(e.key===STORAGE&&e.newValue){try{db=JSON.parse(e.newValue);render()}catch{}}});
function normalizePlayStates(g){if(!g?.plays?.length)return;const states={},score={away:0,home:0};let changed=false;for(const p of g.plays){const key=`${p.inn}-${p.side}`,state=states[key]||{base:[null,null,null],outs:0};if(!p.basesBefore){p.basesBefore=[...state.base];changed=true}if(p.outsBefore===undefined){p.outsBefore=state.outs;changed=true}if(!p.scoreBefore){p.scoreBefore={...score};changed=true}score[p.side]+=p.runs||0;if(!p.scoreAfter){p.scoreAfter={...score};changed=true}if(p.outsAfter===undefined){p.outsAfter=p.outs??state.outs;changed=true}states[key]={base:[...(p.base||state.base)],outs:p.outsAfter};}if(changed)persist()}
window.resultPage=function(g){
  normalizePlayStates(g);
  const teamStats=id=>{const t=team(id),order=ln(id).order,players=order.map(i=>t.players[i]?.[0]).filter(Boolean),rows=players.map(name=>{const b=g.bat[name]||{AB:0,H:0,SH:0,'2B':0,'3B':0,HR:0,BB:0,K:0};return `<tr><td class="player">${safe(name)}</td><td>${b.AB}</td><td>${b.H}</td><td>${b['2B']||0}</td><td>${b['3B']||0}</td><td>${b.HR||0}</td><td>${b.BB||0}</td><td>${b.K||0}</td><td>${b.AB?(b.H/b.AB).toFixed(3).slice(1):'.000'}</td></tr>`}).join('');return `<section class="team-result-card"><div class="team-log-heading"><span>${id===g.awayId?'원정팀 타격 기록':'홈팀 타격 기록'}</span><b>${t.name}</b></div><div class="result-table-scroll"><table class="table"><thead><tr><th>선수</th><th>AB</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>BB</th><th>K</th><th>AVG</th></tr></thead><tbody>${rows}</tbody></table></div></section>`};
  const outcome=g.tiebreak||(g.away===g.home?'무승부':`${team(g.away>g.home?g.awayId:g.homeId).name} 승리`);
  return `${header('FINAL · OFFICIAL RESULT','경기 결과','공식 샘플 시뮬레이션 · 저장된 경기')}<div class="result-head"><div><div class="eyebrow" style="color:#9ba9bc">FANBALL MATCH · ${MATCH.date}</div><h2>${team(g.awayId).name} vs ${team(g.homeId).name}</h2><div class="tiny" style="color:#aeb9c8;margin-top:5px">${outcome}</div></div><div class="final-score">${g.away}<span>:</span>${g.home}</div></div>${ADMIN_MODE?'<div class="result-reset"><button class="btn btn-danger" onclick="resetGame()">경기 초기화 후 다시 실행</button></div>':''}<section class="card result-scoreboard"><div class="score-title"><h2>이닝별 스코어</h2><span class="tag">${g.innings.length}회 종료</span></div>${scoreTable(g)}</section><h2 class="result-section-title">팬볼 타자 기록 <small>팀별 분리</small></h2><div class="result-team-grid">${teamStats(g.awayId)}${teamStats(g.homeId)}</div><h2 class="result-section-title">타석별 경기 로그 <small>이닝별 확인 · 아래 첫 타석부터 위로 쌓임</small></h2>${inningTabs(g.innings.length)}${renderInningLogs(g,selectedLogInning)}<p class="notice">선택한 이닝에서 원정팀의 1번 타석이 아래에서 시작되고, 홈팀 공격 로그는 그 위에 이어집니다. 각 타석에 회 초·말, 타자, 결과, 타석 후 주자·아웃 상황을 표시합니다.</p>`;
};

function inningTabs(maxInning=9){const total=Math.max(9,maxInning);return `<div role="tablist" class="inning-tabs" aria-label="이닝 선택">${Array.from({length:total},(_,i)=>`<button class="${selectedLogInning===i+1?'active':''}" onclick="selectLogInning(${i+1})">${i+1}회</button>`).join('')}</div>`}
function renderInningLogs(g,inning){const plays=(g?.plays||[]).filter(p=>Number(p.inn)===Number(inning)),half=(side,id,label)=>{const list=plays.filter(p=>p.side===side),t=team(id);return `<section class="inning-half ${side}"><div class="team-log-heading"><span>${label}</span><b>${t.name} 공격</b><small>${list.length}타석</small></div><div class="inning-half-plays">${list.length?list.map(p=>playCard(p,g)).join(''):'<p class="empty-log">이 이닝의 타석이 아직 없습니다.</p>'}</div></section>`};return `<div class="inning-selected-heading"><strong>${inning}회</strong><span>${plays.length}타석 기록</span></div><div class="inning-flow">${half('away',g?.awayId||MATCH.away,'초 · 원정팀')}${plays.some(p=>p.side==='home')||!plays.length?half('home',g?.homeId||MATCH.home,'말 · 홈팀'):''}</div>`}
window.selectLogInning=function(inning){selectedLogInning=Number(inning);render()};

function drawFromDistribution(counts,random,total){
  let draw=Math.floor(random()*total);
  for(const [kind,count] of Object.entries(counts)){if(draw<count)return kind;draw-=count}
  return 'OUT';
}
function plateOutcomeProbabilities(g,p,tactic='normal',side=g.half||'away',defense='standard'){
  const opponent=team(side==='away'?g.homeId:g.awayId),base=g.base||[null,null,null],outs=g.outs||0;
  const hitRate=bounded(p[2]+.015-(opponent.pitcher[1]-.25)*.22,.15,.38),walkRate=bounded(p[3]*.3,.035,.15),hrRate=bounded(p[5],.012,.075),otherHits=Math.max(0,bounded(hitRate,.12,.42)-hrRate);
  const prob={'1B':otherHits*.70,'2B':otherHits*.27,'3B':otherHits*.02,HR:hrRate,BB:walkRate,HBP:.012,K:.21,OUT:0,GDP:0,SAC:0,BUNT_FAIL:0};
  if(tactic==='contact'){prob.K=Math.max(.02,prob.K-.05);prob['1B']+=.025;for(const k of ['2B','3B','HR'])prob[k]*=.8}
  if(tactic==='aggressive'){prob.K+=.04;prob.BB*=.7;prob['1B']*=.95;for(const k of ['2B','3B','HR'])prob[k]*=1.2}
  if((defense==='double_play'||defense==='corners_in')&&base[0]&&outs<2)prob['1B']+=.015;
  prob.OUT=Math.max(0,1-prob['1B']-prob['2B']-prob['3B']-prob.HR-prob.BB-prob.HBP-prob.K);
  if(base[0]&&outs<2){prob.GDP=prob.OUT*(defense==='double_play'?.18:.10);prob.OUT-=prob.GDP}
  return prob;
}
function peekNextBatter(g){const side=g.half||'away',t=team(side==='away'?g.awayId:g.homeId),order=ln(t.id).order,index=g.idx?.[side]||0;return t.players[order[index%order.length]]}
const FAVORABLE_OUTCOMES=new Set(['1B','2B','3B','HR','BB','HBP']);
function strategyEffects(g,tactic,batter=peekNextBatter(g),defense='standard'){
  const base=plateOutcomeProbabilities(g,batter,'normal',g.half||'away','standard'),adjusted=plateOutcomeProbabilities(g,batter,tactic,g.half||'away',defense),labels={'1B':'단타','2B':'2루타','3B':'3루타',HR:'홈런',BB:'볼넷',HBP:'사구',K:'삼진',OUT:'일반 아웃',GDP:'병살'};
  return Object.keys(base).filter(k=>['1B','2B','3B','HR','BB','HBP','K','OUT','GDP'].includes(k)).map(k=>({key:k,delta:(adjusted[k]-base[k])*100})).filter(x=>Math.abs(x.delta)>=.05).map(x=>({text:`${labels[x.key]} ${x.delta>0?'+':'−'}${Math.abs(x.delta).toFixed(1)}%p`,tone:(x.delta>0)===FAVORABLE_OUTCOMES.has(x.key)?'good':'bad'}));
}
function oppositeEffects(effects=[]){return effects.map(e=>({...e,tone:e.tone==='good'?'bad':'good'}))}
function renderChoiceEffects(choice){const effects=(choice.effects||[]).slice().sort((a,b)=>Number(b.tone==='good')-Number(a.tone==='good')).map(e=>`<span class="choice-effect ${e.tone}">${e.text}</span>`).join('');return `${effects?`<span class="choice-effects">${effects}</span>`:''}<small class="choice-detail">${choice.detail}</small>`}
function shouldOfferStrategy(g,play){const bases=play.base||[],outs=play.outs||0;if(outs>=3)return false;const runners=bases.filter(Boolean).length,risp=Boolean(bases[1]||bases[2]),firstBasePlay=Boolean(bases[0]&&outs<2),lateClose=play.inn>=7&&Math.abs((g.away||0)-(g.home||0))<=2;return risp||firstBasePlay||runners>=2||lateClose}
window.playPA=function(g,side,inn){
  const random=rng(g.seed+g.plays.length*919),p=nextBatter(g,side);
  const base=g.base||[null,null,null],outs=g.outs||0,scoreBefore={away:g.away,home:g.home},basesBefore=[...base];
  const counts={'1B':0,K:0,BB:0,GDP:0,HR:0,'2B':0,'3B':0,HBP:0,OUT:0,SAC:0,BUNT_FAIL:0};
  let kind;
  if(g.choiceUsed==='bunt'&&base[0]&&outs<2){
    const buntSuccess=g.defenseChoiceUsed==='corners_in'?.58:.72;
    for(let n=0;n<PA_TRIALS;n++)counts[random()<buntSuccess?'SAC':'BUNT_FAIL']++;
    kind=drawFromDistribution(counts,random,PA_TRIALS);
  }else{
    const prob=plateOutcomeProbabilities(g,p,g.choiceUsed||'normal',side,g.defenseChoiceUsed||'standard');
    for(let n=0;n<PA_TRIALS;n++){const x=random();let sum=0,found=false;for(const outcome of Object.keys(counts)){sum+=prob[outcome]||0;if(x<sum){counts[outcome]++;found=true;break}}if(!found)counts.OUT++}
    kind=drawFromDistribution(counts,random,PA_TRIALS);
  }
  const mode=Object.keys(counts).reduce((a,b)=>counts[b]>counts[a]?b:a,'OUT');
  let runs=0;
  if(kind==='HR'){runs=1+base.filter(Boolean).length;g.base=[null,null,null]}
  else if(kind==='3B'){runs=base.filter(Boolean).length;g.base=[null,null,p[0]]}
  else if(kind==='2B'){runs=(base[1]?1:0)+(base[2]?1:0);g.base=[null,p[0],base[0]]}
  else if(kind==='1B'){runs=base[2]?1:0;g.base=[p[0],base[0],base[1]]}
  else if(kind==='BB'||kind==='HBP'){if(base[0]){if(base[1]){if(base[2])runs++;base[2]=base[1]}base[1]=base[0]}base[0]=p[0];g.base=base}
  else if(kind==='GDP'){g.outs=outs+2;g.base=[null,base[1],base[2]]}
  else if(kind==='SAC'){runs=base[2]?1:0;g.base=[null,base[0],base[1]]}
  if(['K','OUT','SAC','BUNT_FAIL'].includes(kind))g.outs=(g.outs||outs)+1;else if(kind!=='GDP')g.outs=outs;
  const b=g.bat[p[0]]||(g.bat[p[0]]={AB:0,H:0,'2B':0,'3B':0,HR:0,BB:0,HBP:0,K:0,GDP:0,SH:0,R:0});
  if(['OUT','K','GDP','BUNT_FAIL','1B','2B','3B','HR'].includes(kind))b.AB++;
  if(['1B','2B','3B','HR'].includes(kind))b.H++;
  if(['2B','3B','HR'].includes(kind))b[kind]=(b[kind]||0)+1;
  if(kind==='BB')b.BB++;if(kind==='HBP')b.HBP++;if(kind==='GDP')b.GDP++;if(kind==='K')b.K++;if(kind==='SAC')b.SH=(b.SH||0)+1;b.R+=runs;
  g[side]+=runs;const row=g.innings[inn-1]||(g.innings[inn-1]={away:0,home:0});row[side]+=runs;
  const record={inn,side,batter:p[0],kind,runs,outs:g.outs||outs,outsBefore:outs,outsAfter:g.outs||outs,basesBefore,base:[...g.base],scoreBefore,scoreAfter:{away:g.away,home:g.home},choice:g.choiceUsed||null,defenseChoice:g.defenseChoiceUsed||'standard',distribution:{trials:PA_TRIALS,counts,selected:kind,mode}};
  g.plays.push(record);return record;
};

function pitchSequence(kind,seed,pitcher){
  const r=rng(seed),seq=[];let balls=0,strikes=0;
  const add=call=>{
    let x,y;
    if(call==='ball'||call==='hbp'){
      const side=Math.floor(r()*4);
      if(call==='hbp'){
        x=side===0?6+r()*14:side===1?80+r()*14:20+r()*60;
        y=side===2?4+r()*14:side===3?82+r()*14:20+r()*60;
      }else{
        x=side===0?10+r()*10:side===1?80+r()*10:25+r()*50;
        y=side===2?10+r()*10:side===3?80+r()*10:25+r()*50;
      }
    }else{
      x=27+r()*46;y=27+r()*46;
    }
    const type=PITCH_TYPES[Math.floor(r()*PITCH_TYPES.length)],range=pitcher?.[4]?.[type]||DEFAULT_PITCH_SPEEDS[type];
    const speed=range[0]+Math.floor(r()*(range[1]-range[0]+1));
    seq.push({call,x,y,speed,type});
  };
  if(kind==='BB'){
    const calledStrikes=Math.floor(r()*3);for(let i=0;i<calledStrikes;i++)add('strike');
    while(balls<4){add('ball');balls++}
  }else if(kind==='K'){
    const calledBalls=Math.floor(r()*4);for(let i=0;i<calledBalls;i++)add('ball');
    for(let i=0;i<3;i++)add('strike');
  }else{
    const before=2+Math.floor(r()*3);
    for(let i=0;i<before;i++){
      let call=r()<.38?'ball':(strikes===2?'foul':(r()<.55?'strike':'foul'));
      if(call==='ball'&&balls>=3)call=strikes===2?'foul':'strike';
      if(call==='ball')balls++;if(call==='strike')strikes++;add(call);
    }
    add(kind==='HBP'?'hbp':'inplay');
  }
  return seq;
}
function snapshotScore(g){return{awayId:g.awayId,homeId:g.homeId,away:g.away,home:g.home,innings:g.innings.map(x=>({...x})),plays:g.plays.slice(),inning:g.inning||1,half:g.half||'away',outs:g.outs||0,base:[...(g.base||[null,null,null])]}}
function baseDiamond(bases=[]){return `<span class="base-diamond" aria-label="주자 ${bases.map((b,i)=>b?['1루','2루','3루'][i]:null).filter(Boolean).join(', ')||'없음'}"><i class="base-second ${bases[1]?'occupied':''}"></i><i class="base-third ${bases[2]?'occupied':''}"></i><i class="base-first ${bases[0]?'occupied':''}"></i><small>주자</small></span>`}
// This batter's hits/at-bats in this game up to and including this plate appearance (e.g. 1/3).
function gameLine(p,g){const plays=g?.plays||[],upto=plays.slice(0,plays.indexOf(p)+1).filter(x=>x.batter===p.batter&&x.side===p.side);let ab=0,h=0;for(const x of upto){if(!['BB','IBB','HBP','SAC','SF'].includes(x.kind))ab++;if(['1B','2B','3B','HR','BUNT_HIT'].includes(x.kind))h++}return `${h}/${ab}`}
// Season batting average of a batter, from the server game's lineup snapshot or the sample roster.
function batterAverage(name,teamId){const fromServer=window.FANBALL_SERVER_GAME?.batterAvg?.(name);const p=fromServer??team(teamId)?.players?.find(x=>x[0]===name)?.[2];return Number.isFinite(p)?`.${String(Math.round(p*1000)).padStart(3,'0')}`:null}
function situationText(bases=[],outs=0){const label={'000':'주자 없음','100':'1루','010':'2루','001':'3루','110':'1,2루','101':'1,3루','011':'2,3루','111':'만루'}[`${bases[0]?1:0}${bases[1]?1:0}${bases[2]?1:0}`];return `${outs}아웃 · ${label}`}
// Event match: '원정'/'홈' after the team name, since both sides are the same team.
function sideSuffix(side){return MATCH.away===MATCH.home?(side==='away'?' (원정)':' (홈)'):''}
// Who is on which base after the plate appearance (user request 2026-11-12), small, under the after line.
function runnerNames(bases){const r=[0,1,2].filter(i=>bases?.[i]).map(i=>`${i+1}루 ${safe(bases[i])}`);return r.length?`<small class="runner-names">${r.join(' · ')}</small>`:''}
function playCard(p,g){const battingId=p.side==='away'?g.awayId:g.homeId,teamName=team(battingId).name+sideSuffix(p.side),score=p.scoreAfter||{away:g.away,home:g.home},bases=p.base||[],outs=p.outsAfter??p.outs??0,offenseNames={normal:'기본 타격',contact:'컨택',aggressive:'강공',bunt:'희생번트',wait:'기다리기'},defenseNames={standard:'기본 수비',double_play:'병살 대비',corners_in:'번트 대비(코너 전진)',infield_in:'내야 전진',outfield_deep:'외야 장타 대비'},approachNames={attack:'정면 승부',pitch_around:'유인구 승부'};return `<article class="play-card">${p.change?`<div class="play-change">⇄ 투수 교체 · ${safe(p.change.from||'')}${p.change.pitches?` (${p.change.pitches}구)`:''} → <b>${safe(p.change.to)}</b></div>`:''}<div class="play-card-top"><span class="inning-label">${p.inn}회 ${p.side==='away'?'초':'말'}</span><b>${teamName} 공격</b><span class="play-score">${score.away} : ${score.home}</span></div><div class="play-card-main"><strong>${safe(p.batter)}<small class="game-line">${gameLine(p,g)}</small></strong><span class="play-outcome">${p.kindLabel||kindName(p.kind)}${p.runs?` · ${p.runs}득점`:''}</span><button class="detail-button" onclick="showDistribution(${g.plays.indexOf(p)})">결과 분포</button></div><div class="play-card-state">${baseDiamond(bases)}<span>타석 후 · ${situationText(bases,outs)}</span>${runnerNames(bases)}</div>${(Array.isArray(p.votes)?p.votes.length>0:(p.choice&&p.choice!=='normal')||(p.defenseChoice&&p.defenseChoice!=='standard'))?`<div class="play-tactic-summary"><span class="tactic-chip offense"><b>공격</b>${offenseNames[p.choice]||'기본 타격'}</span><span class="tactic-chip defense"><b>수비</b>${defenseNames[p.defenseChoice]||'기본 수비'}${approachNames[p.approach]?` · ${approachNames[p.approach]}`:''}</span></div>`:''}</article>`}
function pitchPanel(pending){
  const pitch=pending.pitches[pending.index],seen=pending.pitches.slice(0,pending.index+1);
  const balls=seen.filter(p=>p.call==='ball').length,strikes=seen.filter(p=>p.call==='strike'||p.call==='foul').length;
  const outcome=pending.showResult?'타석 종료':pitch.call==='inplay'?`타격 결과 준비 · ${kindName(pending.play.kind)}`:pitch.call==='hbp'?'몸에 맞는 공':pitch.call==='ball'?'볼':pitch.call==='foul'?'파울':'스트라이크';
  const points=pending.pitches.slice(0,pending.index+1).map((p,i)=>{const fallbackX=p.call==='ball'?(i%2?82:15):35+((p.zone||5)%3)*13,fallbackY=p.call==='ball'?(i%3?13:86):30+Math.floor(((p.zone||5)-1)/3)*20,x=Number.isFinite(p.x)?p.x:fallbackX,y=Number.isFinite(p.y)?p.y:fallbackY;return `<span class="pitch-point ${p.call} ${i===pending.index?'current':''}" style="left:${x}%;top:${y}%" aria-label="${i+1}구">${i+1}</span>`}).join('');
  const outs=pending.showResult?(pending.play.outsAfter??pending.play.outs??0):(pending.before?.outs||0),outsHtml=[0,1].map(i=>`<i class="out-light ${i<outs?'on':''}"></i>`).join('');
  return `<div class="pitch-panel"><div class="atbat-heading"><span>${pending.play.inn}회 ${pending.play.side==='away'?'초':'말'}</span><strong>${safe(pending.play.batter)}</strong></div>${pending.showResult?`<div class="atbat-result"><small>타석 결과</small><b>${kindName(pending.play.kind)}${pending.play.runs?` · ${pending.play.runs}득점`:''}</b></div>`:''}
    <div class="pitch-body"><div class="zone-wrap"><div class="zone-label">STRIKE ZONE · 투구 위치</div><div class="pitch-plot"><div class="pitch-zone-grid">${Array.from({length:9},()=>'<span></span>').join('')}</div>${points}</div></div>
    <div class="pitch-info"><div class="pitch-speed">${pitch.speed}<small>km/h</small></div><div class="pitch-type">${pitch.type}</div><div class="pitch-call ${pitch.call}">${outcome}</div><div class="count-lights"><div><small>B</small>${[0,1,2].map(i=>`<i class="ball-light ${i<balls?'on':''}"></i>`).join('')}</div><div><small>S</small>${[0,1].map(i=>`<i class="strike-light ${i<strikes?'on':''}"></i>`).join('')}</div><div><small>O</small>${outsHtml}</div></div>${baseDiamond(pending.showResult?pending.play.base:(pending.before?.base||[]))}</div></div>
    </div>`;
}
// Situation saved by the server when it opened the vote: inning, outs, runners, count, batter, score.
function remoteSituation(round){
  const s=round?.state_snapshot||{},phase={pre_pa:'타석 전 작전',two_strikes:'2스트라이크 작전',three_balls:'3볼 작전',pitcher_change:'구원투수 투표'}[round?.phase||s.phase]||'작전';
  if(s.inning==null)return `${round.pa_no}번째 타석 · ${phase}`;
  const b=s.base||[],bases={'000':'주자 없음','100':'1루','010':'2루','001':'3루','110':'1,2루','101':'1,3루','011':'2,3루','111':'만루'}[`${b[0]?1:0}${b[1]?1:0}${b[2]?1:0}`];
  const attack=(team(round.offense_team_id)?.short||'')+(MATCH.away===MATCH.home?sideSuffix(String(round.offense_team_id).endsWith('@away')?'away':'home'):''),away=team(MATCH.away)?.short||'원정',home=team(MATCH.home)?.short||'홈';
  return `${s.inning}회 ${s.half==='away'?'초':'말'} · ${s.outs||0}아웃 ${bases}${s.count&&s.count!=='0-0'?` · 카운트 ${s.count}`:''}${s.batter?` · 타자 ${safe(s.batter)}${batterAverage(s.batter,round.offense_team_id)?` (타율 ${batterAverage(s.batter,round.offense_team_id)})`:''}`:''} · ${attack} 공격 · ${away} ${s.score?.away??0}:${s.score?.home??0} ${home}<br><b>${phase}</b>`;
}
// The chances the server computed for this choice (from the current count to the end of the at-bat).
// Compared with the default choice (first in the list), what changes, colored good/bad for this
// role (more hits and walks are good for the offense and bad for the defense), then the full odds.
function remoteChoiceOdds(round,choice){
  const b=round?.state_snapshot?.ballot,list=choice.role==='offense'?b?.offenseChoices:b?.defenseChoices,c=list?.find(x=>x.id===choice.choice_key);
  if(!c?.odds)return '';
  const o=c.odds,base=list[0]?.odds,names={walk:'볼넷',strikeout:'삼진',hit:'안타',extraBase:'장타',sacrifice:'희생 진루',out:'아웃'},goodForOffense={walk:true,hit:true,extraBase:true,sacrifice:true,strikeout:false,out:false};
  const chips=base&&c!==list[0]?Object.keys(names).map(k=>({k,d:Math.round(((o[k]||0)-(base[k]||0))*10)/10})).filter(x=>Math.abs(x.d)>=0.1).map(x=>{const good=(x.d>0)===goodForOffense[x.k]===(choice.role==='offense');return {good,text:`${names[x.k]} ${x.d>0?'+':'−'}${Math.abs(x.d).toFixed(1)}%p`}}).sort((x,y)=>Number(y.good)-Number(x.good)):[];
  const effects=chips.length?`<span class="choice-effects">${chips.map(e=>`<span class="choice-effect ${e.good?'good':'bad'}">${e.text}</span>`).join('')}</span>`:'';
  return `${effects}<small>이번 타석 확률 · 볼넷 ${o.walk}% · 삼진 ${o.strikeout}% · 안타 ${o.hit}% (장타 ${o.extraBase}%)${o.sacrifice?` · 희생 진루 ${o.sacrifice}%`:''} · 아웃 ${o.out}%</small>${c.detail?`<small class="choice-detail">${safe(c.detail)}</small>`:''}`;
}
// Show choices in the order the server built them (default first).
function remoteChoiceOrder(round,choices){
  const b=round?.state_snapshot?.ballot,order=[...(b?.offenseChoices||[]),...(b?.defenseChoices||[])].map(c=>c.id),at=c=>{const i=order.indexOf(c.choice_key);return i<0?(c.is_default?-1:999):i};
  return [...choices].sort((x,y)=>at(x)-at(y));
}
function remoteTacticalPanel(remote){
  if(!remote)return '';
  if(remote.round?.status==='resolved'){
    const find=id=>remote.choices.find(c=>c.id===id)?.label||'기본 작전';
    return `<div class="vote-box remote-vote resolved"><b>작전 투표 완료</b><div class="ballot-situation">${remoteSituation(remote.round)} · 양 팀 작전 확정</div><div class="remote-resolution"><span>공격 · ${safe(find(remote.resolution?.offense_choice_id))}</span><span>수비 · ${safe(find(remote.resolution?.defense_choice_id))}</span></div></div>`;
  }
  if(remote.round?.status==='closing')return `<div class="vote-box remote-vote"><b>투표 마감 · 작전 확정 중</b><p class="tiny muted">서버가 양 팀의 표를 집계하고 있습니다.</p></div>`;
  if(remote.round?.status==='open'){
    const remain=Math.ceil(remote.remainingMs/1000),end=new Date(remote.round.closes_at).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',second:'2-digit'});
    if(remote.round?.phase==='pitcher_change'&&remote.role!=='defense')return `<div class="vote-box remote-vote spectator"><div class="remote-vote-title"><b>상대 팀이 구원투수를 고르는 중입니다</b><span id="server-countdown">${remain}초</span></div><p class="tiny muted">상대 팀 팬 80% 이상이 투수 교체를 요청했습니다. 고른 투수는 다음 타석부터 던집니다.</p></div>`;
    if(!remote.role)return `<div class="vote-box remote-vote spectator"><div class="remote-vote-title"><b>작전 선택 중입니다</b><span id="server-countdown">${remain}초</span></div><div class="ballot-situation">${remoteSituation(remote.round)} · ${end} 마감</div><p class="tiny muted">${window.FANBALL_REMOTE_VOTING?.isEventForMe?.()?'이벤트 매치입니다. 위에서 원정이나 홈 쪽을 고르면 그쪽 작전에 투표할 수 있습니다.':'다른 팀 응원 팬은 관전 중입니다. 양 팀 투표는 같은 시간에 열려 있습니다.'}</p></div>`;
    const teamName=(team(remote.teamId)?.name||'내 응원팀')+(remote.teamId&&MATCH.away===MATCH.home?sideSuffix(String(remote.teamId).endsWith('@away')?'away':'home'):''),roleName=remote.role==='offense'?'공격 작전 선택':'수비 작전 선택';
    return `<div class="vote-box remote-vote ${remote.role}"><div class="remote-vote-title"><b>${teamName} · ${roleName}</b>${remote.noTimer?'<span>고르면 바로 진행</span>':`<span id="server-countdown">${remain}초</span>`}</div><div class="ballot-situation">${remoteSituation(remote.round)}${remote.noTimer?'':` · ${end} 마감`}</div><div class="vote-options">${remoteChoiceOrder(remote.round,remote.choices).map(c=>`<button class="${remote.vote?.choice_id===c.id?'voted':''}" onclick="submitServerTacticalVote('${c.id}')"><b>${safe(c.label)}${remote.vote?.choice_id===c.id?' · 내 선택':''}</b>${remoteChoiceOdds(remote.round,c)}</button>`).join('')}</div><p class="tiny muted">${remote.instantPick?'고르면 바로 적용됩니다. 시간이 지나면 지금 작전(첫 번째 선택지)으로 진행합니다. AI는 이미 작전을 정했고, 내 선택과 함께 공개됩니다. 다른 화면으로 나가거나 새로고침하면 남은 시간 그대로 멈춥니다.':remote.noTimer?'AI는 이미 작전을 정했습니다. 내 선택과 함께 결과 직후 공개됩니다.':'마감 전에는 선택을 바꿀 수 있습니다. 상대 팀의 선택별 득표수는 마감 뒤 공개됩니다.'}</p></div>`;
  }
  if(remote.mode==='game_not_connected')return `<div class="vote-box remote-vote"><b>서버 경기 연결 대기 중</b><p class="tiny muted">이 매치의 서버 경기와 작전 라운드가 아직 등록되지 않았습니다.</p></div>`;
  if(remote.mode==='waiting')return `<div class="vote-box remote-vote"><b>작전 선택 상황을 기다리는 중</b><p class="tiny muted">중요 상황에서 양 팀 투표가 동시에 열립니다.</p></div>`;
  if(remote.mode==='error')return `<div class="vote-box remote-vote"><b>서버 투표 연결을 확인하고 있습니다</b><p class="tiny muted">${safe(remote.error||'잠시 후 다시 확인해 주세요.')}</p></div>`;
  return '';
}
window.submitServerTacticalVote=id=>window.FANBALL_SERVER_GAME?.isLocal?.()?window.FANBALL_SERVER_GAME.voteLocal(id):window.FANBALL_REMOTE_VOTING?.submit(id);
window.gamePage=function(){
  const g=db.game;normalizePlayStates(g);if(g&&g.status==='final'&&!g.pendingPresentation)return resultPage(g);
  const shown=g?.pendingPresentation?.before||g;
  let html=header('GAME CENTER','공식 경기 센터',ADMIN_MODE?'개발 관리자 모드 · 시간 제한 없이 즉시 실행':'실제 경기 모드 · KST 예정 시각에 자동 시작')+(ADMIN_MODE?'<div class="banner admin-banner"><b>개발 관리자 모드</b> · 매치업은 샘플 설정입니다. 팀별 작전 화면 확인을 위해 원정/홈 팀을 바꿀 수 있습니다.</div><div class="admin-matchup card"><label>원정팀 <select onchange="setDemoMatch(\'away\',this.value)">'+TEAMS.map(t=>'<option value="'+t.id+'" '+(MATCH.away===t.id?'selected':'')+'>'+t.name+'</option>').join('')+'</select></label><b>VS</b><label>홈팀 <select onchange="setDemoMatch(\'home\',this.value)">'+TEAMS.map(t=>'<option value="'+t.id+'" '+(MATCH.home===t.id?'selected':'')+'>'+t.name+'</option>').join('')+'</select></label></div>':'<div class="banner live-banner"><b>실제 경기 운영</b> · '+scheduledStartMessage()+' 공식 서비스에서는 서버가 시작 시각과 단 한 번 실행을 관리합니다.</div>')+'<div class="banner">각 타석은 100,000회 표본으로 결과 확률을 추정한 뒤 그 빈도에 따라 결과 하나를 추첨합니다. 투구는 2초 간격으로 표시합니다.</div><div class="game-layout"><section class="card scoreboard"><div class="score-title"><h2>'+team(MATCH.away).short+' vs '+team(MATCH.home).short+'</h2><span class="tag '+(g?'red':'gold')+'">'+(g?.status==='final'?'종료':g?'진행 중':'경기 전')+'</span></div>';
  if(g){html+=scoreTable(shown);const state=g.pendingPresentation?.before||g,inning=g.pendingPresentation?.play?.inn||state.inning||1,half=g.pendingPresentation?.play?.side||state.half||'away',attackId=half==='away'?g.awayId:g.homeId,outs=g.pendingPresentation?.showResult?(g.pendingPresentation.play.outsAfter??g.pendingPresentation.play.outs??0):(state.outs||0),bases=g.pendingPresentation?.showResult?g.pendingPresentation.play.base:(state.base||[]);html+=`<div class="game-countbar"><strong class="current-inning">${inning}회 ${half==='away'?'초':'말'}</strong><span class="attack-team">${team(attackId).name} 공격</span><b>아웃</b><div class="out-lights">${[0,1].map(i=>`<i class="${i<outs?'on':''}"></i>`).join('')}</div><strong>${outs} OUT</strong>${baseDiamond(bases)}</div>`;if(ADMIN_MODE)html+='<button class="btn btn-danger game-reset" onclick="resetGame()">현재 경기 초기화 후 다시 실행</button>'}else if(ADMIN_MODE)html+='<div class="empty"><p>개발 중에는 운영 시간을 기다리지 않고 경기를 확인할 수 있습니다.</p><button class="btn btn-primary" onclick="startGame()">관리자 경기 즉시 시작</button></div>';else html+='<div class="empty"><p>'+scheduledStartMessage()+'</p></div>';
  if(g?.pendingPresentation)html+=pitchPanel(g.pendingPresentation);
  html+='</section><section class="card situation"><div class="score-title"><h2>팬 작전 투표 · 타석 로그</h2></div>';
  const remoteVote=window.FANBALL_REMOTE_VOTING?.view();
  if(remoteVote?.round)html+=remoteTacticalPanel(remoteVote);
  else if(!ADMIN_MODE)html+=remoteTacticalPanel(remoteVote);
  else if(g?.ballot){const mine=ballotForMyTeam(g.ballot);html+=mine?'<div class="vote-box team-ballot '+mine.role+'"><div class="team-ballot-heading"><span class="tag blue">내 응원팀 · '+team(mine.teamId).name+'</span><b>'+mine.label+'</b></div><div class="ballot-situation">'+g.ballot.situation+'</div><div class="tiny muted">개발용 로컬 투표 · 다른 사용자와 동기화되지 않습니다. · <b id="countdown">15초</b></div><div class="vote-options">'+mine.choices.map(c=>'<button onclick="choosePlay(\''+mine.role+'\',\''+c.id+'\')"><b>'+c.label+'</b>'+renderChoiceEffects(c)+'</button>').join('')+'</div></div>':'<div class="vote-box spectator"><div class="remote-vote-title"><b>작전 선택 중입니다</b><span id="countdown">15초</span></div><div class="ballot-situation">'+g.ballot.situation+'</div><p class="tiny muted">내 응원팀은 이 경기의 공격팀이나 수비팀이 아닙니다. 관전할 수 있습니다.</p></div>'}
  html+=inningTabs(shown?.innings?.length||1)+renderInningLogs({...g,...shown,plays:shown?.plays||[]},selectedLogInning);
  if(!g)html+='<div class="empty">경기를 시작하면 투구판과 타석별 분포가 표시됩니다.</div>';
  return html+'</section></div><p class="notice">팬볼 경기는 경기당 한 번만 시작할 수 있습니다. 현재 MVP 데이터는 이 브라우저에 저장됩니다.</p>';
};

window.startGame=function(){
  if(db.game)return notify(db.game.status==='final'?'이미 종료된 경기입니다. 관리자 초기화 후 다시 실행할 수 있습니다.':'경기가 이미 진행 중입니다.');
  if(!ADMIN_MODE)return notify('실제 경기 모드에서는 예정 시각에 자동으로 시작합니다.');
  startGameRun();
};
function startGameRun(){
  if(db.game)return false;
  for(const id of [MATCH.away,MATCH.home])if(ln(id).order.length!==9){notify(team(id).name+' 라인업 9명을 먼저 확정해 주세요.');return false}
  selectedLogInning=1;db.game=newGame();persist();window.advanceMatch();return true;
}
function scheduledStartAt(){return MATCH.scheduledStartAt?Date.parse(MATCH.scheduledStartAt):NaN}
function liveScheduleState(){const start=scheduledStartAt(),now=Date.now();if(!Number.isFinite(start))return 'schedule_missing';if(now<start)return 'before';if(now<=start+20*60*1000)return 'window';return 'after'}
function scheduledStartMessage(){const state=liveScheduleState();if(state==='before')return `예정 시각 ${new Date(scheduledStartAt()).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit'})}에 자동으로 시작합니다.`;if(state==='window')return window.FANBALL_LIVE_READY===true?'공식 라인업이 확정되어 예정 시각에 자동 시작 대기 중입니다.':'공식 KBO 라인업·대표 라인업 연결 대기 중입니다. 연결되면 경기 시간에 자동으로 시작합니다.';if(state==='after')return '오늘 경기 시작 가능 시간이 지났습니다. 다음 공식 경기 일정을 기다려 주세요.';return '공식 경기 일정 연결 대기 중입니다.'}
function checkScheduledStart(){if(ADMIN_MODE||db.game||liveScheduleState()!=='window'||window.FANBALL_LIVE_READY!==true)return;startGameRun()}

function makeStrategyBallot(g){
  const bases=g.base||[null,null,null],outs=g.outs||0,baseKey=`${bases[0]?1:0}${bases[1]?1:0}${bases[2]?1:0}`,baseLabels={'000':'주자 없음','100':'1루','010':'2루','001':'3루','110':'1,2루','101':'1,3루','011':'2,3루','111':'만루'};
  const offenseId=g.half==='away'?g.awayId:g.homeId,defenseId=g.half==='away'?g.homeId:g.awayId;
  const situation=`${g.inning}회 ${g.half==='away'?'초':'말'} · ${outs===0?'무사':`${outs}아웃`} ${baseLabels[baseKey]} · ${team(g.awayId).short} ${g.away}–${g.home} ${team(g.homeId).short}`;
  const offenseChoices=[{id:'normal',label:'기본 타격',detail:'현재 타자와 투수의 샘플 기본 분포를 적용합니다.'}];
  if((bases[1]||bases[2]||bases.filter(Boolean).length>=2)&&outs<3)offenseChoices.push({id:'contact',label:'컨택 타격',detail:'삼진·단타와 장타 간 교환입니다. 샘플 분포 기준.',effects:strategyEffects(g,'contact')});
  if(bases[0]&&outs<2)offenseChoices.push({id:'bunt',label:'희생번트 시도',detail:'성공 시 주자를 보내고 타자는 희생 처리합니다. 성공률은 데모용 샘플입니다.',effects:[{text:'번트 성공 +1베이스 · 72%',tone:'good'},{text:'번트 실패 · 타자 아웃 28%',tone:'bad'}]});
  offenseChoices.push({id:'aggressive',label:'강공',detail:'장타를 노리는 대신 삼진·볼넷·단타 위험이 달라집니다. 데모용 샘플 분포.',effects:strategyEffects(g,'aggressive')});
  const defenseChoices=[{id:'standard',label:'기본 수비',detail:'현재 수비 위치를 유지합니다.'}];
  if(bases[0]&&outs<2){
    defenseChoices.push({id:'double_play',label:'병살 대비 수비',detail:'1루 주자가 있을 때 병살 가능성과 단타 가능성이 함께 달라지는 샘플 수비입니다.',effects:oppositeEffects(strategyEffects(g,'normal',peekNextBatter(g),'double_play'))});
    if(bases[1]&&outs===0)defenseChoices.push({id:'corners_in',label:'코너 내야 전진 수비',detail:'희생번트에 대응합니다. 번트 성공률 72%→58%는 검증 전 데모 가정입니다.',effects:[{text:'번트 실패 +14%p',tone:'good'},{text:'단타 +1.5%p',tone:'bad'}]});
  }
  return{title:'상황별 작전 투표',situation,offenseTeamId:offenseId,defenseTeamId:defenseId,offenseChoices,defenseChoices};
}
function ballotForMyTeam(ballot){
  if(!ballot.offenseChoices){const active=db.game,offenseId=active?.half==='away'?active?.awayId:active?.homeId,defenseId=active?.half==='away'?active?.homeId:active?.awayId;ballot={...makeStrategyBallot(active),...ballot,offenseTeamId:offenseId,defenseTeamId:defenseId,offenseChoices:ballot.choices||[],defenseChoices:makeStrategyBallot(active).defenseChoices}}
  if(db.favorite===ballot.offenseTeamId)return{role:'offense',teamId:ballot.offenseTeamId,label:'공격 작전 선택',choices:ballot.offenseChoices};
  if(db.favorite===ballot.defenseTeamId)return{role:'defense',teamId:ballot.defenseTeamId,label:'수비 작전 선택',choices:ballot.defenseChoices};
  return null;
}
window.choosePlay=function(role,id){
  const g=db.game,ballot=g?.ballot,view=ballot&&ballotForMyTeam(ballot);if(!g||!view)return;
  if(role!==view.role)return notify('내 응원팀의 작전만 선택할 수 있습니다.');
  const choice=view.choices.find(c=>c.id===id);if(!choice)return;
  if(role==='offense')g.choice=id;else g.defenseChoice=id;
  g.ballot=null;persist();render();notify(`${view.label}: ${choice.label} · 다음 타석에 반영`);window.advanceMatch();
};
window.closeBallot=function(auto){const g=db.game;if(!g?.ballot)return;const view=ballotForMyTeam(g.ballot);if(view){const neutral=view.choices.find(x=>x.id==='normal'||x.id==='standard')||view.choices[0];if(view.role==='offense')g.choice=neutral.id;else g.defenseChoice=neutral.id}g.ballot=null;persist();render();if(auto)notify('투표 마감 · 미응답 시 기본 작전 적용');window.advanceMatch()};

function advancePitch(){
  const g=db.game,pending=g?.pendingPresentation;if(!pending)return;
  if(pending.index+1<pending.pitches.length){pending.index++;persist();render();const token=g.runToken;setTimeout(()=>{if(db.game?.runToken===token)advancePitch()},2000);return}
  if(!pending.showResult){pending.showResult=true;persist();render();const token=g.runToken;setTimeout(()=>{if(db.game?.runToken===token)advancePitch()},2000);return}
  const needsVote=pending.needsVote;g.pendingPresentation=null;persist();render();
  if(g.status==='final'){notify('경기가 종료됐습니다. 결과와 분포를 저장했습니다.');return}
  if(needsVote){g.ballot=makeStrategyBallot(g);persist();render();let left=15;const tick=()=>{if(!db.game?.ballot)return;const el=document.querySelector('#countdown');if(el)el.textContent=left+'초';if(left--<=0){window.closeBallot(true);return}setTimeout(tick,1000)};tick();return}
  const token=g.runToken;setTimeout(()=>{if(db.game?.runToken===token)advanceMatch()},250);
}
window.advanceMatch=function(){
  const g=db.game;if(!g||g.status!=='running'||g.ballot||g.pendingPresentation)return;
  g.inning=g.inning||1;g.half=g.half||'away';g.outs=g.outs||0;g.base=g.base||[null,null,null];
  if(g.inning>12){g.status='final';g.tiebreak='12회 종료 무승부';persist();render();return}
  if(g.inning>=9&&g.half==='home'&&g.home>g.away){g.status='final';persist();render();return}
  g.choiceUsed=g.choice||'normal';g.choice=null;g.defenseChoiceUsed=g.defenseChoice||'standard';g.defenseChoice=null;
  const before=snapshotScore(g),play=playPA(g,g.half,g.inning);
  play.choice=g.choiceUsed;play.defenseChoice=g.defenseChoiceUsed;g.choiceUsed=null;g.defenseChoiceUsed=null
  const walkoff=g.half==='home'&&g.inning>=9&&g.home>g.away;
  if(walkoff)g.status='final';
  if(g.outs>=3){g.outs=0;g.base=[null,null,null];if(g.half==='away'){if(g.inning>=9&&g.home>g.away)g.status='final';else g.half='home'}else{if(g.inning>=9&&g.home!==g.away)g.status='final';else if(g.inning>=12){g.status='final';g.tiebreak='12회 종료 무승부'}else{g.inning++;g.half='away'}}}
  play.pitches=pitchSequence(play.kind,g.seed+g.plays.length*173+41,team(play.side==='away'?g.homeId:g.awayId).pitcher);
  g.pendingPresentation={play,pitches:play.pitches,index:0,before,needsVote:shouldOfferStrategy(g,play)};
  persist();render();const token=g.runToken;setTimeout(()=>{if(db.game?.runToken===token)advancePitch()},2000);
};

window.showDistribution=function(i){
  const p=db.game?.plays?.[i];if(!p?.distribution)return notify('이 타석에는 분포 데이터가 없습니다.');
  const d=p.distribution,names={'1B':'단타',K:'삼진',BB:'볼넷',GDP:'병살타',HR:'홈런','2B':'2루타','3B':'3루타',HBP:'몸에 맞는 공',OUT:'아웃',SAC:'희생번트 성공',BUNT_FAIL:'번트 실패 · 타자 아웃'};
  const mode=d.mode||Object.keys(d.counts).reduce((a,b)=>d.counts[b]>d.counts[a]?b:a,'OUT');
  const rows=Object.entries(d.counts).filter(([,n])=>n>0).sort((a,b)=>b[1]-a[1]).map(([k,n])=>`<div class="dist-row ${k===d.selected?'chosen':''}"><span>${names[k]}</span><div class="dist-track"><i style="width:${n/d.trials*100}%"></i></div><b>${n.toLocaleString()}회</b><small>${(n/d.trials*100).toFixed(2)}%</small>${k===d.selected?'<em>적용</em>':''}</div>`).join('');
  document.getElementById('dist-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend',`<div class="modal-backdrop" id="dist-modal" onclick="if(event.target===this)this.remove()"><section class="dist-modal"><button class="modal-close" onclick="document.getElementById('dist-modal').remove()">×</button><div class="eyebrow">PLATE APPEARANCE · ${d.trials.toLocaleString()} TRIALS</div><h2>${safe(p.batter)} 타석 결과 분포</h2><p>${p.inn}회 ${p.side==='away'?'초':'말'} · 적용 결과 <b>${names[d.selected]}</b></p><div class="dist-note">최빈 결과는 ${names[mode]}(${d.counts[mode].toLocaleString()}회)입니다. 실제 타석 결과는 100,000회 빈도에 비례해 한 번 추첨했습니다.</div><div class="dist-list">${rows}</div></section></div>`);
};

document.querySelector('#resetDemo').onclick=window.resetDemo;
if(!ADMIN_MODE&&typeof setInterval==='function')setInterval(checkScheduledStart,1000);
render();
if(db.game?.pendingPresentation)setTimeout(advancePitch,2000);
else if(db.game?.status==='running'&&!db.game?.ballot)setTimeout(advanceMatch,500);

// Home "라인업 참여": real number of fan lineups submitted for today's games (server total, refreshed each minute).
async function refreshLineupCount(){
  const client=window.FANBALL_SERVER_CLIENT;if(!client)return;
  const {data,error}=await client.rpc('fanball_lineup_participation_today');
  if(error||typeof data!=='number')return;
  if(data!==window.FANBALL_LINEUP_COUNT){window.FANBALL_LINEUP_COUNT=data;if(page==='home'&&typeof render==='function')render()}
}
if(typeof setInterval==='function'){setTimeout(refreshLineupCount,1500);setInterval(refreshLineupCount,60000)}
