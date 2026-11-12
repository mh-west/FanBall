/* My-team colors (user request 2026-11-12): the site keeps its default colors until the fan is signed in and has
   a team (profile 응원팀); then the menu, buttons and accents take that team's colors. Colors only, no logos. */
(function(){
  // One color per club (user decision 2026-11-13); the menu, buttons and accents all use it.
  const COLORS={lg:'#C30452',doosan:'#131230',kt:'#000000',ssg:'#CE0E2D',nc:'#315288',tigers:'#EA0029',lotte:'#041E42',samsung:'#074CA1',hanwha:'#FC4E00',kiwoom:'#820024'};
  function apply(){
    const root=document.documentElement,user=window.FANBALL_AUTH_USER?.(),id=typeof db!=='undefined'?db.favorite:null,c=user&&COLORS[id];
    if(!c){if(root.dataset.team){delete root.dataset.team;root.style.removeProperty('--team');root.style.removeProperty('--team-dark')}return}
    if(root.dataset.team===id)return;
    root.dataset.team=id;root.style.setProperty('--team',c);root.style.setProperty('--team-dark',c);
  }
  window.applyTeamTheme=apply;
  apply();setInterval(apply,1500); // follows sign-in and profile changes without hooking every caller
})();
