// FanBall plate-appearance engine as pure functions, shared by the server orchestrator.
// Extracted from dist/app.js + dist/enhancements.js without changing any rule or random draw;
// tests/engine-parity.test.mjs checks that both produce identical games.
// No DOM, storage, or timers here: callers pass the game state and the roster snapshot in.

export const ENGINE_VERSION = 'fanball-engine-1';
export const PA_TRIALS = 100000;
export const MAX_INNINGS = 12;
export const PITCH_INTERVAL_MS = 2000;
export const RESULT_DISPLAY_MS = 2000;
export const NEXT_PA_DELAY_MS = 250;

const PITCH_TYPES = ['직구', '슬라이더', '커브', '체인지업', '포크'];
const DEFAULT_PITCH_SPEEDS = { '직구': [138, 148], '슬라이더': [124, 136], '커브': [108, 122], '체인지업': [120, 134], '포크': [125, 138] };
const FAVORABLE_OUTCOMES = new Set(['1B', '2B', '3B', 'HR', 'BB', 'HBP']);
const OUTCOME_LABELS = { '1B': '단타', '2B': '2루타', '3B': '3루타', HR: '홈런', BB: '볼넷', HBP: '사구', K: '삼진', OUT: '일반 아웃', GDP: '병살' };

export function hash(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }

export function rng(seed) {
  let x = seed >>> 0;
  return () => { x = (x + 0x6D2B79F5) | 0; let z = x; z = Math.imul(z ^ z >>> 15, z | 1); z ^= z + Math.imul(z ^ z >>> 7, z | 61); return ((z ^ z >>> 14) >>> 0) / 4294967296; };
}

const bounded = (value, low, high) => Math.max(low, Math.min(high, value));

// roster: { [teamId]: { players: [[name,pos,avg,obp,slg,hrRate],...], pitcher: [name,oppAvg,...,speeds], order: [playerIndex x9] } }
const teamOf = (roster, id) => roster[id];
const offenseId = g => (g.half === 'away' ? g.awayId : g.homeId);

export function createGame({ awayId, homeId, seed }) {
  return { awayId, homeId, seed: seed >>> 0, status: 'running', away: 0, home: 0, innings: [], plays: [], bat: {}, idx: { away: 0, home: 0 }, inning: 1, half: 'away', outs: 0, base: [null, null, null], tiebreak: null };
}

function nextBatter(g, roster, side) {
  const t = teamOf(roster, side === 'away' ? g.awayId : g.homeId);
  return t.players[t.order[g.idx[side]++ % t.order.length]];
}

function peekNextBatter(g, roster) {
  const side = g.half || 'away', t = teamOf(roster, side === 'away' ? g.awayId : g.homeId), index = g.idx?.[side] || 0;
  return t.players[t.order[index % t.order.length]];
}

export function plateOutcomeProbabilities(g, roster, p, tactic = 'normal', side = g.half || 'away', defense = 'standard') {
  const opponent = teamOf(roster, side === 'away' ? g.homeId : g.awayId), base = g.base || [null, null, null], outs = g.outs || 0;
  const hitRate = bounded(p[2] + .015 - (opponent.pitcher[1] - .25) * .22, .15, .38), walkRate = bounded(p[3] * .3, .035, .15), hrRate = bounded(p[5], .012, .075), otherHits = Math.max(0, bounded(hitRate, .12, .42) - hrRate);
  const prob = { '1B': otherHits * .70, '2B': otherHits * .27, '3B': otherHits * .02, HR: hrRate, BB: walkRate, HBP: .012, K: .21, OUT: 0, GDP: 0, SAC: 0, BUNT_FAIL: 0 };
  if (tactic === 'contact') { prob.K = Math.max(.02, prob.K - .05); prob['1B'] += .025; for (const k of ['2B', '3B', 'HR']) prob[k] *= .8; }
  if (tactic === 'aggressive') { prob.K += .04; prob.BB *= .7; prob['1B'] *= .95; for (const k of ['2B', '3B', 'HR']) prob[k] *= 1.2; }
  if ((defense === 'double_play' || defense === 'corners_in') && base[0] && outs < 2) prob['1B'] += .015;
  prob.OUT = Math.max(0, 1 - prob['1B'] - prob['2B'] - prob['3B'] - prob.HR - prob.BB - prob.HBP - prob.K);
  if (base[0] && outs < 2) { prob.GDP = prob.OUT * (defense === 'double_play' ? .18 : .10); prob.OUT -= prob.GDP; }
  return prob;
}

