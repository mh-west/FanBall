/* If Then Baseball: a trimmed copy of dist/ai-game.js for arena/ — same pitch-by-pitch engine, same
   vote clock, same pitching-change feature, same screen (arena/server-game.js is a copy of
   dist/server-game.js). What's different from the real AI 대결:
   - Fictional teams (arena/roster.js), not Namu Wiki rosters — no lineup editor, no team picker: a
     fresh matchup starts itself with both lineups auto-built (dist/ai-manager.js aiLineupFor, 'ops').
     You always bat last (home); the AI is always the visiting team.
   - No accounts, no history, no persistence across reloads — a quick arcade match, not a saved game.
   - 작전 점수 (user request 2026-11-19): one number per pick, decided the moment you vote (your choice's
     expected runs vs the ballot's average, scaled), not after the at-bat resolves, and not clamped —
     a bad pick costs points, not just withholds them. No separate "판단 효율" metric. Starts at 0, no
     floor or ceiling, every pick just adds to (or subtracts from) the running total. */
import * as E from './engine/pitch-engine.js?v=6';
import { aiLineupFor, aiChoice } from './ai-manager.js?v=6';
import { newMatchup } from './roster.js?v=6';

const SPEEDS = { normal: { label: '보통 (2초)', ms: 2000 }, fast: { label: '빠르게 (1초)', ms: 1000 }, faster: { label: '아주 빠르게 (0.4초)', ms: 400 } };
let A = null; // the match in progress or finished
const save = () => {}; // no persistence (arena/: a fresh match every load)

// ---------- the match ----------
const score = s => ({ away: s.away, home: s.home });
const iso = ms => new Date(ms).toISOString();

// Vote clock: 10 s before the at-bat, 8 s for later votes, like live games. Only runs while the tab is visible.
setInterval(() => { if (A?.round?.closesAt) { A.round.remainingMs = Math.max(0, A.round.closesAt - Date.now()); } }, 1000);
function pauseRound() { if (A?.round?.closesAt) { A.round.remainingMs = Math.max(0, A.round.closesAt - Date.now()); A.round.closesAt = null; } }
function resumeRound() { if (A?.round && !A.round.closesAt) A.round.closesAt = Date.now() + (A.round.remainingMs ?? A.round.seconds * 1000); }
const away = () => document.hidden;

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
function defaultChoice(r) { const mineRole = r.offenseTeamId === A.mine ? 'offense' : 'defense'; return (mineRole === 'offense' ? r.ballot.offenseChoices : r.ballot.defenseChoices)[0].id; }

const skipOn = () => Boolean(window.FANBALL_SKIP_MODE?.());
const speedScale = () => Math.min(1, (SPEEDS[A?.speed]?.ms ?? E.PITCH_INTERVAL_MS) / E.PITCH_INTERVAL_MS);
const PHASE_KO = { pre_pa: '타석 전', two_strikes: '2스트라이크', three_balls: '3볼' };

function vote(choiceId, timedOut = false) {
  if (!A?.round) return notify('지금은 고를 작전이 없습니다.');
  const r = A.round, mineRole = r.offenseTeamId === A.mine ? 'offense' : 'defense', aiRole = mineRole === 'offense' ? 'defense' : 'offense';
  const pick = { [mineRole]: choiceId, [aiRole]: r.aiPick };
  // 작전 점수: decided right now, from my pick's expected runs against the average of what I was
  // offered — never from the random result that follows, and never floored at 0 (user request
  // 2026-11-19). Not scored when time ran out (no real pick, no points).
  let mark = null;
  if (!timedOut) {
    try {
      const vals = E.ballotValues(A.state, A.roster, r.phase), ev = vals[mineRole]?.[choiceId];
      if (ev != null) {
        const avg = mineRole === 'offense' ? vals.offenseAvg : vals.defenseAvg;
        const points = Math.round((mineRole === 'offense' ? ev - avg : avg - ev) * 400) / 10;
        mark = { phase: r.phase, paNo: r.paNo, points };
      }
    } catch (e) { /* no points for this vote */ }
  }
  const label = (role, id) => (role === 'offense' ? r.ballot.offenseChoices : r.ballot.defenseChoices).find(c => c.id === id)?.label || id;
  if (mark) { mark.choice = label(mineRole, choiceId); A.scoreMarks = (A.scoreMarks || []).concat(mark); }
  A.lastCall = { phase: r.phase, mine: label(mineRole, choiceId), ai: label(aiRole, r.aiPick), aiRole };
  A.state = E.applyVote(A.state, A.roster, r.phase, pick);
  A.round = null; A.nextAt = Date.now() + Math.max(300, Math.round(E.POST_VOTE_GAP_MS * speedScale()));
  save(); publish();
  notify(`${timedOut ? '시간 종료 · 기본 작전으로 진행 · ' : ''}AI ${aiRole === 'offense' ? '공격' : '수비'} 작전: ${A.lastCall.ai}`);
}

