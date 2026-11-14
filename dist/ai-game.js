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
import * as E from './engine/pitch-engine.js?v=12da6cf659';
import { aiLineupFor, aiChoice } from './ai-manager.js?v=78ff914d11';
// The AI opponent's own lineup: style picked in the setup card, 'platoon' matched against my starter's hand.
function oppLineup() {
  const style = setup.oppLineupStyle || 'ops';
  const hand = style === 'platoon' ? (pickedStarter(setup.mine, setup.myStarter)?.[6] || null) : null;
  return aiLineupFor(team(setup.opp), style, hand);
}
// "AI 추천" lineup styles for the viewer's own team (dist/ai-manager.js battingOrderFor); the AI's own team always uses 'ops'.
const LINEUP_STYLE_LABELS = { ops: 'OPS 중심', obp: '출루율 중심', platoon: '투수 맞춤', kbo: 'KBO 스타일' };
const LINEUP_STYLE_NOTE = `<p class="tiny muted ai-style-note"><b>OPS 중심</b> 출루율×1.8+장타율이 높은 선수가 중심 타선 · <b>출루율 중심</b> 출루율 높은 순서 그대로 · <b>투수 맞춤</b> 상대 선발과 반대 손 타자를 우대(스위치 타자는 항상 유리) · <b>KBO 스타일</b> 출루율 좋은 타자 1·2번, 장타력 좋은 타자 3~5번, 나머지는 평가 순</p>`;

const KEY = 'fanball-ai-game-v1';
const SPEEDS = { normal: { label: '보통 (2초)', ms: 2000 }, fast: { label: '빠르게 (1초)', ms: 1000 }, faster: { label: '아주 빠르게 (0.4초)', ms: 400 } };
let A = null; // the match in progress or finished
try { A = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { A = null; }
// Matches saved before engine 2.12: my own side is still mine to manage (no automatic pitching changes).
if (A?.state && !A.state.manual?.[A.side]) A.state.manual = { ...(A.state.manual || {}), [A.side]: true };
// Each save is stamped, so the newest copy wins between devices of the same account (dist/account-sync.js).
const save = () => { if (A) A.savedAt = Date.now(); try { localStorage.setItem(KEY, JSON.stringify(A)); } catch (_) {} window.FANBALL_SYNC?.push('ai_match', A || { cleared: true, savedAt: Date.now() }); };

// Finished AI games, newest first (this browser only). Each keeps its plays and pitches so the at-bat
// log and pitch odds can be opened again. Up to 10; older ones drop off, or sooner if storage is full.
const HISTORY_KEY = 'fanball-ai-history-v1', HISTORY_MAX = 10;
const loadHistory = () => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch (_) { return []; } };
function addToHistory(m) {
  let list = loadHistory().filter(h => h.matchId !== m.matchId);
  list.unshift({ matchId: m.matchId, mine: m.mine, opp: m.opp, side: m.side, roster: m.roster, startedAt: m.startedAt, endedAt: m.endedAt,
    state: { away: m.state.away, home: m.state.home, seed: m.state.seed, status: 'final' }, plays: m.plays, pitches: m.pitches });
  writeHistory(list);
}
function writeHistory(list) {
  list = list.slice(0, HISTORY_MAX);
  while (list.length) { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); break; } catch (_) { list.pop(); } }
  window.FANBALL_SYNC?.push('ai_history', list);
}
let V = null; // a past game being viewed
let setup = { mine: null, opp: null, side: 'home', speed: 'normal', lineup: null, myStarter: null, oppStarter: null, lineupStyle: 'ops', oppLineupStyle: 'ops' };

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

const speedScale = () => Math.min(1, (SPEEDS[A?.speed]?.ms ?? E.PITCH_INTERVAL_MS) / E.PITCH_INTERVAL_MS);
function vote(choiceId, timedOut = false) {
  if (!A?.round) return notify('지금은 고를 작전이 없습니다.');
  const r = A.round, mineRole = r.offenseTeamId === A.mine ? 'offense' : 'defense', aiRole = mineRole === 'offense' ? 'defense' : 'offense';
  const pick = { [mineRole]: choiceId, [aiRole]: r.aiPick };
  // Tactic score (score-1, docs/TACTIC_SCORE_DESIGN.md): my pick's expected value against the choices offered, and
  // where the vote happened; scored when the plate appearance ends. Not when time ran out (no vote, no points).
  let mark = null;
  if (!timedOut) {
    try { const vals = E.ballotValues(A.state, A.roster, r.phase), ev = vals[mineRole]?.[choiceId];
      if (ev != null) {
        const avg = mineRole === 'offense' ? vals.offenseAvg : vals.defenseAvg, roleValues = vals[mineRole] || {};
        const bestAdv = Math.max(0, ...Object.values(roleValues).map(value => mineRole === 'offense' ? value - avg : avg - value));
        mark = { phase: r.phase, paNo: r.paNo, role: mineRole, ev, avg, possibleDecision: Math.round(bestAdv * 40 * 100) / 100, at: { base: [...A.state.base], outs: A.state.outs } };
      }
    } catch (e) { /* no points for this vote */ }
  }
  A.state = E.applyVote(A.state, A.roster, r.phase, pick);
  const label = (role, id) => (role === 'offense' ? r.ballot.offenseChoices : r.ballot.defenseChoices).find(c => c.id === id)?.label || id;
  A.lastCall = { phase: r.phase, mine: label(mineRole, choiceId), ai: label(aiRole, r.aiPick), aiRole };
  if (mark) { mark.choice = label(mineRole, choiceId); A.scoreMarks = (A.scoreMarks || []).concat(mark); }
  A.round = null; A.nextAt = Date.now() + Math.max(300, Math.round(E.POST_VOTE_GAP_MS * speedScale()));
  save(); publish();
  notify(`${timedOut ? '시간 종료 · 기본 작전으로 진행 · ' : ''}AI ${aiRole === 'offense' ? '공격' : '수비'} 작전: ${A.lastCall.ai}`);
}

