/* AI match: the viewer picks a team and an opponent, sets a batting order, and plays nine innings
   against an AI manager on the same pitch-by-pitch engine as official games (dist/engine is a copy of
   supabase/functions/_shared). Runs in this browser only; nothing is saved to the server.

   AI manager
   - Lineup: best catcher, best four infielders, best three outfielders, best remaining hitter at DH,
     rated by the engine's own (PA-weighted) OBP and SLG; batting order in the usual sabermetric shape
     (best on-base hitter leads off, best hitters 2nd and 4th, next two 3rd and 5th, the rest 6-9).
   - Tactics: for every choice on the ballot it works out the batter's outcome odds with the engine
     (E.plateAppearanceOdds) and scores them by expected runs: runs scored on the play plus the run
     expectancy of the base-out state after it (RE24 table below). On offense it takes the highest, on
     defense the lowest. Same ballots and same vote moments as official games.
   - The viewer's votes have the live-game clock (10 s, 8 s later in the at-bat) and apply at once; the
     clock and the game stop while the viewer is away from the AI page, the tab, or the site. */
import * as E from './engine/pitch-engine.js';
import { aiLineupFor, aiChoice } from './ai-manager.js';
const aiLineup = teamId => aiLineupFor(team(teamId));

const KEY = 'fanball-ai-game-v1';
const SPEEDS = { normal: { label: '보통 (2초)', ms: 2000 }, fast: { label: '빠르게 (1초)', ms: 1000 }, faster: { label: '아주 빠르게 (0.4초)', ms: 400 } };
let A = null; // the match in progress or finished
try { A = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { A = null; }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(A)); } catch (_) {} };

// Finished AI games, newest first (this browser only). Each keeps its plays and pitches so the at-bat
// log and pitch odds can be opened again. Up to 10; older ones drop off, or sooner if storage is full.
const HISTORY_KEY = 'fanball-ai-history-v1', HISTORY_MAX = 10;
const loadHistory = () => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch (_) { return []; } };
function addToHistory(m) {
  let list = loadHistory().filter(h => h.matchId !== m.matchId);
  list.unshift({ matchId: m.matchId, mine: m.mine, opp: m.opp, side: m.side, roster: m.roster, startedAt: m.startedAt, endedAt: m.endedAt,
    state: { away: m.state.away, home: m.state.home, seed: m.state.seed, status: 'final' }, plays: m.plays, pitches: m.pitches });
  list = list.slice(0, HISTORY_MAX);
  while (list.length) { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); return; } catch (_) { list.pop(); } }
}
let V = null; // a past game being viewed
let setup = { mine: null, opp: null, side: 'home', speed: 'normal', lineup: null };

// ---------- the match ----------
const score = s => ({ away: s.away, home: s.home });
const iso = ms => new Date(ms).toISOString();
const userTeam = () => A?.mine, aiTeam = () => A?.opp;

// Vote clock: 10 s before the at-bat, 8 s for later votes, like live games. It only runs while the
// viewer is on the AI page with the tab visible; leaving, reloading or closing freezes the time left.
setInterval(() => { if (A?.round?.closesAt) { A.round.remainingMs = Math.max(0, A.round.closesAt - Date.now()); save(); } }, 1000);
function pauseRound() {
  if (A?.round?.closesAt) { A.round.remainingMs = Math.max(0, A.round.closesAt - Date.now()); A.round.closesAt = null; save(); }
}
function resumeRound() {
  if (A?.round && !A.round.closesAt) A.round.closesAt = Date.now() + (A.round.remainingMs ?? A.round.seconds * 1000);
}
const away = () => (typeof page !== 'undefined' && page !== 'ai') || document.hidden;

