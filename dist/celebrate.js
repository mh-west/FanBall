// A light firework burst when a run scores (user request 2026-11-13). Display only: it watches the
// at-bat result panel (server-game.js, used by live, room and AI games) for a result with "득점" and
// fires once per result. Skipped when the viewer asks for reduced motion.
(function(){
  const quiet=matchMedia('(prefers-reduced-motion: reduce)');
  let lastKey=null,canvas=null,parts=[],raf=0;
  const COLORS=['#ffcc33','#ff6b6b','#4dabf7','#69db7c','#ffffff','#f783ac'];
  function burst(x,y,n){
    for(let i=0;i<n;i++){const a=Math.random()*Math.PI*2,s=2+Math.random()*4;
      parts.push({x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s-1.5,life:1,decay:.012+Math.random()*.012,c:COLORS[i%COLORS.length],r:2+Math.random()*2})}
  }
  function frame(){
    const g=canvas.getContext('2d');g.clearRect(0,0,canvas.width,canvas.height);
    parts=parts.filter(p=>p.life>0);
    for(const p of parts){p.x+=p.vx;p.y+=p.vy;p.vy+=.08;p.vx*=.985;p.life-=p.decay;g.globalAlpha=Math.max(0,p.life);g.fillStyle=p.c;g.beginPath();g.arc(p.x,p.y,p.r,0,7);g.fill()}
    if(parts.length)raf=requestAnimationFrame(frame);else{canvas.remove();canvas=null;raf=0}
  }
  function fire(runs){
    if(quiet.matches)return;
    if(!canvas){canvas=document.createElement('canvas');canvas.className='celebrate-canvas';canvas.setAttribute('aria-hidden','true');document.body.appendChild(canvas)}
    const dpr=1;canvas.width=innerWidth*dpr;canvas.height=innerHeight*dpr;
    const w=innerWidth,h=innerHeight,shots=Math.min(4,1+runs);
    for(let i=0;i<shots;i++)setTimeout(()=>{burst(w*(.2+Math.random()*.6),h*(.18+Math.random()*.25),28);if(!raf)raf=requestAnimationFrame(frame)},i*280);
  }
  function check(){
    const box=document.querySelector('.pitch-panel .atbat-result');
    if(!box){lastKey=null;return}
    const head=document.querySelector('.pitch-panel .atbat-heading')?.textContent||'',text=box.querySelector('b')?.textContent||'';
    const key=head+'|'+text;if(key===lastKey)return;lastKey=key;
    const m=text.match(/(\d+)득점/);if(m)fire(Number(m[1]));
  }
  setInterval(check,400);
})();
