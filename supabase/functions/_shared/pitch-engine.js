// FanBall pitch-by-pitch engine (fanball-engine-2). Design: docs/PITCH_ENGINE_DESIGN.md.
// Every pitch is drawn from the probabilities of the current ball-strike count, adjusted for the
// batter/pitcher matchup and both teams' tactics. Strikeouts only happen at two strikes and walks
// at three balls because the count rules do that by themselves.
// Pure functions only: callers pass the state and roster in and get a new state back.
import { PITCH_COUNTS, PITCH_OUTCOMES, IN_PLAY_COUNTS, IN_PLAY_OUTCOMES, BUNT_ATTEMPTS, BUNT_IN_PLAY, RUNNER_ON_THIRD_OUTS } from './count-tables.js';

// Bump on every rule change so a finished game can be replayed with the engine it actually used.
// 2: first pitch engine. 2.1 (2026-11-10): late close-game votes need a runner; no bunt with one out
// and only a runner on first; sacrifice odds shown apart from outs. 2.2 (2026-11-11): two-strike and
// three-ball votes only with a runner in scoring position. 2.3 (2026-11-11): with a runner on third and
// fewer than two outs, outs in play split into outfield air / infield air / ground by Retrosheet
// shares, and the runner scores at the measured rates (sacrifice fly, ground out RBI).
export const ENGINE_VERSION = 'fanball-engine-2.3';
export const PITCH_TRIALS = 100000;
export const MAX_INNINGS = 12;
export const PITCH_INTERVAL_MS = 2000;
export const RESULT_DISPLAY_MS = 2000;
export const VOTE_SECONDS = 10;
// Second and later votes within the same at-bat (two strikes, three balls) are shorter. 12 s / 10 s until 2026-11-11, then 10 s / 8 s (user decisions).
export const FOLLOW_UP_VOTE_SECONDS = 8;

// KBO league reference used to judge how good a batter or pitcher is (log5). Replace each value
// when a reliable source is found; docs/PITCH_ENGINE_DESIGN.md lists the sources.
export const KBO_LEAGUE = {
  avg: 0.256, // 2025 season .256 (MyKBO Stats, unverified); first half .259 (강원일보 2025-07-13); 2024 .277
  obp: 0.338, // 2025 regular season, community post (unverified)
  slg: 0.390, // assumed
  k: 0.202, // 2025 K/9 7.77 (roberin.com, unverified) / about 38.5 batters per 9 innings (assumed)
  bb: 0.090, // walks per PA, assumed
};

const PITCH_TYPES = ['직구', '슬라이더', '커브', '체인지업', '포크'];
const DEFAULT_PITCH_SPEEDS = { '직구': [138, 148], '슬라이더': [124, 136], '커브': [108, 122], '체인지업': [120, 134], '포크': [125, 138] };
const COUNTS = ['0-0', '0-1', '0-2', '1-0', '1-1', '1-2', '2-0', '2-1', '2-2', '3-0', '3-1', '3-2'];
const HIT_KINDS = new Set(['1B', '2B', '3B', 'HR']);

// Assumed tactic effects: multipliers on pitch outcome shares and on batted-ball outcome shares.
// All values are assumptions, listed in docs/PITCH_ENGINE_DESIGN.md.
export const TACTICS = {
  offense: {
    normal: { label: '기본 타격' },
    contact: { label: '컨택 타격', pitch: { swinging_strike: 0.7, foul: 1.1, in_play: 1.08 }, twoStrikes: { swinging_strike: 0.85 }, bip: { '1B': 1.12, '2B': 0.8, '3B': 0.8, HR: 0.6 } },
    aggressive: { label: '강공', pitch: { swinging_strike: 1.25, foul: 0.95, in_play: 1.05 }, hitterCount: { swinging_strike: 0.9 }, bip: { '1B': 0.95, '2B': 1.2, '3B': 1.2, HR: 1.35 } },
    wait: { label: '기다리기', pitch: { swinging_strike: 0.4, foul: 0.5, in_play: 0.5, called_strike: 1.1 } },
    bunt: { label: '희생번트' },
  },
  // Where the fielders stand. Stays for the whole plate appearance unless changed.
  alignment: {
    standard: { label: '기본 수비' },
    double_play: { label: '병살 대비 수비', bip: { DP: 1.6, '1B': 1.05 } },
    corners_in: { label: '번트 대비 (코너 내야 전진)', bip: { '1B': 1.08 }, bunt: { sacrifice: 0.85, hit: 0.6, out: 1.1, fieldersChoice: 1.8 } },
    infield_in: { label: '내야 전진 수비', bip: { '1B': 1.15 }, groundRunFactor: 0.35 }, // assumed: runs on ground outs drop to about a third
    outfield_deep: { label: '외야 장타 대비', bip: { '1B': 1.1, '2B': 0.8, '3B': 0.7 } },
  },
  // How the pitcher attacks the batter.
  approach: {
    standard: { label: '기본 투구' },
    attack: { label: '정면 승부', pitch: { ball: 0.8, called_strike: 1.1, in_play: 1.1 }, bip: { HR: 1.05 } },
    pitch_around: { label: '유인구 승부', pitch: { ball: 1.25, called_strike: 0.8, swinging_strike: 1.15, in_play: 0.85 } },
  },
};
const ALIGNMENTS = new Set(Object.keys(TACTICS.alignment));
const APPROACHES = new Set(['attack', 'pitch_around']);
// With a runner on third and fewer than two outs, an out in play is an outfield fly/line, an infield
// fly/pop, or a ground ball (Retrosheet shares), and the runner scores at the measured rate for each.
const R3_OUT_TYPES = (() => { const t = RUNNER_ON_THIRD_OUTS, n = t.outfieldAir.outs + t.infieldAir.outs + t.ground.outs;
  return { outfieldAir: t.outfieldAir.outs / n, infieldAir: t.infieldAir.outs / n, ground: t.ground.outs / n }; })();