function voteView() {
  if (!A?.round) return null;
  const r = A.round, role = r.offenseTeamId === A.mine ? 'offense' : 'defense', list = role === 'offense' ? r.ballot.offenseChoices : r.ballot.defenseChoices;
  return {
    round: { status: 'open', closes_at: iso(r.closesAt || Date.now() + (r.remainingMs ?? 0)), pa_no: r.paNo, phase: r.phase, offense_team_id: r.offenseTeamId, defense_team_id: r.defenseTeamId,
      state_snapshot: { phase: r.phase, count: r.ballot.count, inning: r.inning, half: r.half, outs: r.outs, base: r.base, score: r.score, batter: r.batter, ballot: r.ballot } },
    role, teamId: A.mine, remainingMs: r.closesAt ? Math.max(0, r.closesAt - Date.now()) : (r.remainingMs ?? 0), instantPick: true,
    choices: list.map((c, i) => ({ id: c.id, role, choice_key: c.id, label: c.label, is_default: i === 0 })),
    vote: null,
  };
}

// The viewer's default when time runs out: the first ballot choice (current tactic / normal play).
function defaultChoice(r) { const mineRole = r.offenseTeamId === A.mine ? 'offense' : 'defense'; return (mineRole === 'offense' ? r.ballot.offenseChoices : r.ballot.defenseChoices)[0].id; }

function vote(choiceId, timedOut = false) {
  if (!A?.round) return notify('지금은 고를 작전이 없습니다.');
  const r = A.round, mineRole = r.offenseTeamId === A.mine ? 'offense' : 'defense', aiRole = mineRole === 'offense' ? 'defense' : 'offense';
  const pick = { [mineRole]: choiceId, [aiRole]: r.aiPick };
  A.state = E.applyVote(A.state, A.roster, r.phase, pick);
  const label = (role, id) => (role === 'offense' ? r.ballot.offenseChoices : r.ballot.defenseChoices).find(c => c.id === id)?.label || id;
  A.lastCall = { phase: r.phase, mine: label(mineRole, choiceId), ai: label(aiRole, r.aiPick), aiRole };
  A.round = null; A.nextAt = Date.now() + 300;
  save(); publish();
  notify(`${timedOut ? '시간 종료 · 기본 작전으로 진행 · ' : ''}AI ${aiRole === 'offense' ? '공격' : '수비'} 작전: ${A.lastCall.ai}`);
}

function step() {
  // The match pauses while the viewer is on another page, on another tab, or has closed the site, and
  // goes on from the same pitch (and the same vote time left) when they come back.
  if (away()) { if (A && A.state.status !== 'final') { A.nextAt = Math.max(A.nextAt, Date.now() + 500); pauseRound(); } return; }
  if (A?.round) {
    resumeRound();
    if (Date.now() >= A.round.closesAt) vote(defaultChoice(A.round), true); // time is up: keep the current tactic
    return;
  }
  if (!A || A.state.status === 'final' || Date.now() < A.nextAt) return;
  const roster = A.roster, now = Date.now();
  const pv = E.pendingVote(A.state, roster);
  if (pv) {
    const s = A.state, aiRole = pv.ballot.offenseTeamId === A.opp ? 'offense' : 'defense';
    A.round = { phase: pv.phase, ballot: pv.ballot, paNo: s.pa?.no ?? s.plays.length + 1, offenseTeamId: pv.ballot.offenseTeamId, defenseTeamId: pv.ballot.defenseTeamId,
      inning: s.pa?.inning ?? s.inning, half: s.pa?.side ?? s.half, outs: s.outs, base: s.base, score: score(s), batter: E.upcomingBatter(s, roster),
      aiPick: aiChoice(s, roster, pv.ballot, aiRole, pv.phase),
      seconds: (s.pa?.phasesDone?.length || 0) > 0 ? E.FOLLOW_UP_VOTE_SECONDS : E.VOTE_SECONDS, closesAt: null };
    A.round.remainingMs = A.round.seconds * 1000; resumeRound();
    save(); publish(); return;
  }
  const { game, pitch, play } = E.stepPitch(A.state, roster), pa = play ? null : game.pa;
  const last = play ? play.pitches[play.pitches.length - 1] : pa.pitches[pa.pitches.length - 1];
  A.pitches.push({ pitch_no: game.pitchNo, pa_no: play ? play.paNo : pa.no, count_before: last.count, call: pitch.call, result: pitch.result, created_at: iso(now),
    payload: { ...pitch, batter: play ? play.batter : pa.batter, inning: play ? play.inn : pa.inning, side: play ? play.side : pa.side,
      tactics: play ? { offense: play.choice, alignment: play.defenseChoice, approach: play.approach } : { offense: pa.offense, alignment: pa.alignment, approach: pa.approach },
      voted: play ? (play.votes || []).length > 0 : Boolean(pa.tactical), countAfter: play ? null : `${pa.balls}-${pa.strikes}`, paResult: play ? play.kind : null,
      outs: game.outs, base: game.base, score: score(game) } });
  if (play) A.plays.push({ pa_no: play.paNo, outcome: play.kind, runs: play.runs, result_payload: play });
  game.plays = game.plays.map(p => ({ paNo: p.paNo, kind: p.kind }));
  A.state = game;
  const ms = SPEEDS[A.speed]?.ms ?? E.PITCH_INTERVAL_MS;
  A.nextAt = now + ms + (play ? Math.min(E.RESULT_DISPLAY_MS, ms) : 0);
  if (game.status === 'final') { A.endedAt = now; addToHistory(A); }
  save(); publish();
}

