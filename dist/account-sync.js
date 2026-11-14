/* Account sync (2026-11-12): saved lineups, the AI match in progress and past AI matches follow the
   signed-in account (public.user_state, one row per user and key, readable only by its owner), so the
   same Google account sees them on every device. Signed out, everything stays in this browser as before.
   - On sign-in and whenever the page comes back into view: read the account's copies and merge them with
     this browser's (newest wins; saved lineups merge slot by slot).
   - On change: write to the account after a short pause (the AI match at most every 15 seconds, and right
     away when the page is hidden or closed). */
(function(){
  const api=()=>window.FANBALL_SERVER_CLIENT,user=()=>window.FANBALL_AUTH_USER?.()||null;
  const WAIT={saved_lineups:1500,ai_history:1500,ai_match:15000};
  const HISTORY_SYNC_LIMIT=1_700_000;
  const pending={},timers={};
  let pulledFor=null,pulling=false;

  // Lighter copy of an AI match for the account: per-pitch probability tables are dropped (the pitch odds
  // window then shows "기록 없음" for that game on other devices), everything needed to continue is kept.
  const slim=m=>m&&m.pitches?{...m,pitches:m.pitches.map(p=>p.payload?.distribution?{...p,payload:{...p.payload,distribution:undefined}}:p)}:m;
  function boundedHistory(value){
    const history=(value||[]).map(slim),size=()=>new TextEncoder().encode(JSON.stringify(history)).length;
    while(history.length>1&&size()>HISTORY_SYNC_LIMIT)history.pop();
    if(history.length&&size()>HISTORY_SYNC_LIMIT){
      const game=history[0];let pitches=Array.isArray(game.pitches)?game.pitches.slice():[];
      while(pitches.length&&size()>HISTORY_SYNC_LIMIT){
        const before=size();pitches=pitches.slice(Math.max(1,Math.ceil(pitches.length/5)));history[0]={...game,pitches};
        if(size()>=before)break;
      }
      if(size()>HISTORY_SYNC_LIMIT)history.length=0;
    }
    return history;
  }

  async function write(key){
    clearTimeout(timers[key]);timers[key]=null;
    if(!(key in pending))return;
    const client=api(),u=user();if(!client||!u||pulledFor!==u.id)return; // wait until this account was read first
    let value=pending[key];delete pending[key];
    if(key==='ai_match')value=slim(value);
    if(key==='ai_history')value=boundedHistory(value);
    const {error}=await client.from('user_state').upsert({user_id:u.id,key,value,updated_at:new Date().toISOString()});
    if(error)console.warn('FanBall account sync failed:',key,error.message);
  }
  function push(key,value){
    pending[key]=value;
    if(!timers[key])timers[key]=setTimeout(()=>write(key),WAIT[key]||2000);
  }
  function flush(){for(const k of Object.keys(pending))write(k)}

  // Saved lineups: per team, the newest of each entry (recent, recentAi, slots 1-3) wins.
  function mergeLineups(a,b){
    const stamp=v=>Math.max(v?.at||0,v?.editedAt||0),out={},newer=(x,y)=>(stamp(x)>=stamp(y)?x:y)??null; // a renamed entry carries editedAt
    for(const t of new Set([...Object.keys(a||{}),...Object.keys(b||{})])){
      const x=a?.[t]||{},y=b?.[t]||{};
      out[t]={recent:newer(x.recent,y.recent),recentAi:newer(x.recentAi,y.recentAi),slots:[0,1,2].map(n=>newer(x.slots?.[n],y.slots?.[n]))};
      for(const k of ['recent','recentAi'])if(!out[t][k])delete out[t][k];
    }
    return out;
  }
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

  async function pull(){
    const client=api(),u=user();if(!client||!u||pulling)return;
    pulling=true;
    try{
      const {data,error}=await client.from('user_state').select('key,value,updated_at');
      if(error)throw error;
      const remote=Object.fromEntries((data||[]).map(r=>[r.key,r.value]));
      const first=pulledFor!==u.id;pulledFor=u.id;
      // Saved lineups
      if(typeof savedLineups==='function'){
        const local=savedLineups(),merged=mergeLineups(local,remote.saved_lineups||{});
        if(!same(merged,local)){writeSavedLineups(merged,{fromSync:true});if(['lineup','ai'].includes(page))render()}
        if(!same(merged,remote.saved_lineups||{}))push('saved_lineups',merged);
      }
      // AI match and history (dist/ai-game.js registers FANBALL_AI_SYNC once it has loaded)
      const ai=window.FANBALL_AI_SYNC;
      if(ai){
        const mine=ai.current(),theirs=remote.ai_match;
        if(theirs&&(theirs.savedAt||0)>(mine?.savedAt||0))ai.adopt(theirs);
        else if(mine&&(!theirs||(mine.savedAt||0)>(theirs.savedAt||0)))push('ai_match',mine);
        const lh=ai.history(),rh=remote.ai_history||[],byId=new Map();
        for(const h of [...lh,...rh])if(h?.matchId&&!byId.has(h.matchId))byId.set(h.matchId,h);
        const union=[...byId.values()].sort((x,y)=>(y.startedAt||0)-(x.startedAt||0)).slice(0,10);
        if(!same(union.map(h=>h.matchId),lh.map(h=>h.matchId)))ai.setHistory(union);
        if(!same(union.map(h=>h.matchId),rh.map(h=>h.matchId)))push('ai_history',union);
      }
      if(first&&Object.keys(remote).length)console.info('FanBall: account data loaded');
    }catch(e){console.warn('FanBall account sync read failed:',e.message||e)}
    finally{pulling=false;flush()}
  }

  window.FANBALL_SYNC={push,pull,flush};
  // Sign-in changes, page coming back into view, and the AI module finishing its load all trigger a read.
  let lastUser=null;
  setInterval(()=>{const id=user()?.id||null;if(id!==lastUser){lastUser=id;pulledFor=null;if(id)pull()}},1000);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)flush();else if(user())pull()});
  window.addEventListener('pagehide',flush);
  window.addEventListener('fanball-ai-ready',()=>{if(user())pull()});
})();