const R3_SCORE_RATE = { outfieldAir: RUNNER_ON_THIRD_OUTS.outfieldAir.scored / RUNNER_ON_THIRD_OUTS.outfieldAir.outs,
  infieldAir: RUNNER_ON_THIRD_OUTS.infieldAir.scored / RUNNER_ON_THIRD_OUTS.infieldAir.outs, ground: RUNNER_ON_THIRD_OUTS.ground.scored / RUNNER_ON_THIRD_OUTS.ground.outs };
// Share of non-double-play outs in play that score the runner from third, as sacrifice fly / ground out RBI.
function runnerOnThirdRunShares(tactics) {
  const groundFactor = TACTICS.alignment[tactics?.alignment]?.groundRunFactor ?? 1;
  return { sacrificeFly: R3_OUT_TYPES.outfieldAir * R3_SCORE_RATE.outfieldAir, groundOutRbi: R3_OUT_TYPES.ground * R3_SCORE_RATE.ground * groundFactor,
    infieldAir: R3_OUT_TYPES.infieldAir * R3_SCORE_RATE.infieldAir };
}

export function hash(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
export function rng(seed) {
  let x = seed >>> 0;
  return () => { x = (x + 0x6D2B79F5) | 0; let z = x; z = Math.imul(z ^ z >>> 15, z | 1); z ^= z + Math.imul(z ^ z >>> 7, z | 61); return ((z ^ z >>> 14) >>> 0) / 4294967296; };
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const log5 = (x, y, league) => { const a = x * y / league, b = (1 - x) * (1 - y) / (1 - league); return a / (a + b); };
const normalize = obj => { const sum = Object.values(obj).reduce((a, b) => a + b, 0) || 1; return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v / sum])); };
const toShares = (keys, row) => normalize(Object.fromEntries(keys.map((k, i) => [k, row[i]])));
const scale = (obj, factors = {}) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v * (factors[k] ?? 1)]));

const BASE_PITCH = Object.fromEntries(COUNTS.map(c => [c, toShares(PITCH_OUTCOMES, PITCH_COUNTS[c])]));
const BASE_BIP = Object.fromEntries(COUNTS.map(c => [c, toShares(IN_PLAY_OUTCOMES, IN_PLAY_COUNTS[c])]));
const BUNT_ATTEMPT = normalize({ foul: BUNT_ATTEMPTS.foul, missed: BUNT_ATTEMPTS.missed, inPlay: BUNT_ATTEMPTS.inPlay });
const BUNT_RESULT = normalize({ ...BUNT_IN_PLAY });

// ---------- matchup calibration ----------

// Sample pitchers store [name, opponent AVG, BB/PA, K/PA, speeds]; values outside a sane range
// (some sample rosters keep an ERA-like number in slot 1) fall back to the league value.
function pitcherRates(pitcher, league) {
  const ok = (v, lo, hi) => (Number.isFinite(v) && v > lo && v < hi ? v : null);
  return { avg: ok(pitcher?.[1], 0.1, 0.45) ?? league.avg, bb: ok(pitcher?.[2], 0.01, 0.25) ?? league.bb, k: ok(pitcher?.[3], 0.03, 0.45) ?? league.k };
}

// Batter [name, pos, AVG, OBP, SLG, ...] against a pitcher, as targets per PA / per AB.
export function matchupTargets(batter, pitcher, league = KBO_LEAGUE) {
  const p = pitcherRates(pitcher, league);
  const avg = clamp(batter[2], 0.15, 0.4), obp = clamp(batter[3], avg + 0.01, 0.5), slg = clamp(batter[4], avg, 0.75);
  const batterBB = clamp((obp - avg) / (1 - avg), 0.02, 0.2);
  return {
    avg: log5(avg, p.avg, league.avg),
    bb: log5(batterBB, p.bb, league.bb),
    k: log5(league.k, p.k, league.k), // the sample data has no batter strikeout rate
    iso: clamp(slg - avg, 0.04, 0.35),
  };
}

