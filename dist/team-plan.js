// Team-wide game plans (engine 2.19, user request 2026-11-13): a batting plan and a pitching plan for your side,
// picked before the game (lineup screen) and changed any time during it (game screen). In a game with many
// fans the side plays the most picked plan; in a friend room or AI match your pick is the plan.
// Server games: set_team_plan / team_plan_status (202611130006_team_plans.sql); the orchestrator reads them
// before every pitch. The friend-room lineup editor and the AI match use window.teamPlanChips.
(function(){
  // Labels and descriptions mirror PLANS in dist/engine/pitch-engine.js.
  const INFO={
    offense:{normal:['기본','타자마다 평소대로 칩니다.'],first_pitch:['초구부터 적극 공략','빠른 카운트에 적극적으로 칩니다. 투구 수·볼넷·삼진이 줄고 빗맞은 타구가 늘어요.'],patient:['공 길게 보기','2스트라이크 전엔 잘 안 칩니다. 볼넷과 상대 투구 수가 늘고 루킹 삼진도 늘어요.'],power:['장타 노리기','크게 휘두릅니다. 홈런·2루타가 늘고 헛스윙 삼진도 늘어요.'],contact:['맞히기 위주','짧게 맞힙니다. 삼진이 줄고 장타도 줄어요.']},
    defense:{normal:['기본','투수마다 평소대로 던집니다.'],aggressive:['공격적 투구','스트라이크 먼저. 볼넷·투구 수가 줄고 안타는 조금 늘어요.'],careful:['신중한 투구','코너 위주. 피안타·장타가 줄고 볼넷·투구 수가 늘어 빨리 지쳐요.']},
  };
  window.FANBALL_PLAN_INFO=INFO;
  const esc=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  // Chip rows for both roles. pick: the chosen keys; applied: what the side plays now (may differ in a big game);
  // action: a global function name called as action(role, key).
  window.teamPlanChips=function({pick={},applied=null,action,disabled=false}){
    const row=role=>{const cur=pick[role]||'normal',on=applied?.[role];
      return `<div class="plan-row"><span class="plan-role">${role==='offense'?'공격':'수비'}</span><div class="plan-chips">${Object.entries(INFO[role]).map(([k,[label]])=>`<button type="button" class="plan-chip ${k===cur?'on':''} ${on&&on===k&&on!==cur?'applied':''}" ${disabled?'disabled':''} aria-pressed="${k===cur}" onclick="${action}('${role}','${k}')">${esc(label)}${on&&on===k&&on!==cur?' <small>적용 중</small>':''}</button>`).join('')}</div><small class="plan-desc">${esc(INFO[role][cur][1])}</small></div>`};
    return row('offense')+row('defense');
  };

  // In a game: one slim bar that is always open, with short labels, so a tactic changes in one tap (user request
  // 2026-11-13: opening, picking and folding took too long). The full description comes in the toast after a pick.
  const SHORT={offense:{normal:'기본',first_pitch:'초구 공략',patient:'길게 보기',power:'장타',contact:'맞히기'},defense:{normal:'기본',aggressive:'공격적',careful:'신중'}};
  window.teamPlanBar=function({title,pick={},applied=null,action,disabled=false,note=''}){
    const row=role=>{const cur=pick[role]||'normal',on=applied?.[role];
      return `<div class="pb-row"><span class="pb-role">${role==='offense'?'공격':'수비'}</span>${Object.keys(SHORT[role]).map(k=>`<button type="button" class="plan-chip pb-chip ${k===cur?'on':''} ${on&&on===k&&on!==cur?'applied':''}" ${disabled?'disabled':''} aria-pressed="${k===cur}" title="${esc(INFO[role][k][0])}: ${esc(INFO[role][k][1])}" onclick="${action}('${role}','${k}')">${esc(SHORT[role][k])}</button>`).join('')}</div>`};
    return `<section class="card plan-bar"><div class="pb-head"><b>${esc(title)}</b><small>${note||'누르면 다음 공부터 반영 · 투표한 작전이 우선'}</small></div>${row('offense')}${row('defense')}</section>`;
  };
  // (Older folding version, kept for reference by the AI match before it switched to teamPlanBar.)
  window.teamPlanFold=function({title,note,pick={},chipsHtml}){
    const now=r=>INFO[r][pick[r]||'normal'][0];
    return `<details class="card team-plan in-game" ${window.__teamPlanOpen?'open':''} ontoggle="window.__teamPlanOpen=this.open"><summary><b>${esc(title)}</b><span>공격 ${esc(now('offense'))} · 수비 ${esc(now('defense'))}</span><em><span class="plan-when-closed">바꾸기</span><span class="plan-when-open">접기</span></em></summary><small class="muted tiny plan-note">${note}</small>${chipsHtml}</details>`;
  };
  // ---------- server games (live and friend-room games) ----------
  const api=()=>window.FANBALL_SERVER_CLIENT,rv=()=>window.FANBALL_REMOTE_VOTING;
  const P={gameId:null,status:null,busy:false,at:0};
  const myKey=()=>rv()?.state?.membership?.team_id||null;
  async function load(force){
    const g=rv()?.state?.game;if(!g||!api())return;
    if(!force&&P.gameId===g.id&&Date.now()-P.at<4000)return;
    P.at=Date.now();
    try{const {data,error}=await api().rpc('team_plan_status',{p_game_id:g.id});if(error)throw error;
      const changed=JSON.stringify(data)!==JSON.stringify(P.status)||P.gameId!==g.id;P.gameId=g.id;P.status=data;
      if(changed&&typeof render==='function'&&['game','lineup'].includes(page))render()}
    catch(e){/* tried again on the next poll */}
  }
  window.teamPlanPick=async function(role,key){
    const g=rv()?.state?.game,k=myKey();if(!g||!k||P.busy)return;
    // Start from my last pick, or (no pick yet) what my side plays now, e.g. the plan saved with a friend-room setup.
    const cur=P.status?.mine||P.status?.sides?.[k]||{},next={offense:cur.offense||'normal',defense:cur.defense||'normal',[role]:key};
    P.busy=true;
    try{const {data,error}=await api().rpc('set_team_plan',{p_game_id:g.id,p_offense:next.offense,p_defense:next.defense});if(error)throw error;P.status=data;
      notify(`${role==='offense'?'공격':'수비'} 전술: ${INFO[role][key][0]} — ${INFO[role][key][1]}`)}
    catch(e){notify(e.message==='join this game before choosing'?'이 경기의 한쪽 팀에 참여해야 고를 수 있어요.':'전술을 바꾸지 못했어요: '+(e.message||e))}
    finally{P.busy=false;if(typeof render==='function')render()}
  };
  function card(where){
    const g=rv()?.state?.game;if(!g||!['scheduled','running'].includes(g.status))return '';
    const k=myKey(),st=P.status;if(P.gameId!==g.id){load(true);return ''}
    if(!k)return '';
    const applied=st?.sides?.[k]||{offense:'normal',defense:'normal'},mine=st?.mine||applied,fans=Number(applied.fans||0);
    const name=(typeof team==='function'&&team(String(k).split('@')[0])?.short)||'';
    const many=fans>1;
    const note=`${g.status==='running'?'경기 중 언제든 바꿀 수 있어요. 다음 공부터 반영돼요.':'경기 시작 전에 정해 두면 첫 공부터 적용돼요.'}${many?` 팬 ${fans}명이 고른 것 중 가장 많은 전술이 적용돼요.`:''} 작전 투표가 열린 타석에서는 투표한 작전이 우선이에요.`;
    const chipsHtml=window.teamPlanChips({pick:mine,applied:many?applied:null,action:'teamPlanPick',disabled:P.busy});
    if(where==='in-game')return window.teamPlanBar({title:`팀 전술 · ${name}`,pick:mine,applied:many?applied:null,action:'teamPlanPick',disabled:P.busy,note:many?`팬 ${fans}명 중 최다가 적용 · 금색은 지금 적용 중`:''});
    return `<section class="card team-plan ${where}"><div class="card-head"><div><h2>팀 전술 · ${esc(name)}</h2><small class="muted tiny">${note}</small></div></div>${chipsHtml}</section>`;
  }
  const onPage=()=>typeof page!=='undefined'&&['game','lineup'].includes(page);
  setInterval(()=>{if(onPage())load(false)},1000);
  if(typeof window.gamePage==='function'){
    const base=window.gamePage;
    window.gamePage=function(){const html=base();const c=card('in-game');return c&&html.includes('<div class="game-layout">')?html.replace('<div class="game-layout">',c+'<div class="game-layout">'):html};
  }
  if(typeof window.lineupPage==='function'){
    const base=window.lineupPage;
    window.lineupPage=function(){const html=base();if(typeof db!=='undefined'&&db.lineupCtx)return html;const c=card('pregame');return c&&html.includes('<div class="lineup-layout">')?html.replace('<div class="lineup-layout">',c+'<div class="lineup-layout">'):html};
  }
})();