// The game screen (dist/server-game.js) shows the match while the AI page is open.
let shown = false, publishing = false;
function publish() {
  const G = window.FANBALL_SERVER_GAME; if (!G || publishing) return;
  publishing = true;
  try { publishNow(G); } finally { publishing = false; }
}
function publishNow(G) {
  const onPage = typeof page !== 'undefined' && page === 'ai';
  const M = A || V; // the live match, or a past one opened from the list
  if (!M || !onPage) { if (shown) { shown = false; restoreMatch(); G.setLocal(null); } return; }
  if (M.state.status === 'final' && shown && publishNow.finalShown === M.matchId) return; // nothing changes after the end
  if (M.state.status === 'final') publishNow.finalShown = M.matchId;
  applyMatch(M); shown = true;
  const final = M.state.status === 'final', mine = team(M.mine), opp = team(M.opp), past = !A;
  const won = final && ((M.side === 'home' ? M.state.home - M.state.away : M.state.away - M.state.home));
  const lc = !past && A.lastCall ? `<div class="banner ai-call"><b>직전 작전</b> · 나: ${safe(A.lastCall.mine)} · AI ${A.lastCall.aiRole === 'offense' ? '공격' : '수비'}: ${safe(A.lastCall.ai)}</div>` : '';
  G.setLocal({
    matchId: M.matchId, voteView, vote,
    screen: {
      eyebrow: 'AI MATCH', title: `${mine.short} vs AI ${opp.short}`, sub: `${M.side === 'home' ? '홈' : '원정'} · 이 브라우저에서만 진행 · 공식 경기와 같은 엔진`,
      right: past ? '' : `<div class="ai-head-actions"><select id="ai-speed" aria-label="투구 간격" onchange="aiSetSpeed(this.value)">${Object.entries(SPEEDS).map(([k, s]) => `<option value="${k}" ${A.speed === k ? 'selected' : ''}>${s.label}</option>`).join('')}</select><button class="btn btn-soft" onclick="aiQuit()">그만하기</button></div>`,
      banner: `<div class="banner ai-banner"><b>AI 대결</b> · ${mine.name}(나) vs ${opp.name}(AI). 작전 상황이 오면 실시간 경기처럼 10초(같은 타석의 두 번째 투표부터 8초) 안에 내 작전을 고르세요. AI는 기대 득점으로 작전을 정합니다. 다른 화면으로 나가거나 새로고침하면 그 자리에서 멈춥니다.</div>${lc}`,
      voteTitle: '작전 선택 · 타석 로그',
      resultTitle: final ? (won > 0 ? '승리!' : won < 0 ? '패배' : '무승부') : '경기 결과',
      resultSub: `${mine.name}(나) vs ${opp.name}(AI) · ${new Date(M.startedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · 이 브라우저에서만 진행한 경기`,
      resultActions: past
        ? '<div class="result-reset ai-result-actions"><button class="btn btn-primary" onclick="aiCloseHistory()">지난 경기 목록으로</button></div>'
        : '<div class="result-reset ai-result-actions"><button class="btn btn-primary" onclick="aiRematch()">같은 설정으로 다시 하기</button><button class="btn btn-soft" onclick="aiQuit()">새 대결 설정</button></div>',
    },
    game: { id: 'ai', status: final ? 'final' : 'running', score: score(M.state), started_at: iso(M.startedAt), ended_at: final ? iso(M.endedAt || Date.now()) : null,
      model_version: E.ENGINE_VERSION + ' · AI 대결', seed_hash: '(AI 대결)', revealed_seed: final ? M.state.seed : null, lineup_snapshot: { teams: M.roster } },
    plays: M.plays, pitches: M.pitches,
  });
}

