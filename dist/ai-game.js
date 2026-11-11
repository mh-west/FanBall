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
   - The viewer's votes have no time limit: the game waits, then goes on as soon as a choice is made. */
import * as E from './engine/pitch-engine.js';
import { aiLineupFor, aiChoice } from './ai-manager.js';
const aiLineup = teamId => aiLineupFor(team(teamId));

const KEY = 'fanball-ai-game-v1';
const SPEEDS = { normal: { label: '보통 (2초)', ms: 2000 }, fast: { label: '빠르게 (1초)', ms: 1000 }, faster: { label: '아주 빠르게 (0.4초)', ms: 400 } };
let A = null; // the match in progress or finished
try { A = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { A = null; }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(A)); } catch (_) {} };
let setup = { mine: null, opp: null, side: 'home', speed: 'normal', lineup: null };

// ---------- the match ----------
const score = s => ({ away: s.away, home: s.home });
const iso = ms => new Date(ms).toISOString();
const userTeam = () => A?.mine, aiTeam = () => A?.opp;

function voteView() {
  if (!A?.round) return null;
  const r = A.round, role = r.offenseTeamId === A.mine ? 'offense' : 'defense', list = role === 'offense' ? r.ballot.offenseChoices : r.ballot.defenseChoices;
  return {
    round: { status: 'open', closes_at: iso(Date.now() + 3600e3), pa_no: r.paNo, phase: r.phase, offense_team_id: r.offenseTeamId, defense_team_id: r.defenseTeamId,
      state_snapshot: { phase: r.phase, count: r.ballot.count, inning: r.inning, half: r.half, outs: r.outs, base: r.base, score: r.score, batter: r.batter, ballot: r.ballot } },
    role, teamId: A.mine, remainingMs: 0, noTimer: true,
    choices: list.map((c, i) => ({ id: c.id, role, choice_key: c.id, label: c.label, is_default: i === 0 })),
    vote: null,
  };
}

function vote(choiceId) {
  if (!A?.round) return notify('지금은 고를 작전이 없습니다.');
  const r = A.round, mineRole = r.offenseTeamId === A.mine ? 'offense' : 'defense', aiRole = mineRole === 'offense' ? 'defense' : 'offense';
  const pick = { [mineRole]: choiceId, [aiRole]: r.aiPick };
  A.state = E.applyVote(A.state, A.roster, r.phase, pick);
  const label = (role, id) => (role === 'offense' ? r.ballot.offenseChoices : r.ballot.defenseChoices).find(c => c.id === id)?.label || id;
  A.lastCall = { phase: r.phase, mine: label(mineRole, choiceId), ai: label(aiRole, r.aiPick), aiRole };
  A.round = null; A.nextAt = Date.now() + 300;
  save(); publish();
  notify(`AI ${aiRole === 'offense' ? '공격' : '수비'} 작전: ${A.lastCall.ai}`);
}

