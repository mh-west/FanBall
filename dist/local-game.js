/* Developer demo game (?admin=1, admin accounts only) on the same pitch-by-pitch engine as the
   server (dist/engine is a copy of supabase/functions/_shared). It runs in this browser only and is
   shown with the server game screen (dist/server-game.js), so the demo follows the same rules:
   a pitch every 2 seconds, votes before the at-bat (10 s) and at two strikes / three balls with a
   runner in scoring position (8 s). Nothing here is saved to the server. */
import * as E from './engine/pitch-engine.js?v=4006d49bf8';

const KEY = 'fanball-local-game-v2';
let L = null;
try { L = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { L = null; }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(L)); } catch (_) {} };
const score = s => ({ away: s.away, home: s.home });
const iso = ms => new Date(ms).toISOString();

function myRole() {
  if (!L?.round) return null;
  // Event match: the fan's side key ('<team>@away' or '<team>'), chosen on the lineup page.
  const side = window.FANBALL_REMOTE_VOTING?.mySide?.(), fav = side ? sideKey(MATCH.away, MATCH.home, side) : typeof db !== 'undefined' ? db.favorite : null;
  return fav === L.round.offenseTeamId ? 'offense' : fav === L.round.defenseTeamId ? 'defense' : null;
}

function voteView() {
  if (!L?.round) return null;
  const r = L.round, role = myRole(), list = role === 'offense' ? r.ballot.offenseChoices : role === 'defense' ? r.ballot.defenseChoices : [];
  return {
    round: { status: 'open', closes_at: iso(r.closesAt), pa_no: r.paNo, phase: r.phase, offense_team_id: r.offenseTeamId, defense_team_id: r.defenseTeamId,
      state_snapshot: { phase: r.phase, count: r.ballot.count, inning: r.inning, half: r.half, outs: r.outs, base: r.base, score: r.score, batter: r.batter, ballot: r.ballot } },
    role, teamId: typeof db !== 'undefined' ? db.favorite : null, remainingMs: Math.max(0, r.closesAt - Date.now()),
    choices: list.map((c, i) => ({ id: c.id, role, choice_key: c.id, label: c.label, is_default: i === 0 })),
    vote: r.myVote ? { choice_id: r.myVote } : null,
  };
}

function publish() {
  if (!window.FANBALL_SERVER_GAME) return;
  if (!L) { window.FANBALL_SERVER_GAME.setLocal(null); return; }
  const final = L.state.status === 'final';
  window.FANBALL_SERVER_GAME.setLocal({
    matchId: L.matchId, voteView, vote,
    screen: {
      eyebrow: 'GAME CENTER · DEMO', title: '개발용 데모 경기', sub: '관리자 전용 · 이 브라우저에서만 진행 · 서버에 저장되지 않음',
      right: final ? '' : '<button class="btn btn-danger" onclick="stopLocalDemo()">그만하기</button>',
      banner: '<div class="banner admin-banner"><b>개발용 데모 경기</b> · 이 브라우저에서만 진행되며 서버에 저장되지 않습니다. 규칙과 엔진은 서버 경기와 같습니다. 위의 "그만하기" 버튼으로 언제든 끝낼 수 있습니다.</div>',
      resultTitle: '데모 경기 결과', resultSub: '개발용 데모 · 이 브라우저에서만 진행한 경기',
      resultActions: '<div class="result-reset"><button class="btn btn-soft" onclick="stopLocalDemo(true)">데모 경기 지우기</button></div>',
    },
    game: { id: 'local', status: final ? 'final' : 'running', score: score(L.state), started_at: iso(L.startedAt), ended_at: final ? iso(L.endedAt || Date.now()) : null,
      model_version: E.ENGINE_VERSION + ' · 이 브라우저 전용 데모', seed_hash: '(로컬 데모)', revealed_seed: final ? L.state.seed : null, lineup_snapshot: { teams: L.roster } },
    plays: L.plays, pitches: L.pitches,
  });
}

function vote(choiceId) {
  if (!L?.round) return notify('지금은 투표가 없습니다.');
  L.round.myVote = choiceId; save(); publish(); notify('작전을 골랐습니다. 마감 전까지 바꿀 수 있습니다.');
}

