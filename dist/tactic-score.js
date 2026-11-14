// 작전 점수 (score-1, docs/TACTIC_SCORE_DESIGN.md, user request 2026-11-13).
// - After each plate appearance: a toast with the points for my votes in it (server games: live and friend rooms).
// - Result screen: my score for the game, each vote, and in a friend room the room's standings
//   (server-game.js calls tacticScoreCard; AI matches build theirs in ai-game.js with tacticScoreCardHtml).
// - 순위·기록: the tactic ranking (admin-opened games only).
// Points come from the server (settle_round_scores); AI matches score in the browser with the same engine formula.
(function(){
  const api=()=>window.FANBALL_SERVER_CLIENT,user=()=>window.FANBALL_AUTH_USER?.()||null;
  const PHASE={pre_pa:'타석 전',two_strikes:'2스트라이크',three_balls:'3볼'};
  const fmt1=v=>(Math.round(Number(v||0)*10)/10).toFixed(1),fmt2=v=>Number(v||0).toFixed(2);
  const resultText=r=>r.result_detail||(typeof window.kindName==='function'&&r.result_kind?window.kindName(r.result_kind):r.result_kind)||'';
  const T={gameId:null,data:null,seen:null,plays:-1,at:0,standings:null,ranking:null,rankAt:0,loading:false};

  // Shared card markup (also used by ai-game.js): { total, votes, scored, rows, note, standings }
  const efficiencyText=v=>v==null?'—':`${fmt1(v)}점`;
  window.tacticScoreCardHtml=function({total=0,votes=0,scored=0,rows=[],note='',standings=null,efficiency=null}){
    if(!votes)return `<section class="card tactic-score-card"><div class="card-head"><div><h2>내 작전 점수</h2><small class="muted tiny">${note}</small></div></div><p class="tiny muted ts-empty">이 경기에서 작전 투표를 하지 않아 작전 점수가 없어요.</p></section>`;
    const list=rows.map(r=>`<li><span class="ts-when">${r.pa_no?`${r.pa_no}번째 타석 · `:''}${PHASE[r.phase]||''}</span><span class="ts-pick">${safe(r.choice||'')}${r.applied?'':' <em>적용 안 됨 · 가상 결과</em>'} → ${safe(resultText(r))}</span><b class="${Number(r.points)>0?'plus':''}">+${fmt1(r.points)}</b><small>결과 ${fmt1(r.outcome)} · 판단 ${fmt1(r.decision)}</small></li>`).join('');
    const room=standings?.length?`<div class="ts-standings"><b>이 방 작전 점수 순위</b><ol>${standings.map(s=>`<li class="${s.mine?'mine':''}"><span>${safe(s.nickname)}${s.mine?' (나)':''}</span><b>${fmt2(s.avg)}점</b><small>판단 효율 ${efficiencyText(s.efficiency)} · ${s.votes}표</small></li>`).join('')}</ol></div>`:'';
    return `<section class="card tactic-score-card"><div class="card-head"><div><h2>내 작전 점수</h2><small class="muted tiny">${note}</small></div><div class="ts-highlights"><b class="ts-total">${fmt2(total/votes)}점 <small>평균</small></b><span>판단 효율 <b>${efficiencyText(efficiency)}</b></span></div></div>
      <p class="ts-sum">투표 ${votes}번 · 점수 받은 투표 ${scored}번 · 누적 ${fmt1(total)}점</p>${room}
      <details class="ts-detail"><summary>투표별 내역</summary><ul class="ts-list">${list}</ul><p class="tiny muted">결과 점수 = 그 타석이 만든(수비는 막은) 득점 가치 × 10, 판단 점수 = 고른 작전의 기대값이 선택지 평균보다 나은 만큼 × 40. 다수결에서 밀린 작전은 같은 상황·같은 투구로 다시 돌린 가상 타석으로 계산해요. 점수는 더해지기만 해요.</p></details></section>`;
  };

  async function load(gameId){
    if(!api()||!user()||T.loading)return;T.loading=true;
    try{
      const {data,error}=await api().rpc('my_tactic_scores',{p_game_id:gameId});if(error)throw error;
      const fresh=T.gameId===gameId&&T.seen?(data.rows||[]).filter(r=>!T.seen.has(r.round_id)):[];
      if(T.gameId!==gameId){T.gameId=gameId;T.standings=null}
      T.seen=new Set((data.rows||[]).map(r=>r.round_id));T.data=data;
      if(fresh.length){const sum=fresh.reduce((a,r)=>a+Number(r.points||0),0),last=fresh[fresh.length-1];
        notify?.(`작전 점수 +${fmt1(sum)}점 · ${last.choice||''}${last.applied?'':'(가상)'} → ${resultText(last)} · 결과 ${fmt1(fresh.reduce((a,r)=>a+Number(r.outcome||0),0))} · 판단 ${fmt1(fresh.reduce((a,r)=>a+Number(r.decision||0),0))}`)}
      if(data.votes&&!data.ranked){const s=await api().rpc('game_tactic_standings',{p_game_id:gameId});if(!s.error)T.standings=s.data}
    }catch(e){/* tried again on the next plate appearance */}
    finally{T.loading=false}
  }
  // Server games: fetch my points when a plate appearance ends (and once when the game screen opens).
  setInterval(()=>{
    if(typeof page==='undefined'||page!=='game'||!user()||window.FANBALL_SERVER_GAME?.isLocal?.())return;
    const g=window.FANBALL_REMOTE_VOTING?.state?.game;if(!g||!['running','final'].includes(g.status))return;
    const plays=window.FANBALL_SERVER_GAME?.view?.()?.plays?.length??0;
    if(T.gameId!==g.id||plays!==T.plays){T.plays=plays;load(g.id).then(()=>{if(g.status==='final'&&typeof render==='function')render()})}
  },2500);

  // Result screen of a server game.
  window.tacticScoreCard=function(gameId){
    if(!user())return `<section class="card tactic-score-card"><div class="card-head"><h2>내 작전 점수</h2></div><p class="tiny muted ts-empty">로그인하고 작전 투표를 하면 작전 점수가 쌓여요.</p></section>`;
    if(T.gameId!==gameId||!T.data){load(gameId).then(()=>{if(typeof render==='function')render()});return ''}
    const d=T.data;
    return window.tacticScoreCardHtml({total:Number(d.total),votes:Number(d.votes),scored:Number(d.scored),efficiency:d.efficiency,rows:d.rows||[],standings:d.ranked?null:T.standings,
      note:d.ranked?'관리자가 연 경기라 작전 랭킹에 더해져요.':'친구 방 경기라 랭킹에는 더하지 않아요.'});
  };

  // 순위·기록: the tactic ranking (admin-opened games only).
  async function loadRanking(){
    if(!api()||Date.now()-T.rankAt<30000)return;T.rankAt=Date.now();
    try{const {data,error}=await api().rpc('tactic_ranking',{p_limit:20});if(error)throw error;T.ranking=data;if(page==='records'&&typeof render==='function')render()}catch(e){T.ranking={error:true}}
  }
  function rankingCard(){
    loadRanking();
    const R=T.ranking;
    const rows=!R?'<p class="tiny muted">불러오는 중…</p>':R.error?'<p class="tiny muted">랭킹을 불러오지 못했어요.</p>':!R.rows?.length?'<p class="tiny muted">평균 랭킹은 관리자 경기에서 20번 이상 투표한 뒤 표시돼요.</p>'
      :`<div class="result-table-scroll"><table class="table ts-rank"><thead><tr><th>순위</th><th>팬</th><th>평균 점수</th><th>투표</th><th>판단 효율</th></tr></thead><tbody>${R.rows.map(r=>`<tr class="${r.mine?'mine':''}"><td>${r.rank}</td><td class="player">${safe(r.nickname)}${r.mine?' <small>나</small>':''}</td><td><b>${fmt2(r.avg)}</b></td><td>${r.votes}</td><td>${efficiencyText(r.efficiency)}</td></tr>`).join('')}</tbody></table></div>`;
    const me=R?.me?`<p class="ts-me">내 순위 <b>${R.me.rank}위</b> · 평균 ${fmt2(R.me.avg)}점 · 투표 ${R.me.votes}번 · 판단 효율 ${efficiencyText(R.me.efficiency)}</p>`:'';
    return `<section class="card tactic-rank-card"><div class="card-head"><div><h2>작전 랭킹</h2><small class="muted tiny">관리자 경기 기준 · 투표당 평균 점수순 · 평균 순위는 투표 20번부터 · 친구 방과 AI 대결 제외</small></div><span class="tag">${R?.players??0}명</span></div>${me}${rows}<p class="tiny muted ts-rank-note">판단 효율은 선택지 중 최선의 판단 점수를 100점으로 환산한 비율이에요.</p></section>`;
  }
  if(typeof window.recordsPage==='function'){
    const base=window.recordsPage;
    window.recordsPage=function(){const html=base.apply(this,arguments),card=rankingCard();
      // after the page title block
      const head=html.indexOf('<div class="page-head">');if(head<0)return card+html;
      let depth=0,re=/<\/?div\b[^>]*>/g,m;re.lastIndex=head;while((m=re.exec(html))){depth+=m[0][1]==='/'?-1:1;if(depth===0)return html.slice(0,re.lastIndex)+card+html.slice(re.lastIndex)}
      return html+card};
  }
})();