function step() {
  if (!A || A.state.status === 'final' || A.round || Date.now() < A.nextAt) return;
  const roster = A.roster, now = Date.now();
  const pv = E.pendingVote(A.state, roster);
  if (pv) {
    const s = A.state, aiRole = pv.ballot.offenseTeamId === A.opp ? 'offense' : 'defense';
    A.round = { phase: pv.phase, ballot: pv.ballot, paNo: s.pa?.no ?? s.plays.length + 1, offenseTeamId: pv.ballot.offenseTeamId, defenseTeamId: pv.ballot.defenseTeamId,
      inning: s.pa?.inning ?? s.inning, half: s.pa?.side ?? s.half, outs: s.outs, base: s.base, score: score(s), batter: E.upcomingBatter(s, roster),
      aiPick: aiChoice(s, roster, pv.ballot, aiRole, pv.phase) };
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
  if (game.status === 'final') A.endedAt = now;
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
  if (!A || !onPage) { if (shown) { shown = false; restoreMatch(); G.setLocal(null); } return; }
  if (A.state.status === 'final' && shown && publishNow.finalShown === A.matchId) return; // nothing changes after the end
  if (A.state.status === 'final') publishNow.finalShown = A.matchId;
  applyMatch(); shown = true;
  const final = A.state.status === 'final', mine = team(A.mine), opp = team(A.opp);
  const won = final && ((A.side === 'home' ? A.state.home - A.state.away : A.state.away - A.state.home));
  const lc = A.lastCall ? `<div class="banner ai-call"><b>직전 작전</b> · 나: ${safe(A.lastCall.mine)} · AI ${A.lastCall.aiRole === 'offense' ? '공격' : '수비'}: ${safe(A.lastCall.ai)}</div>` : '';
  G.setLocal({
    matchId: A.matchId, voteView, vote,
    screen: {
      eyebrow: 'AI MATCH', title: `${mine.short} vs AI ${opp.short}`, sub: `${A.side === 'home' ? '홈' : '원정'} · 이 브라우저에서만 진행 · 공식 경기와 같은 엔진`,
      right: `<div class="ai-head-actions"><select id="ai-speed" aria-label="투구 간격" onchange="aiSetSpeed(this.value)">${Object.entries(SPEEDS).map(([k, s]) => `<option value="${k}" ${A.speed === k ? 'selected' : ''}>${s.label}</option>`).join('')}</select><button class="btn btn-soft" onclick="aiQuit()">그만하기</button></div>`,
      banner: `<div class="banner ai-banner"><b>AI 대결</b> · ${mine.name}(나) vs ${opp.name}(AI). 작전 상황이 오면 내 작전을 고르세요. 시간 제한은 없고, AI는 기대 득점으로 작전을 정합니다.</div>${lc}`,
      voteTitle: '작전 선택 · 타석 로그',
      resultTitle: final ? (won > 0 ? '승리!' : won < 0 ? '패배' : '무승부') : '경기 결과',
      resultSub: `${mine.name}(나) vs ${opp.name}(AI) · 이 브라우저에서만 진행한 경기`,
      resultActions: '<div class="result-reset ai-result-actions"><button class="btn btn-primary" onclick="aiRematch()">같은 설정으로 다시 하기</button><button class="btn btn-soft" onclick="aiQuit()">새 대결 설정</button></div>',
    },
    game: { id: 'ai', status: final ? 'final' : 'running', score: score(A.state), started_at: iso(A.startedAt), ended_at: final ? iso(A.endedAt || Date.now()) : null,
      model_version: E.ENGINE_VERSION + ' · AI 대결', seed_hash: '(AI 대결)', revealed_seed: final ? A.state.seed : null, lineup_snapshot: { teams: A.roster } },
    plays: A.plays, pitches: A.pitches,
  });
}

// While the AI page shows the match, the shared screen reads MATCH; keep the viewer's fixture to restore.
let savedMatch = null;
function applyMatch() {
  if (MATCH.id === A.matchId) return;
  savedMatch = savedMatch || { id: MATCH.id, away: MATCH.away, home: MATCH.home, date: MATCH.date, venue: MATCH.venue };
  Object.assign(MATCH, { id: A.matchId, away: A.side === 'home' ? A.opp : A.mine, home: A.side === 'home' ? A.mine : A.opp, venue: team(A.side === 'home' ? A.mine : A.opp).venue || 'AI 구장' });
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
const fmt = v => (v == null ? '–' : v.toFixed(3).replace(/^0/, ''));

function lineupRows(teamId, lineup, editable) {
  const t = team(teamId);
  return lineup.order.map((i, slot) => {
    const p = t.players[i], pos = lineup.slotPos[slot];
    const playerCell = editable
      ? `<select id="ai-slot-${slot}" aria-label="${slot + 1}번 타자" onchange="aiSlotPlayer(${slot},this.value)">${t.players.map((q, k) => `<option value="${k}" ${k === i ? 'selected' : ''}>${safe(q[0])} · ${q.groupName || q[1]}</option>`).join('')}</select>`
      : `<b>${safe(p[0])}</b>`;
    const posCell = editable
      ? `<select id="ai-pos-${slot}" aria-label="${slot + 1}번 수비 위치" onchange="aiSlotPos(${slot},this.value)">${POSITIONS.map(x => `<option ${x === pos ? 'selected' : ''}>${x}</option>`).join('')}</select>`
      : pos;
    return `<tr><td class="slot-number">${slot + 1}번</td><td>${playerCell}</td><td>${posCell}</td><td class="num">${fmt(p[6] ?? p[2])}</td><td class="num">${p[7] != null ? p[7].toFixed(3) : (p[3] + p[4]).toFixed(3)}</td></tr>`;
  }).join('');
}

function lineupProblem(teamId, lineup) {
  const t = team(teamId);
  if (new Set(lineup.order).size !== 9) return '같은 선수를 두 번 넣을 수 없습니다.';
  if (new Set(lineup.slotPos).size !== 9) return '수비 위치(C, 1B, 2B, 3B, SS, LF, CF, RF, DH)는 한 번씩만 정해 주세요.';
  if (!lineup.order.every(i => t.players[i])) return '선수 명단을 다시 확인해 주세요.';
  return null;
}

window.aiMatchPage = function () {
  if (A) { publish(); if (shown && window.FANBALL_SERVER_GAME?.active?.()) return window.FANBALL_SERVER_GAME.page(); }
  const lu = setupLineup(), mine = team(setup.mine), opp = team(setup.opp), ai = fromAi(aiLineup(setup.opp));
  const teamOptions = (sel, skip) => TEAMS.filter(t => t.id !== skip).map(t => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${t.name}</option>`).join('');
  const problem = lineupProblem(setup.mine, lu);
  return header('AI MATCH', 'AI 대결', '내 팀 라인업과 작전으로 AI 감독과 9이닝 승부')
    + `<section class="card ai-setup"><div class="card-head"><h2>대결 설정</h2><span class="tag">이 브라우저에서만 진행</span></div><div class="ai-setup-grid">
      <label>내 팀<select id="ai-mine" onchange="aiSetMine(this.value)">${teamOptions(setup.mine)}</select></label>
      <label>상대 팀 (AI)<span class="ai-opp-row"><select id="ai-opp" onchange="aiSetOpp(this.value)">${teamOptions(setup.opp, setup.mine)}</select><button class="btn btn-soft" type="button" onclick="aiRandomOpp()">무작위</button></span></label>
      <label>내 팀 위치<select id="ai-side" onchange="aiSetSide(this.value)"><option value="home" ${setup.side === 'home' ? 'selected' : ''}>홈 (말 공격)</option><option value="away" ${setup.side === 'away' ? 'selected' : ''}>원정 (초 공격)</option></select></label>
      <label>투구 간격<select id="ai-speed-setup" onchange="aiSetSetupSpeed(this.value)">${Object.entries(SPEEDS).map(([k, s]) => `<option value="${k}" ${setup.speed === k ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>
    </div><p class="tiny muted ai-note">선발투수: ${safe(mine.pitcher[0])}(나) vs ${safe(opp.pitcher[0])}(AI). 작전 상황은 공식 경기와 같습니다(타석 전, 득점권 2스트라이크·3볼). 내 작전은 시간 제한 없이 고르면 바로 진행됩니다.</p></section>`
    + `<div class="ai-lineups"><section class="card"><div class="card-head"><div><h2>내 라인업 · ${mine.name}</h2><small class="muted tiny">타순별 선수와 수비 위치</small></div><span class="ai-head-btns"><button class="btn btn-soft" type="button" onclick="aiFillAi()">AI 추천으로 채우기</button><button class="btn btn-soft" type="button" onclick="aiFillDefault()">기본 라인업</button></span></div>
      <div class="table-scroll"><table class="table ai-table"><thead><tr><th>타순</th><th>선수</th><th>수비</th><th class="num">타율</th><th class="num">OPS</th></tr></thead><tbody>${lineupRows(setup.mine, lu, true)}</tbody></table></div></section>
      <section class="card"><div class="card-head"><div><h2>AI 라인업 · ${opp.name}</h2><small class="muted tiny">출루·장타 기록으로 AI가 짠 타순</small></div><span class="tag gold">AI</span></div>
      <div class="table-scroll"><table class="table ai-table"><thead><tr><th>타순</th><th>선수</th><th>수비</th><th class="num">타율</th><th class="num">OPS</th></tr></thead><tbody>${lineupRows(setup.opp, ai, false)}</tbody></table></div></section></div>`
    + `<div class="ai-start">${problem ? `<p class="ai-problem">${safe(problem)}</p>` : ''}<button class="btn btn-primary" ${problem ? 'disabled' : ''} onclick="aiStart()">경기 시작</button></div>`;
};

const rerender = () => { if (typeof render === 'function') render(); };
window.aiSetMine = id => { setup.mine = id; if (setup.opp === id) setup.opp = null; setup.lineup = null; rerender(); };
window.aiSetOpp = id => { setup.opp = id; rerender(); };
window.aiRandomOpp = () => { const pool = TEAMS.filter(t => t.id !== setup.mine); setup.opp = pool[Math.floor(Math.random() * pool.length)].id; rerender(); };
window.aiSetSide = v => { setup.side = v; rerender(); };
window.aiSetSetupSpeed = v => { setup.speed = v; };
// Picking a player already in the lineup swaps the two batting slots; picking a position already used
// swaps the two slots' positions, so the lineup always stays complete.
window.aiSlotPlayer = (slot, value) => { const lu = setupLineup(), i = Number(value), other = lu.order.indexOf(i);
  if (other >= 0) lu.order[other] = lu.order[slot]; lu.order[slot] = i; rerender(); };
window.aiSlotPos = (slot, value) => { const lu = setupLineup(), other = lu.slotPos.indexOf(value);
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
const baseGo = window.go;
window.go = function (p) {
  const leaving = page === 'ai' && p !== 'ai';
  page = p;
  if (leaving && shown) { shown = false; restoreMatch(); window.FANBALL_SERVER_GAME?.setLocal(null); }
  baseGo(p);
};
if (typeof page !== 'undefined' && page === 'ai') publish();
setInterval(step, 100);