function step() {
  if (!L || L.state.status === 'final' || Date.now() < L.nextAt) return;
  const roster = L.roster, now = Date.now();
  if (L.round) {
    if (now < L.round.closesAt) return;
    const role = myRole(), pick = { offense: L.round.ballot.offenseChoices[0].id, defense: L.round.ballot.defenseChoices[0].id };
    if (role && L.round.myVote) pick[role] = L.round.myVote;
    L.state = E.applyVote(L.state, roster, L.round.phase, pick);
    L.round = null; L.nextAt = now + E.POST_VOTE_GAP_MS;
  } else {
    const pv = E.pendingVote(L.state, roster);
    if (pv) {
      const s = L.state, seconds = (s.pa?.phasesDone?.length || 0) > 0 ? E.FOLLOW_UP_VOTE_SECONDS : E.VOTE_SECONDS;
      L.round = { phase: pv.phase, ballot: pv.ballot, paNo: s.pa?.no ?? s.plays.length + 1, offenseTeamId: pv.ballot.offenseTeamId, defenseTeamId: pv.ballot.defenseTeamId,
        inning: s.pa?.inning ?? s.inning, half: s.pa?.side ?? s.half, outs: s.outs, base: s.base, score: score(s), batter: E.upcomingBatter(s, roster),
        closesAt: now + seconds * 1000, myVote: null };
      L.nextAt = L.round.closesAt;
    } else {
      const { game, pitch, play } = E.stepPitch(L.state, roster), pa = play ? null : game.pa;
      let upNext = play ? E.nextUp(L.state, game, roster) : null;
      if (upNext) upNext = { ...upNext, showAfterMs: E.PITCH_INTERVAL_MS + E.RESULT_DISPLAY_MS };
      const last = play ? play.pitches[play.pitches.length - 1] : pa.pitches[pa.pitches.length - 1];
      L.pitches.push({ pitch_no: game.pitchNo, pa_no: play ? play.paNo : pa.no, count_before: last.count, call: pitch.call, result: pitch.result, created_at: iso(now),
        payload: { ...pitch, batter: play ? play.batter : pa.batter, inning: play ? play.inn : pa.inning, side: play ? play.side : pa.side,
          tactics: play ? { offense: play.choice, alignment: play.defenseChoice, approach: play.approach } : { offense: pa.offense, alignment: pa.alignment, approach: pa.approach },
          voted: play ? (play.votes || []).length > 0 : Boolean(pa.tactical), countAfter: play ? null : `${pa.balls}-${pa.strikes}`, paResult: play ? play.kind : null,
          outs: game.outs, base: game.base, score: score(game), next: upNext } });
      if (play) L.plays.push({ pa_no: play.paNo, outcome: play.kind, runs: play.runs, result_payload: play });
      // Keep the saved state small: the screen uses the pitch and play lists above.
      game.plays = game.plays.map(p => ({ paNo: p.paNo, kind: p.kind }));
      L.state = game;
      L.nextAt = now + E.PITCH_INTERVAL_MS + (play ? E.RESULT_DISPLAY_MS + (upNext?.gapMs || 0) : 0);
      if (game.status === 'final') L.endedAt = now;
    }
  }
  save(); publish();
}

window.FANBALL_LOCAL_GAME = { vote };

// The demo page's start and reset buttons now drive this engine (the old plate-appearance engine is retired).
window.startGame = function () {
  if (!ADMIN_MODE) return notify('개발 도구는 관리자 계정에서만 쓸 수 있습니다.');
  // A game booked on the server: start that game now (the orchestrator picks it up within seconds).
  const row = window.FANBALL_SERVER_GAME?.gameRow?.();
  if (row) {
    if (row.status === 'running') return notify('이 경기는 이미 서버에서 진행 중입니다.');
    if (row.status !== 'scheduled') return notify('이미 끝났거나 중단된 경기입니다. 경기 관리에서 새 경기를 예약해 주세요.');
    if (!confirm('예약된 서버 경기를 지금 바로 시작할까요? 지금까지 제출된 팬 라인업으로 대표 라인업이 정해집니다.')) return;
    window.FANBALL_SERVER_CLIENT.rpc('admin_start_fanball_game_now', { p_game_id: row.id }).then(async ({ error }) => {
      if (error) return notify('시작하지 못했습니다: ' + ({ 'admin only': '관리자 계정만 할 수 있습니다.', 'official games start on schedule': '실제 KBO 일정 경기는 예정 시각에 시작합니다.' }[error.message] || error.message));
      notify('서버 경기를 시작합니다. 몇 초 안에 첫 투구가 나옵니다.');
      for (let i = 0; i < 10; i++) { await new Promise(r => setTimeout(r, 1500)); await window.FANBALL_SERVER_GAME?.load?.(true); if (window.FANBALL_SERVER_GAME?.gameRow?.()?.status === 'running') break; }
      await window.FANBALL_REMOTE_VOTING?.refreshSchedule?.(true); render();
    });
    return;
  }
  if (L && L.matchId === MATCH.id && L.state.status !== 'final') return notify('데모 경기가 이미 진행 중입니다.');
  const roster = {};
  const awayKey = sideKey(MATCH.away, MATCH.home, 'away');
  for (const id of [awayKey, MATCH.home]) {
    const t = team(id), order = ln(id).order.slice();
    if (order.length !== 9) return notify(`${t.name} 라인업 9명을 먼저 정해 주세요.`);
    roster[id] = { players: t.players, pitcher: t.pitcher, bullpen: t.bullpen || [], order };
  }
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  L = { matchId: MATCH.id, roster, state: E.createGame({ awayId: awayKey, homeId: MATCH.home, seed, roster }), pitches: [], plays: [], round: null, startedAt: Date.now(), nextAt: Date.now() };
  if (typeof db !== 'undefined') { db.game = null; persist(); }
  save(); publish(); notify('개발용 데모 경기를 시작했습니다. 이 브라우저에서만 진행됩니다.');
};
// Stop (or, once finished, clear) the demo game from its own screen.
window.stopLocalDemo = function (finished) {
  if (!L) return;
  if (!finished && !confirm('진행 중인 데모 경기를 그만할까요? 이 경기 기록은 지워집니다.')) return;
  window.resetGame();
};
window.resetGame = function () {
  if (!ADMIN_MODE) return notify('개발 도구는 관리자 계정에서만 쓸 수 있습니다.');
  L = null; try { localStorage.removeItem(KEY); } catch (_) {}
  if (typeof db !== 'undefined') { db.game = null; persist(); }
  publish(); render(); notify('데모 경기를 지웠습니다.');
};

publish();
setInterval(step, 250);