const choosingPitcher = () => Boolean(document.querySelector('#dist-modal .pitch-change-list'));
function step() {
  // The match pauses while the viewer is on another page, on another tab, or has closed the site, and
  // goes on from the same pitch (and the same vote time left) when they come back.
  // It also pauses while the pitching-change window is open (user request 2026-11-13), so the pick can take its time.
  if (away() || choosingPitcher()) { if (A && A.state.status !== 'final') { A.nextAt = Math.max(A.nextAt, Date.now() + 500); pauseRound(); } return; }
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
  // Pitch and intro timing follows the selected speed, but keep a finished PA readable at every speed.
  const ms = SPEEDS[A.speed]?.ms ?? E.PITCH_INTERVAL_MS, resultMs = play ? E.RESULT_DISPLAY_MS : 0;
  let upNext = play ? E.nextUp(A.state, game, roster) : null;
  if (upNext) upNext = { ...upNext, gapMs: Math.round(upNext.gapMs * speedScale()), showAfterMs: ms + resultMs };
  const last = play ? play.pitches[play.pitches.length - 1] : pa.pitches[pa.pitches.length - 1];
  A.pitches.push({ pitch_no: game.pitchNo, pa_no: play ? play.paNo : pa.no, count_before: last.count, call: pitch.call, result: pitch.result, created_at: iso(now),
    payload: { ...pitch, batter: play ? play.batter : pa.batter, inning: play ? play.inn : pa.inning, side: play ? play.side : pa.side,
      tactics: play ? { offense: play.choice, alignment: play.defenseChoice, approach: play.approach } : { offense: pa.offense, alignment: pa.alignment, approach: pa.approach },
      voted: play ? (play.votes || []).length > 0 : Boolean(pa.tactical), countAfter: play ? null : `${pa.balls}-${pa.strikes}`, paResult: play ? play.kind : null,
      outs: game.outs, base: game.base, score: score(game), next: upNext } });
  if (play) A.plays.push({ pa_no: play.paNo, outcome: play.kind, runs: play.runs, result_payload: play });
  if (play && A.scoreMarks?.length) { // my votes in this plate appearance get their points
    const got = A.scoreMarks.map(m => { const sc = E.voteScore(m.role, E.paValue(play, m.at), m.ev, m.avg);
      return { pa_no: m.paNo, phase: m.phase, role: m.role, choice: m.choice, applied: true, outcome: sc.outcome, decision: sc.decision, possible_decision: m.possibleDecision, points: sc.total, result_kind: play.kind, result_detail: play.detail }; });
    A.scores = (A.scores || []).concat(got); A.scoreMarks = [];
    const sum = got.reduce((a, x) => a + x.points, 0), o = got.reduce((a, x) => a + x.outcome, 0), d = got.reduce((a, x) => a + x.decision, 0);
    notify(`작전 점수 +${sum.toFixed(1)}점 · ${got[got.length - 1].choice} → ${play.detail || play.kind} · 결과 ${o.toFixed(1)} · 판단 ${d.toFixed(1)}`);
  }
  game.plays = game.plays.map(p => ({ paNo: p.paNo, kind: p.kind }));
  A.state = game;
  A.nextAt = now + ms + resultMs + (upNext?.gapMs || 0);
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
      // Team tactics and the next-half reservation sit right under the strike zone, where the viewer is looking
      // (user request 2026-11-13), not at the top of the page.
      plan: !past && !final ? aiPlanBox(M) + window.aiNextDefenseButton() : '',
      banner: `<div class="banner ai-banner"><b>AI 대결</b> · ${mine.name}(나) vs ${opp.name}(AI). 작전 상황이 오면 실시간 경기처럼 10초(같은 타석의 두 번째 투표부터 8초) 안에 내 작전을 고르세요. AI는 기대 득점으로 작전을 정합니다. 다른 화면으로 나가거나 새로고침하면 그 자리에서 멈춥니다.</div>${lc}`,
      voteTitle: '작전 선택 · 타석 로그',
      resultTitle: final ? (won > 0 ? '승리!' : won < 0 ? '패배' : '무승부') : '경기 결과',
      // My tactic score for this match (shown here only; AI matches never count for the ranking).
      scoreCard: final && window.tacticScoreCardHtml ? (() => { const rows = M.scores || [], total = rows.reduce((a, x) => a + x.points, 0), possible = rows.reduce((a, x) => a + Number(x.possible_decision || 0), 0), decisions = rows.reduce((a, x) => a + Number(x.decision || 0), 0);
        const efficiency = possible > 0 ? Math.min(100, decisions / possible * 100) : null;
        return window.tacticScoreCardHtml({ total, votes: rows.length, scored: rows.filter(x => x.points > 0).length, efficiency, rows, note: 'AI 대결 점수는 이 경기에서만 보여 주고 작전 랭킹에는 더하지 않아요.' }); })() : '',
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
      ? `<select id="ai-slot-${slot}" aria-label="${slot + 1}번 타자" onchange="aiSlotPlayer(${slot},this.value)">${t.players.map((q, k) => [q, k]).sort((a, b) => a[0][0].localeCompare(b[0][0], 'ko')).map(([q, k]) => `<option value="${k}" ${k === i ? 'selected' : ''}>${safe(q[0])} · ${posNames(q)}</option>`).join('')}</select>`
      : `<b>${safe(p[0])}</b>`;
    const posCell = editable
      ? `<select id="ai-pos-${slot}" aria-label="${slot + 1}번 수비 위치" onchange="aiSlotPos(${slot},this.value)">${POSITIONS.filter(x => x !== 'C' || isCatcher(p) || x === pos).map(x => `<option ${x === pos ? 'selected' : ''}>${x}</option>`).join('')}</select>`
      : pos;
    const note = editable ? misplacedNote(p, pos) : '';
    return `<tr><td class="slot-number">${slot + 1}번</td><td>${playerCell}${note ? `<small class="ai-offpos-note">${note}</small>` : ''}</td><td>${posCell}</td><td class="num bat-side" title="${{ R: '우타', L: '좌타', S: '양타' }[p[12]] || '타석 정보 없음'}">${{ R: 'R', L: 'L', S: 'S' }[p[12]] || '-'}</td><td class="num">${fmt(p[6] ?? p[2])}</td><td class="num">${p[7] != null ? p[7].toFixed(3) : (p[3] + p[4]).toFixed(3)}</td></tr>`;
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
  return `<section class="card ai-history"><div class="card-head"><div><h2>지난 AI 경기</h2><small class="muted tiny">${window.FANBALL_AUTH_USER?.() ? '계정' : '이 브라우저'}에 최근 ${HISTORY_MAX}경기까지 저장됩니다</small></div></div><div class="ai-history-list">${rows}</div></section>`;
}
window.aiOpenHistory = id => { if (A) return notify('진행 중인 AI 경기를 먼저 끝내 주세요.'); V = loadHistory().find(h => h.matchId === id) || null; publish(); rerender(); };
window.aiCloseHistory = () => { V = null; publish(); rerender(); };

