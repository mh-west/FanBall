/* Vote dock and vote alerts (user feedback 2026-11-12: on a phone it is easy to miss that a vote is open, and
   voting means scrolling down past the strike zone and back up; tablets and laptops should also make the
   moment obvious).

   - Watches the page for an open tactical vote of my side (the .vote-box.remote-vote.offense / .defense card
     that enhancements.js renders for live games and AI matches, pitcher-change votes included).
   - When that card is not on screen, shows a compact copy of it in a fixed dock: above the bottom menu on phones, at the bottom on tablets, at
     the right beside the pitch board on laptops. Buttons in the dock press the real buttons, so voting logic
     stays in one place. The dock can be folded; it goes away when the vote closes.
   - When a vote opens: a short vibration (where the browser allows it), a banner at the top, the tab title
     "🔔 투표 중", an optional two-note sound (on/off in the dock, remembered in this browser), and a browser
     notification when the tab is in the background (only after the fan allows it from the dock). */
(function(){
  const BOX='#app .vote-box.remote-vote.offense, #app .vote-box.remote-vote.defense';
  const store={get(k,d){try{const v=localStorage.getItem(k);return v===null?d:v}catch(e){return d}},set(k,v){try{localStorage.setItem(k,v)}catch(e){}}};
  const baseTitle=document.title;
  let lastKey=null,folded=false,lastHtml='';
  // Votes already announced: a vote card that drops out for a moment (a redraw, a failed refresh) and comes back
  // is the same vote, so it does not sound again (user report 2026-11-13: the sound kept going).
  const announced=[];

  document.body.insertAdjacentHTML('beforeend','<div id="vote-dock" class="vote-dock" hidden role="region" aria-label="작전 투표"></div><div id="vote-flash" class="vote-flash" hidden role="status"></div>');
  const dock=document.getElementById('vote-dock'),flash=document.getElementById('vote-flash');

  const text=(el,sel)=>(el.querySelector(sel)?.textContent||'').trim();
  const soundOn=()=>store.get('fanball_vote_sound','1')==='1';
  function beep(){
    if(!soundOn())return;
    try{
      const C=window.AudioContext||window.webkitAudioContext;if(!C)return;
      const ctx=beep.ctx||(beep.ctx=new C());if(ctx.state==='suspended')ctx.resume();
      [[880,0],[1175,0.16]].forEach(([f,t])=>{const o=ctx.createOscillator(),g=ctx.createGain();o.frequency.value=f;o.type='sine';
        g.gain.setValueAtTime(0.0001,ctx.currentTime+t);g.gain.exponentialRampToValueAtTime(0.18,ctx.currentTime+t+0.02);g.gain.exponentialRampToValueAtTime(0.0001,ctx.currentTime+t+0.14);
        o.connect(g).connect(ctx.destination);o.start(ctx.currentTime+t);o.stop(ctx.currentTime+t+0.16)});
    }catch(e){}
  }
  function announce(title,situation){
    try{if(navigator.userActivation?.hasBeenActive!==false)navigator.vibrate?.([140,70,140])}catch(e){} // browsers allow it only after the fan has tapped the page
    beep();
    flash.innerHTML=`<b>🔔 투표가 열렸습니다</b><span>${safe(title)}${situation?' · '+safe(situation):''}</span>`;
    flash.hidden=false;flash.classList.remove('show');void flash.offsetWidth;flash.classList.add('show');
    clearTimeout(announce.t);announce.t=setTimeout(()=>{flash.hidden=true},3200);
    if(document.hidden&&'Notification' in window&&Notification.permission==='granted'){
      try{const n=new Notification('팬볼 · 작전 투표가 열렸습니다',{body:[title,situation].filter(Boolean).join(' · '),tag:'fanball-vote',renotify:true});n.onclick=()=>{window.focus();n.close()}}catch(e){}
    }
  }

  window.voteDockPick=function(i){const btn=document.querySelectorAll(BOX.split(',').map(s=>s.trim()+' .vote-options button').join(','))[i];btn?.click();setTimeout(tick,60)};
  window.voteDockFold=function(){folded=!folded;lastHtml='';tick()};
  window.voteDockSound=function(){store.set('fanball_vote_sound',soundOn()?'0':'1');lastHtml='';tick();if(soundOn())beep();notify?.(soundOn()?'투표 알림음을 켰습니다.':'투표 알림음을 껐습니다.')};
  window.voteDockNotify=async function(){try{await Notification.requestPermission()}catch(e){}lastHtml='';tick()};

  // A sound switch on the vote card itself (user request 2026-11-12), so the sound can be turned off before a
  // vote opens and on wide screens where the dock never shows.
  function soundSwitch(){
    for(const card of document.querySelectorAll('#app .vote-box.remote-vote')){
      let b=card.querySelector('.vote-sound-toggle');
      if(!b){card.insertAdjacentHTML('afterbegin','<button type="button" class="vote-sound-toggle" onclick="voteDockSound()"></button>');b=card.querySelector('.vote-sound-toggle')}
      const label=soundOn()?'🔊 알림음 켜짐':'🔇 알림음 꺼짐';if(b.textContent!==label){b.textContent=label;b.setAttribute('aria-label',soundOn()?'투표 알림음 끄기':'투표 알림음 켜기')}
    }
  }
  // The game screen is redrawn on every pitch, which drops the button; put it back as soon as the screen
  // changes (before the browser paints), so it no longer blinks (user report 2026-11-13).
  {const app=document.getElementById('app');if(app&&window.MutationObserver)new MutationObserver(()=>soundSwitch()).observe(app,{childList:true,subtree:true})}
  function tick(){
    soundSwitch();
    const box=document.querySelector(BOX);
    if(!box||!box.querySelector('.vote-options button')){
      if(lastKey!==null){lastKey=null;folded=false;document.body.classList.remove('vote-live','vote-docked');document.title=baseTitle}
      if(!dock.hidden){dock.hidden=true;dock.innerHTML='';lastHtml=''}
      return;
    }
    const title=text(box,'.remote-vote-title b'),time=text(box,'.remote-vote-title span'),situation=text(box,'.ballot-situation').split(' · ').filter(x=>!/마감|타석 전 작전|\d+\s*:\s*\d+/.test(x)).slice(0,3).join(' · ');
    const options=[...box.querySelectorAll('.vote-options button')].map(b=>({label:(b.querySelector('b')?.textContent||'').trim(),voted:b.classList.contains('voted'),
      effects:[...b.querySelectorAll('.choice-effect')].slice(0,2).map(e=>({good:e.classList.contains('good'),text:e.textContent.trim()}))}));
    const key=title+'|'+situation+'|'+options.map(o=>o.label.replace(' · 내 선택','')).join('/');
    if(key!==lastKey){if((lastKey===null||!options.some(o=>o.voted))&&!announced.includes(key)&&time!=='0초'){announce(title,situation);announced.push(key);if(announced.length>40)announced.shift()}lastKey=key;folded=false}
    document.body.classList.add('vote-live');
    const secs=/^\d+초$/.test(time)?time:'';
    document.title=`🔔 투표 중${secs?' '+secs:''} · ${baseTitle}`;
    // Only when the vote card itself is not on screen (user request 2026-11-12): on a wide screen it usually is.
    // Hysteresis (user report 2026-11-14: scrolling near the edge flickered the dock in and out - its
    // padding-bottom shifted the page under a tap, so it took a second one to register): once docked,
    // require more of the real card to show again before un-docking, instead of the same 50% both ways.
    const r=box.getBoundingClientRect(),wasDocked=document.body.classList.contains('vote-docked'),
      visible=Math.max(0,Math.min(r.bottom,innerHeight)-Math.max(r.top,0)),
      inView=r.top<innerHeight-60&&r.bottom>90&&visible>Math.min(r.height,innerHeight)*(wasDocked?0.65:0.5);
    if(inView){if(!dock.hidden){dock.hidden=true;dock.innerHTML='';lastHtml=''}document.body.classList.remove('vote-docked');return}
    document.body.classList.add('vote-docked');
    const voted=options.find(o=>o.voted);
    const notifyBtn=('Notification' in window)&&Notification.permission==='default'?'<button type="button" class="vd-link" onclick="voteDockNotify()">다른 탭에 있을 때 알림 받기</button>':'';
    const html=`<div class="vd-head"><b class="vd-title">🔔 ${safe(title)}</b>${time?`<span class="vd-time ${secs&&parseInt(secs)<=3?'hurry':''}">${safe(time)}</span>`:''}<button type="button" class="vd-icon" onclick="voteDockSound()" aria-label="${soundOn()?'알림음 끄기':'알림음 켜기'}" title="${soundOn()?'알림음 끄기':'알림음 켜기'}">${soundOn()?'🔊':'🔇'}</button><button type="button" class="vd-icon" onclick="voteDockFold()" aria-expanded="${!folded}">${folded?'펼치기':'접기'}</button></div>`+
      (folded?`<div class="vd-folded">${voted?'내 선택: '+safe(voted.label.replace(' · 내 선택','')):'아직 고르지 않았습니다'}</div>`:
      `${situation?`<div class="vd-sit">${safe(situation)}</div>`:''}<div class="vd-options">${options.map((o,i)=>`<button type="button" class="vd-opt ${o.voted?'voted':''}" onclick="voteDockPick(${i})"><b>${safe(o.label)}</b>${o.effects.map(e=>`<small class="${e.good?'good':'bad'}">${safe(e.text)}</small>`).join('')}</button>`).join('')}</div><div class="vd-foot"><span>${voted?'마감 전까지 바꿀 수 있습니다':'버튼을 누르면 바로 투표됩니다'}</span>${notifyBtn}</div>`);
    if(html!==lastHtml){dock.innerHTML=html;lastHtml=html}
    dock.classList.toggle('folded',folded);
    dock.hidden=false;
  }
  setInterval(tick,300);
})();
