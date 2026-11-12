/* My-team colors (user request 2026-11-12): the site keeps its default colors until the fan is signed in and has
   a team (profile 응원팀); then the menu, buttons and accents take that team's colors. Colors only, no logos. */
(function(){
  const COLORS={ // [main, dark] - the clubs' well-known primary colors
    lg:['#C30452','#5e0228'], kt:['#EB1C24','#231F20'], ssg:['#CE0E2D','#5a0613'], nc:['#315288','#1b2d4c'], doosan:['#1A1748','#0d0b26'],
    tigers:['#EA0029','#06141F'], lotte:['#D00F31','#041E42'], samsung:['#074CA1','#03264f'], hanwha:['#FC4E00','#07111A'], kiwoom:['#820024','#2d0209'],
  };
  function apply(){
    const root=document.documentElement,user=window.FANBALL_AUTH_USER?.(),id=typeof db!=='undefined'?db.favorite:null,c=user&&COLORS[id];
    if(!c){if(root.dataset.team){delete root.dataset.team;root.style.removeProperty('--team');root.style.removeProperty('--team-dark')}return}
    if(root.dataset.team===id)return;
    root.dataset.team=id;root.style.setProperty('--team',c[0]);root.style.setProperty('--team-dark',c[1]);
  }
  window.applyTeamTheme=apply;
  apply();setInterval(apply,1500); // follows sign-in and profile changes without hooking every caller
})();
