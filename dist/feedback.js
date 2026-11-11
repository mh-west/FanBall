/* Suggestion box (nav "건의하기"). Signed-in fans send suggestions and see their own with the admin's
   status and reply; admins (?admin=1, is_admin on the server) see every suggestion and set its status.
   The server functions submit_feedback and admin_update_feedback check the caller themselves
   (supabase/migrations/202611110003_feedback.sql). */
(function(){
  const api=()=>window.FANBALL_SERVER_CLIENT,user=()=>window.FANBALL_AUTH_USER?.()||null;
  const CATS={feature:'기능 제안',bug:'오류 신고',data:'선수·기록 데이터',other:'기타'};
  const STATUS={new:['접수','gold'],read:['확인함','blue'],planned:['반영 예정','blue'],done:['반영 완료','green'],declined:['보류','']};
  const PAGES={home:'홈',lineup:'라인업 투표',game:'경기 센터',records:'순위 · 기록',ai:'AI 대결',admin:'경기 관리'};
  const F={rows:null,loading:false,error:null,busy:false,filter:'all',draft:{category:'feature',body:''}};
  const errorText=e=>{const m=e?.message||String(e);return ({'sign in first':'로그인한 뒤 보낼 수 있습니다.','too short':'내용을 5자 이상 적어 주세요.','too long':'내용은 1000자까지 쓸 수 있습니다.','too many suggestions':'건의는 한 시간에 5개까지 보낼 수 있습니다. 잠시 뒤 다시 보내 주세요.','admin only':'관리자 계정만 할 수 있습니다.'})[m]||m};
  const when=iso=>new Date(iso).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
  const rerender=()=>{if(page==='feedback')render()};

  async function load(){
    const client=api();if(!client||!user()||F.loading)return;
    F.loading=true;
    try{
      // Row-level security returns only the fan's own rows, or every row for an admin.
      const {data,error}=await client.from('feedback').select('id,user_id,nickname,category,body,page,status,admin_note,created_at,updated_at').order('created_at',{ascending:false}).limit(300);
      if(error)throw error;F.rows=data||[];F.error=null;
    }catch(e){F.error=errorText(e)}
    finally{F.loading=false;rerender()}
  }

  window.feedbackDraft=function(field,value){F.draft[field]=value;if(field==='body'){const c=document.querySelector('#feedback-count');if(c)c.textContent=`${value.trim().length}/1000`}};
  window.feedbackSubmit=async function(){
    if(!user())return openAccount();
    const body=F.draft.body.trim();
    if(body.length<5)return notify('내용을 5자 이상 적어 주세요.');
    if(F.busy)return;F.busy=true;rerender();
    try{
      const {error}=await api().rpc('submit_feedback',{p_category:F.draft.category,p_body:body,p_page:F.from||null});
      if(error)throw error;
      F.draft.body='';notify('건의를 보냈습니다. 고맙습니다!');F.rows=null;
    }catch(e){notify('보내기 실패: '+errorText(e))}
    finally{F.busy=false;rerender()}
  };
  window.feedbackSetStatus=async function(id){
    if(!ADMIN_MODE)return;
    const status=document.querySelector(`#fb-status-${id}`).value,note=document.querySelector(`#fb-note-${id}`).value;
    try{const {error}=await api().rpc('admin_update_feedback',{p_id:id,p_status:status,p_note:note});if(error)throw error;notify('상태를 저장했습니다.');F.rows=null;rerender()}
    catch(e){notify('저장 실패: '+errorText(e))}
  };
  window.feedbackFilter=function(v){if(v!==undefined)F.filter=v;rerender()};
  window.feedbackReload=function(){F.rows=null;rerender()};

  function item(r,admin){
    const [label,tone]=STATUS[r.status]||[r.status,''];
    const who=admin?`<span class="muted">${safe(r.nickname||'닉네임 없음')}${r.page?` · ${safe(PAGES[r.page]||r.page)} 화면에서`:''}</span>`:'';
    const reply=r.admin_note?`<div class="fb-reply"><b>운영자 답변</b>${safe(r.admin_note)}</div>`:'';
    const controls=admin?`<div class="fb-admin"><select id="fb-status-${r.id}">${Object.entries(STATUS).map(([k,[l]])=>`<option value="${k}" ${k===r.status?'selected':''}>${l}</option>`).join('')}</select><input id="fb-note-${r.id}" maxlength="500" placeholder="답변 (건의한 사람에게 보입니다)" value="${safe(r.admin_note||'')}"><button class="btn btn-soft" onclick="feedbackSetStatus(${r.id})">저장</button></div>`:'';
    return `<article class="fb-item"><div class="fb-meta"><span class="tag">${CATS[r.category]||r.category}</span><span class="tag ${tone}">${label}</span><small class="muted">${when(r.created_at)}</small>${who}</div><p class="fb-body">${safe(r.body)}</p>${reply}${controls}</article>`;
  }

  window.feedbackPage=function(){
    const admin=ADMIN_MODE,signed=!!user();
    if(signed&&F.rows===null&&!F.loading&&!F.error)load();
    const head=header('FEEDBACK','건의하기','FanBall을 쓰면서 불편했던 점이나 바라는 기능을 알려 주세요');
    const form=!api()?'<div class="empty">서버 연결 설정이 필요합니다.</div>':`<section class="card fb-form"><div class="card-head"><h2>새 건의</h2><span class="tag">운영자만 읽습니다</span></div>
      <div class="fb-cats">${Object.entries(CATS).map(([k,l])=>`<label class="fb-cat ${F.draft.category===k?'on':''}"><input type="radio" name="fb-cat" value="${k}" ${F.draft.category===k?'checked':''} onchange="feedbackDraft('category',this.value);feedbackFilter()">${l}</label>`).join('')}</div>
      <textarea id="feedback-body" maxlength="1000" rows="5" placeholder="${signed?'예: AI 대결에서 투수를 바꿀 수 있으면 좋겠어요 / 어떤 선수의 기록이 실제와 달라요':'로그인하면 건의를 보낼 수 있습니다'}" ${signed?'':'disabled'} oninput="feedbackDraft('body',this.value)">${safe(F.draft.body)}</textarea>
      <div class="fb-foot"><small class="muted tiny" id="feedback-count">${F.draft.body.trim().length}/1000</small>${signed?`<button class="btn btn-primary" ${F.busy?'disabled':''} onclick="feedbackSubmit()">${F.busy?'보내는 중…':'보내기'}</button>`:'<button class="btn btn-primary" onclick="openAccount()">로그인하고 건의하기</button>'}</div>
      <p class="tiny muted fb-note">닉네임과 함께 저장되며, 운영자가 확인하면 아래 목록에서 진행 상태와 답변을 볼 수 있습니다. 한 시간에 5개까지 보낼 수 있습니다.</p></section>`;
    if(!signed)return head+form;
    let rows=F.rows||[];
    if(admin&&F.filter!=='all')rows=rows.filter(r=>F.filter==='open'?['new','read'].includes(r.status):r.category===F.filter);
    const counts=admin&&F.rows?` · 새 건의 ${F.rows.filter(r=>r.status==='new').length}개`:'';
    const filter=admin?`<select onchange="feedbackFilter(this.value)">${[['all','전체'],['open','처리 전'],...Object.entries(CATS)].map(([k,l])=>`<option value="${k}" ${F.filter===k?'selected':''}>${l}</option>`).join('')}</select>`:'';
    const list=F.error?`<div class="empty">불러오기 실패: ${safe(F.error)}</div>`:F.rows===null?'<div class="empty">불러오는 중…</div>':rows.length?rows.map(r=>item(r,admin)).join(''):`<div class="empty">${admin?'건의가 없습니다.':'아직 보낸 건의가 없습니다.'}</div>`;
    return head+form+`<section class="card fb-list"><div class="card-head"><div><h2>${admin?'받은 건의 (관리자)':'내가 보낸 건의'}</h2><small class="muted tiny">최신순${counts}</small></div><span class="fb-tools">${filter}<button class="btn btn-soft" onclick="feedbackReload()">새로고침</button></span></div>${list}</section>`;
  };
  // Remember which screen the fan came from, so a suggestion says where the problem was.
  const nav=document.querySelector('#nav');
  nav?.addEventListener('click',e=>{const b=e.target.closest('button[data-page="feedback"]');if(b&&page!=='feedback')F.from=page},true);
})();