function drawFromDistribution(counts, random, total) {
  let draw = Math.floor(random() * total);
  for (const [kind, count] of Object.entries(counts)) { if (draw < count) return kind; draw -= count; }
  return 'OUT';
}

// One plate appearance. Mutates g (callers pass a clone). Mirrors window.playPA in dist/enhancements.js.
function playPA(g, roster, side, inn, offense, defense) {
  const random = rng(g.seed + g.plays.length * 919), p = nextBatter(g, roster, side);
  const base = g.base || [null, null, null], outs = g.outs || 0, scoreBefore = { away: g.away, home: g.home }, basesBefore = [...base];
  const counts = { '1B': 0, K: 0, BB: 0, GDP: 0, HR: 0, '2B': 0, '3B': 0, HBP: 0, OUT: 0, SAC: 0, BUNT_FAIL: 0 };
  let kind;
  if (offense === 'bunt' && base[0] && outs < 2) {
    const buntSuccess = defense === 'corners_in' ? .58 : .72;
    for (let n = 0; n < PA_TRIALS; n++) counts[random() < buntSuccess ? 'SAC' : 'BUNT_FAIL']++;
    kind = drawFromDistribution(counts, random, PA_TRIALS);
  } else {
    const prob = plateOutcomeProbabilities(g, roster, p, offense || 'normal', side, defense || 'standard');
    for (let n = 0; n < PA_TRIALS; n++) { const x = random(); let sum = 0, found = false; for (const outcome of Object.keys(counts)) { sum += prob[outcome] || 0; if (x < sum) { counts[outcome]++; found = true; break; } } if (!found) counts.OUT++; }
    kind = drawFromDistribution(counts, random, PA_TRIALS);
  }
  const mode = Object.keys(counts).reduce((a, b) => (counts[b] > counts[a] ? b : a), 'OUT');
  let runs = 0;
  if (kind === 'HR') { runs = 1 + base.filter(Boolean).length; g.base = [null, null, null]; }
  else if (kind === '3B') { runs = base.filter(Boolean).length; g.base = [null, null, p[0]]; }
  else if (kind === '2B') { runs = (base[1] ? 1 : 0) + (base[2] ? 1 : 0); g.base = [null, p[0], base[0]]; }
  else if (kind === '1B') { runs = base[2] ? 1 : 0; g.base = [p[0], base[0], base[1]]; }
  else if (kind === 'BB' || kind === 'HBP') { if (base[0]) { if (base[1]) { if (base[2]) runs++; base[2] = base[1]; } base[1] = base[0]; } base[0] = p[0]; g.base = base; }
  else if (kind === 'GDP') { g.outs = outs + 2; g.base = [null, base[1], base[2]]; }
  else if (kind === 'SAC') { runs = base[2] ? 1 : 0; g.base = [null, base[0], base[1]]; }
  if (['K', 'OUT', 'SAC', 'BUNT_FAIL'].includes(kind)) g.outs = (g.outs || outs) + 1; else if (kind !== 'GDP') g.outs = outs;
  const b = g.bat[p[0]] || (g.bat[p[0]] = { AB: 0, H: 0, '2B': 0, '3B': 0, HR: 0, BB: 0, HBP: 0, K: 0, GDP: 0, SH: 0, R: 0 });
  if (['OUT', 'K', 'GDP', 'BUNT_FAIL', '1B', '2B', '3B', 'HR'].includes(kind)) b.AB++;
  if (['1B', '2B', '3B', 'HR'].includes(kind)) b.H++;
  if (['2B', '3B', 'HR'].includes(kind)) b[kind] = (b[kind] || 0) + 1;
  if (kind === 'BB') b.BB++; if (kind === 'HBP') b.HBP++; if (kind === 'GDP') b.GDP++; if (kind === 'K') b.K++; if (kind === 'SAC') b.SH = (b.SH || 0) + 1; b.R += runs;
  g[side] += runs; const row = g.innings[inn - 1] || (g.innings[inn - 1] = { away: 0, home: 0 }); row[side] += runs;
  const record = { inn, side, batter: p[0], kind, runs, outs: g.outs || outs, outsBefore: outs, outsAfter: g.outs || outs, basesBefore, base: [...g.base], scoreBefore, scoreAfter: { away: g.away, home: g.home }, choice: offense || null, defenseChoice: defense || 'standard', distribution: { trials: PA_TRIALS, counts, selected: kind, mode } };
  g.plays.push(record);
  return record;
}