const NEUTRAL_PROFILE = { mBall: 1, mWhiff: 1, mHit: 1, mPow: 1 };

// Pitch outcome shares at a count for a profile and tactics (before any bunt handling).
function pitchShares(count, profile, tactics) {
  const [b, s] = count.split('-').map(Number);
  let p = scale(BASE_PITCH[count], { ball: profile.mBall, swinging_strike: profile.mWhiff, called_strike: Math.sqrt(profile.mWhiff) });
  const off = TACTICS.offense[tactics.offense] || {}, app = TACTICS.approach[tactics.approach] || {};
  p = scale(p, off.pitch);
  if (s === 2) p = scale(p, off.twoStrikes);
  if (b > s) p = scale(p, off.hitterCount);
  p = scale(p, app.pitch);
  return normalize(p);
}

function bipShares(count, profile, tactics) {
  const off = TACTICS.offense[tactics.offense] || {}, ali = TACTICS.alignment[tactics.alignment] || {}, app = TACTICS.approach[tactics.approach] || {};
  let p = scale(BASE_BIP[count], { '1B': profile.mHit, '2B': profile.mHit * profile.mPow, '3B': profile.mHit * profile.mPow, HR: profile.mHit * profile.mPow });
  p = scale(scale(scale(p, off.bip), ali.bip), app.bip);
  return normalize(p);
}

// Batted-ball outcome shares at a count for this game situation (results that cannot happen here,
// such as a double play with two outs, are folded into ordinary outs). Used for display.
export function inPlayShares(count, profile, tactics, { runnerOnFirst = false, runnerOnThird = false, outs = 0 } = {}) {
  const p = { ...bipShares(count, profile, { offense: 'normal', alignment: 'standard', approach: 'standard', ...tactics }) };
  if (!(runnerOnFirst && outs < 2)) { p.OUT += p.DP; p.DP = 0; }
  p.OUT += p.SAC_BUNT; p.SAC_BUNT = 0;
  p.OUT += p.SAC_FLY; p.SAC_FLY = 0; p.GO_RBI = 0;
  if (runnerOnThird && outs < 2) {
    const r = runnerOnThirdRunShares(tactics), outs3 = p.OUT;
    p.SAC_FLY = outs3 * (r.sacrificeFly + r.infieldAir); p.GO_RBI = outs3 * r.groundOutRbi; p.OUT = outs3 - p.SAC_FLY - p.GO_RBI;
  }
  return normalize(p);
}

// Exact plate-appearance outcome probabilities from a count (Markov chain over the 12 counts).
// Used to calibrate players and to show each tactic's effect on the vote cards.
export function plateAppearanceOdds(profile, tactics, start = '0-0', situation = { bunting: false }) {
  const reach = Object.fromEntries(COUNTS.map(c => [c, 0]));
  reach[start] = 1;
  const out = { BB: 0, K: 0, HBP: 0, bip: Object.fromEntries(IN_PLAY_OUTCOMES.map(k => [k, 0])), bunt: { sacrifice: 0, hit: 0, out: 0, fieldersChoice: 0 } };
  const order = [...COUNTS].sort((x, y) => (x[0] - 0 + (x[2] - 0)) - (y[0] - 0 + (y[2] - 0)));
  for (const c of order) {
    const r = reach[c]; if (!r) continue;
    const [b, s] = c.split('-').map(Number);
    const p = situation.bunting ? buntPitchShares(c, profile, tactics) : pitchShares(c, profile, tactics);
    // At two strikes a foul (not a bunt foul) keeps the count: remove the self-loop.
    const stay = s === 2 && !situation.bunting ? p.foul : 0, f = r / (1 - stay);
    const strikes = p.called_strike + p.swinging_strike + (s === 2 && !situation.bunting ? 0 : p.foul);
    out.HBP += f * p.hbp;
    if (b === 3) out.BB += f * p.ball; else reach[`${b + 1}-${s}`] += f * p.ball;
    if (s === 2) out.K += f * strikes; else reach[`${b}-${s + 1}`] += f * strikes;
    if (situation.bunting) { for (const [k, v] of Object.entries(buntResultShares(tactics))) out.bunt[k] += f * p.in_play * v; }
    else { const bip = bipShares(c, profile, tactics); for (const k of IN_PLAY_OUTCOMES) out.bip[k] += f * p.in_play * bip[k]; }
  }
  return out;
}

function summarize(odds) {
  const hits = odds.bip['1B'] + odds.bip['2B'] + odds.bip['3B'] + odds.bip.HR + odds.bunt.hit;
  const tb = odds.bip['1B'] + odds.bunt.hit + 2 * odds.bip['2B'] + 3 * odds.bip['3B'] + 4 * odds.bip.HR;
  const ab = 1 - odds.BB - odds.HBP - odds.bip.SAC_FLY - odds.bip.SAC_BUNT - odds.bunt.sacrifice;
  return { avg: hits / ab, iso: (tb - hits) / ab, bb: odds.BB, k: odds.K, hbp: odds.HBP, hit: hits, xbh: odds.bip['2B'] + odds.bip['3B'] + odds.bip.HR, hr: odds.bip.HR };
}

