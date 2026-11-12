/* Shared server voting reader/writer. Inactive until Supabase and migrations are configured. */
(function(){
  let state={mode:'unconfigured',game:null,round:null,choices:[],membership:null,vote:null,resolution:null};
  let channel=null,refreshing=false,lastSignature='',scheduleRows=[],scheduleLoaded=false,lastScheduleAt=0;
  const api=()=>window.FANBALL_SERVER_CLIENT;
  const user=()=>window.FANBALL_AUTH_USER?.()||null;
  async function refreshSchedule(force=false){
    const client=api();if(!client||(!force&&Date.now()-lastScheduleAt<60000))return;
    lastScheduleAt=Date.now();
    const gameDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const {data,error}=await client.from('kbo_games').select('id,game_date,scheduled_at,away_team_id,home_team_id,status,provider').eq('game_date',gameDate).order('scheduled_at',{ascending:true});
    if(error){console.warn('FanBall schedule query failed:',error.message);return}
    scheduleRows=data||[];scheduleLoaded=true;
    // The selected game may be a server fixture that only exists once the schedule has loaded.
    if(typeof db!=='undefined'&&db.activeFixtureId&&MATCH.id!==db.activeFixtureId&&typeof applyDemoFixture==='function'){const f=todayFixtures().find(x=>x.id===db.activeFixtureId);if(f){applyDemoFixture(f);refresh()}}
    // If the page still points at a game that is not on today's server schedule (deleted, rebooked or an
    // old sample), switch to today's game for the fan's team (or the first one), so lineups and votes go
    // to a real server game instead of staying in this browser.
    if(typeof db!=='undefined'&&typeof applyDemoFixture==='function'&&!(typeof db.game!=='undefined'&&db.game)){
      const fx=todayFixtures();
      if(fx.length&&!fx.some(x=>x.id===MATCH.id)){
        const f=fx.find(x=>x.status!=='final'&&(x.away===db.favorite||x.home===db.favorite))||fx.find(x=>x.status!=='final')||fx[0];
        applyDemoFixture(f);db.activeFixtureId=f.id;persist();refresh();window.FANBALL_SERVER_GAME?.load?.(true);
        if(typeof render==='function')render();
      }
    }
    if(typeof page!=='undefined'&&['home','game'].includes(page)&&typeof render==='function')render();
  }
  const setState=next=>{
    state=next;
    const signature=JSON.stringify({mode:state.mode,game:state.game?.id,round:state.round?.id,status:state.round?.status,choices:state.choices.map(c=>c.id),vote:state.vote?.choice_id,membership:state.membership?.team_id,changeStatus});
    if(signature!==lastSignature){lastSignature=signature;if(typeof page!=='undefined'&&page==='game'&&typeof render==='function')render()}
  };
  async function refresh(){
    await refreshSchedule();
    const client=api();if(!client){setState({mode:'unconfigured',game:null,round:null,choices:[],membership:null,vote:null,resolution:null});return}
    const currentUser=user();
    if(refreshing)return;refreshing=true;
    try{
      const {data:gameRow,error:gameError}=await client.from('fanball_games').select('id,kbo_game_id,status,score,inning_state').eq('kbo_game_id',MATCH.id).maybeSingle();
      if(gameError)throw gameError;
      if(!gameRow){setState({mode:'game_not_connected',game:null,round:null,choices:[],membership:null,vote:null,resolution:null});return}
      // Join only after the user saved a team: the first join fixes the team for this game.
      // Spectators of a friend-room game watch without joining a side (the room refuses them as voters).
      const membershipResult=currentUser?.user_metadata?.fanball_team&&!window.FANBALL_ROOMS?.isWatching?.(MATCH.id)?await client.rpc('join_fanball_game',{p_game_id:gameRow.id}):{data:null,error:null};
      if(membershipResult.error)throw membershipResult.error;
      const membership=membershipResult.data;
      const {data:round,error:roundError}=await client.from('tactical_rounds').select('id,game_id,pa_no,phase,state_snapshot,offense_team_id,defense_team_id,opens_at,closes_at,status').eq('game_id',gameRow.id).in('status',['open','closing','resolved']).order('created_at',{ascending:false}).limit(1).maybeSingle();
      if(roundError)throw roundError;
      if(!round){if(gameRow.status==='running')await loadChangeStatus(gameRow.id);setState({mode:'waiting',game:gameRow,round:null,choices:[],membership,vote:null,resolution:null});return}
      const [{data:choices,error:choicesError},{data:vote,error:voteError},{data:resolution,error:resolutionError}]=await Promise.all([
        client.from('tactical_choices').select('id,role,choice_key,label,is_default').eq('round_id',round.id),
        currentUser?client.from('tactical_votes').select('choice_id,role,team_id').eq('round_id',round.id).eq('user_id',currentUser.id).maybeSingle():Promise.resolve({data:null,error:null}),
        client.from('tactical_resolutions').select('offense_choice_id,defense_choice_id,vote_counts,fallback_roles').eq('round_id',round.id).maybeSingle()
      ]);
      if(choicesError)throw choicesError;if(voteError)throw voteError;if(resolutionError)throw resolutionError;
      if(gameRow.status==='running')await loadChangeStatus(gameRow.id);
      setState({mode:'ready',game:gameRow,round,choices:choices||[],membership,vote,resolution});
      if(round.status==='open'&&channel?.__gameId!==gameRow.id)subscribe(gameRow.id);
    }catch(error){
      setState({mode:'error',game:null,round:null,choices:[],membership:null,vote:null,resolution:null,error:error.message||'서버 연결 오류'});
      console.warn('FanBall server vote refresh failed:',error.message||error);
    }finally{refreshing=false}
  }
  function subscribe(gameId){
    const client=api();if(!client)return;
    if(channel)client.removeChannel(channel);
    channel=client.channel('fanball-rounds-'+gameId)
      .on('postgres_changes',{event:'*',schema:'public',table:'tactical_rounds',filter:'game_id=eq.'+gameId},refresh)
      .on('postgres_changes',{event:'*',schema:'public',table:'tactical_resolutions'},refresh)
      .subscribe();
    channel.__gameId=gameId;
  }
  async function submit(choiceId){
    const client=api();if(!client||!state.round||state.round.status!=='open')return window.notify?.('현재 투표가 열려 있지 않습니다.');
    const {error}=await client.rpc('submit_tactical_vote',{p_round_id:state.round.id,p_choice_id:choiceId});
    if(error){window.notify?.(error.message==='voting is closed'?'투표 시간이 끝났습니다.':'투표 제출 실패: '+error.message);await refresh();return}
    window.notify?.('작전을 제출했습니다. 마감 전까지 수정할 수 있습니다.');await refresh();
  }
  function view(){
    if(!state.round)return ['game_not_connected','error','waiting'].includes(state.mode)?state:null;
    const teamId=state.membership?.team_id;
    const role=teamId===state.round.offense_team_id?'offense':teamId===state.round.defense_team_id?'defense':null;
    return {...state,role,teamId,remainingMs:Math.max(0,Date.parse(state.round.closes_at)-Date.now()),choices:state.round.status==='resolved'?state.choices:(role?state.choices.filter(c=>c.role===role):[])};
  }
  // Event match (a team against itself): fans of that team pick the away or the home side.
  const isEventForMe=()=>typeof MATCH!=='undefined'&&MATCH.away===MATCH.home&&typeof db!=='undefined'&&db.favorite===MATCH.home;
  // The server's side (membership key) is the truth once known; the browser keeps a copy so the page can
  // show the choice before the server answers. chooseSide always loads the game first, so a choice made
  // on the lineup page reaches the server (an earlier version could keep it only in the browser).
  function serverSide(){const key=state.membership?.team_id;return key&&isEventForMe()?(key.endsWith('@away')?'away':'home'):null}
  function mySide(){
    if(!isEventForMe())return null;
    return serverSide()||db.eventSides?.[MATCH.id]||null;
  }
  async function chooseSide(side,{quiet=false}={}){
    if(!isEventForMe())return true;
    const client=api();
    await window.FANBALL_SERVER_GAME?.load?.(true);
    const row=window.FANBALL_SERVER_GAME?.gameRow?.();
    if(client&&row){
      if(!user()){window.notify?.('로그인한 뒤 쪽을 고를 수 있습니다.');return false}
      const {data,error}=await client.rpc('choose_fanball_side',{p_game_id:row.id,p_side:side});
      if(error){window.notify?.(error.message==='your side is fixed once the game starts'?'경기가 시작된 뒤에는 쪽을 바꿀 수 없습니다.':'쪽 선택 실패: '+error.message);await refresh();return false}
      state={...state,membership:data};
    }
    db.eventSides=db.eventSides||{};db.eventSides[MATCH.id]=side;persist();
    if(!quiet)window.notify?.(`${side==='away'?'원정':'홈'} ${team(MATCH.home).short} 쪽으로 참여합니다.`);
    await refresh();if(typeof render==='function')render();
    return true;
  }
  // Pitching change requests (live games): counts per side and whether I asked.
  let changeStatus=null;
  async function loadChangeStatus(gameId){const client=api();if(!client||!gameId)return;const {data,error}=await client.rpc('pitching_change_status',{p_game_id:gameId});if(!error)changeStatus=data}
  async function requestChange(on,pitcher,nextHalf=false){
    const client=api(),row=state.game;if(!client||!row)return;
    if(!user())return window.notify?.('로그인한 뒤 요청할 수 있습니다.');
    const {data,error}=await client.rpc('request_pitching_change',{p_game_id:row.id,p_pitcher:pitcher||null,p_on:on,p_next_half:nextHalf});
    if(error){const messages={'join this game before asking':'이 경기에 참여한 팬만 요청할 수 있습니다.','join the batting side to reserve its next pitcher':'공격 중인 우리 쪽에 참여해야 다음 투수를 예약할 수 있습니다.','only the fielding side can request a current pitcher change':'수비 중인 팀만 현재 투수 교체를 요청할 수 있습니다.','game state is not ready':'경기 상태를 불러오는 중입니다. 잠시 후 다시 시도해 주세요.','game has no next half-inning':'이 경기에는 다음 수비 이닝이 없습니다.'};window.notify?.(messages[error.message]||'요청 실패: '+error.message);await refresh();return}
    changeStatus=data;window.notify?.(on?'투수 교체를 요청했습니다.':'투수 교체 요청을 취소했습니다.');if(typeof render==='function')render();
  }
  window.FANBALL_REMOTE_VOTING={refresh,refreshSchedule,submit,view,mySide,serverSide,chooseSide,isEventForMe,requestChange,changeStatus:()=>changeStatus,getSchedule:()=>scheduleLoaded?scheduleRows:null,get state(){return state}};
  setInterval(()=>{if(window.FANBALL_SERVER_GAME?.isLocal?.())return;/* local games (AI match) run their own clock */const el=document.querySelector('#server-countdown');if(el)el.textContent=Math.ceil(Math.max(0,Date.parse(state.round?.closes_at||0)-Date.now())/1000)+'초'},250);
  setInterval(()=>{if(typeof page!=='undefined'&&['home','game'].includes(page))refresh()},2500);
  if(api()){refreshSchedule(true);refresh()}
})();