function pitchSequence(kind, seed, pitcher) {
  const r = rng(seed), seq = []; let balls = 0, strikes = 0;
  const add = call => {
    let x, y;
    if (call === 'ball' || call === 'hbp') {
      const side = Math.floor(r() * 4);
      if (call === 'hbp') { x = side === 0 ? 6 + r() * 14 : side === 1 ? 80 + r() * 14 : 20 + r() * 60; y = side === 2 ? 4 + r() * 14 : side === 3 ? 82 + r() * 14 : 20 + r() * 60; }
      else { x = side === 0 ? 10 + r() * 10 : side === 1 ? 80 + r() * 10 : 25 + r() * 50; y = side === 2 ? 10 + r() * 10 : side === 3 ? 80 + r() * 10 : 25 + r() * 50; }
    } else { x = 27 + r() * 46; y = 27 + r() * 46; }
    const type = PITCH_TYPES[Math.floor(r() * PITCH_TYPES.length)], range = pitcher?.[4]?.[type] || DEFAULT_PITCH_SPEEDS[type];
    const speed = range[0] + Math.floor(r() * (range[1] - range[0] + 1));
    seq.push({ call, x, y, speed, type });
  };
  if (kind === 'BB') { const calledStrikes = Math.floor(r() * 3); for (let i = 0; i < calledStrikes; i++) add('strike'); while (balls < 4) { add('ball'); balls++; } }
  else if (kind === 'K') { const calledBalls = Math.floor(r() * 4); for (let i = 0; i < calledBalls; i++) add('ball'); for (let i = 0; i < 3; i++) add('strike'); }
  else {
    const before = 2 + Math.floor(r() * 3);
    for (let i = 0; i < before; i++) {
      let call = r() < .38 ? 'ball' : (strikes === 2 ? 'foul' : (r() < .55 ? 'strike' : 'foul'));
      if (call === 'ball' && balls >= 3) call = strikes === 2 ? 'foul' : 'strike';
      if (call === 'ball') balls++; if (call === 'strike') strikes++; add(call);
    }
    add(kind === 'HBP' ? 'hbp' : 'inplay');
  }
  return seq;
}

export function shouldOfferStrategy(g, play) {
  const bases = play.base || [], outs = play.outs || 0; if (outs >= 3) return false;
  const runners = bases.filter(Boolean).length, risp = Boolean(bases[1] || bases[2]), firstBasePlay = Boolean(bases[0] && outs < 2), lateClose = play.inn >= 7 && Math.abs((g.away || 0) - (g.home || 0)) <= 2;
  return risp || firstBasePlay || runners >= 2 || lateClose;
}

function strategyEffects(g, roster, tactic, batter = peekNextBatter(g, roster), defense = 'standard') {
  const base = plateOutcomeProbabilities(g, roster, batter, 'normal', g.half || 'away', 'standard'), adjusted = plateOutcomeProbabilities(g, roster, batter, tactic, g.half || 'away', defense);
  return Object.keys(base).filter(k => ['1B', '2B', '3B', 'HR', 'BB', 'HBP', 'K', 'OUT', 'GDP'].includes(k)).map(k => ({ key: k, delta: (adjusted[k] - base[k]) * 100 })).filter(x => Math.abs(x.delta) >= .05).map(x => ({ text: `${OUTCOME_LABELS[x.key]} ${x.delta > 0 ? '+' : '−'}${Math.abs(x.delta).toFixed(1)}%p`, tone: (x.delta > 0) === FAVORABLE_OUTCOMES.has(x.key) ? 'good' : 'bad' }));
}
const oppositeEffects = (effects = []) => effects.map(e => ({ ...e, tone: e.tone === 'good' ? 'bad' : 'good' }));

