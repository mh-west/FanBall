/* FanBall profile and optional Supabase OAuth. Provider credentials must be configured in Supabase. */
window.FANBALL_AUTH_CONFIG=window.FANBALL_AUTH_CONFIG||{supabaseUrl:'',supabaseAnonKey:''};
let fanballSupabase=null,fanballUser=null;
if(window.FANBALL_AUTH_CONFIG.supabaseUrl&&window.FANBALL_AUTH_CONFIG.supabaseAnonKey&&window.supabase?.createClient){
  fanballSupabase=window.supabase.createClient(window.FANBALL_AUTH_CONFIG.supabaseUrl,window.FANBALL_AUTH_CONFIG.supabaseAnonKey);
  fanballSupabase.auth.getSession().then(({data})=>{fanballUser=data.session?.user||null;applyAuthProfile();updateAccountButton()});
  fanballSupabase.auth.onAuthStateChange((_event,session)=>{fanballUser=session?.user||null;applyAuthProfile();updateAccountButton();if(fanballUser&&!fanballUser.user_metadata?.fanball_nickname)setTimeout(openAccount,400)});
}
function applyAuthProfile(){
  const meta=fanballUser?.user_metadata||{};
  if(meta.fanball_nickname)db.nickname=meta.fanball_nickname;
  if(meta.fanball_team&&team(meta.fanball_team)){db.favorite=meta.fanball_team;pickTeam=db.favorite;const select=document.querySelector('#favorite');if(select)select.value=db.favorite}
  if(fanballUser)persist();
}
function updateAccountButton(){const label=document.querySelector('#avatarLabel');if(label)label.textContent=db.nickname||'프로필 설정'}
window.openAccount=function(){
  document.querySelector('#account-modal')?.remove();
  const connected=!!fanballSupabase,teamOptions=TEAMS.map(t=>`<option value="${t.id}" ${db.favorite===t.id?'selected':''}>${t.name}</option>`).join('');
  const providerButtons=connected?'<button class="account-provider" onclick="connectFanballProvider(\'google\')"><b>G</b> Google로 계속하기</button><button class="account-provider" onclick="connectFanballProvider(\'apple\')"><b>●</b> Apple로 계속하기</button>':'<p class="account-setup-note">Google·Apple 계정 연결은 인증 프로젝트 설정 후 활성화됩니다. 지금 저장한 프로필은 이 브라우저에 보관됩니다.</p><button class="account-provider" disabled><b>G</b> Google · 설정 대기</button><button class="account-provider" disabled><b>●</b> Apple · 설정 대기</button>';
  const identity=fanballUser?`<p class="account-status">연결된 계정 · ${safe(fanballUser.email||fanballUser.app_metadata?.provider||'로그인됨')}</p>`:'<p class="account-status">로그인하지 않은 상태 · 프로필은 현재 브라우저에 저장됩니다.</p>';
  document.body.insertAdjacentHTML('beforeend',`<div class="modal-backdrop" id="account-modal" onclick="if(event.target===this)this.remove()"><section class="account-modal"><button class="modal-close" onclick="document.querySelector('#account-modal').remove()">×</button><div class="eyebrow">FANBALL PROFILE</div><h2>내 프로필</h2>${identity}<label for="fanball-nickname">닉네임</label><input id="fanball-nickname" maxlength="12" value="${safe(db.nickname||'')}" placeholder="2~12자 닉네임"><label for="fanball-team">응원팀</label><select id="fanball-team">${teamOptions}</select><button class="btn btn-primary account-save" onclick="saveFanballProfile()">프로필 저장</button><div class="account-divider"><span>계정 연결</span></div>${providerButtons}${fanballUser?'<button class="account-signout" onclick="signOutFanball()">로그아웃</button>':''}</section></div>`);
};
window.saveFanballProfile=async function(){
  const nickname=document.querySelector('#fanball-nickname')?.value.trim()||'',teamId=document.querySelector('#fanball-team')?.value;
  if(nickname.length<2)return notify('닉네임은 2자 이상 입력해 주세요.');
  db.nickname=nickname;db.favorite=teamId;pickTeam=teamId;const select=document.querySelector('#favorite');if(select)select.value=teamId;persist();updateAccountButton();
  if(fanballUser&&fanballSupabase){const {error}=await fanballSupabase.auth.updateUser({data:{fanball_nickname:nickname,fanball_team:teamId}});if(error)return notify('프로필 저장 실패: '+error.message)}
  document.querySelector('#account-modal')?.remove();render();notify('닉네임과 응원팀을 저장했습니다.');
};
window.connectFanballProvider=async function(provider){
  if(!fanballSupabase)return notify('Google·Apple 로그인을 쓰려면 Supabase URL과 공개 anon key, OAuth 공급자 설정이 필요합니다.');
  const {error}=await fanballSupabase.auth.signInWithOAuth({provider,options:{redirectTo:location.origin+location.pathname}});
  if(error)notify('계정 연결 실패: '+error.message);
};
window.signOutFanball=async function(){if(!fanballSupabase)return;const {error}=await fanballSupabase.auth.signOut();if(error)return notify('로그아웃 실패: '+error.message);fanballUser=null;document.querySelector('#account-modal')?.remove();updateAccountButton();notify('로그아웃했습니다.');};
updateAccountButton();
window.updateAccountButton=updateAccountButton;
const favoriteSelect=document.querySelector('#favorite');
if(favoriteSelect){const previousChange=favoriteSelect.onchange;favoriteSelect.onchange=async event=>{previousChange?.call(favoriteSelect,event);if(fanballUser&&fanballSupabase){const {error}=await fanballSupabase.auth.updateUser({data:{fanball_team:db.favorite}});if(error)notify('응원팀 동기화 실패: '+error.message)}}}