// While the AI page shows the match, the shared screen reads MATCH; keep the viewer's fixture to restore.
let savedMatch = null;
function applyMatch(M) {
  if (MATCH.id === M.matchId) return;
  savedMatch = savedMatch || { id: MATCH.id, away: MATCH.away, home: MATCH.home, date: MATCH.date, venue: MATCH.venue };
  Object.assign(MATCH, { id: M.matchId, away: M.side === 'home' ? M.opp : M.mine, home: M.side === 'home' ? M.mine : M.opp, venue: team(M.side === 'home' ? M.mine : M.opp).venue || 'AI 구장' });
}
function restoreMatch() { if (savedMatch) Object.assign(MATCH, savedMatch); savedMatch = null; }

// ---------- setup page ----------
// A lineup here is { order: [player index × 9], slotPos: [position × 9] }: positions belong to batting slots.
function defaultLineup(teamId) { const t = team(teamId), order = t.defaultOrder.slice(0, 9); return { order, slotPos: order.map(i => t.defaultPos[i]) }; }
const fromAi = l => ({ order: l.order, slotPos: l.order.map(i => l.pos[i]) });
function setupLineup() {
  if (!setup.mine) setup.mine = team(db.favorite) ? db.favorite : TEAMS[0].id;
  if (!setup.opp || setup.opp === setup.mine) setup.opp = TEAMS.find(t => t.id !== setup.mine).id;
  if (!setup.lineup || setup.lineup.team !== setup.mine) setup.lineup = { team: setup.mine, ...defaultLineup(setup.mine) };
  return setup.lineup;
}
const POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH'];
const POS_KO = { C: '포수', '1B': '1루', '2B': '2루', '3B': '3루', SS: '유격', LF: '좌익', CF: '중견', RF: '우익', DH: '지명', IF: '내야', OF: '외야' };
const posNames = p => (p.positions?.length ? p.positions : [p.group]).map(x => POS_KO[x] || x).join('·');
const fmt = v => (v == null ? '–' : v.toFixed(3).replace(/^0/, ''));