// Find the multipliers that make this matchup produce its target AVG, ISO, BB% and K%.
export function calibrateMatchup(batter, pitcher, league = KBO_LEAGUE) {
  const target = matchupTargets(batter, pitcher, league);
  const m = { ...NEUTRAL_PROFILE }, neutral = { offense: 'normal', alignment: 'standard', approach: 'standard' };
  for (let i = 0; i < 60; i++) {
    const got = summarize(plateAppearanceOdds(m, neutral));
    m.mBall = clamp(m.mBall * (target.bb / got.bb) ** 0.8, 0.2, 5);
    m.mWhiff = clamp(m.mWhiff * (target.k / got.k) ** 0.8, 0.2, 5);
    m.mHit = clamp(m.mHit * (target.avg / got.avg) ** 0.9, 0.2, 5);
    m.mPow = clamp(m.mPow * (target.iso / got.iso) ** 0.9, 0.2, 5);
  }
  const fitted = summarize(plateAppearanceOdds(m, neutral));
  return { ...m, target, fitted: { avg: fitted.avg, iso: fitted.iso, bb: fitted.bb, k: fitted.k } };
}

// ---------- bunts ----------

function buntPitchShares(count, profile, tactics) {
  const base = pitchShares(count, profile, { ...tactics, offense: 'normal' });
  const rest = 1 - base.ball - base.hbp; // the batter squares around on strikes and takes balls
  return { ball: base.ball, hbp: base.hbp, called_strike: 0, swinging_strike: rest * BUNT_ATTEMPT.missed, foul: rest * BUNT_ATTEMPT.foul, in_play: rest * BUNT_ATTEMPT.inPlay };
}
function buntResultShares(tactics) {
  return normalize(scale(BUNT_RESULT, TACTICS.alignment[tactics.alignment]?.bunt));
}
// Sacrifice bunts are offered with a runner on 1st or 2nd and fewer than two outs, except one out
// with only a runner on first (2 outs, runner on 2nd is rarely worth it; user decision 2026-11-10).
const canBunt = g => {
  if (!(g.base[0] || g.base[1]) || g.outs >= 2) return false;
  const onlyFirst = g.base[0] && !g.base[1] && !g.base[2];
  return !(g.outs === 1 && onlyFirst);
};

// ---------- game state ----------

// trials: samples per pitch (PITCH_TRIALS in real games; tests may use fewer for speed).
export function createGame({ awayId, homeId, seed, roster, league = KBO_LEAGUE, trials = PITCH_TRIALS }) {
  const profiles = {};
  for (const [side, teamId, oppId] of [['away', awayId, homeId], ['home', homeId, awayId]]) {
    const pitcher = roster[oppId].pitcher;
    profiles[side] = roster[teamId].players.map(batter => calibrateMatchup(batter, pitcher, league));
  }
  return {
    engine: ENGINE_VERSION, awayId, homeId, seed: seed >>> 0, status: 'running', away: 0, home: 0,
    innings: [], plays: [], bat: {}, idx: { away: 0, home: 0 }, inning: 1, half: 'away', outs: 0, base: [null, null, null],
    tiebreak: null, pitchNo: 0, pa: null, profiles, trials,
  };
}

const sideTeam = (g, side) => (side === 'away' ? g.awayId : g.homeId);
const offenseTeamId = g => sideTeam(g, g.half);
const defenseTeamId = g => sideTeam(g, g.half === 'away' ? 'home' : 'away');

// A vote opens with a runner in scoring position, a runner on first with fewer than two outs,
// two or more runners, or from the 7th inning in a game within two runs when at least one runner
// is on base (user decision 2026-11-10: no vote with the bases empty).
// Name of the batter who is up next (before the plate appearance starts).
export function upcomingBatter(state, roster) {
  if (state.pa) return state.pa.batter;
  const side = state.half, team = roster[sideTeam(state, side)];
  return team.players[team.order[state.idx[side] % team.order.length]][0];
}

export function isTacticalSituation(g) {
  if (g.outs >= 3) return false;
  const runners = g.base.filter(Boolean).length;
  const lateClose = g.inning >= 7 && Math.abs(g.away - g.home) <= 2 && runners >= 1;
  return Boolean(g.base[1] || g.base[2]) || Boolean(g.base[0] && g.outs < 2) || runners >= 2 || lateClose;
}