// How the AI builds its lineup (dist/ai-manager.js aiLineupFor), shown under the AI lineup.
const AI_LINEUP_NOTE = `<div class="ai-basis tiny muted"><b>AI 라인업은 이렇게 짭니다</b><ol>
  <li><b>타자 평가</b>: 2026 시즌 1군 기록(타율·출루율·장타율)을 쓰되, 타석이 적은 선수는 리그 평균 100타석을 섞어 보정합니다. 출루율×1.8 + 장타율로 순위를 매깁니다.</li>
  <li><b>수비 위치</b>: 상위 12명이 순위대로 2026 시즌에 가장 많이 나선 포지션을 먼저 차지합니다. 남은 자리는 포수 → 유격수 → 중견수 → 2루수 → 3루수 → 우익수 → 좌익수 → 1루수 순으로, 그 자리를 2026년에 뛴 선수 중 가장 잘 치는 선수가 맡습니다. 포수는 포수만 맡고, 남은 최고 타자가 지명타자입니다.</li>
  <li><b>타순</b>: 위에서 고른 라인업 스타일(OPS/출루율/투수 맞춤/KBO)을 따릅니다. 기본값 OPS 중심은 상위 5명 중 출루율이 가장 높은 선수가 1번, 남은 상위 두 명이 2번·4번(장타율이 높은 쪽이 4번), 다음 두 명이 3번·5번, 나머지가 6~9번입니다.</li>
  <li><b>작전</b>: 매 투표마다 이 타자·투수·볼카운트·주자 상황에서 각 작전의 기대 득점(RE24)을 계산해, 공격은 가장 높은 것, 수비는 가장 낮은 것을 고릅니다. 차이가 거의 없으면 기본 작전을 고릅니다.</li>
</ol></div>`;