function lineupRows(teamId, lineup, editable) {
  const t = team(teamId);
  return lineup.order.map((i, slot) => {
    const p = t.players[i], pos = lineup.slotPos[slot];
    const playerCell = editable
      ? `<select id="ai-slot-${slot}" aria-label="${slot + 1}번 타자" onchange="aiSlotPlayer(${slot},this.value)">${t.players.map((q, k) => `<option value="${k}" ${k === i ? 'selected' : ''}>${safe(q[0])} · ${posNames(q)}</option>`).join('')}</select>`
      : `<b>${safe(p[0])}</b>`;
    const posCell = editable
      ? `<select id="ai-pos-${slot}" aria-label="${slot + 1}번 수비 위치" onchange="aiSlotPos(${slot},this.value)">${POSITIONS.filter(x => x !== 'C' || isCatcher(p) || x === pos).map(x => `<option ${x === pos ? 'selected' : ''}>${x}</option>`).join('')}</select>`
      : pos;
    const note = editable ? misplacedNote(p, pos) : '';
    return `<tr><td class="slot-number">${slot + 1}번</td><td>${playerCell}${note ? `<small class="ai-offpos-note">${note}</small>` : ''}</td><td>${posCell}</td><td class="num">${fmt(p[6] ?? p[2])}</td><td class="num">${p[7] != null ? p[7].toFixed(3) : (p[3] + p[4]).toFixed(3)}</td></tr>`;
  }).join('');
}

function lineupProblem(teamId, lineup) {
  const t = team(teamId);
  if (new Set(lineup.order).size !== 9) return '같은 선수를 두 번 넣을 수 없습니다.';
  if (new Set(lineup.slotPos).size !== 9) return '수비 위치(C, 1B, 2B, 3B, SS, LF, CF, RF, DH)는 한 번씩만 정해 주세요.';
  if (!lineup.order.every(i => t.players[i])) return '선수 명단을 다시 확인해 주세요.';
  const c = lineup.slotPos.indexOf('C');
  if (c >= 0 && !isCatcher(t.players[lineup.order[c]])) return '포수 자리에는 포수만 넣을 수 있습니다.';
  return null;
}