function startPlateAppearance(g, roster) {
  const side = g.half, team = roster[sideTeam(g, side)], order = team.order;
  const batterIndex = order[g.idx[side] % order.length];
  g.idx[side]++;
  g.pa = {
    no: g.plays.length + 1, side, inning: g.inning, batterIndex, batter: team.players[batterIndex][0],
    balls: 0, strikes: 0, pitches: [], offense: 'normal', alignment: 'standard', approach: 'standard',
    tactical: false, phasesDone: [], votes: [], ibb: false,
    basesBefore: [...g.base], outsBefore: g.outs, scoreBefore: { away: g.away, home: g.home },
  };
}

// The vote that must happen before the next pitch, or null. Key-count votes (two strikes, three
// balls) happen only in plate appearances that opened with a vote, and only while a runner is in
// scoring position (user decision 2026-11-11, to keep games shorter).
export function pendingVote(state, roster) {
  if (state.status !== 'running') return null;
  const g = state;
  if (!g.pa) return isTacticalSituation(g) ? { phase: 'pre_pa', ballot: makeBallot(g, roster, 'pre_pa') } : null;
  if (!g.pa.tactical || g.pa.ibb) return null;
  if (!(g.base[1] || g.base[2])) return null;
  if (g.pa.strikes === 2 && !g.pa.phasesDone.includes('two_strikes')) return { phase: 'two_strikes', ballot: makeBallot(g, roster, 'two_strikes') };
  if (g.pa.balls === 3 && !g.pa.phasesDone.includes('three_balls')) return { phase: 'three_balls', ballot: makeBallot(g, roster, 'three_balls') };
  return null;
}

const choice = (id, label, detail) => ({ id, label, detail });

export function makeBallot(state, roster, phase) {
  const g = state, b = g.base, outs = g.outs;
  const offense = [], defense = [];
  if (phase === 'pre_pa') {
    offense.push(choice('normal', '기본 타격', '현재 카운트별 기본 확률로 칩니다.'));
    if (b[1] || b[2] || b.filter(Boolean).length >= 2) offense.push(choice('contact', '컨택 타격', '헛스윙을 줄이고 맞히는 데 집중합니다. 장타는 줄어듭니다.'));
    if (canBunt(g)) offense.push(choice('bunt', '희생번트', '스트라이크에 번트를 대고 볼은 골라냅니다. 2스트라이크 번트 파울은 삼진입니다.'));
    offense.push(choice('aggressive', '강공', '장타를 노립니다. 헛스윙이 늘어납니다.'));
    defense.push(choice('standard', '기본 수비', '기본 위치에서 기본 투구로 승부합니다.'));
    if (b[0] && outs < 2) defense.push(choice('double_play', '병살 대비 수비', '병살 가능성을 높이는 대신 땅볼 안타가 조금 늘어납니다.'));
    if (canBunt(g)) defense.push(choice('corners_in', '번트 대비 수비', '코너 내야수가 전진해 번트 성공을 줄입니다.'));
    if (b[2] && outs < 2) defense.push(choice('infield_in', '내야 전진 수비', '3루 주자의 홈 득점을 막습니다. 땅볼 안타가 늘어납니다.'));
    defense.push(choice('outfield_deep', '외야 장타 대비', '외야가 물러나 2루타·3루타를 줄입니다. 짧은 안타는 늘어납니다.'));
    defense.push(choice('attack', '정면 승부', '스트라이크존으로 승부합니다. 볼넷이 줄고 맞는 공이 늘어납니다.'));
    defense.push(choice('pitch_around', '유인구 승부', '유인구로 승부합니다. 헛스윙과 볼넷이 함께 늘어납니다.'));
    if (!b[0]) defense.push(choice('intentional_walk', '고의사구', '타자를 바로 1루로 보냅니다.'));
  } else {
    const off = TACTICS.offense[g.pa.offense].label, def = [TACTICS.alignment[g.pa.alignment].label, TACTICS.approach[g.pa.approach].label].join(' · ');
    offense.push(choice('keep', `현재 작전 유지 (${off})`, '지금 작전을 그대로 이어 갑니다.'));
    if (phase === 'two_strikes') {
      if (g.pa.offense !== 'contact') offense.push(choice('contact', '컨택으로 전환', '삼진을 피하는 데 집중합니다.'));
      if (g.pa.offense === 'bunt') offense.push(choice('normal', '번트 포기 · 기본 타격', '2스트라이크 번트 파울은 삼진이라 강공으로 바꿉니다.'));
      else if (g.pa.offense !== 'aggressive') offense.push(choice('aggressive', '강공 유지·전환', '장타를 노립니다.'));
    } else {
      offense.push(choice('wait', '기다리기', '볼넷을 노리고 웬만하면 치지 않습니다.'));
      if (g.pa.offense !== 'aggressive') offense.push(choice('aggressive', '노려 치기', '카운트가 유리할 때 장타를 노립니다.'));
    }
    defense.push(choice('keep', `현재 작전 유지 (${def})`, '지금 수비와 투구를 그대로 이어 갑니다.'));
    defense.push(choice('attack', '정면 승부', '스트라이크존으로 승부합니다.'));
    defense.push(choice('pitch_around', '유인구 승부', '유인구로 승부합니다.'));
    if (phase === 'three_balls' && !b[0]) defense.push(choice('intentional_walk', '고의사구', '타자를 바로 1루로 보냅니다.'));
  }
  // Show what each choice does to this plate appearance from the current count.
  const from = phase === 'pre_pa' ? '0-0' : `${g.pa.balls}-${g.pa.strikes}`;
  const current = phase === 'pre_pa' ? { offense: 'normal', alignment: 'standard', approach: 'standard' } : { offense: g.pa.offense, alignment: g.pa.alignment, approach: g.pa.approach };
  const profile = batterProfile(g, roster, phase === 'pre_pa' ? null : g.pa);
  for (const c of offense) c.odds = choiceOdds(g, profile, applyChoice(current, 'offense', c.id), from);
  for (const c of defense) c.odds = choiceOdds(g, profile, applyChoice(current, 'defense', c.id), from);
  return { phase, offenseTeamId: offenseTeamId(g), defenseTeamId: defenseTeamId(g), offenseChoices: offense, defenseChoices: defense, count: from };
}

