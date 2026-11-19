/* Tactic Arena: a copyright-safe, single-player version of FanBall's AI 대결 — fictional teams and
   players (dist/arena/roster.js, no real KBO data), same pitch-by-pitch engine (arena/engine is a copy
   of dist/engine), you call every tactic for your side and the AI calls the other side's; at the end you
   see your 작전 점수 (same formula as the main site: dist/tactic-score.js, docs/TACTIC_SCORE_DESIGN.md).
   Local-only (no accounts, no server) — a quick "can we show this without the KBO license problem" demo. */
import * as E from './engine/pitch-engine.js';
import { aiLineupFor, aiChoice } from './ai-manager.js';
import { newMatchup } from './roster.js';

const app = document.getElementById('app');
const safe = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt1 = v => (Math.round(Number(v || 0) * 10) / 10).toFixed(1);
const KO_PHASE = { pre_pa: '타석 전', two_strikes: '2스트라이크', three_balls: '3볼' };
const BASE_LABEL = b => b[0] && b[1] && b[2] ? '만루' : (b[0] || b[1] || b[2]) ? `${[b[0] && 1, b[1] && 2, b[2] && 3].filter(Boolean).join(',')}루` : '주자 없음';

let M = null; // { state, roster, myId, aiId, away, home, log:[], scores:[], scoreMarks:[], round:null, nextAt:0 }

function newGame() {
  const m = newMatchup();
  const luAway = aiLineupFor(m.away, 'ops'), luHome = aiLineupFor(m.home, 'ops');
  const roster = {
    [m.away.id]: { players: m.away.players, pitcher: m.away.pitcher, bullpen: m.away.bullpen, order: luAway.order, positions: Object.fromEntries(luAway.order.map(i => [m.away.players[i][0], luAway.pos[i]])) },
    [m.home.id]: { players: m.home.players, pitcher: m.home.pitcher, bullpen: m.home.bullpen, order: luHome.order, positions: Object.fromEntries(luHome.order.map(i => [m.home.players[i][0], luHome.pos[i]])) },
  };
  const state = E.createGame({ awayId: m.away.id, homeId: m.home.id, seed: m.seed, roster });
  M = { state, roster, away: m.away, home: m.home, myId: m.home.id, aiId: m.away.id, log: [], scores: [], scoreMarks: [], round: null, nextAt: 0 };
  render();
}

function teamOf(id) { return id === M.away.id ? M.away : M.home; }

function vote(choiceId) {
  if (!M.round) return;
  const r = M.round, mineRole = r.offenseTeamId === M.myId ? 'offense' : 'defense', aiRole = mineRole === 'offense' ? 'defense' : 'offense';
  const pick = { [mineRole]: choiceId, [aiRole]: r.aiPick };
  let mark = null;
  try {
    const vals = E.ballotValues(M.state, M.roster, r.phase), ev = vals[mineRole]?.[choiceId];
    if (ev != null) {
      const avg = mineRole === 'offense' ? vals.offenseAvg : vals.defenseAvg, roleValues = vals[mineRole] || {};
      const bestAdv = Math.max(0, ...Object.values(roleValues).map(v => mineRole === 'offense' ? v - avg : avg - v));
      mark = { phase: r.phase, paNo: r.paNo, role: mineRole, ev, avg, possibleDecision: Math.round(bestAdv * 40 * 100) / 100, at: { base: [...M.state.base], outs: M.state.outs } };
    }
  } catch (e) { /* no points for this vote */ }
  const label = (role, id) => (role === 'offense' ? r.ballot.offenseChoices : r.ballot.defenseChoices).find(c => c.id === id)?.label || id;
  if (mark) { mark.choice = label(mineRole, choiceId); M.scoreMarks.push(mark); }
  M.lastCall = { mine: label(mineRole, choiceId), ai: label(aiRole, r.aiPick), aiRole };
  M.state = E.applyVote(M.state, M.roster, r.phase, pick);
  M.round = null; M.nextAt = Date.now() + 400;
  render();
}

function step() {
  if (!M || M.state.status === 'final' || M.round || Date.now() < M.nextAt) return;
  const pv = E.pendingVote(M.state, M.roster);
  if (pv) {
    const aiRole = pv.ballot.offenseTeamId === M.aiId ? 'offense' : 'defense';
    M.round = { phase: pv.phase, ballot: pv.ballot, paNo: (M.state.pa?.no ?? M.state.plays.length + 1),
      aiPick: aiChoice(M.state, M.roster, pv.ballot, aiRole, pv.phase) };
    render(); return;
  }
  const { game, play } = E.stepPitch(M.state, M.roster);
  if (play) {
    M.log.unshift({ inn: play.inn, side: play.side, batter: play.batter, kind: play.kind, runs: play.runs, detail: play.detail, count: `${play.count}`, base: [...play.base], outs: play.outsAfter });
    M.log = M.log.slice(0, 30);
    if (M.scoreMarks.length) {
      const got = M.scoreMarks.map(m => { const sc = E.voteScore(m.role, E.paValue(play, m.at), m.ev, m.avg);
        return { pa_no: m.paNo, phase: m.phase, choice: m.choice, outcome: sc.outcome, decision: sc.decision, possible: m.possibleDecision, points: sc.total, detail: play.detail || play.kind };
      });
      M.scores = M.scores.concat(got); M.scoreMarks = [];
    }
  }
  M.state = game;
  M.nextAt = Date.now() + (play ? 900 : 550);
  if (game.status === 'final') M.endedAt = Date.now();
  render();
}

