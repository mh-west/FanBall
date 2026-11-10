/* Server-run official game in the game center (docs/ORCHESTRATOR_DESIGN.md, stage 4).
   Reads the game row, plate appearances and pitches the server saves, follows them live
   (Realtime + a polling fallback), and draws them with the same score table, runner diamond,
   at-bat cards and vote cards as the local demo. The browser never decides a result. */
(function(){
  const S={kboId:null,game:null,plays:[],pitches:[],channel:null,loading:false,lastPitch:0,lastPa:0,lastLoad:0,error:null};
  const api=()=>window.FANBALL_SERVER_CLIENT;
  const BASES={'000':'주자 없음','100':'1루','010':'2루','001':'3루','110':'1,2루','101':'1,3루','011':'2,3루','111':'만루'};
  const baseLabel=b=>BASES[`${b?.[0]?1:0}${b?.[1]?1:0}${b?.[2]?1:0}`];
  const PITCH_RESULT={ball:'볼',called_strike:'스트라이크',swinging_strike:'헛스윙',foul:'파울',in_play:'인플레이',hbp:'몸에 맞는 공',intentional_walk:'고의사구',bunt_foul:'번트 파울',bunt_swinging_strike:'번트 헛스윙',bunt_in_play:'번트 인플레이'};
  const OUTCOME_NAMES={'1B':'단타','2B':'2루타','3B':'3루타',HR:'홈런',OUT:'아웃',DP:'병살',ROE_FC:'실책·야수선택',SAC_FLY:'희생플라이',SAC_BUNT:'희생번트',sacrifice:'희생 성공',hit:'번트 안타',out:'번트 아웃',fieldersChoice:'야수선택(선행 주자 아웃)'};
  const OFFENSE={normal:'기본 타격',contact:'컨택 타격',aggressive:'강공',wait:'기다리기',bunt:'희생번트'};
  const ALIGN={standard:'기본 수비',double_play:'병살 대비',corners_in:'번트 대비',infield_in:'내야 전진',outfield_deep:'외야 장타 대비'};
  const APPROACH={standard:'기본 투구',attack:'정면 승부',pitch_around:'유인구 승부'};

  // Result names of the pitch engine (fanball-engine-2) added to the demo's names.
  const baseKindName=window.kindName;
  window.kindName=k=>({IBB:'고의사구',SF:'희생플라이',SAC:'희생번트 성공',BUNT_HIT:'번트 안타',BUNT_OUT:'번트 아웃',FC:'야수선택',ROE:'실책 출루',GDP:'병살타'})[k]||baseKindName(k);

  // A strikeout is named by its last pitch: swing → 헛스윙 삼진, taken strike → 루킹 삼진, bunt → 번트 삼진.
  function resultName(kind,lastPitchResult){
    if(kind==='K')return {swinging_strike:'헛스윙 삼진',called_strike:'루킹 삼진',bunt_foul:'번트 삼진(파울)',bunt_swinging_strike:'번트 삼진(헛스윙)'}[lastPitchResult]||'삼진';
    return kindName(kind);
  }

  function reset(kboId){
    if(S.channel&&api())api().removeChannel(S.channel);
    Object.assign(S,{kboId,game:null,plays:[],pitches:[],channel:null,lastPitch:0,lastPa:0,error:null});
  }

  async function load(force=false){
    const client=api();if(!client||typeof MATCH==='undefined')return;
    if(S.kboId!==MATCH.id)reset(MATCH.id);
    if(S.loading||(!force&&Date.now()-S.lastLoad<2500))return;
    S.loading=true;S.lastLoad=Date.now();
    try{
      const {data:game,error}=await client.from('fanball_games').select('id,kbo_game_id,status,score,started_at,ended_at,model_version,seed_hash,revealed_seed,lineup_snapshot').eq('kbo_game_id',MATCH.id).maybeSingle();
      if(error)throw error;
      const changed=JSON.stringify([game?.status,game?.score])!==JSON.stringify([S.game?.status,S.game?.score]);
      S.game=game||null;
      if(!game||game.status==='scheduled'){if(changed)redraw();return}
      const [pas,pitches]=await Promise.all([
        client.from('plate_appearances').select('pa_no,outcome,runs,result_payload').eq('game_id',game.id).gt('pa_no',S.lastPa).order('pa_no'),
        client.from('pitches').select('pitch_no,pa_no,count_before,call,result,payload,created_at').eq('game_id',game.id).gt('pitch_no',S.lastPitch).order('pitch_no').limit(1000),
      ]);
      if(pas.error)throw pas.error;if(pitches.error)throw pitches.error;
      for(const row of pas.data||[]){const pl=row.result_payload||{},lastP=(pl.pitches||[])[(pl.pitches||[]).length-1];S.plays.push({...pl,paNo:row.pa_no,kind:row.outcome,runs:row.runs,kindLabel:resultName(row.outcome,lastP?.result)});S.lastPa=row.pa_no}
      for(const row of pitches.data||[]){S.pitches.push(row);S.lastPitch=row.pitch_no}
      if(game.status==='running'&&!S.channel)subscribe(game.id);
      if(changed||pas.data?.length||pitches.data?.length)redraw();
      S.error=null;
    }catch(error){S.error=error.message||String(error);console.warn('FanBall server game load failed:',S.error)}
    finally{S.loading=false}
  }

  function subscribe(gameId){
    const client=api();if(!client)return;
    S.channel=client.channel('fanball-game-'+gameId)
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'pitches',filter:'game_id=eq.'+gameId},()=>load(true))
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'plate_appearances',filter:'game_id=eq.'+gameId},()=>load(true))
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'fanball_games',filter:'id=eq.'+gameId},()=>load(true))
      .subscribe();
  }

  function redraw(){
    if(typeof page==='undefined'||typeof render!=='function')return;
    if(page==='game'||page==='home')render();
  }

  // ---------- view model in the shape the demo renderers use ----------
  function view(){
    const g=S.game;if(!g||g.status==='scheduled')return null;
    const awayId=MATCH.away,homeId=MATCH.home,innings=[],bat={};
    for(const p of S.plays){
      const row=innings[p.inn-1]||(innings[p.inn-1]={away:0,home:0});row[p.side]+=p.runs||0;
      const b=bat[p.batter]||(bat[p.batter]={AB:0,H:0,SH:0,'2B':0,'3B':0,HR:0,BB:0,K:0});
      if(!['BB','IBB','HBP','SAC','SF'].includes(p.kind))b.AB++;
      if(['1B','2B','3B','HR','BUNT_HIT'].includes(p.kind))b.H++;
      if(['2B','3B','HR'].includes(p.kind))b[p.kind]++;
      if(p.kind==='BB'||p.kind==='IBB')b.BB++;if(p.kind==='K')b.K++;if(p.kind==='SAC')b.SH++;
    }
    for(let i=0;i<innings.length;i++)innings[i]=innings[i]||{away:0,home:0};
    const last=S.pitches[S.pitches.length-1],score=last?.payload?.score||g.score||{away:0,home:0};
    return {server:true,id:g.id,status:g.status,awayId,homeId,away:score.away??0,home:score.home??0,innings,plays:S.plays,bat,last,
      tiebreak:g.status==='final'&&score.away===score.home?'12회 종료 무승부':null};
  }

  // The plate appearance on screen: the one in progress, or the one that just ended.
  function currentAtBat(v){
    const last=v.last;if(!last)return null;
    const paNo=last.pa_no,pitches=S.pitches.filter(p=>p.pa_no===paNo),play=last.payload?.paResult?S.plays.find(p=>p.paNo===paNo):null;
    return {paNo,pitches,play,last,ended:Boolean(last.payload?.paResult)};
  }

  function pitchBoard(ab){
    const lastP=ab.last,pay=lastP.payload||{},count=(ab.ended?ab.play?.count:pay.countAfter)||lastP.count_before;
    const [balls,strikes]=(count||'0-0').split('-').map(Number);
    const outs=ab.ended?(ab.play?.outsAfter??pay.outs??0):(pay.outs??0),bases=ab.ended?(ab.play?.base||pay.base):pay.base;
    const points=ab.pitches.map((p,i)=>{const q=p.payload||{};return `<span class="pitch-point ${p.call} ${i===ab.pitches.length-1?'current':''}" style="left:${q.x}%;top:${q.y}%" aria-label="${i+1}구">${i+1}</span>`}).join('');
    const callText=lastP.call==='ibb'?'고의사구':(PITCH_RESULT[lastP.result]||lastP.result);
    // Show the applied tactics only in at-bats where a vote was held.
    const tactics=pay.tactics||{},voted=pay.voted??(tactics.offense!=='normal'||tactics.alignment!=='standard'||tactics.approach!=='standard'),tacticLine=voted?[OFFENSE[tactics.offense],ALIGN[tactics.alignment],APPROACH[tactics.approach]].filter(Boolean).join(' · '):'';
    return `<div class="pitch-panel"><div class="atbat-heading"><span>${pay.inning}회 ${pay.side==='away'?'초':'말'}</span><strong>${safe(pay.batter||'')}</strong></div>${ab.ended&&ab.play?`<div class="atbat-result"><small>타석 결과</small><b>${ab.play.kindLabel||kindName(ab.play.kind)}${ab.play.runs?` · ${ab.play.runs}득점`:''}</b></div>`:''}
    <div class="pitch-body"><div class="zone-wrap"><div class="zone-label">STRIKE ZONE · 투구 위치</div><div class="pitch-plot"><div class="pitch-zone-grid">${Array.from({length:9},()=>'<span></span>').join('')}</div>${points}</div></div>
    <div class="pitch-info"><div class="pitch-speed">${pay.speed??'-'}<small>km/h</small></div><div class="pitch-type">${safe(pay.type||'')}</div><div class="pitch-call ${lastP.call}">${callText}${lastP.payload?.bip?` · ${OUTCOME_NAMES[lastP.payload.bip]||lastP.payload.bip}`:''}</div><div class="count-lights"><div><small>B</small>${[0,1,2].map(i=>`<i class="ball-light ${i<Math.min(balls,3)?'on':''}"></i>`).join('')}</div><div><small>S</small>${[0,1].map(i=>`<i class="strike-light ${i<Math.min(strikes,2)?'on':''}"></i>`).join('')}</div><div><small>O</small>${[0,1].map(i=>`<i class="out-light ${i<Math.min(outs,2)?'on':''}"></i>`).join('')}</div></div>${baseDiamond(bases||[])}</div></div>
    <div class="server-pitch-foot"><span>${S.pitches.length}구째 · ${lastP.count_before} → ${ab.ended?'타석 종료':count}</span>${tacticLine?`<span>투표로 정한 작전 · ${tacticLine}</span>`:''}<button class="detail-button" onclick="showServerPitch(${lastP.pitch_no})">이 투구 확률</button></div></div>`;
  }

  // Probability of each pitch result at that count, then what a ball in play would become.
  window.showServerPitch=function(pitchNo){
    const p=S.pitches.find(x=>x.pitch_no===pitchNo);if(!p)return;
    const d=p.payload?.distribution,total=d?Object.values(d.counts).reduce((a,b)=>a+b,0):0;
    const label={ball:'볼',called_strike:'스트라이크',swinging_strike:'헛스윙',foul:'파울',in_play:'인플레이',hbp:'몸에 맞는 공'};
    const rows=d?Object.entries(d.counts).sort((a,b)=>b[1]-a[1]).map(([k,n])=>`<div class="dist-row ${p.result.replace('bunt_','')===k?'chosen':''}"><span>${(p.payload?.bunting&&k!=='ball'&&k!=='hbp'?'번트 ':'')+(label[k]||k)}</span><div class="dist-track"><i style="width:${n/total*100}%"></i></div><b>${n.toLocaleString()}회</b><small>${(n/total*100).toFixed(1)}%</small></div>`).join(''):'<p class="tiny muted">이 투구에는 분포가 없습니다.</p>';
    const ip=p.payload?.inPlayOdds,ipRows=ip?Object.entries(ip).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<div class="dist-row ${p.payload?.bip===k?'chosen':''}"><span>${OUTCOME_NAMES[k]||k}</span><div class="dist-track"><i style="width:${v}%"></i></div><b></b><small>${v}%</small></div>`).join(''):'';
    document.getElementById('dist-modal')?.remove();
    document.body.insertAdjacentHTML('beforeend',`<div class="modal-backdrop" id="dist-modal" onclick="if(event.target===this)this.remove()"><section class="dist-modal"><button class="modal-close" onclick="document.getElementById('dist-modal').remove()">×</button><div class="eyebrow">PITCH ${p.pitch_no} · ${d?d.trials.toLocaleString()+' TRIALS':''}</div><h2>${safe(p.payload?.batter||'')} · ${p.count_before}에서 던진 공</h2><p>결과 <b>${PITCH_RESULT[p.result]||p.result}</b>${p.payload?.paResult?` · 타석 결과 <b>${resultName(p.payload.paResult,p.result)}</b>`:''}</p><div class="dist-list">${rows}</div>${ipRows?`<h3 class="dist-subtitle">${p.payload?.bunting?'번트가 굴러가면':'공이 인플레이되면'}</h3><div class="dist-list">${ipRows}</div>`:''}<div class="notice">투구 결과는 이 카운트·선수·작전 조건으로 표본을 뽑은 빈도에서 하나를 추첨했습니다. 인플레이 결과도 같은 방식입니다. 볼카운트별 기준값 출처: Retrosheet (아래 표시).</div></section></div>`);
  };

  // At-bat cards: the demo card asks showDistribution(index); for server games list that at-bat's pitches.
  const baseShowDistribution=window.showDistribution;
  window.showDistribution=function(i){
    const v=active()?view():null;if(!v)return baseShowDistribution(i);
    const play=v.plays[i];if(!play)return;
    // Each pitch as "N구 · count before → count after · result" so 0-0 is clearly the count before the pitch.
    const rows=S.pitches.filter(p=>p.pa_no===play.paNo).map((p,i)=>`<div class="dist-row"><span>${i+1}구 · ${p.count_before} → ${p.payload?.paResult?resultName(p.payload.paResult,p.result):(p.payload?.countAfter||'')}</span><div class="dist-track"><i style="width:0"></i></div><b>${PITCH_RESULT[p.result]||p.result}</b><small><button class="detail-button" onclick="showServerPitch(${p.pitch_no})">확률</button></small></div>`).join('');
    document.getElementById('dist-modal')?.remove();
    document.body.insertAdjacentHTML('beforeend',`<div class="modal-backdrop" id="dist-modal" onclick="if(event.target===this)this.remove()"><section class="dist-modal"><button class="modal-close" onclick="document.getElementById('dist-modal').remove()">×</button><div class="eyebrow">PLATE APPEARANCE ${play.paNo}</div><h2>${safe(play.batter)} · ${play.kindLabel||kindName(play.kind)}</h2><p>${play.inn}회 ${play.side==='away'?'초':'말'} · 투구 ${play.pitches?.length||0}개 · 카운트별 결과</p><div class="dist-list">${rows}</div></section></div>`);
  };

  const ATTRIBUTION='<p class="notice data-credit">볼카운트별 기준값: The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at "www.retrosheet.org". · 선수 이름과 기록은 샘플이며, 실제 KBO 기록의 권리는 KBO 등 원 권리자에게 있습니다.</p>';

  function livePage(v){
    const ab=currentAtBat(v),pay=v.last?.payload||{},inning=pay.inning||1,half=pay.side||'away',attackId=half==='away'?v.awayId:v.homeId;
    const outs=ab?.ended?(ab.play?.outsAfter??0):(pay.outs??0),bases=ab?.ended?(ab.play?.base||[]):(pay.base||[]);
    let html=header('GAME CENTER','공식 경기 센터','서버가 진행하는 공식 경기 · 모든 팬이 같은 투구를 같은 시각에 봅니다')
      +`<div class="banner live-banner"><b>실시간 공식 경기</b> · 투구는 서버에서 2초 간격으로 한 개씩 계산되어 바로 표시됩니다. 작전 투표는 타석 전과 득점권 핵심 카운트(2스트라이크·3볼)에서 12초 동안 열립니다.</div>`
      +`<div class="game-layout"><section class="card scoreboard"><div class="score-title"><h2>${team(v.awayId).short} vs ${team(v.homeId).short}</h2><span class="tag red">진행 중</span></div>${scoreTable(v)}`
      +`<div class="game-countbar"><strong class="current-inning">${inning}회 ${half==='away'?'초':'말'}</strong><span class="attack-team">${team(attackId).name} 공격</span><b>아웃</b><div class="out-lights">${[0,1].map(i=>`<i class="${i<Math.min(outs,2)?'on':''}"></i>`).join('')}</div><strong>${outs} OUT</strong>${baseDiamond(bases)}</div>`
      +(ab?pitchBoard(ab):'<div class="empty"><p>첫 투구를 기다리고 있습니다.</p></div>')
      +'</section><section class="card situation"><div class="score-title"><h2>팬 작전 투표 · 타석 로그</h2></div>';
    const remoteVote=window.FANBALL_REMOTE_VOTING?.view();
    html+=remoteVote?.round?.status==='open'||remoteVote?.round?.status==='closing'?remoteTacticalPanel(remoteVote):`<div class="vote-box remote-vote"><b>지금은 투표가 없습니다</b><p class="tiny muted">${baseLabel(pay.base)} · ${pay.outs??0}아웃. 작전 상황(득점권 주자, 2아웃 전 1루 주자 등)이 되면 다음 투구 전에 양 팀 투표가 동시에 열립니다.</p></div>`;
    const maxInning=Math.max(1,...v.plays.map(p=>p.inn),inning);
    if(selectedLogInning>maxInning)selectedLogInning=maxInning;
    html+=inningTabs(maxInning)+renderInningLogs(v,selectedLogInning);
    return html+'</section></div>'+ATTRIBUTION;
  }

  function resultPageServer(v){
    const g=S.game,lineup=g.lineup_snapshot?.teams||{};
    const teamStats=id=>{const t=lineup[id],names=t?t.order.map(i=>t.players[i][0]):[],rows=names.map(name=>{const b=v.bat[name]||{AB:0,H:0,SH:0,'2B':0,'3B':0,HR:0,BB:0,K:0};return `<tr><td class="player">${safe(name)}</td><td>${b.AB}</td><td>${b.H}</td><td>${b.SH}</td><td>${b['2B']}</td><td>${b['3B']}</td><td>${b.HR}</td><td>${b.BB}</td><td>${b.K}</td><td>${b.AB?(b.H/b.AB).toFixed(3).slice(1):'.000'}</td></tr>`}).join('');return `<section class="team-result-card"><div class="team-log-heading"><span>${id===v.awayId?'원정팀 타격 기록':'홈팀 타격 기록'}</span><b>${team(id).name}</b></div><div class="result-table-scroll"><table class="table"><thead><tr><th>선수</th><th>AB</th><th>H</th><th>SH</th><th>2B</th><th>3B</th><th>HR</th><th>BB</th><th>K</th><th>AVG</th></tr></thead><tbody>${rows}</tbody></table></div></section>`};
    const outcome=v.tiebreak||(v.away===v.home?'무승부':`${team(v.away>v.home?v.awayId:v.homeId).name} 승리`);
    const minutes=g.started_at&&g.ended_at?Math.round((Date.parse(g.ended_at)-Date.parse(g.started_at))/60000):null;
    const maxInning=Math.max(1,...v.plays.map(p=>p.inn));if(selectedLogInning>maxInning)selectedLogInning=1;
    return `${header('FINAL · OFFICIAL RESULT','경기 결과','서버가 한 번만 진행한 공식 경기 · 기록은 바꿀 수 없습니다')}<div class="result-head"><div><div class="eyebrow" style="color:#9ba9bc">FANBALL MATCH · ${MATCH.date}</div><h2>${team(v.awayId).name} vs ${team(v.homeId).name}</h2><div class="tiny" style="color:#aeb9c8;margin-top:5px">${outcome} · 투구 ${S.pitches.length}개 · 타석 ${v.plays.length}개${minutes!=null?` · ${minutes}분`:''}</div></div><div class="final-score">${v.away}<span>:</span>${v.home}</div></div><section class="card result-scoreboard"><div class="score-title"><h2>이닝별 스코어</h2><span class="tag">${v.innings.length}회 종료</span></div>${scoreTable(v)}</section><h2 class="result-section-title">팬볼 타자 기록 <small>팀별 분리</small></h2><div class="result-team-grid">${teamStats(v.awayId)}${teamStats(v.homeId)}</div><h2 class="result-section-title">타석별 경기 로그 <small>카드의 '결과 분포'에서 투구별 확률 확인</small></h2>${inningTabs(maxInning)}${renderInningLogs(v,selectedLogInning)}<section class="card seed-proof"><h3>결과 검증 정보</h3><p class="tiny muted">경기 시작 때 공개한 시드 지문(SHA-256)과 종료 뒤 공개한 시드입니다. 공개된 엔진 코드(${safe(g.model_version||'')})와 기록된 투표 결과로 경기를 다시 계산하면 같은 투구가 나옵니다.</p><p class="tiny"><b>시드 지문</b> <code>${safe(g.seed_hash||'')}</code><br><b>공개 시드</b> <code>${g.revealed_seed??'-'}</code></p></section>${ATTRIBUTION}`;
  }

  function active(){return Boolean(S.game&&S.game.status!=='scheduled'&&S.kboId===MATCH?.id&&S.game.model_version!=='fanball-engine-1'&&!/^fanball-engine-1/.test(S.game.model_version||''))}

  window.FANBALL_SERVER_GAME={
    load,active,view,
    page(){const v=view();return v.status==='final'?resultPageServer(v):livePage(v)},
    homeCard(){
      const v=view();if(!v)return '';const pay=v.last?.payload||{},label=v.status==='final'?'경기 종료':'실시간 진행 중',half=pay.side||'away',attackId=half==='away'?v.awayId:v.homeId;
      return `<section class="home-live-card" id="home-live-match"><div class="home-live-head"><span class="home-live-dot"></span><b>팬볼 공식 경기 ${label}</b><button type="button" onclick="go('game')">경기 보기 →</button></div><div class="home-live-main"><strong>${v.status==='final'?'FINAL':`${pay.inning||1}회 ${half==='away'?'초':'말'}`}</strong><span>${v.status==='final'?'서버 공식 결과':`${team(attackId).name} 공격 · ${baseLabel(pay.base)} · ${pay.outs??0}아웃`}</span><b>${team(v.awayId).short} ${v.away} : ${v.home} ${team(v.homeId).short}</b></div></section>`;
    },
  };

  // The game center and the home card show the server game when the selected fixture has one.
  const baseGamePage=window.gamePage,baseHomeLiveCard=window.homeLiveCard;
  window.gamePage=function(){return active()?window.FANBALL_SERVER_GAME.page():baseGamePage()};
  window.homeLiveCard=function(){return active()?window.FANBALL_SERVER_GAME.homeCard():baseHomeLiveCard()};

  setInterval(()=>{if(typeof page!=='undefined'&&['home','game'].includes(page))load()},3000);
  if(api())load(true);
})();