// Choices for the next plate appearance. Labels and effects are the same as the browser ballot.
// Team display names are not part of the engine, so the situation text uses team ids.
export function makeStrategyBallot(g, roster) {
  const bases = g.base || [null, null, null], outs = g.outs || 0;
  const offenseChoices = [{ id: 'normal', label: '기본 타격', detail: '현재 타자와 투수의 샘플 기본 분포를 적용합니다.' }];
  if ((bases[1] || bases[2] || bases.filter(Boolean).length >= 2) && outs < 3) offenseChoices.push({ id: 'contact', label: '컨택 타격', detail: '삼진·단타와 장타 간 교환입니다. 샘플 분포 기준.', effects: strategyEffects(g, roster, 'contact') });
  if (bases[0] && outs < 2) offenseChoices.push({ id: 'bunt', label: '희생번트 시도', detail: '성공 시 주자를 보내고 타자는 희생 처리합니다. 성공률은 데모용 샘플입니다.', effects: [{ text: '번트 성공 +1베이스 · 72%', tone: 'good' }, { text: '번트 실패 · 타자 아웃 28%', tone: 'bad' }] });
  offenseChoices.push({ id: 'aggressive', label: '강공', detail: '장타를 노리는 대신 삼진·볼넷·단타 위험이 달라집니다. 데모용 샘플 분포.', effects: strategyEffects(g, roster, 'aggressive') });
  const defenseChoices = [{ id: 'standard', label: '기본 수비', detail: '현재 수비 위치를 유지합니다.' }];
  if (bases[0] && outs < 2) {
    defenseChoices.push({ id: 'double_play', label: '병살 대비 수비', detail: '1루 주자가 있을 때 병살 가능성과 단타 가능성이 함께 달라지는 샘플 수비입니다.', effects: oppositeEffects(strategyEffects(g, roster, 'normal', peekNextBatter(g, roster), 'double_play')) });
    if (bases[1] && outs === 0) defenseChoices.push({ id: 'corners_in', label: '코너 내야 전진 수비', detail: '희생번트에 대응합니다. 번트 성공률 72%→58%는 검증 전 데모 가정입니다.', effects: [{ text: '번트 실패 +14%p', tone: 'good' }, { text: '단타 +1.5%p', tone: 'bad' }] });
  }
  return { offenseTeamId: offenseId(g), defenseTeamId: offenseId(g) === g.awayId ? g.homeId : g.awayId, offenseChoices, defenseChoices };
}

// Advance one step: apply both decided tactics to the next plate appearance and settle game-end rules.
// Mirrors window.advanceMatch in dist/enhancements.js. Returns a new state; the input is not changed.
// play is null when the game ended without a plate appearance.
export function stepPlateAppearance(state, roster, { offense = 'normal', defense = 'standard' } = {}) {
  const g = structuredClone(state);
  if (g.status !== 'running') throw new Error('game is not running');
  if (g.inning > MAX_INNINGS) { g.status = 'final'; g.tiebreak = '12회 종료 무승부'; return { game: g, play: null, needsVote: false }; }
  if (g.inning >= 9 && g.half === 'home' && g.home > g.away) { g.status = 'final'; return { game: g, play: null, needsVote: false }; }
  const play = playPA(g, roster, g.half, g.inning, offense || 'normal', defense || 'standard');
  const walkoff = g.half === 'home' && g.inning >= 9 && g.home > g.away;
  if (walkoff) g.status = 'final';
  if (g.outs >= 3) {
    g.outs = 0; g.base = [null, null, null];
    if (g.half === 'away') { if (g.inning >= 9 && g.home > g.away) g.status = 'final'; else g.half = 'home'; }
    else if (g.inning >= 9 && g.home !== g.away) g.status = 'final';
    else if (g.inning >= MAX_INNINGS) { g.status = 'final'; g.tiebreak = '12회 종료 무승부'; }
    else { g.inning++; g.half = 'away'; }
  }
  play.pitches = pitchSequence(play.kind, g.seed + g.plays.length * 173 + 41, teamOf(roster, play.side === 'away' ? g.homeId : g.awayId).pitcher);
  const needsVote = g.status !== 'final' && shouldOfferStrategy(g, play);
  return { game: g, play, needsVote };
}

// How long clients show this plate appearance before the next step (pitches, then the result).
export function presentationMs(play) {
  return play.pitches.length * PITCH_INTERVAL_MS + RESULT_DISPLAY_MS;
}