function applyChoice(tactics, role, id) {
  const t = { ...tactics };
  if (!id || id === 'keep') return t;
  if (role === 'offense') { t.offense = id; return t; }
  if (id === 'intentional_walk') { t.ibb = true; return t; }
  if (id === 'standard') { t.alignment = 'standard'; t.approach = 'standard'; return t; }
  if (ALIGNMENTS.has(id)) t.alignment = id; else if (APPROACHES.has(id)) t.approach = id;
  return t;
}

function batterProfile(g, roster, pa) {
  const side = pa ? pa.side : g.half, order = roster[sideTeam(g, side)].order;
  const index = pa ? pa.batterIndex : order[g.idx[side] % order.length];
  return g.profiles[side][index];
}

// Rounded chances (percent) of the main results of this plate appearance under a choice.
function choiceOdds(g, profile, tactics, from) {
  if (tactics.ibb) return { walk: 100, strikeout: 0, hit: 0, extraBase: 0, sacrifice: 0, out: 0 };
  const bunting = tactics.offense === 'bunt' && canBunt(g);
  const raw = plateAppearanceOdds(profile, tactics, from, { bunting }), s = summarize(raw);
  const pct = v => Math.round(v * 1000) / 10;
  // A sacrifice (bunt or fly) moves runners up even though the batter is out; show it apart from outs.
  let sacrifice = raw.bunt.sacrifice;
  if (g.base[2] && g.outs < 2) { const r = runnerOnThirdRunShares(tactics); sacrifice += (raw.bip.OUT + raw.bip.SAC_FLY) * (r.sacrificeFly + r.groundOutRbi + r.infieldAir); }
  const odds = { walk: pct(s.bb + s.hbp), strikeout: pct(s.k), hit: pct(s.hit), extraBase: pct(s.xbh), sacrifice: pct(sacrifice) };
  odds.out = Math.round((100 - odds.walk - odds.strikeout - odds.hit - odds.sacrifice) * 10) / 10;
  return odds;
}

// Apply a closed vote. pre_pa starts the plate appearance; key-count votes change it.
export function applyVote(state, roster, phase, { offense = 'keep', defense = 'keep' } = {}) {
  const g = structuredClone(state);
  if (phase === 'pre_pa') {
    if (g.pa) throw new Error('plate appearance already started');
    startPlateAppearance(g, roster);
    g.pa.tactical = true;
  } else if (!g.pa) throw new Error('no plate appearance in progress');
  if (g.pa.phasesDone.includes(phase)) throw new Error(`vote ${phase} already applied`);
  const t = applyChoice(applyChoice({ offense: g.pa.offense, alignment: g.pa.alignment, approach: g.pa.approach }, 'offense', offense), 'defense', defense);
  if (t.offense === 'bunt' && !canBunt(g)) t.offense = 'normal';
  Object.assign(g.pa, { offense: t.offense, alignment: t.alignment, approach: t.approach, ibb: Boolean(t.ibb) });
  g.pa.phasesDone.push(phase);
  g.pa.votes.push({ phase, offense, defense });
  return g;
}

// ---------- pitches ----------

// Sample the pitch `trials` times and draw the result from those frequencies (shown as the pitch's distribution).
function drawCounts(shares, random, trials) {
  const keys = Object.keys(shares), counts = Object.fromEntries(keys.map(k => [k, 0]));
  for (let n = 0; n < trials; n++) {
    const x = random(); let sum = 0, hit = false;
    for (const k of keys) { sum += shares[k]; if (x < sum) { counts[k]++; hit = true; break; } }
    if (!hit) counts[keys[keys.length - 1]]++;
  }
  let draw = Math.floor(random() * trials);
  for (const k of keys) { if (draw < counts[k]) return { kind: k, counts }; draw -= counts[k]; }
  return { kind: keys[keys.length - 1], counts };
}
const drawOne = (shares, random) => { let x = random(); for (const [k, v] of Object.entries(shares)) { if (x < v) return k; x -= v; } return Object.keys(shares).pop(); };

