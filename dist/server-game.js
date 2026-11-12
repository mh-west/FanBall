/* Server-run official game in the game center (docs/ORCHESTRATOR_DESIGN.md, stage 4).
   Reads the game row, plate appearances and pitches the server saves, follows them live
   (Realtime + a polling fallback), and draws them with the same score table, runner diamond,
   at-bat cards and vote cards as the local demo. The browser never decides a result. */
(function(){
  // The at-bat log follows the inning being played unless the viewer picked another inning.
  let followLive=true;
  const S={kboId:null,game:null,plays:[],pitches:[],channel:null,loading:false,lastPitch:0,lastPa:0,lastLoad:0,error:null,resultQueue:[],resultSeen:new Set(),resultTimer:null};
  const api=()=>window.FANBALL_SERVER_CLIENT;
  const BASES={'000':'주자 없음','100':'1루','010':'2루','001':'3루','110':'1,2루','101':'1,3루','011':'2,3루','111':'만루'};
  const baseLabel=b=>BASES[`${b?.[0]?1:0}${b?.[1]?1:0}${b?.[2]?1:0}`];
  const PITCH_RESULT={ball:'볼',called_strike:'스트라이크',swinging_strike:'헛스윙',foul:'파울',in_play:'인플레이',hbp:'몸에 맞는 공',intentional_walk:'고의사구',bunt_foul:'번트 파울',bunt_swinging_strike:'번트 헛스윙',bunt_in_play:'번트 인플레이'};
  const OUTCOME_NAMES={'1B':'단타','2B':'2루타','3B':'3루타',HR:'홈런',OUT:'아웃',DP:'병살',ROE_FC:'실책·야수선택',SAC_FLY:'희생플라이(득점)',GO_RBI:'땅볼 아웃 · 타점',SAC_BUNT:'희생번트',sacrifice:'희생 성공',hit:'번트 안타',out:'번트 아웃',fieldersChoice:'야수선택(선행 주자 아웃)',doublePlay:'번트 병살'};
  const OFFENSE={normal:'기본 타격',contact:'컨택 타격',aggressive:'강공',wait:'기다리기',bunt:'희생번트'};
  const ALIGN={standard:'기본 수비',double_play:'병살 대비',corners_in:'번트 대비',infield_in:'내야 전진',outfield_deep:'외야 장타 대비'};
  const APPROACH={standard:'기본 투구',attack:'정면 승부',pitch_around:'유인구 승부'};

  // Result names of the pitch engine (fanball-engine-2) added to the demo's names.
  const baseKindName=window.kindName;
  window.kindName=k=>({BUNT_DP:'번트 병살',GO_RBI:'땅볼 아웃 · 타점',IBB:'고의사구',SF:'희생플라이',SAC:'희생번트 성공',BUNT_HIT:'번트 안타',BUNT_OUT:'번트 아웃',FC:'번트 실패 · 야수선택',ROE:'실책 출루',GDP:'병살타'})[k]||baseKindName(k);

  // A strikeout is named by its last pitch: swing → 헛스윙 삼진, taken strike → 루킹 삼진, bunt → 번트 삼진.
  // A bunt that gets the lead runner out (the batter reaches first) is scored a fielder's choice; say what
  // happened first: runner on 1st → out at 2nd, runners on 1st and 2nd → out at 3rd (engine FC rule).
  function resultName(kind,lastPitchResult,basesBefore,detail){
    if(kind==='K')return {swinging_strike:'헛스윙 삼진',called_strike:'루킹 삼진',bunt_foul:'번트 삼진(파울)',bunt_swinging_strike:'번트 삼진(헛스윙)'}[lastPitchResult]||'삼진';
    if(kind==='FC'&&Array.isArray(basesBefore)){const [a,b,c]=basesBefore.map(Boolean),forced=a,where=a?(b?(c?'홈':'3루'):'2루'):(c?'홈':'3루');return `번트 실패 · ${where} ${forced?'포스아웃':'주자 아웃'}(야수선택)`} // engine fieldersChoiceBases (2.19)
    return detail||kindName(kind);
  }

  // Developer demo (dist/local-game.js) can feed this screen instead of the server.
  let local=null;
  function toPlay(row){const pl=row.result_payload||{},lastP=(pl.pitches||[])[(pl.pitches||[]).length-1];return {...pl,paNo:row.pa_no,kind:row.outcome,runs:row.runs,kindLabel:resultName(row.outcome,lastP?.result,pl.basesBefore,pl.detail)}}

  function reset(kboId){
    if(S.channel&&api())api().removeChannel(S.channel);
    clearTimeout(S.resultTimer);
    Object.assign(S,{kboId,game:null,plays:[],pitches:[],channel:null,lastPitch:0,lastPa:0,error:null,resultQueue:[],resultSeen:new Set(),resultTimer:null});
  }

  async function load(force=false){
    if(local)return;
    const client=api();if(!client||typeof MATCH==='undefined')return;
    if(S.kboId!==MATCH.id)reset(MATCH.id);
    if(S.loading||(!force&&Date.now()-S.lastLoad<2500))return;
    S.loading=true;S.lastLoad=Date.now();
    // A different game may be selected while this load is in flight; drop its results then.
    const kboId=MATCH.id,stale=()=>Boolean(local)||S.kboId!==kboId;
    try{
      const {data:game,error}=await client.from('fanball_games').select('id,kbo_game_id,status,score,started_at,ended_at,model_version,seed_hash,revealed_seed,lineup_snapshot').eq('kbo_game_id',MATCH.id).maybeSingle();
      if(error)throw error;
      if(stale())return;
      const changed=JSON.stringify([game?.status,game?.score])!==JSON.stringify([S.game?.status,S.game?.score]);
      S.game=game||null;
      if(!game||game.status==='scheduled'){if(changed)redraw();return}
      const [pas,pitches]=await Promise.all([
        client.from('plate_appearances').select('pa_no,outcome,runs,result_payload').eq('game_id',game.id).gt('pa_no',S.lastPa).order('pa_no'),
        client.from('pitches').select('pitch_no,pa_no,count_before,call,result,payload,created_at').eq('game_id',game.id).gt('pitch_no',S.lastPitch).order('pitch_no').limit(1000),
      ]);
      if(pas.error)throw pas.error;if(pitches.error)throw pitches.error;
      if(stale())return;
      for(const row of pas.data||[]){S.plays.push(toPlay(row));S.lastPa=row.pa_no}
      for(const row of pitches.data||[]){S.pitches.push(row);S.lastPitch=row.pitch_no}
      if(game.status==='running'&&!S.channel)subscribe(game.id);
      if(changed||pas.data?.length||pitches.data?.length)redraw();
      S.error=null;
    }catch(error){S.error=error.message||String(error);console.warn('FanBall server game load failed:',S.error)}
    finally{S.loading=false;if(S.kboId!==MATCH.id)load(true)}
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
    if(page==='game'||page==='home'||page==='ai')render();
  }

  // ---------- view model in the shape the demo renderers use ----------
  function view(){
    const g=S.game;if(!g||g.status==='scheduled')return null;
    const awayId=MATCH.away,homeId=MATCH.home,innings=[],bat={};
    for(const p of S.plays){
      const row=innings[p.inn-1]||(innings[p.inn-1]={away:0,home:0});row[p.side]+=p.runs||0;
      const bk=awayId===homeId?p.side+':'+p.batter:p.batter,b=bat[bk]||(bat[bk]={AB:0,H:0,SH:0,'2B':0,'3B':0,HR:0,BB:0,K:0});
      if(!['BB','IBB','HBP','SAC','SF'].includes(p.kind))b.AB++;
      if(['1B','2B','3B','HR','BUNT_HIT'].includes(p.kind))b.H++;
      if(['2B','3B','HR'].includes(p.kind))b[p.kind]++;
      if(p.kind==='BB'||p.kind==='IBB')b.BB++;if(p.kind==='K')b.K++;if(p.kind==='SAC')b.SH++;b.RBI=(b.RBI||0)+(p.rbi??(['GDP','ROE'].includes(p.kind)?0:(p.runs||0)));
      // Runs scored: lead runners cross first (3rd, 2nd, 1st), then the batter on a home run.
      if(p.runs>0){const before=p.basesBefore||[],who=[before[2],before[1],before[0],p.batter].filter(Boolean).slice(0,p.runs);
        for(const n of who){const k=awayId===homeId?p.side+':'+n:n,r=bat[k]||(bat[k]={AB:0,H:0,SH:0,'2B':0,'3B':0,HR:0,BB:0,K:0});r.R=(r.R||0)+1}}
    }
    for(let i=0;i<innings.length;i++)innings[i]=innings[i]||{away:0,home:0};
    const last=S.pitches[S.pitches.length-1],score=last?.payload?.score||g.score||{away:0,home:0};
    return {server:true,id:g.id,status:g.status,awayId,homeId,away:score.away??0,home:score.home??0,innings,plays:S.plays,bat,last,
      tiebreak:g.status==='final'&&score.away===score.home?'12회 종료 무승부':null};
  }

  // The plate appearance on screen: the one in progress, or the one that just ended.
  function currentAtBat(v){
    collectCompletedResults();
    if(S.resultQueue.length){
      const item=S.resultQueue[0],play=S.plays.find(p=>p.paNo===item.paNo);
      if(play){
        if(!item.startedAt){
          item.startedAt=Date.now();
          S.resultTimer=setTimeout(()=>{
            S.resultQueue.shift();S.resultTimer=null;redraw();
          },3000);
        }
        return {paNo:item.paNo,pitches:S.pitches.filter(p=>p.pa_no===item.paNo),play,last:item.pitch,ended:true};
      }
    }
    const last=v.last;if(!last)return null;
    const paNo=last.pa_no,pitches=S.pitches.filter(p=>p.pa_no===paNo),play=last.payload?.paResult?S.plays.find(p=>p.paNo===paNo):null;
    return {paNo,pitches,play,last,ended:Boolean(last.payload?.paResult)};
  }

  // Keep each completed at-bat visible even if polling/realtime coalesces several server updates.
  // The next pitch can arrive before the prior result was rendered, so the latest-pitch-only view
  // would otherwise replace that result immediately.
  function collectCompletedResults(){
    // Only results that just happened are queued. Coming back to the page (an AI match resumed after the
    // suggestion page, or a reload) must not replay every earlier at-bat one by one (user report 2026-11-12).
    const RECENT_MS=8000;
    for(const pitch of S.pitches){
      if(!pitch.payload?.paResult||S.resultSeen.has(pitch.pitch_no))continue;
      if(!S.plays.some(play=>play.paNo===pitch.pa_no))continue;
      S.resultSeen.add(pitch.pitch_no);
      const at=Date.parse(pitch.created_at||'');
      if(Number.isFinite(at)&&Date.now()-at>RECENT_MS)continue;
      S.resultQueue.push({paNo:pitch.pa_no,pitch});
    }
    S.resultQueue.sort((a,b)=>a.pitch.pitch_no-b.pitch.pitch_no);
  }

  // The pitcher facing this half-inning (the other team's starter in the game's lineup snapshot):
  // [name, opp AVG, BB/PA, K/PA, {pitch: [min, max] km/h}, {pitch: usage %}, throws].
  function fieldingPitcher(battingSide){
    const v=view(),teams=S.game?.lineup_snapshot?.teams||{},teamId=battingSide==='away'?v?.homeId:v?.awayId,key=v&&sideKey(v.awayId,v.homeId,battingSide==='away'?'home':'away');
    if(!teamId)return null;
    // The pitcher on the mound now: the name on the latest pitch to this side (relievers since engine 2.8).
    const t=teams[key]||teams[teamId]||team(teamId),starter=t?.pitcher||team(teamId)?.pitcher;
    const last=[...S.pitches].reverse().find(p=>p.payload?.side===battingSide&&p.payload?.pitcher),name=last?.payload?.pitcher;
    const now=name&&name!==starter?.[0]?(t?.bullpen||team(teamId)?.bullpen||[]).find(x=>x[0]===name):null;
    return {teamId,pitcher:now||starter,relief:Boolean(now)};
  }
  // Batting order slot and side of the plate for the batter at the plate (user request 2026-11-12). The slot comes
  // from the plate appearances this side has finished (no substitutions, so it cycles 1-9).
  function batterTag(side,name,ab){
    if(!name)return '';
    const v=view(),teams=S.game?.lineup_snapshot?.teams||{},key=v&&sideKey(v.awayId,v.homeId,side),t=teams[key]||teams[side==='away'?v?.awayId:v?.homeId];
    const done=S.plays.filter(p=>p.side===side).length-(ab?.ended?1:0),slot=((done%9)+9)%9+1;
    const HAND={R:'우타',L:'좌타',S:'스위치'},bats=t?.players?.find(p=>p[0]===name)?.[12],hand=HAND[bats];
    // Today's line: at-bats and hits in this game before this plate appearance (user request 2026-11-12).
    const mine=S.plays.filter(p=>p.side===side&&p.batter===name&&!(ab?.ended&&p.paNo===ab.play?.paNo));
    const atBats=mine.filter(p=>!['BB','IBB','HBP','SAC','SF'].includes(p.kind)).length,hits=mine.filter(p=>['1B','2B','3B','HR','BUNT_HIT'].includes(p.kind)).length;
    const today=`${hits}/${atBats}`; // hits / at-bats (e.g. 1/2); 0/0 before a batter's first at-bat.
    // Next batter in the fixed batting order.
    const order=t?.order||[],nextP=order.length?t.players[order[slot%order.length]]:null,nextHand=HAND[nextP?.[12]];
    return `<span class="batter-tag">${slot}번${hand?` · ${hand}`:''} · ${today}</span>${nextP?`<span class="next-batter">다음 ${safe(nextP[0])}${nextHand?` · ${nextHand}`:''}</span>`:''}`;
  }
  function pitcherButton(battingSide){
    const f=fieldingPitcher(battingSide);if(!f?.pitcher)return '';
    return `<span class="pitcher-wrap"><button type="button" class="pitcher-name" onclick="showPitcherCard('${battingSide}')" aria-label="투수 ${safe(f.pitcher[0])} 구종 보기"><small>${f.relief?'구원':'투수'} · ${safe(team(f.teamId)?.short||'')}</small><b>${safe(f.pitcher[0])}</b><i aria-hidden="true">›</i></button>${changeButton(battingSide,f.pitcher[0])}</span>`;
  }
  // Pitching change, right beside the pitcher's name (user request 2026-11-12): in AI matches the reliever
  // picker (ai-game.js), in live games the fielding side's change request with its count.
  function changeButton(battingSide,pitcher){
    if(local)return typeof window.aiChangeButtonSmall==='function'?window.aiChangeButtonSmall():'';
    const rv=window.FANBALL_REMOTE_VOTING,st=rv?.changeStatus?.(),key=rv?.state?.membership?.team_id;
    if(!st||!key||S.game?.status!=='running')return '';
    const v=view();if(!v||key!==sideKey(v.awayId,v.homeId,battingSide==='away'?'home':'away'))return '';
    const members=Number(st.sides?.[key]||0),asked=(st.requests||[]).filter(r=>r.side===key&&r.pitcher===pitcher&&!r.target_inning).reduce((n,r)=>n+Number(r.n),0),need=Math.max(1,Math.ceil(members*(st.threshold||0.8))),mine=(st.mine?.pitcher??st.mine)===pitcher&&!(st.mine?.target_inning);
    return `<button type="button" class="pitch-change-btn ${mine?'on':''}" title="우리 쪽 참여자의 80%가 요청하면 구원투수 투표가 열립니다" onclick="FANBALL_REMOTE_VOTING.requestChange(${mine?'false':'true'},${JSON.stringify(pitcher).replace(/"/g,'&quot;')},false)">${mine?'요청 취소':'투수 교체 요청'} <small>${asked}/${need}</small></button>`;
  }
  window.showPitcherCard=function(battingSide){
    const f=fieldingPitcher(battingSide);if(!f?.pitcher)return;
    const [name,avg,bb,k,speeds,mix,throws]=f.pitcher,types=Object.keys(speeds||{});
    const total=types.reduce((a,t)=>a+(mix?.[t]||0),0)||types.length||1;
    // Pitches seen so far from him in this game.
    const seen={};for(const p of S.pitches){const q=p.payload||{};if(q.side===battingSide&&q.type&&(!q.pitcher||q.pitcher===name)){(seen[q.type]=seen[q.type]||[]).push(q.speed)}}
    const rows=types.sort((a,b)=>(mix?.[b]||0)-(mix?.[a]||0)).map(t=>{const share=mix?(mix[t]||0)/total*100:100/types.length,[lo,hi]=speeds[t],g=seen[t]||[];
      return `<div class="rep-row"><b>${safe(t)}</b><div class="dist-track"><i style="width:${share.toFixed(1)}%"></i></div><span class="rep-share">${share.toFixed(0)}%</span><span class="rep-speed">평균 ${Math.round((lo+hi)/2)}km/h<small>${lo}–${hi}</small></span><span class="rep-seen">${g.length?`오늘 ${g.length}개 · 평균 ${Math.round(g.reduce((a,b)=>a+b,0)/g.length)}`:'오늘 0개'}</span></div>`}).join('');
    const rate=x=>x==null?'–':x<1?(x*100).toFixed(1)+'%':String(x);
    document.getElementById('dist-modal')?.remove();
    document.body.insertAdjacentHTML('beforeend',`<div class="modal-backdrop" id="dist-modal" onclick="if(event.target===this)this.remove()"><section class="dist-modal pitcher-card"><button class="modal-close" onclick="document.getElementById('dist-modal').remove()">×</button><div class="eyebrow">STARTING PITCHER · ${safe(team(f.teamId)?.name||'')}</div><h2>${safe(name)}<small>${throws==='L'?'좌투':throws==='R'?'우투':''}</small></h2>
      <div class="rep-stats"><span>피안타율 <b>${avg!=null?avg.toFixed(3).replace(/^0/,''):'–'}</b></span><span>볼넷 <b>${rate(bb)}</b></span><span>삼진 <b>${rate(k)}</b></span><small>상대 타자 대비 · 2026 시즌</small></div>
      <h3 class="dist-subtitle">구종 · 구사율 · 구속</h3>${types.length?`<div class="rep-list">${rows}</div>`:'<p class="tiny muted">이 투수의 구종 정보가 없습니다.</p>'}
      <p class="notice">구종별 구사율과 구속 범위는 나무위키 투수 문서를 바탕으로 정했고, 문서에 없는 값은 추정값입니다. 평균 구속은 범위의 가운데 값입니다. 경기에서는 이 비율과 범위로 공이 정해집니다.</p></section></div>`);
  };

  // How many pitches the pitcher on the mound has thrown so far, up to this pitch: one starter per team,
  // so it is the pitches thrown to the side now batting.
  function pitcherPitchCount(p){
    const side=p.payload?.side,who=p.payload?.pitcher;return S.pitches.filter(x=>x.payload?.side===side&&x.pitch_no<=p.pitch_no&&(!who||x.payload?.pitcher===who)).length;
  }

  // When this browser first saw a pitch (used to time the fly-in and the between-batters notices).
  // A pitch loaded long after it was thrown counts from its server time, so nothing replays.
  const SEEN=new Map();
  function arrival(p){
    if(!SEEN.has(p.pitch_no)){const c=Date.parse(p.created_at||'')||0;SEEN.set(p.pitch_no,c&&Math.abs(Date.now()-c)<2500?Date.now():(c||Date.now()-600000));if(SEEN.size>400)SEEN.delete(SEEN.keys().next().value)}
    return SEEN.get(p.pitch_no);
  }
  // After a plate appearance: "3회 말" when a half-inning starts, then "2번 타자 나성범", timed by CSS
  // (negative delays keep the timing right when the page re-renders in between).
  const teamNameOf=side=>`${team(side==='away'?MATCH.away:MATCH.home)?.name||''}${MATCH.away===MATCH.home?(side==='away'?' (원정)':' (홈)'):''}`;
  function betweenNotice(pay,elapsed){
    const n=pay.next;if(!n)return '';
    const start=n.showAfterMs??4000,halfMs=n.newHalf?Math.round((n.gapMs||3000)*2/3):0,event=MATCH.away===MATCH.home;
    const teamName=`${team(n.side==='away'?MATCH.away:MATCH.home)?.name||''}${event?(n.side==='away'?' (원정)':' (홈)'):''}`;
    const half=n.newHalf?`<div class="between-notice half" style="animation-duration:${halfMs}ms;animation-delay:${start-elapsed}ms"><small>${n.side==='away'?'초':'말'} 공격 시작</small><b>${n.inning}회 ${n.side==='away'?'초':'말'}</b><span>${safe(teamName)} 공격</span></div>`:'';
    const changeMs=n.change?2000:0,change=n.change?`<div class="between-notice change" style="animation-duration:${changeMs}ms;animation-delay:${start+halfMs-elapsed}ms"><small>투수 교체 · ${safe(teamNameOf(n.side==='away'?'home':'away'))}</small><b>${safe(n.change.to)}</b><span>${safe(n.change.from||'')} ${n.change.pitches?`(${n.change.pitches}구)`:''} → ${safe(n.change.to)}</span></div>`:'';
    return half+change+`<div class="between-notice batter" style="animation-delay:${start+halfMs+changeMs-elapsed}ms"><small>${n.inning}회 ${n.side==='away'?'초':'말'} · 다음 타자</small><b>${n.slot}번 타자</b><span>${safe(n.batter)}</span></div>`;
  }
  // How each pitch type flies in to its spot (px on the plot): `rise` is how far above the spot it starts,
  // `side` how far it moves sideways (+ toward the pitcher's arm side, - toward his glove side), and
  // `lateX`/`lateY` how much of that movement is still left at 60% of the flight (0.4 is a straight line;
  // more means the pitch breaks late). Faster pitches arrive sooner. Display only.
  const FLIGHT={fastball:{rise:128,side:3,lateX:.4,lateY:.36},sinker:{rise:118,side:16,lateX:.6,lateY:.5},cutter:{rise:122,side:-13,lateX:.65,lateY:.42},
    slider:{rise:112,side:-30,lateX:.72,lateY:.55},sweeper:{rise:100,side:-48,lateX:.75,lateY:.48},curve:{rise:168,side:-10,lateX:.5,lateY:.8},
    changeup:{rise:124,side:14,lateX:.55,lateY:.66},splitter:{rise:126,side:6,lateX:.5,lateY:.74}};
  const FLIGHT_OF={'직구':'fastball','포심':'fastball','투심':'sinker','싱커':'sinker','커터':'cutter','슬라이더':'slider','스위퍼':'sweeper','커브':'curve','너클커브':'curve','체인지업':'changeup','포크':'splitter','스플리터':'splitter'};
  function flightStyle(q,battingSide,elapsed){
    const f=FLIGHT[FLIGHT_OF[q.type]]||FLIGHT.fastball,lefty=fieldingPitcher(battingSide)?.pitcher?.[6]==='L';
    // A right-hander's arm side is the catcher's left: a pitch that runs to the arm side starts to the right of where it ends.
    const sx=(lefty?-1:1)*f.side,dur=Math.round(Math.min(680,Math.max(340,62000/(Number(q.speed)||140))));
    if(elapsed>=dur+60)return '';
    return `;--sx:${sx}px;--sy:${-f.rise}px;--mx:${Math.round(sx*f.lateX)}px;--my:${Math.round(-f.rise*f.lateY)}px;animation:pitch-fly ${dur}ms linear both;animation-delay:${-elapsed}ms`;
  }
  function pitchBoard(ab){
    const elapsed=Date.now()-arrival(ab.last);
    const lastP=ab.last,pay=lastP.payload||{},count=(ab.ended?ab.play?.count:pay.countAfter)||lastP.count_before;
    const [balls,strikes]=(count||'0-0').split('-').map(Number);
    const outs=ab.ended?(ab.play?.outsAfter??pay.outs??0):(pay.outs??0),bases=ab.ended?(ab.play?.base||pay.base):pay.base;
    const points=ab.pitches.map((p,i)=>{const q=p.payload||{};const cur=i===ab.pitches.length-1,fly=cur?flightStyle(q,pay.side,elapsed):'';return `<span class="pitch-point ${p.call} ${cur?'current':''}" style="left:${q.x}%;top:${q.y}%${fly}" aria-label="${i+1}구">${i+1}</span>`}).join('');
    const callText=lastP.call==='ibb'?'고의사구':(PITCH_RESULT[lastP.result]||lastP.result);
    // Show the applied tactics only in at-bats where a vote was held.
    const tactics=pay.tactics||{},voted=pay.voted??(tactics.offense!=='normal'||tactics.alignment!=='standard'||tactics.approach!=='standard'),tacticLine=voted?`<span class="tactic-chip offense"><b>공격</b>${OFFENSE[tactics.offense]||'기본 타격'}</span><span class="tactic-chip defense"><b>수비</b>${[ALIGN[tactics.alignment]||'기본 수비',tactics.approach&&tactics.approach!=='standard'?APPROACH[tactics.approach]:null].filter(Boolean).join(' · ')}</span>`:'';
    return `<div class="pitch-panel">${ab.ended?betweenNotice(pay,elapsed):''}<div class="atbat-heading"><span>${pay.inning}회 ${pay.side==='away'?'초':'말'}</span><strong>${safe(pay.batter||'')}</strong>${batterTag(pay.side,pay.batter,ab)}${pitcherButton(pay.side)}</div>${ab.ended&&ab.play?`<div class="atbat-result"><small>타석 결과</small><b>${ab.play.kindLabel||kindName(ab.play.kind)}${ab.play.runs?` · ${ab.play.runs}득점`:''}</b><span class="atbat-last">${ab.pitches.length}구째 ${pay.speed?pay.speed+'km/h ':''}${safe(pay.type||'')} → ${PITCH_RESULT[lastP.result]||lastP.result}${lastP.payload?.bip?` · ${OUTCOME_NAMES[lastP.payload.bip]||lastP.payload.bip}`:''}</span></div>`:''}
    <div class="pitch-body"><div class="zone-wrap"><div class="zone-label">STRIKE ZONE · 투구 위치</div><div class="pitch-plot"><div class="pitch-zone-grid">${Array.from({length:9},()=>'<span></span>').join('')}</div>${points}</div></div>
    <div class="pitch-info"><div class="pitch-speed">${pay.speed??'-'}<small>km/h</small></div><div class="pitch-type">${safe(pay.type||'')}</div><div class="pitch-call ${lastP.call}">${callText}${lastP.payload?.bip?` · ${OUTCOME_NAMES[lastP.payload.bip]||lastP.payload.bip}`:''}</div><div class="count-lights"><div><small>B</small>${[0,1,2].map(i=>`<i class="ball-light ${i<Math.min(balls,3)?'on':''}"></i>`).join('')}</div><div><small>S</small>${[0,1].map(i=>`<i class="strike-light ${i<Math.min(strikes,2)?'on':''}"></i>`).join('')}</div><div><small>O</small>${[0,1].map(i=>`<i class="out-light ${i<Math.min(outs,2)?'on':''}"></i>`).join('')}</div></div>${baseDiamond(bases||[])}</div></div>
    <div class="server-pitch-foot"><span>${pitcherPitchCount(lastP)}구째 · ${lastP.count_before} → ${ab.ended?'타석 종료':count}</span>${tacticLine?`<span class="play-tactic-summary">${tacticLine}</span>`:''}<button class="detail-button" onclick="showServerPitch(${lastP.pitch_no})">이 투구 확률</button></div></div>`;
  }

  // Probability of each pitch result at that count, then what a ball in play would become.
  window.showServerPitch=function(pitchNo){
    const p=S.pitches.find(x=>x.pitch_no===pitchNo);if(!p)return;
    const play=S.plays.find(x=>x.paNo===p.pa_no)||{}; // its at-bat, for the runners before it (bunt FC label)
    const d=p.payload?.distribution,total=d?Object.values(d.counts).reduce((a,b)=>a+b,0):0;
    const label={ball:'볼',called_strike:'스트라이크',swinging_strike:'헛스윙',foul:'파울',in_play:'인플레이',hbp:'몸에 맞는 공'};
    const rows=d?Object.entries(d.counts).sort((a,b)=>b[1]-a[1]).map(([k,n])=>`<div class="dist-row ${p.result.replace('bunt_','')===k?'chosen':''}"><span>${(p.payload?.bunting&&k!=='ball'&&k!=='hbp'?'번트 ':'')+(label[k]||k)}</span><div class="dist-track"><i style="width:${n/total*100}%"></i></div><b>${n.toLocaleString()}회</b><small>${(n/total*100).toFixed(1)}%</small></div>`).join(''):'<p class="tiny muted">이 투구에는 분포가 없습니다.</p>';
    const buntOutcome=p.payload?.bunting&&p.payload?.paResult?({SAC:'sacrifice',BUNT_HIT:'hit',BUNT_OUT:'out',FC:'fieldersChoice',BUNT_DP:'doublePlay'}[play.kind]):null;
    const selectedInPlay=buntOutcome||p.payload?.bip;
    const ip=p.payload?.inPlayOdds,ipRows=ip?Object.entries(ip).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<div class="dist-row ${selectedInPlay===k?'chosen':''}"><span>${OUTCOME_NAMES[k]||k}</span><div class="dist-track"><i style="width:${v}%"></i></div><b></b><small>${v}%</small></div>`).join(''):'';
    document.getElementById('dist-modal')?.remove();
    document.body.insertAdjacentHTML('beforeend',`<div class="modal-backdrop" id="dist-modal" onclick="if(event.target===this)this.remove()"><section class="dist-modal"><button class="modal-close" onclick="document.getElementById('dist-modal').remove()">×</button><div class="eyebrow">PITCH ${p.pitch_no} · ${d?d.trials.toLocaleString()+' TRIALS':''}</div><h2>${safe(p.payload?.batter||'')} · ${p.count_before}에서 던진 공</h2><p>결과 <b>${PITCH_RESULT[p.result]||p.result}</b>${p.payload?.paResult?` · 타석 결과 <b>${resultName(p.payload.paResult,p.result,play.basesBefore)}</b>`:''}</p><div class="dist-list">${rows}</div>${ipRows?`<h3 class="dist-subtitle">${p.payload?.bunting?'번트가 굴러가면':'공이 인플레이되면'}</h3><div class="dist-list">${ipRows}</div>`:''}<div class="notice">투구 결과는 이 카운트·선수·작전 조건으로 표본을 뽑은 빈도에서 하나를 추첨했습니다. 인플레이 결과도 같은 방식입니다. 볼카운트별 기준값 출처: Retrosheet (아래 표시).</div></section></div>`);
  };

  // At-bat cards: the demo card asks showDistribution(index); for server games list that at-bat's pitches.
  const baseShowDistribution=window.showDistribution;
  window.showDistribution=function(i){
    const v=active()?view():null;if(!v)return baseShowDistribution(i);
    const play=v.plays[i];if(!play)return;
    // Each pitch as "N구 · count before → count after · result" so 0-0 is clearly the count before the pitch.
    const rows=S.pitches.filter(p=>p.pa_no===play.paNo).map((p,i)=>`<div class="dist-row"><span>${i+1}구 · ${p.count_before} → ${p.payload?.paResult?resultName(p.payload.paResult,p.result,play.basesBefore):(p.payload?.countAfter||'')}</span><div class="dist-track"><i style="width:0"></i></div><b>${PITCH_RESULT[p.result]||p.result}</b><small><button class="detail-button" onclick="showServerPitch(${p.pitch_no})">확률</button></small></div>`).join('');
    document.getElementById('dist-modal')?.remove();
    document.body.insertAdjacentHTML('beforeend',`<div class="modal-backdrop" id="dist-modal" onclick="if(event.target===this)this.remove()"><section class="dist-modal"><button class="modal-close" onclick="document.getElementById('dist-modal').remove()">×</button><div class="eyebrow">PLATE APPEARANCE ${play.paNo}</div><h2>${safe(play.batter)} · ${play.kindLabel||kindName(play.kind)}</h2><p>${play.inn}회 ${play.side==='away'?'초':'말'} · 투구 ${play.pitches?.length||0}개 · 카운트별 결과</p><div class="dist-list">${rows}</div></section></div>`);
  };

  const ATTRIBUTION='<p class="notice data-credit">볼카운트별 기준값: The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at "www.retrosheet.org". · 선수 기록은 나무위키 선수 문서(CC BY-NC-SA 2.0 KR)에서 읽었고, 실제 KBO 기록의 권리는 KBO 등 원 권리자에게 있습니다.</p>';

  // Live games: fans of the fielding side can ask to change the pitcher; at 80% of that side's
  // participants a vote for the reliever opens before the next plate appearance (orchestrator).
  function changeRequestBar(pay,v){
    const rv=window.FANBALL_REMOTE_VOTING,st=rv?.changeStatus?.(),key=rv?.state?.membership?.team_id;
    if(!st||!key||S.game?.status!=='running'||!pay?.side||!v)return '';
    const fieldKey=sideKey(v.awayId,v.homeId,pay.side==='away'?'home':'away');
    if(key===fieldKey&&pay.pitcher){
      const members=Number(st.sides?.[key]||0),asked=(st.requests||[]).filter(r=>r.side===key&&r.pitcher===pay.pitcher&&!r.target_inning).reduce((n,r)=>n+Number(r.n),0),need=Math.max(1,Math.ceil(members*(st.threshold||0.8))),mine=(st.mine?.pitcher??st.mine)===pay.pitcher&&!(st.mine?.target_inning);
      return `<div class="change-request"><div><b>투수 교체 요청</b><small>지금 ${safe(pay.pitcher)} · 요청 ${asked}/${need}명(우리 쪽 참여자 ${members}명의 80%)이 모이면 다음 타석 전에 구원투수 투표가 열립니다.</small></div><button class="btn ${mine?'btn-soft':'btn-primary'}" onclick="FANBALL_REMOTE_VOTING.requestChange(${mine?'false':'true'},${JSON.stringify(pay.pitcher).replace(/"/g,'&quot;')},false)">${mine?'요청 취소':'교체 요청'}</button></div>`;
    }
    const battingKey=sideKey(v.awayId,v.homeId,pay.side);
    if(key!==battingKey)return '';
    const targetHalf=pay.side==='away'?'home':'away',targetInning=(pay.inning||1)+(pay.side==='home'?1:0);
    if(pay.side==='home'&&(pay.inning||1)>=12)return '';
    const members=Number(st.sides?.[key]||0),asked=(st.requests||[]).filter(r=>r.side===key&&r.target_inning===targetInning&&r.target_half===targetHalf).reduce((n,r)=>n+Number(r.n),0),need=Math.max(1,Math.ceil(members*(st.threshold||0.8))),mine=st.mine?.target_inning===targetInning&&st.mine?.target_half===targetHalf;
    return `<div class="change-request next-pitcher-request"><div><b>다음 수비 이닝 투수 예약</b><small>${targetInning}회 ${targetHalf==='away'?'초':'말'} 시작 전 · 요청 ${asked}/${need}명(우리 쪽 참여자 ${members}명의 80%)이 모이면 구원투수 투표가 열립니다.</small></div><button class="btn ${mine?'btn-soft':'btn-primary'}" onclick="FANBALL_REMOTE_VOTING.requestChange(${mine?'false':'true'},'',true)">${mine?'예약 요청 취소':'교체 예약 요청'}</button></div>`;
  }
  function livePage(v){
    const ab=currentAtBat(v),pay=v.last?.payload||{},inning=pay.inning||1,half=pay.side||'away',attackId=half==='away'?v.awayId:v.homeId;
    const outs=ab?.ended?(ab.play?.outsAfter??0):(pay.outs??0),bases=ab?.ended?(ab.play?.base||[]):(pay.base||[]);
    // A local game (admin demo or AI match) may bring its own heading and banner (local.screen).
    const sc=local?.screen;
    let html=(sc?header(sc.eyebrow,sc.title,sc.sub,sc.right||''):header('GAME CENTER','공식 경기 센터','서버가 진행하는 공식 경기 · 모든 팬이 같은 투구를 같은 시각에 봅니다',ADMIN_MODE&&S.game?.status==='running'?`<button class="btn btn-danger" onclick="adminStopGame('${S.game.id}','${team(MATCH.away).short} vs ${team(MATCH.home).short}')">경기 중단</button>`:''))
      +(sc?sc.banner:(local?'<div class="banner admin-banner"><b>개발용 데모 경기</b> · 이 브라우저에서만 진행되며 서버에 저장되지 않습니다. 규칙과 엔진은 서버 경기와 같습니다.</div>':'')
      +`<div class="banner live-banner"><b>실시간 공식 경기</b> · 투구는 서버에서 2초 간격으로 한 개씩 계산되어 바로 표시됩니다. 작전 투표는 타석 전과 득점권 핵심 카운트(2스트라이크·3볼)에서 10초 동안 열립니다.</div>`)
      +(!local&&typeof eventSidePicker==='function'&&!window.FANBALL_REMOTE_VOTING?.serverSide?.()?eventSidePicker('game'):'')
      +`<div class="game-layout"><section class="card scoreboard"><div class="score-title"><h2>${team(v.awayId).short} vs ${team(v.homeId).short}</h2><span class="tag red">진행 중</span></div>${scoreTable(v)}`
      +`<div class="game-countbar"><strong class="current-inning">${inning}회 ${half==='away'?'초':'말'}</strong><span class="attack-team">${team(attackId).name}${MATCH.away===MATCH.home?(half==='away'?' (원정)':' (홈)'):''} 공격</span><b>아웃</b><div class="out-lights">${[0,1].map(i=>`<i class="${i<Math.min(outs,2)?'on':''}"></i>`).join('')}</div><strong>${outs} OUT</strong>${baseDiamond(bases)}</div>`
      +(ab?pitchBoard(ab):`<div class="pitch-panel"><div class="between-notice half static"><small>경기 시작</small><b>1회 초</b><span>${team(v.awayId).name}${v.awayId===v.homeId?' (원정)':''} 공격 · 곧 첫 투구가 나옵니다</span></div></div>`)
      +`</section><section class="card situation"><div class="score-title"><h2>${sc?.voteTitle||'팬 작전 투표 · 타석 로그'}</h2></div>`;
    const remoteVote=local?local.voteView():window.FANBALL_REMOTE_VOTING?.view();
    html+=remoteVote?.round?.status==='open'||remoteVote?.round?.status==='closing'?remoteTacticalPanel(remoteVote):`<div class="vote-box remote-vote"><b>지금은 투표가 없습니다</b><p class="tiny muted">${baseLabel(pay.base)} · ${pay.outs??0}아웃. 작전 상황(득점권 주자, 2아웃 전 1루 주자 등)이 되면 다음 투구 전에 양 팀 투표가 동시에 열립니다.</p></div>`;
    if(!local)html+=changeRequestBar(pay,v);
    const maxInning=Math.max(1,...v.plays.map(p=>p.inn),inning);
    if(followLive||selectedLogInning>maxInning)selectedLogInning=inning;
    html+=inningTabs(maxInning)+renderInningLogs(v,selectedLogInning);
    return html+'</section></div>'+ATTRIBUTION;
  }

  // Pitchers' lines from the play log (engine 2.8 puts the pitcher on every play and pitch).
  function pitcherStats(v){
    const lines={away:new Map(),home:new Map()};
    for(const p of v.plays||[]){
      if(!p.pitcher)continue;const fs=p.side==='away'?'home':'away',m=lines[fs];
      const l=m.get(p.pitcher)||{outs:0,h:0,r:0,bb:0,k:0,hr:0};m.set(p.pitcher,l);
      l.outs+=Math.max(0,Math.min(3,p.outsAfter??0)-(p.outsBefore??0));l.r+=p.runs||0;
      if(['1B','2B','3B','HR','BUNT_HIT'].includes(p.kind))l.h++;if(p.kind==='HR')l.hr++;if(['BB','IBB','HBP'].includes(p.kind))l.bb++;if(p.kind==='K')l.k++;
    }
    const pc=(side,name)=>S.pitches.filter(x=>x.payload?.side===side&&x.payload?.pitcher===name).length;
    const ip=o=>`${Math.floor(o/3)}${o%3?` ${o%3}/3`:''}`;
    const table=(fs,id)=>{const m=lines[fs];if(!m.size)return '';const batSide=fs==='away'?'home':'away';
      return `<section class="team-result-card"><div class="team-log-heading"><span>${fs==='away'?'원정팀':'홈팀'} 투수 기록</span><b>${team(id).name}</b></div><div style="overflow:auto"><table class="table"><thead><tr><th>투수</th><th>이닝</th><th>피안타</th><th>실점</th><th>볼넷·사구</th><th>삼진</th><th>피홈런</th><th>투구 수</th></tr></thead><tbody>${[...m].map(([name,l],i)=>`<tr><td class="player">${safe(name)}${i?'<small>구원</small>':'<small>선발</small>'}</td><td>${ip(l.outs)}</td><td>${l.h}</td><td>${l.r}</td><td>${l.bb}</td><td>${l.k}</td><td>${l.hr}</td><td>${pc(batSide,name)}</td></tr>`).join('')}</tbody></table></div></section>`};
    const html=table('away',v.awayId)+table('home',v.homeId);
    return html?`<h2 class="result-section-title">팬볼 투수 기록 <small>교체 순서대로</small></h2><div class="result-team-grid">${html}</div>`:'';
  }
  // How it ended (user request 2026-11-12): winner and score, and the last plate appearance (a walk-off called out).
  function finalBanner(v){
    const outcome=v.tiebreak||(v.away===v.home?'무승부':`${team(v.away>v.home?v.awayId:v.homeId).name} 승리`);
    const lastPlay=v.plays[v.plays.length-1],walkOff=lastPlay&&lastPlay.side==='home'&&lastPlay.runs>0&&v.home>v.away&&lastPlay.inn>=9;
    return lastPlay?`<div class="final-banner"><b>경기 종료 · ${safe(outcome)} · ${v.away} : ${v.home}</b><span>${lastPlay.inn}회 ${lastPlay.side==='away'?'초':'말'} ${safe(lastPlay.batter)} · ${safe(lastPlay.kindLabel||kindName(lastPlay.kind))}${walkOff?' · 끝내기':''}</span></div>`:'';
  }
  // The last pitch stays on screen (with the result and the final score) before the result page.
  const FINAL_HOLD_MS=7000;
  function resultPageServer(v){
    const g=S.game,lineup=g.lineup_snapshot?.teams||{};
    const teamStats=(id,side)=>{const t=lineup[sideKey(v.awayId,v.homeId,side)]||lineup[id],names=t?t.order.map(i=>t.players[i][0]):[],rows=names.map(name=>{const b=v.bat[v.awayId===v.homeId?side+':'+name:name]||{AB:0,H:0,SH:0,'2B':0,'3B':0,HR:0,BB:0,K:0,RBI:0};return `<tr><td class="player">${safe(name)}</td><td>${b.AB}</td><td>${b.H}</td><td>${b.HR}</td><td>${b.R||0}</td><td>${b.RBI||0}</td><td>${b.BB}</td><td>${b.K}</td><td>${b.AB?(b.H/b.AB).toFixed(3).slice(1):'.000'}</td></tr>`}).join('');return `<section class="team-result-card"><div class="team-log-heading"><span>${side==='away'?'원정팀 타격 기록':'홈팀 타격 기록'}</span><b>${team(id).name}</b></div><div class="result-table-scroll"><table class="table"><thead><tr><th>선수</th><th>AB</th><th>H</th><th>HR</th><th>R</th><th>RBI</th><th>BB</th><th>K</th><th>AVG</th></tr></thead><tbody>${rows}</tbody></table></div></section>`};
    const outcome=v.tiebreak||(v.away===v.home?'무승부':`${team(v.away>v.home?v.awayId:v.homeId).name} 승리`);
    const endLine=finalBanner(v);
    const minutes=g.started_at&&g.ended_at?Math.round((Date.parse(g.ended_at)-Date.parse(g.started_at))/60000):null;
    const maxInning=Math.max(1,...v.plays.map(p=>p.inn));if(selectedLogInning>maxInning)selectedLogInning=1;
    return `${local?.screen?header('FINAL',local.screen.resultTitle||'경기 결과',local.screen.resultSub||''):header('FINAL · OFFICIAL RESULT','경기 결과','서버가 한 번만 진행한 공식 경기 · 기록은 바꿀 수 없습니다')}${local?.screen?.resultActions||''}<div class="result-head"><div><div class="eyebrow" style="color:#9ba9bc">FANBALL MATCH · ${MATCH.date}</div><h2>${team(v.awayId).name} vs ${team(v.homeId).name}</h2><div class="tiny" style="color:#aeb9c8;margin-top:5px">${outcome} · 투구 ${S.pitches.length}개 · 타석 ${v.plays.length}개${minutes!=null?` · ${minutes}분`:''}</div></div><div class="final-score">${v.away}<span>:</span>${v.home}</div></div>${endLine}<section class="card result-scoreboard"><div class="score-title"><h2>이닝별 스코어</h2><span class="tag">${v.innings.length}회 종료</span></div>${scoreTable(v)}</section><h2 class="result-section-title">팬볼 타자 기록 <small>팀별 분리</small></h2><div class="result-team-grid">${teamStats(v.awayId,'away')}${teamStats(v.homeId,'home')}</div>${pitcherStats(v)}<h2 class="result-section-title">타석별 경기 로그 <small>카드의 '결과 분포'에서 투구별 확률 확인</small></h2>${inningTabs(maxInning)}${renderInningLogs(v,selectedLogInning)}${local?'':`<section class="card seed-proof"><h3>결과 검증 정보</h3><p class="tiny muted">경기 시작 때 공개한 시드 지문(SHA-256)과 종료 뒤 공개한 시드입니다. 공개된 엔진 코드(${safe(g.model_version||'')})와 기록된 투표 결과로 경기를 다시 계산하면 같은 투구가 나옵니다.</p><p class="tiny"><b>시드 지문</b> <code>${safe(g.seed_hash||'')}</code><br><b>공개 시드</b> <code>${g.revealed_seed??'-'}</code></p></section>`}${local&&!local.screen&&ADMIN_MODE?'<div class="result-reset"><button class="btn btn-danger" onclick="resetGame()">데모 경기 지우기</button></div>':''}${ATTRIBUTION}`;
  }

  function active(){if(local)return local.matchId===MATCH?.id;return Boolean(S.game&&S.game.status!=='scheduled'&&S.game.status!=='cancelled'&&S.kboId===MATCH?.id&&S.game.model_version!=='fanball-engine-1'&&!/^fanball-engine-1/.test(S.game.model_version||''))}

  window.FANBALL_SERVER_GAME={
    load,active,view,
    gameRow(){return local?null:(S.kboId===MATCH?.id?S.game:null)},
    // Developer demo: data = {matchId, game:{status,score,started_at,ended_at,model_version,lineup_snapshot}, plays:[rows], pitches:[rows], voteView(), vote(id)} or null.
    setLocal(data){local=data;if(data){if(S.kboId!==data.matchId)reset(data.matchId);if(S.channel&&api())api().removeChannel(S.channel);Object.assign(S,{kboId:data.matchId,game:data.game,plays:data.plays.map(toPlay),pitches:data.pitches,channel:null})}else reset(null);redraw()},
    isLocal(){return Boolean(local)},
    voteLocal(id){return local?.vote?.(id)},
    batterAvg(name){for(const t of Object.values(S.game?.lineup_snapshot?.teams||{})){const p=t.players.find(x=>x[0]===name);if(p)return p[6]??p[2]}return null},
    page(){const v=view();if(!v)return baseGamePage();
      if(v.status==='final'&&v.last){const since=Date.now()-arrival(v.last);if(since<FINAL_HOLD_MS){clearTimeout(this._hold);this._hold=setTimeout(()=>redraw(),FINAL_HOLD_MS-since+50);return livePage(v).replace('<span class="tag red">진행 중</span>','<span class="tag red">경기 종료</span>').replace('<div class="game-layout">',finalBanner(v)+'<div class="game-layout">')}}
      return v.status==='final'?resultPageServer(v):livePage(v)},
    homeCard(){
      const v=view();if(!v)return '';const pay=v.last?.payload||{},label=v.status==='final'?'경기 종료':'실시간 진행 중',half=pay.side||'away',attackId=half==='away'?v.awayId:v.homeId;
      return `<section class="home-live-card" id="home-live-match"><div class="home-live-head"><span class="home-live-dot"></span><b>팬볼 공식 경기 ${label}</b><button type="button" onclick="go('game')">경기 보기 →</button></div><div class="home-live-main"><strong>${v.status==='final'?'FINAL':`${pay.inning||1}회 ${half==='away'?'초':'말'}`}</strong><span>${v.status==='final'?'서버 공식 결과':`${team(attackId).name}${MATCH.away===MATCH.home?(half==='away'?' (원정)':' (홈)'):''} 공격 · ${baseLabel(pay.base)} · ${pay.outs??0}아웃`}</span><b>${team(v.awayId).short} ${v.away} : ${v.home} ${team(v.homeId).short}</b></div></section>`;
    },
  };

  // Every server game running right now, whatever fixture is selected, for the home banner.
  // Score, inning and runners come from each game's latest pitch.
  const LIVE={rows:[],loading:false,at:0};
  async function loadLive(){
    const client=api();if(!client||LIVE.loading||Date.now()-LIVE.at<2500)return;
    LIVE.loading=true;LIVE.at=Date.now();
    try{
      const {data,error}=await client.from('fanball_games').select('id,status,score,model_version,kbo_games!inner(id,scheduled_at,away_team_id,home_team_id,provider)').eq('status','running').limit(50);
      if(error)throw error;
      const rows=(data||[]).filter(g=>!/^fanball-engine-1/.test(g.model_version||'')&&(g.kbo_games?.provider!=='room'||window.FANBALL_ROOMS?.isMine?.(g.kbo_games.id)));
      const last=await Promise.all(rows.map(g=>client.from('pitches').select('payload').eq('game_id',g.id).order('pitch_no',{ascending:false}).limit(1).maybeSingle()));
      LIVE.rows=rows.map((g,i)=>({id:g.id,score:g.score,k:g.kbo_games,pay:last[i].data?.payload||{}})).sort((a,b)=>new Date(a.k.scheduled_at)-new Date(b.k.scheduled_at));
    }catch(e){console.warn('FanBall live games load failed:',e.message||e)}
    finally{LIVE.loading=false}
  }
  function liveCard(r){
    const pay=r.pay,half=pay.side||'away',awayId=r.k.away_team_id,homeId=r.k.home_team_id,attackId=half==='away'?awayId:homeId,score=pay.score||r.score||{};
    return `<section class="home-live-card"><div class="home-live-head"><span class="home-live-dot"></span><b>팬볼 공식 경기 실시간 진행 중</b><button type="button" onclick="openLiveGame('${safe(r.k.id)}')">경기 보기 →</button></div><div class="home-live-main"><strong>${pay.inning||1}회 ${half==='away'?'초':'말'}</strong><span>${team(attackId)?.name||attackId} 공격 · ${baseLabel(pay.base)} · ${pay.outs??0}아웃</span><b>${team(awayId)?.short||awayId} ${score.away??0} : ${score.home??0} ${team(homeId)?.short||homeId}</b></div></section>`;
  }
  window.openLiveGame=function(kboId){
    const r=LIVE.rows.find(x=>x.k.id===kboId);if(!r)return go('game');
    if(typeof db!=='undefined'&&db.game)return notify('이 브라우저의 데모 경기를 초기화한 뒤 다른 경기를 열 수 있습니다.');
    const i=todayFixtures().findIndex(f=>f.id===kboId);
    if(i>=0){selectHomeFixture(i);go('game');return}
    const d=new Date(r.k.scheduled_at),parts=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',weekday:'short'}).formatToParts(d),part=k=>parts.find(p=>p.type===k)?.value||'';
    applyDemoFixture({id:kboId,away:r.k.away_team_id,home:r.k.home_team_id,scheduledAt:r.k.scheduled_at,date:`${part('month')}.${part('day')} (${part('weekday')})`,venue:team(r.k.home_team_id)?.venue||'구장 정보 대기'});
    db.activeFixtureId=kboId;persist();load(true);go('game');
  };

  // The game center shows the server game when the selected fixture has one. The home banner lists
  // every running game; the selected one uses its live data, and a finished selected game stays as FINAL.
  const baseGamePage=window.gamePage,baseHomeLiveCard=window.homeLiveCard;
  window.gamePage=function(){return active()?window.FANBALL_SERVER_GAME.page():baseGamePage()};
  window.homeLiveCard=function(){
    if(local)return active()?window.FANBALL_SERVER_GAME.homeCard():'';
    const selected=active()?S.game:null;
    const cards=LIVE.rows.map(r=>selected&&r.id===selected.id&&selected.status==='running'?window.FANBALL_SERVER_GAME.homeCard().replace(' id="home-live-match"',''):liveCard(r));
    if(selected?.status==='final')cards.push(window.FANBALL_SERVER_GAME.homeCard().replace(' id="home-live-match"',''));
    const legacy=baseHomeLiveCard();if(legacy)cards.unshift(legacy.replace(' id="home-live-match"',''));
    return cards.length?`<div id="home-live-match" class="home-live-list">${cards.join('')}</div>`:'';
  };

  // After an automatic update reload, return to the screen the viewer was on.
  try{const saved=JSON.parse(sessionStorage.getItem('fanball:restore')||'null');sessionStorage.removeItem('fanball:restore');if(saved&&Date.now()-saved.at<120000){if(Number(saved.inning)>0){selectedLogInning=Number(saved.inning);followLive=false}if(['home','lineup','game','records'].includes(saved.page)&&saved.page!==page)go(saved.page)}}catch(_){}
  // Picking the current inning (or a later one) goes back to following the live inning.
  const baseSelectLogInning=window.selectLogInning;
  window.selectLogInning=function(inning){
    if(active()&&S.game?.status==='running'){const cur=Number(S.pitches[S.pitches.length-1]?.payload?.inning||1);followLive=Number(inning)>=cur}
    baseSelectLogInning(inning);
  };

  setInterval(()=>{if(typeof page!=='undefined'&&['home','game'].includes(page))load();if(typeof page!=='undefined'&&page==='home')loadLive()},3000);
  if(api()){load(true);loadLive()}
})();