const choosingPitcher = () => Boolean(document.querySelector('#dist-modal .pitch-change-list'));
function step() {
  if (away() || choosingPitcher()) { if (A && A.state.status !== 'final') { A.nextAt = Math.max(A.nextAt, Date.now() + 500); pauseRound(); } return; }
  if (A?.round) {
    resumeRound();
    if (Date.now() >= A.round.closesAt) vote(defaultChoice(A.round), true);
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
  const paVoted = play ? (play.votes || []).length > 0 : Boolean(game.pa?.tactical);
  const fast = skipOn() && !paVoted;
  const ms = fast ? 120 : (SPEEDS[A.speed]?.ms ?? E.PITCH_INTERVAL_MS), resultMs = play ? (fast ? 150 : E.RESULT_DISPLAY_MS) : 0;
  let upNext = play ? E.nextUp(A.state, game, roster) : null;
  if (upNext) upNext = { ...upNext, gapMs: Math.round(upNext.gapMs * (fast ? 0.04 : speedScale())), showAfterMs: ms + resultMs };
  const last = play ? play.pitches[play.pitches.length - 1] : pa.pitches[pa.pitches.length - 1];
  A.pitches.push({ pitch_no: game.pitchNo, pa_no: play ? play.paNo : pa.no, count_before: last.count, call: pitch.call, result: pitch.result, created_at: iso(now),
    payload: { ...pitch, batter: play ? play.batter : pa.batter, inning: play ? play.inn : pa.inning, side: play ? play.side : pa.side,
      tactics: play ? { offense: play.choice, alignment: play.defenseChoice, approach: play.approach } : { offense: pa.offense, alignment: pa.alignment, approach: pa.approach },
      voted: play ? (play.votes || []).length > 0 : Boolean(pa.tactical), countAfter: play ? null : `${pa.balls}-${pa.strikes}`, paResult: play ? play.kind : null,
      outs: game.outs, base: game.base, score: score(game), next: upNext } });
  if (play) A.plays.push({ pa_no: play.paNo, outcome: play.kind, runs: play.runs, result_payload: play });
  if (play && A.scoreMarks?.length) { // my picks from this plate appearance now get their (already decided) points
    const got = A.scoreMarks.map(m => ({ pa_no: m.paNo, phase: m.phase, choice: m.choice, points: m.points, result_kind: play.kind, result_detail: play.detail }));
    A.scores = (A.scores || []).concat(got); A.scoreMarks = [];
    const sum = Math.round(got.reduce((a, x) => a + x.points, 0) * 10) / 10;
    notify(`작전 점수 ${sum >= 0 ? '+' : ''}${sum.toFixed(1)}점 · ${got[got.length - 1].choice} → ${play.detail || play.kind}`);
  }
  game.plays = game.plays.map(p => ({ paNo: p.paNo, kind: p.kind }));
  A.state = game;
  A.nextAt = now + ms + resultMs + (upNext?.gapMs || 0);
  if (game.status === 'final') A.endedAt = now;
  save(); publish();
}

// 작전 점수 card (user request 2026-11-19): one running total from 0, no cap either way, each pick's
// point value decided at vote time (not from the random outcome) and never floored at 0.
function scoreCardHtml(rows) {
  if (!rows.length) return `<section class="card tactic-score-card"><div class="card-head"><h2>내 작전 점수</h2></div><p class="tiny muted ts-empty">이 경기에서 작전을 고르지 않아 점수가 없어요.</p></section>`;
  const total = Math.round(rows.reduce((a, x) => a + x.points, 0) * 10) / 10;
  const cls = v => v > 0 ? 'plus' : v < 0 ? 'minus' : '';
  const list = rows.map(r => `<li><span class="ts-when">${r.pa_no}번째 타석 · ${PHASE_KO[r.phase] || ''}</span><span class="ts-pick">${safe(r.choice || '')} → ${safe(r.result_detail || r.result_kind || '')}</span><b class="${cls(r.points)}">${r.points >= 0 ? '+' : ''}${r.points.toFixed(1)}</b></li>`).join('');
  return `<section class="card tactic-score-card"><div class="card-head"><div><h2>내 작전 점수</h2><small class="muted tiny">0점에서 시작 · 상황마다 내 선택이 평균보다 나은 만큼 더하고, 못한 만큼 뺍니다</small></div><b class="ts-total ${cls(total)}">${total >= 0 ? '+' : ''}${total.toFixed(1)}점</b></div><ul class="ts-list">${list}</ul></section>`;
}

// The game screen (arena/server-game.js, a copy of dist/server-game.js) shows the match.
let shown = false, publishing = false;
function publish() { const G = window.FANBALL_SERVER_GAME; if (!G || publishing) return; publishing = true; try { publishNow(G); } finally { publishing = false; } }
function publishNow(G) {
  if (!A) { if (shown) { shown = false; restoreMatch(); G.setLocal(null); } return; }
  if (A.state.status === 'final' && shown && publishNow.finalShown === A.matchId) return;
  if (A.state.status === 'final') publishNow.finalShown = A.matchId;
  applyMatch(A); shown = true;
  const final = A.state.status === 'final', mine = team(A.mine), opp = team(A.opp);
  const won = final && (A.state.home - A.state.away);
  const lc = A.lastCall ? `<div class="banner ai-call"><b>직전 작전</b> · 나: ${safe(A.lastCall.mine)} · AI ${A.lastCall.aiRole === 'offense' ? '공격' : '수비'}: ${safe(A.lastCall.ai)}</div>` : '';
  G.setLocal({
    matchId: A.matchId, voteView, vote,
    screen: {
      eyebrow: 'IF THEN BASEBALL', title: `${mine.short} vs AI ${opp.short}`, sub: '홈 · 가상 팀 · 가상 선수 · 공식 사이트와 같은 엔진',
      right: `<div class="ai-head-actions"><select id="ai-speed" aria-label="투구 간격" onchange="aiSetSpeed(this.value)">${Object.entries(SPEEDS).map(([k, s]) => `<option value="${k}" ${A.speed === k ? 'selected' : ''}>${s.label}</option>`).join('')}</select><button class="btn btn-soft" onclick="aiQuit()">그만하기</button></div>`,
      plan: !final ? window.aiNextDefenseButton() : '',
      banner: `<div class="banner ai-banner"><b>If Then Baseball</b> · ${mine.name}(나) vs ${opp.name}(AI) · 가상 팀·가상 선수(실제 KBO와 무관). 작전 상황이 오면 10초(같은 타석 두 번째 투표부터 8초) 안에 작전을 고르세요. AI는 기대 득점으로 작전을 정합니다.</div>${lc}`,
      voteTitle: '작전 선택 · 타석 로그',
      resultTitle: final ? (won > 0 ? '승리!' : won < 0 ? '패배' : '무승부') : '경기 결과',
      scoreCard: final ? scoreCardHtml(A.scores || []) : '',
      resultSub: `${mine.name}(나) vs ${opp.name}(AI) · ${new Date(A.startedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
      resultActions: '<div class="result-reset ai-result-actions"><button class="btn btn-primary" onclick="aiRematch()">새 대결</button></div>',
    },
    game: { id: 'ai', status: final ? 'final' : 'running', score: score(A.state), started_at: iso(A.startedAt), ended_at: final ? iso(A.endedAt || Date.now()) : null,
      model_version: E.ENGINE_VERSION + ' · If Then Baseball', seed_hash: '(가상 경기)', revealed_seed: final ? A.state.seed : null, lineup_snapshot: { teams: A.roster } },
    plays: A.plays, pitches: A.pitches,
  });
}

let savedMatch = null;
function applyMatch(M) {
  if (MATCH.id === M.matchId) return;
  savedMatch = savedMatch || { id: MATCH.id, away: MATCH.away, home: MATCH.home, date: MATCH.date, venue: MATCH.venue };
  Object.assign(MATCH, { id: M.matchId, away: M.opp, home: M.mine, venue: team(M.mine).venue || '아레나 구장' });
}
function restoreMatch() { if (savedMatch) Object.assign(MATCH, savedMatch); savedMatch = null; }

// ---------- starting a match: fictional teams, no setup screen — a fresh matchup starts itself ----------
function registerTeam(t) { window.ARENA_TEAMS[t.id] = { id: t.id, name: t.name, short: t.short, venue: '아레나 구장', players: t.players, pitcher: t.pitcher, bullpen: t.bullpen }; }

window.aiStart = function () {
  const m = newMatchup();
  registerTeam(m.away); registerTeam(m.home);
  const luA = aiLineupFor(m.away, 'ops'), luH = aiLineupFor(m.home, 'ops');
  const roster = {
    [m.away.id]: { players: m.away.players, pitcher: m.away.pitcher, bullpen: m.away.bullpen, order: luA.order, positions: Object.fromEntries(luA.order.map(i => [m.away.players[i][0], luA.pos[i]])) },
    [m.home.id]: { players: m.home.players, pitcher: m.home.pitcher, bullpen: m.home.bullpen, order: luH.order, positions: Object.fromEntries(luH.order.map(i => [m.home.players[i][0], luH.pos[i]])) },
  };
  A = { matchId: `ai-${Date.now()}`, mine: m.home.id, opp: m.away.id, side: 'home', speed: 'normal', roster,
    state: E.createGame({ awayId: m.away.id, homeId: m.home.id, seed: m.seed, roster, manual: { home: true } }),
    pitches: [], plays: [], scores: [], scoreMarks: [], round: null, lastCall: null, startedAt: Date.now(), nextAt: Date.now() + 500 };
  save(); publish();
};
window.aiQuit = () => { A = null; publish(); };
window.aiRematch = () => window.aiStart();
window.aiSetSpeed = v => { if (A && SPEEDS[v]) A.speed = v; };

// ---------- my pitching changes (same as the main site's AI 대결) ----------
const myFielding = () => A && A.state.status === 'running' && A.state.half !== A.side;
const SLOT_NAME = { over: '', three: '스리쿼터', side: '사이드암', under: '언더핸드' };
let pitcherChangeTarget = null;
function nextDefenseTarget() { const g = A.state, half = g.half === 'away' ? 'home' : 'away'; return { inning: g.inning + (g.half === 'home' ? 1 : 0), half }; }
function aiChangeButton(targetMode = 'next_pa') {
  if (!A || A.state.status !== 'running') return '';
  const request = A.state.forcedChange?.[A.side], asked = typeof request === 'number' ? request : request?.index, pen = A.roster[A.mine]?.bullpen || [];
  if (asked != null) {
    const t = request?.target, label = t?.inning != null ? `${t.inning}회 ${t.half === 'away' ? '초' : '말'}부터` : '다음 타석';
    return `<button class="btn btn-soft ai-change on" onclick="aiCancelChange()">${label} ${safe(pen[asked]?.[0] || '')} 등판 · 취소</button>`;
  }
  const free = E.availableRelievers(A.state, A.roster, A.side);
  if (!free.length) return '';
  if (targetMode === 'next_half' && nextDefenseTarget().inning > E.MAX_INNINGS) return '';
  return `<button class="btn btn-soft ai-change" onclick="aiOpenChange('${targetMode}')">${targetMode === 'next_half' ? '다음 수비 이닝 투수 예약' : '투수 교체'}</button>`;
}
window.aiChangeButtonSmall = () => myFielding() ? aiChangeButton().replace('btn btn-soft ai-change', 'pitch-change-btn ai-change') : '';
window.aiNextDefenseButton = () => {
  if (myFielding()) return ''; const button = aiChangeButton('next_half'); if (!button) return '';
  const now = E.currentPitcher(A.state, A.roster, A.side), m = A.state.mound?.[A.side], pc = m?.pc?.[m.cur] || 0;
  return `<div class="ai-change-plan"><span class="change-load">우리 투수 <b>${safe(now?.[0] || '')}</b> ${pc}구</span>${button}</div>`;
};
window.aiOpenChange = (targetMode = 'next_pa') => {
  if (!A || A.state.status !== 'running') return;
  const g = A.state;
  pitcherChangeTarget = targetMode === 'next_half' ? nextDefenseTarget() : { paNo: (g.pa?.no ?? g.plays.length + 1) + (g.pa ? 1 : 0) };
  const free = E.availableRelievers(A.state, A.roster, A.side), now = E.currentPitcher(A.state, A.roster, A.side), m = A.state.mound?.[A.side];
  const rows = free.map(r => `<button class="pitch-change-row" onclick="aiPickReliever(${r.index})"><b>${safe(r.name)}</b><span>${r.throws === 'L' ? '좌완' : '우완'}${SLOT_NAME[r.slot] ? ' ' + SLOT_NAME[r.slot] : ''}</span><small>피안타율 ${r.avg?.toFixed(3).replace(/^0/, '') ?? '–'} · 삼진 ${r.k != null ? (r.k * 100).toFixed(0) + '%' : '–'} · 볼넷 ${r.bb != null ? (r.bb * 100).toFixed(0) + '%' : '–'}</small><em class="${r.fit >= 2 ? 'good' : ''}">다음 3타자 중 같은 손 ${r.fit}명</em></button>`).join('');
  document.getElementById('dist-modal')?.remove();
  const targetText = pitcherChangeTarget.inning != null ? `${pitcherChangeTarget.inning}회 ${pitcherChangeTarget.half === 'away' ? '초' : '말'} 첫 타석` : '현재 타석 다음 타석';
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop" id="dist-modal" onclick="if(event.target===this)this.remove()"><section class="dist-modal"><button class="modal-close" onclick="document.getElementById('dist-modal').remove()">✕</button><small class="eyebrow">PITCHING CHANGE · 경기 잠깐 멈춤</small><h2>${targetMode === 'next_half' ? '다음 수비 이닝 투수 예약' : '투수 교체'}</h2><p class="tiny muted">현재 ${safe(now?.[0] || '')} (${m?.pc?.[m.cur] || 0}구). 선택한 투수는 <b>${targetText}</b>부터 던집니다.</p><div class="pitch-change-list">${rows || '<p class="tiny muted">남은 구원투수가 없습니다.</p>'}</div></section></div>`);
};
window.aiPickReliever = index => {
  try { A.state = E.requestPitcherChange(A.state, A.roster, A.side, index, pitcherChangeTarget); } catch (e) { document.getElementById('dist-modal')?.remove(); return notify(e.message === 'that plate appearance has already started' || e.message === 'that half-inning has already started' ? '교체 적용 시점이 지나 예약이 취소됐습니다.' : e.message === 'game has no next half-inning' ? '이 경기에는 다음 수비 이닝이 없습니다.' : '그 투수는 지금 올릴 수 없습니다.'); }
  document.getElementById('dist-modal')?.remove();
  const t = pitcherChangeTarget; pitcherChangeTarget = null;
  save(); publish(); notify(t?.inning != null ? `${t.inning}회 ${t.half === 'away' ? '초' : '말'}부터 ${A.roster[A.mine].bullpen[index][0]}이(가) 던집니다.` : `다음 타석부터 ${A.roster[A.mine].bullpen[index][0]}이(가) 던집니다.`);
};
window.aiCancelChange = () => { if (!A) return; A.state = E.cancelPitcherChange(A.state, A.side); save(); publish(); notify('투수 교체를 취소했습니다.'); };

window.addEventListener('pagehide', pauseRound);
document.addEventListener('visibilitychange', () => { if (document.hidden) pauseRound(); });
setInterval(() => {
  step();
  const el = document.querySelector('#server-countdown');
  if (el && A?.round) el.textContent = Math.ceil(Math.max(0, (A.round.closesAt ?? Date.now() + (A.round.remainingMs ?? 0)) - Date.now()) / 1000) + '초';
}, 100);

window.aiStart();
render();