function pitchVisual(call, random, pitcher) {
  let x, y;
  if (call === 'ball' || call === 'hbp' || call === 'ibb') {
    const side = Math.floor(random() * 4);
    if (call === 'hbp') { x = side === 0 ? 6 + random() * 14 : side === 1 ? 80 + random() * 14 : 20 + random() * 60; y = side === 2 ? 4 + random() * 14 : side === 3 ? 82 + random() * 14 : 20 + random() * 60; }
    else { x = side === 0 ? 10 + random() * 10 : side === 1 ? 80 + random() * 10 : 25 + random() * 50; y = side === 2 ? 10 + random() * 10 : side === 3 ? 80 + random() * 10 : 25 + random() * 50; }
  } else { x = 27 + random() * 46; y = 27 + random() * 46; }
  const type = PITCH_TYPES[Math.floor(random() * PITCH_TYPES.length)], range = pitcher?.[4]?.[type] || DEFAULT_PITCH_SPEEDS[type];
  return { x, y, type, speed: range[0] + Math.floor(random() * (range[1] - range[0] + 1)) };
}

// Throw one pitch (starting a plate appearance if none is in progress). Returns the new state,
// the pitch, and the finished plate appearance when this pitch ended it.
export function stepPitch(state, roster) {
  const g = structuredClone(state);
  if (g.status !== 'running') throw new Error('game is not running');
  if (!g.pa) startPlateAppearance(g, roster);
  const pa = g.pa, count = `${pa.balls}-${pa.strikes}`, profile = g.profiles[pa.side][pa.batterIndex];
  const random = rng(g.seed + g.pitchNo * 7919 + 17);
  const pitcher = roster[sideTeam(g, pa.side === 'away' ? 'home' : 'away')].pitcher;
  const tactics = { offense: pa.offense, alignment: pa.alignment, approach: pa.approach };
  const bunting = pa.offense === 'bunt' && canBunt(g);
  g.pitchNo++;

  let pitch;
  if (pa.ibb) {
    pitch = { call: 'ibb', result: 'intentional_walk', ...pitchVisual('ibb', random, pitcher) };
    pa.pitches.push({ ...pitch, count });
    return finishPlateAppearance(g, roster, 'IBB', pitch, random);
  }
  const shares = bunting ? buntPitchShares(count, profile, tactics) : pitchShares(count, profile, tactics);
  // What a ball in play would turn into at this count (for display; computed before the draw and
  // without using the random stream, so results do not change).
  const pct = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v > 0).map(([k, v]) => [k, Math.round(v * 1000) / 10]));
  const inPlayOdds = bunting
    ? pct(buntResultShares(tactics))
    : pct(inPlayShares(count, profile, tactics, { runnerOnFirst: Boolean(g.base[0]), runnerOnThird: Boolean(g.base[2]), outs: g.outs }));
  const { kind, counts } = drawCounts(shares, random, g.trials || PITCH_TRIALS);
  const call = { ball: 'ball', called_strike: 'strike', swinging_strike: 'strike', foul: 'foul', in_play: 'inplay', hbp: 'hbp' }[kind];
  pitch = { call, result: bunting && kind !== 'ball' && kind !== 'hbp' ? `bunt_${kind}` : kind, ...pitchVisual(call, random, pitcher), distribution: { trials: g.trials || PITCH_TRIALS, counts }, inPlayOdds, bunting };
  pa.pitches.push({ ...pitch, count });

  if (kind === 'hbp') return finishPlateAppearance(g, roster, 'HBP', pitch, random);
  if (kind === 'ball') { if (pa.balls === 3) return finishPlateAppearance(g, roster, 'BB', pitch, random); pa.balls++; return { game: g, pitch, play: null }; }
  if (kind === 'called_strike' || kind === 'swinging_strike' || (kind === 'foul' && (pa.strikes < 2 || bunting))) {
    if (pa.strikes === 2) return finishPlateAppearance(g, roster, 'K', pitch, random);
    pa.strikes++; return { game: g, pitch, play: null };
  }
  if (kind === 'foul') return { game: g, pitch, play: null };
  // In play.
  if (bunting) {
    const r = drawOne(buntResultShares(tactics), random);
    return finishPlateAppearance(g, roster, { sacrifice: 'SAC', hit: 'BUNT_HIT', out: 'BUNT_OUT', fieldersChoice: 'FC' }[r], pitch, random);
  }
  let bip = bipShares(count, profile, tactics);
  // Situational results only where they can happen; otherwise they are ordinary outs.
  bip = inPlayShares(count, profile, tactics, { runnerOnFirst: Boolean(g.base[0]), runnerOnThird: Boolean(g.base[2]), outs: g.outs });
  const result = drawOne(bip, random);
  pitch.bip = result;
  return finishPlateAppearance(g, roster, { DP: 'GDP', SAC_FLY: 'SF', ROE_FC: 'ROE' }[result] || result, pitch, random);
}

