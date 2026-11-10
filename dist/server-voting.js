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
    if(typeof page!=='undefined'&&page==='home'&&typeof render==='function')render();
  }
  const setState=next=>{
    state=next;
    const signature=JSON.stringify({mode:state.mode,game:state.game?.id,round:state.round?.id,status:state.round?.status,choices:state.choices.map(c=>c.id),vote:state.vote?.choice_id,membership:state.membership?.team_id});
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
      const membershipResult=currentUser?.user_metadata?.fanball_team?await client.rpc('join_fanball_game',{p_game_id:gameRow.id}):{data:null,error:null};
      if(membershipResult.error)throw membershipResult.error;
      const membership=membershipResult.data;
      const {data:round,error:roundError}=await client.from('tactical_rounds').select('id,game_id,pa_no,phase,state_snapshot,offense_team_id,defense_team_id,opens_at,closes_at,status').eq('game_id',gameRow.id).in('status',['open','closing','resolved']).order('created_at',{ascending:false}).limit(1).maybeSingle();
      if(roundError)throw roundError;
      if(!round){setState({mode:'waiting',game:gameRow,round:null,choices:[],membership,vote:null,resolution:null});return}
      const [{data:choices,error:choicesError},{data:vote,error:voteError},{data:resolution,error:resolutionError}]=await Promise.all([
        client.from('tactical_choices').select('id,role,choice_key,label,is_default').eq('round_id',round.id),
        currentUser?client.from('tactical_votes').select('choice_id,role,team_id').eq('round_id',round.id).eq('user_id',currentUser.id).maybeSingle():Promise.resolve({data:null,error:null}),
        client.from('tactical_resolutions').select('offense_choice_id,defense_choice_id,vote_counts,fallback_roles').eq('round_id',round.id).maybeSingle()
      ]);
      if(choicesError)throw choicesError;if(voteError)throw voteError;if(resolutionError)throw resolutionError;
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
  window.FANBALL_REMOTE_VOTING={refresh,refreshSchedule,submit,view,getSchedule:()=>scheduleLoaded?scheduleRows:null,get state(){return state}};
  setInterval(()=>{const el=document.querySelector('#server-countdown');if(el)el.textContent=Math.ceil(Math.max(0,Date.parse(state.round?.closes_at||0)-Date.now())/1000)+'초'},250);
  setInterval(()=>{if(typeof page!=='undefined'&&['home','game'].includes(page))refresh()},2500);
  if(api()){refreshSchedule(true);refresh()}
})();