window.aiMatchPage = function () {
  if (A || V) { publish(); if (shown && window.FANBALL_SERVER_GAME?.active?.()) return window.FANBALL_SERVER_GAME.page(); }
  const lu = setupLineup(), mine = team(setup.mine), opp = team(setup.opp), ai = fromAi(oppLineup());
  const teamOptions = (sel, skip) => TEAMS.filter(t => t.id !== skip).map(t => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${t.name}</option>`).join('');
  const problem = lineupProblem(setup.mine, lu);
  return header('AI MATCH', 'AI 대결', '내 팀 라인업과 작전으로 AI 감독과 9이닝 승부')
    + `<section class="card friend-entry"><div><b>친구랑 하고 싶다면?</b><small class="muted">방을 만들고 8자리 코드를 보내면 친구들과 편을 나눠 붙거나 관전할 수 있어요.</small></div><button class="btn btn-primary" type="button" onclick="go('friend')">친구와 대결</button></section>`
    + `<section class="card ai-setup"><div class="card-head"><h2>대결 설정</h2><span class="tag">${window.FANBALL_AUTH_USER?.() ? '계정에 저장 · 다른 기기에서 이어 하기' : '이 브라우저에서만 진행'}</span></div><div class="ai-setup-grid">
      <label>내 팀<select id="ai-mine" onchange="aiSetMine(this.value)">${teamOptions(setup.mine)}</select></label>
      <label>상대 팀 (AI)<span class="ai-opp-row"><select id="ai-opp" onchange="aiSetOpp(this.value)">${teamOptions(setup.opp, setup.mine)}</select><button class="btn btn-soft" type="button" onclick="aiRandomOpp()">무작위</button></span></label>
      <label>내 팀 위치<select id="ai-side" onchange="aiSetSide(this.value)"><option value="home" ${setup.side === 'home' ? 'selected' : ''}>홈 (말 공격)</option><option value="away" ${setup.side === 'away' ? 'selected' : ''}>원정 (초 공격)</option></select></label>
      <label>내 선발<select id="ai-my-starter" onchange="aiSetStarter('mine',this.value)">${starterOptions(setup.mine, setup.myStarter)}</select></label>
      <label>상대 선발 (AI)<select id="ai-opp-starter" onchange="aiSetStarter('opp',this.value)">${starterOptions(setup.opp, setup.oppStarter)}</select></label>
      <label>투구 간격<select id="ai-speed-setup" onchange="aiSetSetupSpeed(this.value)">${Object.entries(SPEEDS).map(([k, s]) => `<option value="${k}" ${setup.speed === k ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>
    </div><p class="tiny muted ai-note">수비 위치는 자유롭게 정할 수 있지만 포수는 포수만 맡습니다. 외야수를 내야에(또는 내야수를 외야에) 두면 상대의 실책 출루와 안타가 늘어납니다. AI 추천은 2026 시즌에 뛴 포지션으로만 짭니다.<br>선발투수: ${safe(pickedStarter(setup.mine, setup.myStarter)?.[0] || '')}(나) vs ${safe(pickedStarter(setup.opp, setup.oppStarter)?.[0] || '')}(AI). 작전 상황은 공식 경기와 같습니다(타석 전, 득점권 2스트라이크·3볼). 내 작전은 10초(두 번째 투표부터 8초) 안에 고르고, 고르면 바로 진행됩니다. 나가거나 새로고침하면 경기가 그 자리에서 멈춥니다.</p></section>`
    + `<div class="ai-lineups"><section class="card"><div class="card-head"><div><h2>내 라인업 · ${mine.name}</h2><small class="muted tiny">타순별 선수와 수비 위치</small></div><span class="ai-head-btns"><button class="btn btn-soft" type="button" onclick="aiFillAi()">AI 추천으로 채우기</button><button class="btn btn-soft" type="button" onclick="aiFillDefault()">기본 라인업</button></span></div>
      <div class="ai-style-pick"><label for="ai-lineup-style">라인업 스타일</label><select id="ai-lineup-style" onchange="aiSetLineupStyle(this.value)" title="AI 추천이 타순을 짜는 기준">${Object.entries(LINEUP_STYLE_LABELS).map(([k, l]) => `<option value="${k}" ${(setup.lineupStyle || 'ops') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="table-scroll"><table class="table ai-table"><thead><tr><th>타순</th><th>선수</th><th>수비</th><th class="num" title="우타 R · 좌타 L · 양타 S">타석</th><th class="num">타율</th><th class="num">OPS</th></tr></thead><tbody>${lineupRows(setup.mine, lu, true)}</tbody></table></div>${LINEUP_STYLE_NOTE}${aiSavedCard()}</section>
      <section class="card"><div class="card-head"><div><h2>AI 라인업 · ${opp.name}</h2><small class="muted tiny">AI가 짠 타순</small></div><span class="tag gold">AI</span></div>
      <div class="ai-style-pick"><label for="ai-opp-lineup-style">라인업 스타일</label><select id="ai-opp-lineup-style" onchange="aiSetOppLineupStyle(this.value)" title="AI 라인업이 타순을 짜는 기준">${Object.entries(LINEUP_STYLE_LABELS).map(([k, l]) => `<option value="${k}" ${(setup.oppLineupStyle || 'ops') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="table-scroll"><table class="table ai-table"><thead><tr><th>타순</th><th>선수</th><th>수비</th><th class="num" title="우타 R · 좌타 L · 양타 S">타석</th><th class="num">타율</th><th class="num">OPS</th></tr></thead><tbody>${lineupRows(setup.opp, ai, false)}</tbody></table></div>${AI_LINEUP_NOTE}</section></div>`
    + `${window.teamPlanChips ? `<section class="card team-plan"><div class="card-head"><div><h2>팀 전술</h2><small class="muted tiny">경기 중에도 언제든 바꿀 수 있어요</small></div></div>${window.teamPlanChips({ pick: setup.plan || {}, action: 'aiSetupPlan' })}</section>` : ''}<div class="ai-start">${problem ? `<p class="ai-problem">${safe(problem)}</p>` : ''}<button class="btn btn-primary" ${problem ? 'disabled' : ''} onclick="aiStart()">경기 시작</button></div>`
    + historyList();
};

const rerender = () => { if (typeof render === 'function') render(); };
window.aiSetMine = id => { setup.mine = id; setup.myStarter = null; if (setup.opp === id) { setup.opp = null; setup.oppStarter = null; } setup.lineup = null; rerender(); };
window.aiSetOpp = id => { setup.opp = id; setup.oppStarter = null; rerender(); };
window.aiRandomOpp = () => { const pool = TEAMS.filter(t => t.id !== setup.mine); setup.opp = pool[Math.floor(Math.random() * pool.length)].id; setup.oppStarter = null; rerender(); };
window.aiSetSide = v => { setup.side = v; rerender(); };
window.aiSetSetupSpeed = v => { setup.speed = v; };
// Starters: any of the team's five (dist/rotations.js); the default is the team's usual starter.
const pickedStarter = (teamId, name) => window.starterFor ? window.starterFor(teamId, name) : team(teamId).pitcher;
function starterOptions(teamId, chosen) {
  const t = team(teamId), cur = pickedStarter(teamId, chosen)?.[0];
  return (t?.rotation?.length ? t.rotation : [t.pitcher]).map(p => `<option value="${safe(p[0])}" ${p[0] === cur ? 'selected' : ''}>${safe(p[0])} · ${p[6] === 'L' ? '좌완' : '우완'}${p[7] === 'three' ? ' 스리쿼터' : p[7] === 'side' ? ' 사이드암' : p[7] === 'under' ? ' 언더핸드' : ''}${Number.isFinite(p[1]) ? ` · 피안타율 ${p[1].toFixed(3).replace(/^0/, '')}` : ''}</option>`).join('');
}
window.aiSetStarter = (who, name) => { if (who === 'mine') setup.myStarter = name; else setup.oppStarter = name; rerender(); };
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
window.aiSetLineupStyle = v => { setup.lineupStyle = v; rerender(); };
window.aiSetOppLineupStyle = v => { setup.oppLineupStyle = v; rerender(); };
window.aiFillAi = () => {
  const style = setup.lineupStyle || 'ops';
  const oppHand = style === 'platoon' ? (pickedStarter(setup.opp, setup.oppStarter)?.[6] || null) : null;
  setup.lineup = { team: setup.mine, ...fromAi(aiLineupFor(team(setup.mine), style, oppHand)) };
  rerender();
  notify(`${LINEUP_STYLE_LABELS[style]} 라인업으로 채웠습니다.${style === 'platoon' && !oppHand ? ' (상대 선발을 먼저 정하면 더 정확해집니다.)' : ''}`);
};
window.aiFillDefault = () => { setup.lineup = { team: setup.mine, ...defaultLineup(setup.mine) }; rerender(); };

// Saved lineups, shared with the lineup vote page (dist/enhancements.js: last submitted lineup + 3 slots,
// kept in this browser by player name and position), plus the lineup of the last AI match.
const snapshotMine = () => { const lu = setupLineup(), t = team(setup.mine); return { at: Date.now(), slots: lu.order.map((i, k) => ({ player: t.players[i][0], pos: lu.slotPos[k] })) }; };
const savedFor = () => { const all = savedLineups(), k = setup.mine; all[k] = all[k] || { slots: [null, null, null] }; all[k].slots = all[k].slots || [null, null, null]; return [all, all[k]]; };
window.aiLoadSaved = which => {
  const [, mine] = savedFor(), saved = liveSaved(which === 'recent' ? mine.recent : which === 'ai' ? mine.recentAi : mine.slots[which]);
  if (!saved) return;
  const t = team(setup.mine), order = saved.slots.map(x => t.players.findIndex(p => p[0] === x.player)), missing = saved.slots.filter((x, k) => order[k] < 0).map(x => x.player);
  if (missing.length) return notify(`지금 명단에 없는 선수가 있어 불러오지 못했습니다: ${missing.join(', ')}`);
  setup.lineup = { team: setup.mine, order, slotPos: saved.slots.map(x => x.pos) };
  rerender(); notify('저장한 라인업을 불러왔습니다.');
};
window.aiSaveSlot = n => {
  const [all, mine] = savedFor();
  const old = liveSaved(mine.slots[n]);
  if (old && !confirm(`'${slotName(old, n)}'에 있는 라인업을 지금 라인업으로 바꿀까요?`)) return;
  const name = askLineupName(old?.name || '', n); if (name === null) return;
  mine.slots[n] = { ...snapshotMine(), name }; writeSavedLineups(all); rerender(); notify(`지금 라인업을 '${slotName({ name }, n)}'에 저장했습니다.`);
};
window.aiRenameSlot = n => { const [all, mine] = savedFor(), x = liveSaved(mine.slots[n]); if (!x) return; const name = askLineupName(x.name || '', n); if (name === null) return; mine.slots[n] = { ...x, name, editedAt: Date.now() }; writeSavedLineups(all); rerender(); notify(`이름을 '${slotName({ name }, n)}'(으)로 바꿨습니다.`); };
window.aiDeleteSlot = n => { const [all, mine] = savedFor(); if (!liveSaved(mine.slots[n]) || !confirm(`'${slotName(mine.slots[n], n)}'을(를) 지울까요?`)) return; mine.slots[n] = { deleted: true, at: Date.now() }; writeSavedLineups(all); rerender(); };
function aiSavedCard() {
  if (typeof savedLineups !== 'function') return '';
  const [, mine] = savedFor(), when = at => new Date(at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const preview = x => x.slots.slice(0, 4).map(v => safe(v.player)).join(' · ') + ' …';
  const auto = [['ai', '최근 AI 대결', liveSaved(mine.recentAi)], ['recent', '최근 투표 제출', liveSaved(mine.recent)]].filter(r => r[2])
    .map(([k, label, x]) => `<div class="saved-row recent"><div><b>${label}</b><small>${when(x.at)} · ${preview(x)}</small></div><button class="btn btn-soft" type="button" onclick="aiLoadSaved('${k}')">불러오기</button></div>`).join('');
  const slots = [0, 1, 2].map(n => { const x = liveSaved(mine.slots[n]); return `<div class="saved-row"><div><b>${safe(slotName(x, n))}</b><small>${x ? `${when(x.at)} · ${preview(x)}` : '비어 있음'}</small></div><span class="saved-actions">${x ? `<button class="btn btn-soft" type="button" onclick="aiLoadSaved(${n})">불러오기</button><button class="btn btn-soft" type="button" onclick="aiRenameSlot(${n})">이름</button>` : ''}<button class="btn btn-soft" type="button" onclick="aiSaveSlot(${n})">${x ? '덮어쓰기' : '지금 라인업 저장'}</button>${x ? `<button class="btn btn-soft saved-del" type="button" aria-label="저장 ${n + 1} 지우기" onclick="aiDeleteSlot(${n})">✕</button>` : ''}</span></div>`; }).join('');
  return `<div class="saved-lineups ai-saved"><div class="ai-saved-head"><b>내 라인업 저장 · 불러오기</b><small class="muted tiny">라인업 투표 화면과 같은 저장 목록 · ${window.FANBALL_AUTH_USER?.() ? '로그인한 계정에 저장' : '이 브라우저에만 저장(로그인하면 계정에 저장)'}</small></div>${auto}${slots}</div>`;
}

window.aiStart = function () {
  const lu = setupLineup(), problem = lineupProblem(setup.mine, lu);
  if (problem) return notify(problem);
  if (window.FANBALL_SERVER_GAME?.isLocal?.() && !shown) return notify('관리자 데모 경기가 진행 중입니다. 데모를 지운 뒤 시작해 주세요.');
  if (typeof savedLineups === 'function') { const [all, mine] = savedFor(); mine.recentAi = snapshotMine(); writeSavedLineups(all); }
  const ai = oppLineup(), mineT = team(setup.mine), oppT = team(setup.opp);
  const roster = {
    [setup.mine]: { players: mineT.players, pitcher: pickedStarter(setup.mine, setup.myStarter), bullpen: (window.bullpenFor ? window.bullpenFor(setup.mine, pickedStarter(setup.mine, setup.myStarter)?.[0]) : mineT.bullpen) || [], order: lu.order.slice(), positions: Object.fromEntries(lu.order.map((i, s) => [mineT.players[i][0], lu.slotPos[s]])) },
    [setup.opp]: { players: oppT.players, pitcher: pickedStarter(setup.opp, setup.oppStarter), bullpen: (window.bullpenFor ? window.bullpenFor(setup.opp, pickedStarter(setup.opp, setup.oppStarter)?.[0]) : oppT.bullpen) || [], order: ai.order.slice(), positions: Object.fromEntries(ai.order.map(i => [oppT.players[i][0], ai.pos[i]])) },
  };
  const awayId = setup.side === 'home' ? setup.opp : setup.mine, homeId = setup.side === 'home' ? setup.mine : setup.opp;
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  A = { matchId: `ai-${Date.now()}`, mine: setup.mine, opp: setup.opp, side: setup.side, speed: setup.speed, roster,
    state: E.createGame({ awayId, homeId, seed, roster, manual: { [setup.side]: true }, plans: { [setup.side]: { ...(setup.plan || {}) } } }), pitches: [], plays: [], round: null, lastCall: null, startedAt: Date.now(), nextAt: Date.now() + 500 };
  save(); publish(); rerender(); notify(`${oppT.name} AI와의 경기를 시작합니다.`);
};
// Team-wide plans (engine 2.19): mine are picked in the setup and changed any time in the game; the AI plays 기본.
window.aiSetupPlan = (role, key) => { setup.plan = { ...(setup.plan || {}), [role]: key }; rerender(); };
window.aiPlan = (role, key) => { if (!A || A.state.status === 'final') return; A.state = E.setPlan(A.state, A.side, role, key); save(); publish(); notify(`${role === 'offense' ? '공격' : '수비'} 전술: ${window.FANBALL_PLAN_INFO?.[role]?.[key]?.[0] || key} — ${window.FANBALL_PLAN_INFO?.[role]?.[key]?.[1] || ''}`); };
const aiPlanBox = M => window.teamPlanBar ? window.teamPlanBar({ title: `팀 전술 · ${team(M.mine).short}`, pick: M.state.plans?.[M.side] || {}, action: 'aiPlan' }) : '';
window.aiQuit = function () {
  if (A?.state?.status === 'final' && !loadHistory().some(h => h.matchId === A.matchId)) addToHistory(A);
  A = null; try { localStorage.removeItem(KEY); } catch (_) {} window.FANBALL_SYNC?.push('ai_match', { cleared: true, savedAt: Date.now() });
  publish(); rerender();
};
window.aiRematch = function () {
  if (!A) return;
  Object.assign(setup, { plan: { ...(A.state.plans?.[A.side] || {}) }, mine: A.mine, opp: A.opp, side: A.side, speed: A.speed, myStarter: A.roster[A.mine]?.pitcher?.[0] || null, oppStarter: A.roster[A.opp]?.pitcher?.[0] || null, lineup: { team: A.mine, order: A.roster[A.mine].order.slice(), slotPos: A.roster[A.mine].order.map(i => A.roster[A.mine].positions[team(A.mine).players[i][0]]) } });
  A = null; try { localStorage.removeItem(KEY); } catch (_) {} window.FANBALL_SYNC?.push('ai_match', { cleared: true, savedAt: Date.now() });
  window.aiStart();
};
window.aiSetSpeed = v => { if (A && SPEEDS[v]) { A.speed = v; save(); } };

// ---------- my pitching changes ----------
// While my team is in the field I can bring in a reliever; he takes over from the next plate appearance.
const myFielding = () => A && A.state.status === 'running' && A.state.half !== A.side;
const SLOT_NAME = { over: '', three: '스리쿼터', side: '사이드암', under: '언더핸드' };
let pitcherChangeTarget = null;
function nextDefenseTarget() {
  const g=A.state,half=g.half==='away'?'home':'away';
  return {inning:g.inning+(g.half==='home'?1:0),half};
}
function aiChangeButton(targetMode='next_pa') {
  if (!A || A.state.status !== 'running') return '';
  const request=A.state.forcedChange?.[A.side],asked=typeof request==='number'?request:request?.index,pen=A.roster[A.mine]?.bullpen||[];
  if (asked != null) {
    const t=request?.target,label=t?.inning!=null?`${t.inning}회 ${t.half==='away'?'초':'말'}부터`:t?.paNo!=null?'다음 타석':'다음 타석';
    return `<button class="btn btn-soft ai-change on" onclick="aiCancelChange()">${label} ${safe(pen[asked]?.[0]||'')} 등판 · 취소</button>`;
  }
  const free = E.availableRelievers(A.state, A.roster, A.side);
  if (!free.length) return '';
  if (targetMode==='next_half'&&nextDefenseTarget().inning>E.MAX_INNINGS) return '';
  return `<button class="btn btn-soft ai-change" onclick="aiOpenChange('${targetMode}')">${targetMode==='next_half'?'다음 수비 이닝 투수 예약':'투수 교체'}</button>`;
}
// Shown beside the pitcher's name on the pitch board (server-game.js changeButton).
window.aiChangeButtonSmall = () => myFielding()?aiChangeButton().replace('btn btn-soft ai-change', 'pitch-change-btn ai-change'):'';
// While we bat: the reservation for our next half-inning, with our pitcher's pitch count so far (user request 2026-11-13).
window.aiNextDefenseButton = () => {
  if (myFielding()) return ''; const button=aiChangeButton('next_half'); if (!button) return '';
  const now = E.currentPitcher(A.state, A.roster, A.side), m = A.state.mound?.[A.side], pc = m?.pc?.[m.cur] || 0;
  return `<div class="ai-change-plan"><span class="change-load">우리 투수 <b>${safe(now?.[0] || '')}</b> ${pc}구</span>${button}</div>`;
};
window.aiOpenChange = (targetMode='next_pa') => {
  if (!A || A.state.status!=='running') return;
  const g=A.state;
  pitcherChangeTarget=targetMode==='next_half'
    ? nextDefenseTarget()
    : {paNo:(g.pa?.no??g.plays.length+1)+(g.pa?1:0)};
  const free = E.availableRelievers(A.state, A.roster, A.side), now = E.currentPitcher(A.state, A.roster, A.side), m = A.state.mound?.[A.side];
  const rows = free.map(r => `<button class="pitch-change-row" onclick="aiPickReliever(${r.index})"><b>${safe(r.name)}</b><span>${r.throws === 'L' ? '좌완' : '우완'}${SLOT_NAME[r.slot] ? ' ' + SLOT_NAME[r.slot] : ''}</span><small>피안타율 ${r.avg?.toFixed(3).replace(/^0/, '') ?? '–'} · 삼진 ${r.k != null ? (r.k * 100).toFixed(0) + '%' : '–'} · 볼넷 ${r.bb != null ? (r.bb * 100).toFixed(0) + '%' : '–'}</small><em class="${r.fit >= 2 ? 'good' : ''}">다음 3타자 중 같은 손 ${r.fit}명</em></button>`).join('');
  document.getElementById('dist-modal')?.remove();
  const targetText=pitcherChangeTarget.inning!=null?`${pitcherChangeTarget.inning}회 ${pitcherChangeTarget.half==='away'?'초':'말'} 첫 타석`:'현재 타석 다음 타석';
  // The batters he will face first, in order with their hands (the same ones the 같은 손 count uses).
  const oppSide = A.side === 'away' ? 'home' : 'away', bat = A.roster[A.opp], start = g.idx[oppSide];
  const nextHands = (window.fanballHandsLine || (() => ''))([0, 1, 2].map(k => { const slot = (start + k) % bat.order.length, p = bat.players[bat.order[slot]]; return { slot: slot + 1, name: p?.[0] || '', hand: p?.[12] || '' }; }));
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop" id="dist-modal" onclick="if(event.target===this)this.remove()"><section class="dist-modal"><button class="modal-close" onclick="document.getElementById('dist-modal').remove()">✕</button><small class="eyebrow">PITCHING CHANGE · 경기 잠깐 멈춤</small><h2>${targetMode==='next_half'?'다음 수비 이닝 투수 예약':'투수 교체'}</h2><p class="tiny muted">현재 ${safe(now?.[0] || '')} (${m?.pc?.[m.cur] || 0}구). 선택한 투수는 <b>${targetText}</b>부터 던집니다. 같은 손 타자를 상대하면 투수가 유리합니다.</p>${nextHands}<div class="pitch-change-list">${rows || '<p class="tiny muted">남은 구원투수가 없습니다.</p>'}</div></section></div>`);
};
window.aiPickReliever = index => {
  try { A.state = E.requestPitcherChange(A.state, A.roster, A.side, index, pitcherChangeTarget); } catch (e) { document.getElementById('dist-modal')?.remove();return notify(e.message==='that plate appearance has already started'||e.message==='that half-inning has already started'?'교체 적용 시점이 지나 예약이 취소됐습니다. 다음 기회에 다시 선택해 주세요.':e.message==='game has no next half-inning'?'이 경기에는 다음 수비 이닝이 없습니다.':'그 투수는 지금 올릴 수 없습니다.'); }
  document.getElementById('dist-modal')?.remove();
  const t=pitcherChangeTarget;pitcherChangeTarget=null;
  save(); publish(); rerender(); notify(t?.inning!=null?`${t.inning}회 ${t.half==='away'?'초':'말'}부터 ${A.roster[A.mine].bullpen[index][0]}이(가) 던집니다.`:`다음 타석부터 ${A.roster[A.mine].bullpen[index][0]}이(가) 던집니다.`);
};
window.aiCancelChange = () => { if (!A) return; A.state = E.cancelPitcherChange(A.state, A.side); save(); publish(); rerender(); notify('투수 교체를 취소했습니다.'); };

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
  // No automatic jump to the AI page when the site is opened again (user request 2026-11-12): the match
  // waits, paused, until the fan presses AI 대결.
  if (page !== 'ai') setTimeout(() => notify('진행 중인 AI 경기가 있습니다. AI 대결 메뉴를 누르면 이어서 할 수 있습니다.'), 800);
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

// Account sync (dist/account-sync.js): adopt a newer match or history from another device of the same account.
window.FANBALL_AI_SYNC = {
  current: () => A,
  adopt(remote) {
    if (!remote || !(remote.savedAt > (A?.savedAt || 0))) return false;
    if (remote.cleared) { if (A && A.state?.status !== 'final') { A = null; try { localStorage.removeItem(KEY); } catch (_) {} publish(); markNav(); rerender(); } return true; }
    if (!remote.state || !remote.roster) return false;
    A = remote; if (A?.state && !A.state.manual?.[A.side]) A.state.manual = { ...(A.state.manual || {}), [A.side]: true }; pauseRound();
    try { localStorage.setItem(KEY, JSON.stringify(A)); } catch (_) {}
    if (A?.round?.closesAt) { A.round.remainingMs = A.round.remainingMs ?? A.round.seconds * 1000; A.round.closesAt = null; }
    publish(); markNav(); rerender();
    if (A.state.status !== 'final' && page !== 'ai') notify('다른 기기에서 하던 AI 경기를 불러왔습니다. AI 대결에서 이어서 할 수 있습니다.');
    return true;
  },
  history: () => loadHistory(),
  setHistory(list) { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX))); } catch (_) {} if (page === 'ai' && !A) rerender(); },
};
window.dispatchEvent(new Event('fanball-ai-ready'));