function historyList() {
  const list = loadHistory();
  if (!list.length) return '';
  const rows = list.map(h => {
    const mine = team(h.mine), opp = team(h.opp), my = h.side === 'home' ? h.state.home : h.state.away, ai = h.side === 'home' ? h.state.away : h.state.home;
    const res = my > ai ? ['승', 'win'] : my < ai ? ['패', 'loss'] : ['무', 'draw'];
    const when = new Date(h.startedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `<button class="ai-history-row" type="button" onclick="aiOpenHistory('${h.matchId}')"><span class="ai-history-res ${res[1]}">${res[0]}</span><b>${safe(mine?.short || h.mine)} ${my} : ${ai} ${safe(opp?.short || h.opp)}</b><small>${when} · ${h.side === 'home' ? '홈' : '원정'} · 타석 ${h.plays.length}개</small><span class="ai-history-open">타격 로그 →</span></button>`;
  }).join('');
  return `<section class="card ai-history"><div class="card-head"><div><h2>지난 AI 경기</h2><small class="muted tiny">이 브라우저에 최근 ${HISTORY_MAX}경기까지 저장됩니다</small></div></div><div class="ai-history-list">${rows}</div></section>`;
}
window.aiOpenHistory = id => { if (A) return notify('진행 중인 AI 경기를 먼저 끝내 주세요.'); V = loadHistory().find(h => h.matchId === id) || null; publish(); rerender(); };
window.aiCloseHistory = () => { V = null; publish(); rerender(); };

// How the AI builds its lineup (dist/ai-manager.js aiLineupFor), shown under the AI lineup.
const AI_LINEUP_NOTE = `<div class="ai-basis tiny muted"><b>AI 라인업은 이렇게 짭니다</b><ol>
  <li><b>타자 평가</b>: 2026 시즌 1군 기록(타율·출루율·장타율)을 쓰되, 타석이 적은 선수는 리그 평균 100타석을 섞어 보정합니다. 출루율×1.8 + 장타율로 순위를 매깁니다.</li>
  <li><b>수비 위치</b>: 상위 12명이 순위대로 2026 시즌에 가장 많이 나선 포지션을 먼저 차지합니다. 남은 자리는 포수 → 유격수 → 중견수 → 2루수 → 3루수 → 우익수 → 좌익수 → 1루수 순으로, 그 자리를 2026년에 뛴 선수 중 가장 잘 치는 선수가 맡습니다. 포수는 포수만 맡고, 남은 최고 타자가 지명타자입니다.</li>
  <li><b>타순</b>: 상위 5명 중 출루율이 가장 높은 선수가 1번, 남은 상위 두 명이 2번·4번(장타율이 높은 쪽이 4번), 다음 두 명이 3번·5번, 나머지가 6~9번입니다.</li>
  <li><b>작전</b>: 매 투표마다 이 타자·투수·볼카운트·주자 상황에서 각 작전의 기대 득점(RE24)을 계산해, 공격은 가장 높은 것, 수비는 가장 낮은 것을 고릅니다. 차이가 거의 없으면 기본 작전을 고릅니다.</li>
</ol></div>`;

window.aiMatchPage = function () {
  if (A || V) { publish(); if (shown && window.FANBALL_SERVER_GAME?.active?.()) return window.FANBALL_SERVER_GAME.page(); }
  const lu = setupLineup(), mine = team(setup.mine), opp = team(setup.opp), ai = fromAi(aiLineup(setup.opp));
  const teamOptions = (sel, skip) => TEAMS.filter(t => t.id !== skip).map(t => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${t.name}</option>`).join('');
  const problem = lineupProblem(setup.mine, lu);
  return header('AI MATCH', 'AI 대결', '내 팀 라인업과 작전으로 AI 감독과 9이닝 승부')
    + `<section class="card ai-setup"><div class="card-head"><h2>대결 설정</h2><span class="tag">이 브라우저에서만 진행</span></div><div class="ai-setup-grid">
      <label>내 팀<select id="ai-mine" onchange="aiSetMine(this.value)">${teamOptions(setup.mine)}</select></label>
      <label>상대 팀 (AI)<span class="ai-opp-row"><select id="ai-opp" onchange="aiSetOpp(this.value)">${teamOptions(setup.opp, setup.mine)}</select><button class="btn btn-soft" type="button" onclick="aiRandomOpp()">무작위</button></span></label>
      <label>내 팀 위치<select id="ai-side" onchange="aiSetSide(this.value)"><option value="home" ${setup.side === 'home' ? 'selected' : ''}>홈 (말 공격)</option><option value="away" ${setup.side === 'away' ? 'selected' : ''}>원정 (초 공격)</option></select></label>
      <label>투구 간격<select id="ai-speed-setup" onchange="aiSetSetupSpeed(this.value)">${Object.entries(SPEEDS).map(([k, s]) => `<option value="${k}" ${setup.speed === k ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>
    </div><p class="tiny muted ai-note">수비 위치는 자유롭게 정할 수 있지만 포수는 포수만 맡습니다. 외야수를 내야에(또는 내야수를 외야에) 두면 상대의 실책 출루와 안타가 늘어납니다. AI 추천은 2026 시즌에 뛴 포지션으로만 짭니다.<br>선발투수: ${safe(mine.pitcher[0])}(나) vs ${safe(opp.pitcher[0])}(AI). 작전 상황은 공식 경기와 같습니다(타석 전, 득점권 2스트라이크·3볼). 내 작전은 10초(두 번째 투표부터 8초) 안에 고르고, 고르면 바로 진행됩니다. 나가거나 새로고침하면 경기가 그 자리에서 멈춥니다.</p></section>`
    + `<div class="ai-lineups"><section class="card"><div class="card-head"><div><h2>내 라인업 · ${mine.name}</h2><small class="muted tiny">타순별 선수와 수비 위치</small></div><span class="ai-head-btns"><button class="btn btn-soft" type="button" onclick="aiFillAi()">AI 추천으로 채우기</button><button class="btn btn-soft" type="button" onclick="aiFillDefault()">기본 라인업</button></span></div>
      <div class="table-scroll"><table class="table ai-table"><thead><tr><th>타순</th><th>선수</th><th>수비</th><th class="num">타율</th><th class="num">OPS</th></tr></thead><tbody>${lineupRows(setup.mine, lu, true)}</tbody></table></div></section>
      <section class="card"><div class="card-head"><div><h2>AI 라인업 · ${opp.name}</h2><small class="muted tiny">출루·장타 기록으로 AI가 짠 타순</small></div><span class="tag gold">AI</span></div>
      <div class="table-scroll"><table class="table ai-table"><thead><tr><th>타순</th><th>선수</th><th>수비</th><th class="num">타율</th><th class="num">OPS</th></tr></thead><tbody>${lineupRows(setup.opp, ai, false)}</tbody></table></div>${AI_LINEUP_NOTE}</section></div>`
    + `<div class="ai-start">${problem ? `<p class="ai-problem">${safe(problem)}</p>` : ''}<button class="btn btn-primary" ${problem ? 'disabled' : ''} onclick="aiStart()">경기 시작</button></div>`
    + historyList();
};

const rerender = () => { if (typeof render === 'function') render(); };
window.aiSetMine = id => { setup.mine = id; if (setup.opp === id) setup.opp = null; setup.lineup = null; rerender(); };
window.aiSetOpp = id => { setup.opp = id; rerender(); };
window.aiRandomOpp = () => { const pool = TEAMS.filter(t => t.id !== setup.mine); setup.opp = pool[Math.floor(Math.random() * pool.length)].id; rerender(); };
window.aiSetSide = v => { setup.side = v; rerender(); };
window.aiSetSetupSpeed = v => { setup.speed = v; };
// Picking a player already in the lineup swaps the two batting slots; picking a position already used
// swaps the two slots' positions, so the lineup always stays complete.
window.aiSlotPlayer = (slot, value) => { const lu = setupLineup(), t = team(setup.mine), i = Number(value), other = lu.order.indexOf(i);
  const catchesNow = s => lu.slotPos[s] === 'C';
  if (catchesNow(slot) && !isCatcher(t.players[i])) { notify('포수 자리에는 포수만 넣을 수 있습니다.'); return rerender(); }
  if (other >= 0 && catchesNow(other) && !isCatcher(t.players[lu.order[slot]])) { notify('포수 자리에는 포수만 넣을 수 있습니다.'); return rerender(); }
  if (other >= 0) lu.order[other] = lu.order[slot]; lu.order[slot] = i; rerender(); };
window.aiSlotPos = (slot, value) => { const lu = setupLineup(), t = team(setup.mine), other = lu.slotPos.indexOf(value);
  if (value === 'C' && !isCatcher(t.players[lu.order[slot]])) { notify('포수 자리에는 포수만 넣을 수 있습니다.'); return rerender(); }
  if (other >= 0 && lu.slotPos[slot] === 'C' && !isCatcher(t.players[lu.order[other]])) { notify('포수가 빠지면 포수 자리를 이어받을 선수가 없습니다. 다른 포수를 먼저 넣어 주세요.'); return rerender(); }
  if (other >= 0) lu.slotPos[other] = lu.slotPos[slot]; lu.slotPos[slot] = value; rerender(); };
window.aiFillAi = () => { setup.lineup = { team: setup.mine, ...fromAi(aiLineup(setup.mine)) }; rerender(); notify('AI 추천 라인업으로 채웠습니다.'); };
window.aiFillDefault = () => { setup.lineup = { team: setup.mine, ...defaultLineup(setup.mine) }; rerender(); };

window.aiStart = function () {
  const lu = setupLineup(), problem = lineupProblem(setup.mine, lu);
  if (problem) return notify(problem);
  if (window.FANBALL_SERVER_GAME?.isLocal?.() && !shown) return notify('관리자 데모 경기가 진행 중입니다. 데모를 지운 뒤 시작해 주세요.');
  const ai = aiLineup(setup.opp), mineT = team(setup.mine), oppT = team(setup.opp);
  const roster = {
    [setup.mine]: { players: mineT.players, pitcher: mineT.pitcher, order: lu.order.slice(), positions: Object.fromEntries(lu.order.map((i, s) => [mineT.players[i][0], lu.slotPos[s]])) },
    [setup.opp]: { players: oppT.players, pitcher: oppT.pitcher, order: ai.order.slice(), positions: Object.fromEntries(ai.order.map(i => [oppT.players[i][0], ai.pos[i]])) },
  };
  const awayId = setup.side === 'home' ? setup.opp : setup.mine, homeId = setup.side === 'home' ? setup.mine : setup.opp;
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  A = { matchId: `ai-${Date.now()}`, mine: setup.mine, opp: setup.opp, side: setup.side, speed: setup.speed, roster,
    state: E.createGame({ awayId, homeId, seed, roster }), pitches: [], plays: [], round: null, lastCall: null, startedAt: Date.now(), nextAt: Date.now() + 500 };
  save(); publish(); rerender(); notify(`${oppT.name} AI와의 경기를 시작합니다.`);
};
window.aiQuit = function () {
  if (A?.state?.status === 'final' && !loadHistory().some(h => h.matchId === A.matchId)) addToHistory(A);
  A = null; try { localStorage.removeItem(KEY); } catch (_) {}
  publish(); rerender();
};
window.aiRematch = function () {
  if (!A) return;
  Object.assign(setup, { mine: A.mine, opp: A.opp, side: A.side, speed: A.speed, lineup: { team: A.mine, order: A.roster[A.mine].order.slice(), slotPos: A.roster[A.mine].order.map(i => A.roster[A.mine].positions[team(A.mine).players[i][0]]) } });
  A = null; try { localStorage.removeItem(KEY); } catch (_) {}
  window.aiStart();
};
window.aiSetSpeed = v => { if (A && SPEEDS[v]) { A.speed = v; save(); } };

// Leaving the AI page hands the shared screen back to the viewer's fixture; coming back shows the match.
// Resume: remember the page across reloads; a match in progress brings the viewer back to it, and the
// menu marks it while they are elsewhere.
const LAST_PAGE = 'fanball-last-page';
function markNav() { const b = document.querySelector('#nav [data-page="ai"]'); if (b) b.classList.toggle('ai-live', Boolean(A && A.state.status !== 'final')); }
const baseGo = window.go;
window.go = function (p) {
  try { localStorage.setItem(LAST_PAGE, p); } catch (_) {}
  const leaving = page === 'ai' && p !== 'ai';
  page = p;
  if (leaving && shown) { shown = false; restoreMatch(); window.FANBALL_SERVER_GAME?.setLocal(null); }
  if (leaving) V = null;
  baseGo(p);
};
if (A && A.state.status !== 'final') {
  let last = null; try { last = localStorage.getItem(LAST_PAGE); } catch (_) {}
  if (last === 'ai' && page !== 'ai') window.go('ai');
  else if (page !== 'ai') setTimeout(() => notify('진행 중인 AI 경기가 있습니다. AI 대결 메뉴에서 이어서 할 수 있습니다.'), 800);
}
if (typeof page !== 'undefined' && page === 'ai') publish();
markNav();
// A round saved with a running clock (the page was closed mid-vote) resumes with the time it had left.
if (A?.round?.closesAt) { A.round.remainingMs = A.round.remainingMs ?? A.round.seconds * 1000; A.round.closesAt = null; }
window.addEventListener('pagehide', pauseRound);
document.addEventListener('visibilitychange', () => { if (document.hidden) pauseRound(); });
setInterval(() => {
  step(); markNav();
  const el = document.querySelector('#server-countdown');
  if (el && A?.round && page === 'ai') el.textContent = Math.ceil(Math.max(0, (A.round.closesAt ?? Date.now() + (A.round.remainingMs ?? 0)) - Date.now()) / 1000) + '초';
}, 100);