function oddsLine(c) {
  const o = c.odds; if (!o) return '';
  const parts = [];
  if (o.hit) parts.push(`안타 ${o.hit}%`); if (o.walk) parts.push(`볼넷 ${o.walk}%`); if (o.extraBase) parts.push(`장타 ${o.extraBase}%`);
  if (o.strikeout) parts.push(`삼진 ${o.strikeout}%`); if (o.sacrifice) parts.push(`희생 ${o.sacrifice}%`);
  return parts.length ? `<small>${parts.join(' · ')}</small>` : '';
}

function voteBox() {
  if (!M.round) return '';
  const r = M.round, mineRole = r.ballot.offenseTeamId === M.myId ? 'offense' : 'defense';
  const list = mineRole === 'offense' ? r.ballot.offenseChoices : r.ballot.defenseChoices;
  const g = M.state, base = g.base, mine = teamOf(M.myId), ai = teamOf(M.aiId);
  return `<section class="card vote-box">
    <div class="vote-head"><b>${KO_PHASE[r.phase]} · ${mineRole === 'offense' ? '공격' : '수비'} 작전을 고르세요</b>
    <small>${safe(mine.name)}(나) vs ${safe(ai.name)}(AI) · ${g.pa?.inning ?? g.inning}회 ${g.pa?.side === 'away' ? '초' : '말'} · ${g.outs}아웃 · ${BASE_LABEL(base)} · ${g.pa ? `${g.pa.balls}-${g.pa.strikes}` : '0-0'} · 타자 ${safe(E.upcomingBatter(g, M.roster))}</small></div>
    <div class="vote-options">${list.map(c => `<button type="button" onclick="window.ARENA.vote('${c.id}')"><b>${safe(c.label)}</b><span>${safe(c.detail || '')}</span>${oddsLine(c)}</button>`).join('')}</div>
  </section>`;
}

function scoreCard() {
  const rows = M.scores;
  if (!rows.length) return `<section class="card ts-card"><div class="card-head"><h2>내 작전 점수</h2></div><p class="tiny muted">아직 작전 투표가 없어요.</p></section>`;
  const total = rows.reduce((a, x) => a + x.points, 0), possible = rows.reduce((a, x) => a + Number(x.possible || 0), 0), decision = rows.reduce((a, x) => a + Number(x.decision || 0), 0);
  const efficiency = possible > 0 ? Math.min(100, decision / possible * 100) : null;
  const list = rows.slice().reverse().map(r => `<li><span class="ts-when">${r.pa_no}번째 타석 · ${KO_PHASE[r.phase]}</span><span class="ts-pick">${safe(r.choice)} → ${safe(r.detail)}</span><b class="${r.points > 0 ? 'plus' : ''}">+${fmt1(r.points)}</b><small>결과 ${fmt1(r.outcome)} · 판단 ${fmt1(r.decision)}</small></li>`).join('');
  return `<section class="card ts-card"><div class="card-head"><div><h2>내 작전 점수</h2><small class="muted tiny">투표 ${rows.length}번 · 누적 ${fmt1(total)}점</small></div><div class="ts-total">${fmt1(total / rows.length)}점 <small>평균</small>${efficiency != null ? `<span>판단 효율 ${fmt1(efficiency)}점</span>` : ''}</div></div><ul class="ts-list">${list}</ul></section>`;
}

function logLine(p) {
  const runsTxt = p.runs ? ` · ${p.runs}득점` : '';
  return `<li><span class="log-inn">${p.inn}회 ${p.side === 'away' ? '초' : '말'}</span><b>${safe(p.batter)}</b><span>${safe(p.detail || p.kind)}${runsTxt}</span><small>${p.outs}아웃 · ${BASE_LABEL(p.base)}</small></li>`;
}

function render() {
  if (!M) { app.innerHTML = `<div class="empty"><button class="btn btn-primary" onclick="window.ARENA.newGame()">새 대결 시작</button></div>`; return; }
  const g = M.state, final = g.status === 'final';
  const won = final && (g.home - g.away);
  const header = `<header class="ar-top"><b>IF THEN BASEBALL</b><span class="tiny muted">가상 팀 · 가상 선수 · 작전을 고르면(If) 결과를 봅니다(Then)</span></header>`;
  const score = `<section class="card ar-score"><div class="ar-score-row"><div class="ar-club ${M.away.id === M.myId ? 'mine' : ''}"><b>${safe(M.away.name)}</b><small>${M.away.id === M.myId ? '나' : 'AI'} · 원정</small></div><div class="ar-vs">${g.away} : ${g.home}</div><div class="ar-club right ${M.home.id === M.myId ? 'mine' : ''}"><b>${safe(M.home.name)}</b><small>${M.home.id === M.myId ? '나' : 'AI'} · 홈</small></div></div>
    <div class="ar-sit">${final ? '경기 종료' : `${g.inning}회 ${g.half === 'away' ? '초' : '말'} · ${g.outs}아웃 · ${BASE_LABEL(g.base)}`}</div></section>`;
  const resultBanner = final ? `<section class="card ar-result"><h2>${won > 0 ? '승리!' : won < 0 ? '패배' : '무승부'}</h2><p>${safe(M.home.name)} ${g.home} : ${g.away} ${safe(M.away.name)}</p><button class="btn btn-primary" onclick="window.ARENA.newGame()">새 대결</button></section>` : '';
  app.innerHTML = header + score + resultBanner + voteBox() + scoreCard()
    + `<section class="card ar-log"><div class="card-head"><h2>타석 기록</h2></div><ul class="log-list">${M.log.map(logLine).join('') || '<li class="empty-log">아직 없어요.</li>'}</ul></section>`;
}

window.ARENA = { vote, newGame };
setInterval(step, 250);
newGame();
