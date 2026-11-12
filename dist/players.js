// 선수 정보 (user request 2026-11-13): a page to look players up, starting with runner speed grades. More tabs
// (other player info) can be added to TABS later. Speed grades come from dist/runner-speed.js (player[13], [14]),
// drafted from career steals per time on first (tools/build-runner-speed.py, Namu Wiki career tables).
(function(){
  const P={tab:'speed',team:'all'};
  const GRADE={5:['매우 빠름','추가 진루·번트 안타가 가장 잦고, 병살·2루 포스아웃이 가장 적어요.'],4:['빠름','한 베이스 더 가는 일이 자주 있어요.'],3:['보통','리그 평균으로 계산해요.'],2:['느림','추가 진루가 적고 병살이 조금 늘어요.'],1:['매우 느림','추가 진루가 드물고, 1루 주자일 때 병살·2루 포스아웃이 가장 잦아요.']};
  const STEAL={1:'도루 적음',2:'도루 보통',3:'도루 많음'};
  const TABS=[['speed','주력']]; // later: more player info
  window.playersTab=t=>{P.tab=t;render()};
  window.playersTeam=t=>{P.team=t;render()};
  function speedTab(){
    const teams=P.team==='all'?TEAMS:TEAMS.filter(t=>t.id===P.team);
    const known=(t,name)=>Boolean(window.FANBALL_RUNNER_SPEED?.[t.id]?.[name]);
    const groups={5:[],4:[],3:[],2:[],1:[]};
    for(const t of teams)for(const p of t.players){const g=Math.min(5,Math.max(1,Number(p[13])||3));groups[g].push({t,p,known:known(t,p[0])})}
    const chip=({t,p,known})=>`<li class="pl-chip"><b>${safe(p[0])}</b><small>${P.team==='all'?`${safe(t.short)} · `:''}${safe(p.groupName||p[1]||'')}${known?` · ${STEAL[p[14]]||''}`:' · 기록 없음(보통)'}</small></li>`;
    const sections=[5,4,3,2,1].map(g=>`<section class="card pl-grade g${g}"><div class="card-head"><div><h2>${g}등급 · ${GRADE[g][0]}</h2><small class="muted tiny">${GRADE[g][1]}</small></div><span class="tag">${groups[g].length}명</span></div>${groups[g].length?`<ul class="pl-list">${groups[g].sort((a,b)=>a.t.id===b.t.id?a.p[0].localeCompare(b.p[0],'ko'):TEAMS.indexOf(a.t)-TEAMS.indexOf(b.t)).map(chip).join('')}</ul>`:'<p class="muted tiny">해당 선수가 없어요.</p>'}</section>`).join('');
    return `<p class="tiny muted pl-note">주력 등급은 선수마다 통산 도루 수를 1루에 나간 횟수(단타+볼넷)로 나눈 값으로 정한 초안이에요(나무위키 통산 기록). 경기에서는 안타 때 한 베이스 더 가기, 병살, 2루 포스아웃, 번트 안타, 태그업에 쓰여요. 「기록 없음」 선수는 보통(3등급)으로 계산해요.</p>${sections}`;
  }
  window.playersPage=function(){
    const head=header('PLAYERS','선수 정보','팀별 선수 특성을 한눈에 봐요');
    const tabs=`<div class="pl-tabs">${TABS.map(([k,l])=>`<button type="button" class="ctx-chip ${P.tab===k?'on':''}" onclick="playersTab('${k}')"><b>${l}</b></button>`).join('')}</div>`;
    const teams=`<div class="pl-teams"><button type="button" class="plan-chip ${P.team==='all'?'on':''}" onclick="playersTeam('all')">전체</button>${TEAMS.map(t=>`<button type="button" class="plan-chip ${P.team===t.id?'on':''}" onclick="playersTeam('${t.id}')">${safe(t.short)}</button>`).join('')}</div>`;
    return head+tabs+teams+(P.tab==='speed'?speedTab():'');
  };
})();