function finishPlateAppearance(g, roster, kind, pitch, random) {
  const pa = g.pa, side = pa.side, inn = pa.inning, name = pa.batter, base = [...g.base], outs = g.outs;
  let runs = 0, newBase = base, newOuts = outs;
  const advanceAll = () => { runs = base[2] ? 1 : 0; newBase = [name, base[0], base[1]]; };
  const force = () => { newBase = [...base]; if (newBase[0]) { if (newBase[1]) { if (newBase[2]) runs++; newBase[2] = newBase[1]; } newBase[1] = newBase[0]; } newBase[0] = name; };
  switch (kind) {
    case 'HR': runs = 1 + base.filter(Boolean).length; newBase = [null, null, null]; break;
    case '3B': runs = base.filter(Boolean).length; newBase = [null, null, name]; break;
    case '2B': runs = (base[1] ? 1 : 0) + (base[2] ? 1 : 0); newBase = [null, name, base[0]]; break;
    case '1B': case 'BUNT_HIT': case 'ROE': advanceAll(); break;
    case 'BB': case 'IBB': case 'HBP': force(); break;
    case 'K': case 'BUNT_OUT': newOuts = outs + 1; break;
    case 'OUT': newOuts = outs + 1; break;
    case 'GO_RBI': newOuts = outs + 1; runs = 1; newBase = [base[0], base[1], null]; break; // ground out, run scores
    case 'GDP': newOuts = outs + 2; newBase = [null, base[1], base[2]]; break;
    case 'SF': newOuts = outs + 1; runs = 1; newBase = [base[0], base[1], null]; break;
    case 'SAC': newOuts = outs + 1; runs = base[2] ? 1 : 0; newBase = [null, base[0], base[1]]; break;
    case 'FC': // the lead forced runner is out, the batter reaches first
      newOuts = outs + 1;
      if (base[0] && base[1]) newBase = [name, base[0], base[2]];
      else if (base[0]) newBase = [name, base[1], base[2]];
      else newBase = [name, null, base[2]];
      break;
    default: throw new Error(`unknown result ${kind}`);
  }
  if (newOuts >= 3) runs = 0; // a third out on the play: no run scores (outs-first simplification)
  g.base = newBase; g.outs = newOuts;
  const b = g.bat[name] || (g.bat[name] = { PA: 0, AB: 0, H: 0, '2B': 0, '3B': 0, HR: 0, BB: 0, HBP: 0, K: 0, GDP: 0, SH: 0, SF: 0, R: 0 });
  b.PA++;
  if (!['BB', 'IBB', 'HBP', 'SAC', 'SF'].includes(kind)) b.AB++;
  if (['1B', '2B', '3B', 'HR', 'BUNT_HIT'].includes(kind)) b.H++;
  if (['2B', '3B', 'HR'].includes(kind)) b[kind]++;
  if (kind === 'BB' || kind === 'IBB') b.BB++;
  if (kind === 'HBP') b.HBP++; if (kind === 'K') b.K++; if (kind === 'GDP') b.GDP++; if (kind === 'SAC') b.SH++; if (kind === 'SF') b.SF++;
  b.R += runs;
  g[side] += runs;
  const row = g.innings[inn - 1] || (g.innings[inn - 1] = { away: 0, home: 0 }); row[side] += runs;
  const play = {
    paNo: pa.no, inn, side, batter: name, kind, runs, outs: g.outs, outsBefore: pa.outsBefore, outsAfter: g.outs,
    basesBefore: pa.basesBefore, base: [...g.base], scoreBefore: pa.scoreBefore, scoreAfter: { away: g.away, home: g.home },
    choice: pa.offense, defenseChoice: pa.alignment, approach: pa.approach, votes: pa.votes, pitches: pa.pitches,
    count: `${pa.balls}-${pa.strikes}`,
  };
  g.plays.push(play);
  g.pa = null;
  // Game-end rules (docs/GAME_RULES.md), same as fanball-engine-1.
  if (g.half === 'home' && g.inning >= 9 && g.home > g.away) g.status = 'final';
  if (g.outs >= 3) {
    g.outs = 0; g.base = [null, null, null];
    if (g.half === 'away') { if (g.inning >= 9 && g.home > g.away) g.status = 'final'; else g.half = 'home'; }
    else if (g.inning >= 9 && g.home !== g.away) g.status = 'final';
    else if (g.inning >= MAX_INNINGS) { g.status = 'final'; g.tiebreak = '12회 종료 무승부'; }
    else { g.inning++; g.half = 'away'; }
  }
  return { game: g, pitch, play };
}
