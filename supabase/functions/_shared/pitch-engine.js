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
export const ENGINE_VERSION = 'fanball-engine-2.23';
export const PITCH_TRIALS = 100000;
export const MAX_INNINGS = 12;
export const PITCH_INTERVAL_MS = 2000;
export const RESULT_DISPLAY_MS = 3000; // the last pitch and the at-bat result stay up this long
// Pauses that give fans time to follow the game: after a vote closes, before a new batter's first pitch
// (his name is shown), and before a half-inning starts ("3회 초" is shown).
export const POST_VOTE_GAP_MS = 1000;
export const BATTER_INTRO_MS = 1000;
export const HALF_INNING_MS = 2000;
export const PITCHING_CHANGE_MS = 2000;
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
// All values are assumptions, listed in docs/PITCH_ENGINE_DESIGN.md. Since 2.6 every tactic has a cost, tuned
// so that by expected runs each wins only in its own situations (no tactic is better everywhere).
export const TACTICS = {
  offense: {
    normal: { label: '기본 타격' },
    // 2.17: against 유인구 승부 a contact hitter fights off more pitches: more fouls and some more whiffs (user)
    contact: { label: '컨택 타격', pitch: { swinging_strike: 0.75, foul: 1.1, in_play: 1.06, ball: 0.9 }, twoStrikes: { swinging_strike: 0.85 }, vsApproach: { pitch_around: { foul: 1.35, swinging_strike: 1.08, in_play: 0.9 } }, bip: { '1B': 1.1, '2B': 0.8, '3B': 0.8, HR: 0.55, OUT: 1.02 } },
    // 2.17: hunting a pitch to drive, he rarely takes a strike (fewer looking strikeouts; user)
    aggressive: { label: '강공', pitch: { swinging_strike: 1.38, foul: 0.95, in_play: 1.03, ball: 0.94, called_strike: 0.8 }, hitterCount: { swinging_strike: 0.9 }, bip: { '1B': 0.95, '2B': 1.15, '3B': 1.15, HR: 1.3, OUT: 1.02 } },
    // 2.17: taking means almost no swings (few whiffs) until two strikes, when he protects the plate (user)
    wait: { label: '기다리기', pitch: { swinging_strike: 0.2, foul: 0.4, in_play: 0.4, called_strike: 1.2 }, twoStrikes: { swinging_strike: 1.5, foul: 2.2, in_play: 2.0, called_strike: 0.85 } },
    bunt: { label: '희생번트' },
  },
  // Where the fielders stand. Stays for the whole plate appearance unless changed.
  alignment: {
    standard: { label: '기본 수비' },
    double_play: { label: '병살 대비 수비', bip: { DP: 1.6, '1B': 1.05 } },
    // 2.19: charging corners get the lead runner much more often (fewer safe sacrifices; user)
    corners_in: { label: '번트 대비 (코너 내야 전진)', bip: { '1B': 1.08 }, bunt: { sacrifice: 0.62, hit: 0.55, out: 1.15, fieldersChoice: 3.4 } },
    // 2.18: with the infield in, a bunt is charged hard: fewer sacrifices and bunt hits, more outs (user)
    infield_in: { label: '내야 전진 수비', bip: { '1B': 1.15 }, groundRunFactor: 0.35, bunt: { sacrifice: 0.8, hit: 0.55, out: 1.25, fieldersChoice: 1.6 } }, // assumed: runs on ground outs drop to about a third
    outfield_deep: { label: '외야 장타 대비', bip: { '1B': 1.1, '2B': 0.8, '3B': 0.7 } },
  },
  // How the pitcher attacks the batter.
  approach: {
    standard: { label: '기본 투구' },
    attack: { label: '정면 승부', pitch: { ball: 0.68, called_strike: 1.15, in_play: 1.18 }, bip: { '1B': 1.1, '2B': 1.15, '3B': 1.15, HR: 1.3 } }, // 2.16: fewer balls, more strikes and more hits (user)
    // 2.17: chase pitches get clearly more swings and misses (user)
    pitch_around: { label: '유인구 승부', pitch: { ball: 1.2, called_strike: 0.78, swinging_strike: 1.35, in_play: 0.8 }, bip: { '2B': 0.9, '3B': 0.9, HR: 0.8, OUT: 1.03 } },
  },
};
// 2.19: team-wide game plans (user request 2026-11-13). Each side picks one batting plan and one pitching plan
// before or during the game; they hold for every pitch until changed. A plan steers the whole lineup, so its
// effects are milder than an at-bat tactic, and a voted at-bat tactic replaces it for that plate appearance
// (a batting plan applies while the at-bat tactic is 기본 타격, a pitching plan while the approach is 기본 투구).
// early: only at counts before a strike or ball has piled up (fewer than 2 pitches seen).
export const PLANS = {
  offense: {
    normal: { label: '기본', detail: '타자마다 평소대로 칩니다.' },
    first_pitch: { label: '초구부터 적극 공략', detail: '빠른 카운트의 존 안 공을 놓치지 않습니다. 투구 수와 볼넷이 줄고, 빗맞은 타구도 늘어납니다.',
      early: { called_strike: 0.6, in_play: 1.35, foul: 1.1, swinging_strike: 1.1, ball: 0.92 }, earlyBip: { OUT: 1.12, '2B': 0.92, HR: 0.88 } },
    patient: { label: '공 길게 보기', detail: '2스트라이크 전에는 잘 치지 않고 공을 봅니다. 볼넷과 상대 투구 수가 늘고, 루킹 삼진도 늘어납니다.',
      beforeTwo: { swinging_strike: 0.75, foul: 0.8, in_play: 0.72, called_strike: 1.15, ball: 1.03 }, twoStrikes: { called_strike: 1.12 } },
    power: { label: '장타 노리기', detail: '크게 휘두릅니다. 홈런과 2루타가 늘고 헛스윙 삼진도 늘어납니다.',
      pitch: { swinging_strike: 1.2, in_play: 0.96 }, bip: { '1B': 0.93, '2B': 1.1, '3B': 1.05, HR: 1.25, OUT: 1.02 } },
    contact: { label: '맞히기 위주', detail: '짧게 쥐고 맞힙니다. 삼진이 줄고 인플레이가 늘지만 장타는 줄어듭니다.',
      pitch: { swinging_strike: 0.82, foul: 1.05, in_play: 1.06 }, bip: { '1B': 1.06, '2B': 0.9, '3B': 0.9, HR: 0.75 } },
  },
  defense: {
    normal: { label: '기본', detail: '투수마다 평소대로 던집니다.' },
    aggressive: { label: '공격적 투구', detail: '스트라이크를 먼저 던집니다. 볼넷과 투구 수가 줄지만 안타는 조금 늘어납니다.',
      pitch: { ball: 0.9, called_strike: 1.06, in_play: 1.05 }, bip: { '1B': 1.05, '2B': 1.07, '3B': 1.07, HR: 1.14 } },
    careful: { label: '신중한 투구', detail: '코너를 찌릅니다. 피안타와 장타가 줄지만 볼넷과 투구 수가 늘어 투수가 빨리 지칩니다.',
      pitch: { ball: 1.12, called_strike: 0.94, in_play: 0.92 }, bip: { '1B': 0.96, '2B': 0.94, '3B': 0.94, HR: 0.88 } },
  },
};
export const planOf = (g, side, role) => { const v = g?.plans?.[side]?.[role]; return PLANS[role][v] ? v : 'normal'; };
// The plans that apply to a plate appearance's pitches (none where a voted tactic replaces them).
const plansFor = (g, side, tactics) => ({
  offensePlan: tactics.offense === 'normal' ? planOf(g, side, 'offense') : 'normal',
  defensePlan: tactics.approach === 'standard' ? planOf(g, side === 'away' ? 'home' : 'away', 'defense') : 'normal',
});
// Set a side's plans (role 'offense' or 'defense'); returns a new state.
export function setPlan(state, side, role, value) {
  if (!PLANS[role]?.[value]) throw new Error('unknown plan');
  const g = structuredClone(state); g.plans = { ...(g.plans || {}), [side]: { ...(g.plans?.[side] || {}), [role]: value } }; return g;
}
const ALIGNMENTS = new Set(Object.keys(TACTICS.alignment));
const APPROACHES = new Set(['attack', 'pitch_around']);
// With a runner on third and fewer than two outs, an out in play is an outfield fly/line, an infield
// fly/pop, or a ground ball (Retrosheet shares), and the runner scores at the measured rate for each.
const R3_OUT_TYPES = (() => { const t = RUNNER_ON_THIRD_OUTS, n = t.outfieldAir.outs + t.infieldAir.outs + t.ground.outs;
  return { outfieldAir: t.outfieldAir.outs / n, infieldAir: t.infieldAir.outs / n, ground: t.ground.outs / n }; })();
const R3_SCORE_RATE = { outfieldAir: RUNNER_ON_THIRD_OUTS.outfieldAir.scored / RUNNER_ON_THIRD_OUTS.outfieldAir.outs,
  infieldAir: RUNNER_ON_THIRD_OUTS.infieldAir.scored / RUNNER_ON_THIRD_OUTS.infieldAir.outs, ground: RUNNER_ON_THIRD_OUTS.ground.scored / RUNNER_ON_THIRD_OUTS.ground.outs };
// Share of non-double-play outs in play that score the runner from third, as sacrifice fly / ground out RBI.
function runnerOnThirdRunShares(tactics, speed = 3) {
  const groundFactor = TACTICS.alignment[tactics?.alignment]?.groundRunFactor ?? 1, f = SPEED.tagUp[speedGrade(speed)];
  return { sacrificeFly: R3_OUT_TYPES.outfieldAir * R3_SCORE_RATE.outfieldAir * f, groundOutRbi: R3_OUT_TYPES.ground * R3_SCORE_RATE.ground * groundFactor * f,
    infieldAir: R3_OUT_TYPES.infieldAir * R3_SCORE_RATE.infieldAir };
}

// Runner speed (2.10, user decision 2026-11-12). player[13] is a speed grade 1 (slow) .. 5 (very fast), 3 when
// unknown; drafted from each player's career steals per time on first (data/runner-speed.json, can be set by
// hand). Assumed values, documented in docs/PITCH_ENGINE_DESIGN.md:
// - extra bases on hits: a single scores the runner from 2nd, or takes the runner from 1st to 3rd; a double
//   scores the runner from 1st (base chances near MLB rates, higher with two outs: runners go on contact);
// - double plays: a fast batter beats the relay more often;
// - tag-ups and ground-out runs from 3rd, bunt hits.
export const SPEED = {
  extra: { 1: 0.6, 2: 0.8, 3: 1, 4: 1.2, 5: 1.4 },
  dp: { 1: 1.3, 2: 1.15, 3: 1, 4: 0.85, 5: 0.7 },
  // 2.20 (user report: slow 카스트로 safe at 2nd on a short-stop grounder): the double-play share in the count
  // tables is over all balls in play, but only about one in five comes with a runner on 1st and fewer than two
  // outs, so in that situation it is scaled up (to about 13% of balls in play, ~9% of plate appearances, near
  // KBO/MLB GIDP rates). The runner on 1st's speed counts too (a slow runner is turned two more often).
  dpSituation: 1, // 2.21: the double plays in that situation come mostly from the fielder-based rule below (groundDp)
  dpRunner: { 1: 1.15, 2: 1.07, 3: 1, 4: 0.93, 5: 0.85 },
  // On a ground-ball out that is not a double play, the fielders often get the lead runner: the runner from 1st
  // is forced out at 2nd and the batter is safe at 1st (before 2.20 the runner always reached 2nd).
  forceAtSecond: { base: 0.55, runner: { 1: 1.3, 2: 1.15, 3: 1, 4: 0.85, 5: 0.7 } },
  // 2.21 (user: slow 디아즈 on 1st reached 2nd on a 2루수 땅볼): a ground-ball out with a runner on 1st and fewer than
  // two outs is resolved by who fields it (the fielder the play text names). turn: it becomes a double play
  // (x batter speed dp x runner dpRunner, at most 92%); otherwise force: the runner is forced out at 2nd and the
  // batter is safe (x runner forceAtSecond.runner, at most 95%); otherwise the batter is out and the runner moves
  // up (a slow roller). Middle infielders and the pitcher turn two most easily, the first baseman least. Tuned so
  // the double play comes in about 10-11% of plate appearances with a runner on 1st and fewer than two outs.
  groundDp: { turn: { P: 0.4, SS: 0.36, '2B': 0.36, '3B': 0.28, '1B': 0.18 }, force: { P: 0.7, SS: 0.7, '2B': 0.7, '3B': 0.7, '1B': 0.45 } },
  tagUp: { 1: 0.85, 2: 0.93, 3: 1, 4: 1.05, 5: 1.1 },
  buntHit: { 1: 0.4, 2: 0.8, 3: 1, 4: 1.25, 5: 1.5 },
  // 2.18 (user): a slow batter is thrown out on a bunt more often, and a bunt can become a double play (the lead
  // runner and the batter), mostly when the infield charges (in, or corners in) and the batter is slow.
  buntOut: { 1: 1.3, 2: 1.15, 3: 1, 4: 0.88, 5: 0.75 },
  buntDp: { base: 0.025, slow: { 1: 1.8, 2: 1.4, 3: 1, 4: 0.6, 5: 0.4 }, align: { infield_in: 2.2, corners_in: 1.6 } },
  // 2.22 (user: 박상준-type slow batters should beat out a bunt even less, and when they do reach it is more often
  // a fielder's error than a clean hit): share of a successful bunt that is scored ROE instead of a bunt hit.
  buntRoe: { 1: 0.4, 2: 0.2, 3: 0.1, 4: 0.05, 5: 0.02 },
  // base chance of the extra base: [fewer than two outs, two outs]
  // two outs (2.16, user): runners go on contact, so on a hit to the outfield they take two bases unless slow
  secondScoresOnSingle: [0.55, 0.92], firstToThirdOnSingle: [0.25, 0.75], firstScoresOnDouble: [0.4, 0.85],
  // infield single, runner on 2nd and 3rd base open: he takes 3rd (assumed; 2.14, user request). Nobody scores
  // from 2nd on an infield hit, and a runner on 3rd holds unless forced.
  secondToThirdOnInfieldSingle: [0.35, 0.55], // before 2.21; now by fielder (below)
  // 2.21 (user): on an infield hit the runner on 2nd (3rd open) takes 3rd depending on who fielded it: the third
  // baseman charged in and left the bag (often), the shortstop had the ball in front of the runner (rarely), the
  // right side is far from 3rd (often). [fewer than two outs, two outs] x runner speed (extra).
  secondToThirdOnInfieldHitBy: { '3B': [0.5, 0.7], SS: [0.15, 0.3], '2B': [0.6, 0.8], '1B': [0.6, 0.8], P: [0.3, 0.5] },
  // 2.21: infield hits need speed: share of singles that are infield hits = 12% x this.
  infieldHit: { 1: 0.4, 2: 0.7, 3: 1, 4: 1.3, 5: 1.6 },
  // outs in play before the third out (2.15, user request): on a ground out the runner on 2nd takes 3rd when
  // 3rd is open and he is not forced; on a fly out to the outfield he tags up to 3rd. Assumed.
  secondToThirdOnGroundOut: 0.6, secondToThirdOnFlyOut: 0.3,
};
export function speedGrade(v) { const n = Math.round(Number(v)); return n >= 1 && n <= 5 ? n : 3; }
const runnerSpeed = (team, name) => speedGrade(team?.players?.find(p => p[0] === name)?.[13]);

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

// Platoon (2.8): batters do worse against a pitcher throwing from their own side. Multipliers on the
// matchup targets, relative to the batter's season line (which is mostly against right-handers). Assumed
// values in the range of published MLB/KBO platoon splits; left-handed batters lose the most against
// left-handers. Three-quarter, sidearm and underhand pitchers widen the gap (x1.2 / x1.4 / x1.6 of the
// distance from 1; 2.9 added three-quarter).
// Keyed by the side the batter hits from, then the pitcher's arm. See docs/PITCH_ENGINE_DESIGN.md.
export const PLATOON = {
  R: { R: { avg: 0.985, iso: 0.97, k: 1.03, bb: 0.98 }, L: { avg: 1.035, iso: 1.07, k: 0.95, bb: 1.04 } },
  L: { R: { avg: 1.01, iso: 1.02, k: 0.98, bb: 1.01 }, L: { avg: 0.93, iso: 0.85, k: 1.13, bb: 0.92 } },
};
const SLOT_SPREAD = { over: 1, three: 1.2, side: 1.4, under: 1.6 };
export function platoonFactors(batter, pitcher) {
  if (!batter?.[12] || !pitcher) return null;
  const side = battingSide(batter, pitcher), arm = pitcher[6] === 'L' ? 'L' : 'R', base = PLATOON[side][arm];
  const spread = SLOT_SPREAD[pitcher[7]] || 1;
  return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, 1 + (v - 1) * spread]));
}

// Batter [name, pos, AVG, OBP, SLG, ...] against a pitcher, as targets per PA / per AB.
export function matchupTargets(batter, pitcher, league = KBO_LEAGUE) {
  const p = pitcherRates(pitcher, league);
  const avg = clamp(batter[2], 0.15, 0.4), obp = clamp(batter[3], avg + 0.01, 0.5), slg = clamp(batter[4], avg, 0.75);
  // Batter walks and strikeouts per PA when known (batter[10], batter[9]); otherwise walks from OBP - AVG
  // and a league-average strikeout rate.
  const batterBB = Number.isFinite(batter[10]) ? clamp(batter[10], 0.02, 0.2) : clamp((obp - avg) / (1 - avg), 0.02, 0.2);
  const batterK = Number.isFinite(batter[9]) ? clamp(batter[9], 0.05, 0.4) : league.k;
  const f = platoonFactors(batter, pitcher) || { avg: 1, iso: 1, k: 1, bb: 1 };
  return {
    avg: clamp(log5(avg, p.avg, league.avg) * f.avg, 0.12, 0.42),
    bb: clamp(log5(batterBB, p.bb, league.bb) * f.bb, 0.01, 0.25),
    k: clamp(log5(batterK, p.k, league.k) * f.k, 0.03, 0.5),
    iso: clamp((slg - avg) * f.iso, 0.03, 0.38),
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
  p = scale(p, off.vsApproach?.[tactics.approach]);
  const op = PLANS.offense[tactics.offensePlan] || {}, dp = PLANS.defense[tactics.defensePlan] || {};
  p = scale(p, op.pitch);
  if (b + s < 2) p = scale(p, op.early);
  if (s < 2) p = scale(p, op.beforeTwo); else p = scale(p, op.twoStrikes);
  p = scale(p, dp.pitch);
  return normalize(p);
}

function bipShares(count, profile, tactics) {
  const off = TACTICS.offense[tactics.offense] || {}, ali = TACTICS.alignment[tactics.alignment] || {}, app = TACTICS.approach[tactics.approach] || {};
  let p = scale(BASE_BIP[count], { '1B': profile.mHit, '2B': profile.mHit * profile.mPow, '3B': profile.mHit * profile.mPow, HR: profile.mHit * profile.mPow });
  p = scale(scale(scale(p, off.bip), ali.bip), app.bip);
  const op = PLANS.offense[tactics.offensePlan] || {}, dp = PLANS.defense[tactics.defensePlan] || {};
  const [b, s] = count.split('-').map(Number);
  p = scale(scale(p, op.bip), dp.bip);
  if (b + s < 2) p = scale(p, op.earlyBip);
  if (profile.defense) p = scale(p, profile.defense); // the fielding team's out-of-position fielders
  return normalize(p);
}

// Batted-ball outcome shares at a count for this game situation (results that cannot happen here,
// such as a double play with two outs, are folded into ordinary outs). Used for display.
export function inPlayShares(count, profile, tactics, { runnerOnFirst = false, runnerOnThird = false, outs = 0, batterSpeed = 3, thirdSpeed = 3, firstSpeed = 3 } = {}) {
  const p = { ...bipShares(count, profile, { offense: 'normal', alignment: 'standard', approach: 'standard', ...tactics }) };
  if (!(runnerOnFirst && outs < 2)) { p.OUT += p.DP; p.DP = 0; }
  else { const dp = Math.min(p.DP * SPEED.dpSituation * SPEED.dp[speedGrade(batterSpeed)] * SPEED.dpRunner[speedGrade(firstSpeed)], p.DP + p.OUT * 0.6); p.OUT -= dp - p.DP; p.DP = dp; }
  p.OUT += p.SAC_BUNT; p.SAC_BUNT = 0;
  p.OUT += p.SAC_FLY; p.SAC_FLY = 0; p.GO_RBI = 0;
  if (runnerOnThird && outs < 2) {
    const r = runnerOnThirdRunShares(tactics, thirdSpeed), outs3 = p.OUT;
    p.SAC_FLY = outs3 * (r.sacrificeFly + r.infieldAir); p.GO_RBI = outs3 * r.groundOutRbi; p.OUT = outs3 - p.SAC_FLY - p.GO_RBI;
  }
  return normalize(p);
}

// Exact plate-appearance outcome probabilities from a count (Markov chain over the 12 counts).
// Used to calibrate players and to show each tactic's effect on the vote cards.
export function plateAppearanceOdds(profile, tactics, start = '0-0', situation = { bunting: false }) {
  const reach = Object.fromEntries(COUNTS.map(c => [c, 0]));
  reach[start] = 1;
  const out = { BB: 0, K: 0, HBP: 0, bip: Object.fromEntries(IN_PLAY_OUTCOMES.map(k => [k, 0])), bunt: { sacrifice: 0, hit: 0, roe: 0, out: 0, fieldersChoice: 0, doublePlay: 0 } };
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
// Damped steps: with real pitchers (very few walks and many strikeouts) full steps overshoot and never settle.
const CAL_ITERS = 120, CAL_STEP = 0.5;
export function calibrateMatchup(batter, pitcher, league = KBO_LEAGUE) {
  const target = matchupTargets(batter, pitcher, league);
  const m = { ...NEUTRAL_PROFILE }, neutral = { offense: 'normal', alignment: 'standard', approach: 'standard' };
  for (let i = 0; i < CAL_ITERS; i++) {
    const got = summarize(plateAppearanceOdds(m, neutral));
    m.mBall = clamp(m.mBall * (target.bb / got.bb) ** CAL_STEP, 0.2, 5);
    m.mWhiff = clamp(m.mWhiff * (target.k / got.k) ** CAL_STEP, 0.2, 5);
    m.mHit = clamp(m.mHit * (target.avg / got.avg) ** CAL_STEP, 0.2, 5);
    m.mPow = clamp(m.mPow * (target.iso / got.iso) ** CAL_STEP, 0.05, 5); // low floor: slap hitters with ISO near .045
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
// 2.23 (user: bunts should succeed as a sacrifice more and as a hit less, across every batter): on top of the
// 2025 MLB sample rate (BUNT_IN_PLAY), sacrifices are worth 1.25x and hits 0.75x before speed and alignment.
const BUNT_TENDENCY = { sacrifice: 1.25, hit: 0.75 };
function buntResultShares(tactics, batterSpeed = 3) {
  const sp = speedGrade(batterSpeed);
  const p = scale(scale(scale(BUNT_RESULT, TACTICS.alignment[tactics.alignment]?.bunt), { hit: SPEED.buntHit[sp], out: SPEED.buntOut[sp] }), BUNT_TENDENCY);
  p.doublePlay = SPEED.buntDp.base * SPEED.buntDp.slow[sp] * (SPEED.buntDp.align[tactics.alignment] || 1);
  // 2.22: of a bunt that reaches base, a slow batter's is more often a fielder's error than a clean hit.
  p.roe = p.hit * SPEED.buntRoe[sp];
  p.hit -= p.roe;
  return normalize(p);
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
// Fielders out of their position group: an outfielder (or catcher) in the infield, an infielder (or
// catcher) in the outfield. Read from roster.positions (name -> position) and the player's 2026 positions
// in player[11] (or his listed position / group in player[1]). DH and pitchers are not fielders here.
const POS_GROUP = { C: 'C', '1B': 'IF', '2B': 'IF', '3B': 'IF', SS: 'IF', IF: 'IF', LF: 'OF', CF: 'OF', RF: 'OF', OF: 'OF' };
export function misplacedFielders(team) {
  const out = { infield: 0, outfield: 0 };
  if (!team?.positions) return out;
  for (const i of team.order || []) {
    const p = team.players[i], at = POS_GROUP[team.positions[p[0]]];
    const own = new Set((Array.isArray(p[11]) && p[11].length ? p[11] : [p[1]]).map(x => POS_GROUP[x]).filter(Boolean));
    if (!at || !own.size || at === 'C' || own.has(at)) continue;
    out[at === 'IF' ? 'infield' : 'outfield']++;
  }
  return out;
}
// Assumed effect per misplaced fielder on the batting side's balls in play (user decision 2026-11-11):
// an infielder out of place doubles errors / fielder's choices and lets a few more grounders through;
// an outfielder out of place gives up more extra bases. Multiplied per misplaced fielder.
export const MISPLACED_EFFECT = { infield: { ROE_FC: 2.0, '1B': 1.05, DP: 0.85 }, outfield: { ROE_FC: 1.5, '1B': 1.03, '2B': 1.12, '3B': 1.25 } };
function defenseFactors(team) {
  const m = misplacedFielders(team), f = {};
  for (const where of ['infield', 'outfield']) for (const [k, v] of Object.entries(MISPLACED_EFFECT[where])) f[k] = (f[k] ?? 1) * v ** m[where];
  return m.infield + m.outfield ? f : null;
}

export function createGame({ awayId, homeId, seed, roster, league = KBO_LEAGUE, trials = PITCH_TRIALS, manual = null, plans = null }) {
  const profiles = {};
  for (const [side, teamId, oppId] of [['away', awayId, homeId], ['home', homeId, awayId]]) {
    const pitcher = roster[oppId].pitcher, defense = defenseFactors(roster[oppId]);
    // Only the batting order bats (the lineup is fixed once the game starts), so bench players get no profile.
    // A batter is calibrated against the pitcher with a normal defense; the fielding team's misplaced
    // fielders then add to his balls in play.
    const batting = new Set(roster[teamId].order);
    profiles[side] = roster[teamId].players.map((batter, i) => {
      if (!batting.has(i)) return null;
      const prof = calibrateMatchup(batter, pitcher, league);
      return defense ? { ...prof, defense } : prof;
    });
  }
  return {
    engine: ENGINE_VERSION, awayId, homeId, seed: seed >>> 0, status: 'running', away: 0, home: 0, manual: manual || {}, plans: plans || {},
    innings: [], plays: [], bat: {}, idx: { away: 0, home: 0 }, inning: 1, half: 'away', halfPA: 0, outs: 0, base: [null, null, null],
    tiebreak: null, pitchNo: 0, pa: null, profiles, trials,
    // Who is pitching for each fielding side: -1 = the starter, else an index into roster[team].bullpen.
    // relief[side][i] holds batting-order profiles against reliever i (filled when he comes in).
    mound: { away: newMound(), home: newMound() }, relief: { away: {}, home: {} }, changes: [], pitching: {},
  };
}

// ---------- pitchers (2.8): fatigue and pitching changes ----------
// Starters tire after 75 pitches, relievers after 25 (assumed). Past that, with x = pitches past fresh / 15, the
// fatigue factor f = 1 + 0.03x + 0.008x^2 keeps growing with no cap (2.12, user decision: no pitch limit; the
// more he throws, the worse he gets): control (walks x f), stuff (hits x f, strikeouts / (1 + 0.5(f - 1))) and
// velocity (1 km/h less per 12 pitches past fresh, up to 8). About 1.09 at 105 pitches, 1.25 at 135, 1.47 at 165.
// A side flagged manual (g.manual[side]: the fan's own team in an AI match, a live-game side with fans) is
// changed only when asked; other sides change automatically and deterministically (no random draws) before a
// plate appearance from pitch counts, runs and the inning; there is no fixed closer.
const newMound = () => ({ cur: -1, used: [], pc: { '-1': 0 }, outs: { '-1': 0 }, runs: { '-1': 0 }, enteredHalf: '1-away-x' });
export const FATIGUE = { starterFresh: 75, relieverFresh: 25, per15: 0.03, per15sq: 0.008, kmhPer: 12, kmhMax: 8 };
// Fatigue of the pitcher on the mound for this fielding side: { f, kmh } (f = 1 when fresh).
// The approach and how loose the command is: wilder pitchers (walk rate) and tired ones miss their spot more.
function aimFor(g, fs, pitcher, tactics) {
  const bb = Number(pitcher?.[2]) || 0.09, f = fatigueOf(g, fs).f;
  return { approach: tactics?.approach || 'standard', wobble: Math.max(0.06, Math.min(0.45, 0.14 + (bb - 0.09) * 1.5 + (f - 1) * 0.6)), twoStrikes: g.pa?.strikes === 2 };
}
export function fatigueOf(g, fieldSide) {
  const m = g.mound?.[fieldSide]; if (!m) return { f: 1, kmh: 0, pc: 0 };
  const pc = m.pc[m.cur] || 0, over = Math.max(0, pc - (m.cur < 0 ? FATIGUE.starterFresh : FATIGUE.relieverFresh)), x = over / 15;
  return { f: 1 + FATIGUE.per15 * x + FATIGUE.per15sq * x * x, kmh: Math.min(FATIGUE.kmhMax, Math.floor(over / FATIGUE.kmhPer)), pc };
}
const fieldSideOf = battingSide => (battingSide === 'away' ? 'home' : 'away');
export function currentPitcher(g, roster, fieldSide) {
  const m = g.mound?.[fieldSide], team = roster[sideTeam(g, fieldSide)];
  return !m || m.cur < 0 ? team.pitcher : team.bullpen?.[m.cur] || team.pitcher;
}
// The batter's profile against whoever is pitching now, with fatigue applied.
export function currentProfile(g, roster, battingSide, index) {
  const fs = fieldSideOf(battingSide), m = g.mound?.[fs];
  const base = !m || m.cur < 0 ? g.profiles[battingSide][index] : g.relief?.[battingSide]?.[m.cur]?.[index] ?? g.profiles[battingSide][index];
  if (!base || !m) return base;
  const { f } = fatigueOf(g, fs);
  if (f <= 1) return base;
  return { ...base, mHit: base.mHit * f, mBall: base.mBall * f, mWhiff: base.mWhiff / (1 + 0.5 * (f - 1)) };
}
const quality = p => (p?.[3] ?? 0.2) - (p?.[2] ?? 0.09) - 0.5 * (p?.[1] ?? 0.26);
// The reliever to bring in before the next plate appearance, or null to stay with the current pitcher.
export function plannedChange(g, roster) {
  if (g.status !== 'running' || g.pa) return null;
  const fs = fieldSideOf(g.half), m = g.mound?.[fs], team = roster[sideTeam(g, fs)];
  const pen = team.bullpen || [];
  if (!m || !pen.length) return null;
  const free = pen.map((_, i) => i).filter(i => !m.used.includes(i) && i !== m.cur);
  if (!free.length) return null;
  // A requested change may be tied to one PA or to the first PA of a future half-inning.
  const request = g.forcedChange?.[fs], asked = typeof request === 'number' ? request : request?.index;
  const target = typeof request === 'object' ? request.target : null;
  const targetMatches = !target || (target.paNo != null
    ? target.paNo === g.plays.length + 1
    : target.inning === g.inning && target.half === g.half && (g.halfPA || 0) === 0);
  if (asked != null && free.includes(asked) && targetMatches) return { side: fs, from: currentPitcher(g, roster, fs)?.[0], to: pen[asked][0], index: asked, pitches: m.pc[m.cur] || 0, requested: true };
  if (g.manual?.[fs]) return null; // the fans manage this side (2.12)
  const pc = m.pc[m.cur] || 0, runs = m.runs[m.cur] || 0, outs = m.outs[m.cur] || 0;
  const halfStart = g.outs === 0 && !g.base.some(Boolean) && m.enteredHalf !== `${g.inning}-${g.half}`;
  let go = false;
  if (m.cur < 0) go = pc >= 105 || (halfStart && pc >= 92) || runs >= 7 || (g.inning >= 5 && runs >= 5 && halfStart);
  else go = pc >= 35 || runs >= 3 || (halfStart && outs >= 3);
  if (!go) return null;
  // Late and close: the best arms; otherwise save them. Among the two picked, the better platoon fit
  // for the next three batters wins.
  const lead = fs === 'home' ? g.home - g.away : g.away - g.home, highLeverage = g.inning >= 7 && Math.abs(lead) <= 3;
  const ranked = free.sort((a, b) => quality(pen[b]) - quality(pen[a]) || a - b);
  const group = highLeverage ? ranked.slice(0, 2) : ranked.slice(-2);
  const bat = roster[sideTeam(g, g.half)], next = [0, 1, 2].map(k => bat.players[bat.order[(g.idx[g.half] + k) % bat.order.length]]);
  const fit = i => next.filter(b => b?.[12] && battingSide(b, pen[i]) === (pen[i][6] === 'L' ? 'L' : 'R')).length;
  const pick = group.reduce((a, b) => (fit(b) > fit(a) ? b : a));
  return { side: fs, from: currentPitcher(g, roster, fs)?.[0], to: pen[pick][0], index: pick, pitches: pc };
}
function applyChange(g, roster) {
  const c = plannedChange(g, roster);
  if (!c) return null;
  const m = g.mound[c.side], team = roster[sideTeam(g, c.side)], reliever = team.bullpen[c.index];
  if (g.forcedChange) delete g.forcedChange[c.side];
  m.used.push(c.index); m.cur = c.index; m.pc[c.index] = 0; m.outs[c.index] = 0; m.runs[c.index] = 0; m.enteredHalf = `${g.inning}-${g.half}`;
  // Batting-order profiles against him (same calibration as against the starter).
  const batSide = g.half, bat = roster[sideTeam(g, batSide)], defense = defenseFactors(team);
  g.relief[batSide] = g.relief[batSide] || {};
  g.relief[batSide][c.index] = bat.players.map((b, i) => (bat.order.includes(i) ? (prof => (defense ? { ...prof, defense } : prof))(calibrateMatchup(b, reliever)) : null));
  const change = { inning: g.inning, half: g.half, side: c.side, from: c.from, to: c.to, pitches: c.pitches, paNo: g.plays.length + 1, requested: Boolean(c.requested) };
  g.changes.push(change);
  return change;
}
function discardExpiredChange(g) {
  for (const [side, request] of Object.entries(g.forcedChange || {})) {
    if (!request || typeof request !== 'object' || !request.target) continue; // older saved games store an index.
    const t = request.target;
    const targetKey=t.inning*2+(t.half==='home'?1:0),currentKey=g.inning*2+(g.half==='home'?1:0);
    const expired = t.paNo != null
      ? g.plays.length + 1 > t.paNo
      : currentKey > targetKey || (currentKey === targetKey && (g.halfPA || 0) > 0);
    if (expired) delete g.forcedChange[side];
  }
}
// Relievers the fielding side can still bring in: [{index, name, throws, slot, avg, bb, k, fit}], where fit
// counts the next three batters who hit from the same side as he throws (the matchup favours him).
export function availableRelievers(g, roster, fieldSide) {
  const m = g.mound?.[fieldSide], pen = roster[sideTeam(g, fieldSide)]?.bullpen || [];
  if (!m) return [];
  const batSide = fieldSide === 'away' ? 'home' : 'away', bat = roster[sideTeam(g, batSide)];
  const start = g.pa && g.pa.side === batSide ? g.idx[batSide] : g.idx[batSide];
  const next = [0, 1, 2].map(k => bat.players[bat.order[(start + k) % bat.order.length]]);
  return pen.map((p, i) => ({ index: i, name: p[0], throws: p[6] === 'L' ? 'L' : 'R', slot: p[7] || 'over', avg: p[1], bb: p[2], k: p[3],
    fit: next.filter(b => b?.[12] && battingSide(b, p) === (p[6] === 'L' ? 'L' : 'R')).length }))
    .filter(r => !m.used.includes(r.index) && r.index !== m.cur);
}
// Ask for a reliever: he takes over before the next plate appearance (pure; returns a new state).
export function requestPitcherChange(state, roster, fieldSide, index, target = null) {
  const g = structuredClone(state);
  if (!availableRelievers(g, roster, fieldSide).some(r => r.index === index)) throw new Error('that reliever cannot come in');
  if (target?.paNo != null && (g.pa?.no >= target.paNo || g.plays.length + 1 > target.paNo)) throw new Error('that plate appearance has already started');
  if (target?.inning != null) {
    if (target.inning > MAX_INNINGS) throw new Error('game has no next half-inning');
    const currentKey = g.inning * 2 + (g.half === 'home' ? 1 : 0), targetKey = target.inning * 2 + (target.half === 'home' ? 1 : 0);
    if (currentKey > targetKey || (currentKey === targetKey && (g.pa || (g.halfPA || 0) > 0))) throw new Error('that half-inning has already started');
  }
  g.forcedChange = { ...(g.forcedChange || {}), [fieldSide]: target ? { index, target } : index };
  return g;
}
export function cancelPitcherChange(state, fieldSide) { const g = structuredClone(state); if (g.forcedChange) delete g.forcedChange[fieldSide]; return g; }

function pitcherLine(g, name) { return g.pitching[name] || (g.pitching[name] = { outs: 0, h: 0, r: 0, bb: 0, k: 0, hr: 0, pc: 0 }); }

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

// After a plate appearance: who bats next and whether a new half-inning starts (null when the game is
// over). Screens show this between plate appearances; `gapMs` is the extra wait before the next step.
export function nextUp(before, game, roster) {
  if (game.status !== 'running' || game.pa) return null;
  const side = game.half, team = roster[sideTeam(game, side)], slot = game.idx[side] % team.order.length;
  const newHalf = before.half !== game.half || before.inning !== game.inning;
  // A pitching change before this batter is announced too (and takes a little longer).
  const change = plannedChange(game, roster);
  return { inning: game.inning, side, slot: slot + 1, batter: team.players[team.order[slot]][0], newHalf,
    change: change ? { from: change.from, to: change.to, pitches: change.pitches } : null,
    gapMs: BATTER_INTRO_MS + (newHalf ? HALF_INNING_MS : 0) + (change ? PITCHING_CHANGE_MS : 0) };
}

export function isTacticalSituation(g) {
  if (g.outs >= 3) return false;
  const runners = g.base.filter(Boolean).length;
  const lateClose = g.inning >= 7 && Math.abs(g.away - g.home) <= 2 && runners >= 1;
  return Boolean(g.base[1] || g.base[2]) || Boolean(g.base[0] && g.outs < 2) || runners >= 2 || lateClose;
}

function startPlateAppearance(g, roster) {
  if (!g.mound) Object.assign(g, { mound: { away: newMound(), home: newMound() }, relief: { away: {}, home: {} }, changes: [], pitching: {} });
  discardExpiredChange(g);
  const change = applyChange(g, roster);
  const side = g.half, team = roster[sideTeam(g, side)], order = team.order;
  const batterIndex = order[g.idx[side] % order.length];
  g.idx[side]++;
  g.pa = {
    no: g.plays.length + 1, side, inning: g.inning, batterIndex, batter: team.players[batterIndex][0],
    balls: 0, strikes: 0, pitches: [], offense: 'normal', alignment: 'standard', approach: 'standard',
    tactical: false, phasesDone: [], votes: [], ibb: false,
    basesBefore: [...g.base], outsBefore: g.outs, scoreBefore: { away: g.away, home: g.home },
    pitcher: currentPitcher(g, roster, fieldSideOf(side))?.[0], change,
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
    if (b[1] || b[2] || b.filter(Boolean).length >= 2) offense.push(choice('contact', '컨택 타격', '헛스윙을 줄이고 맞히는 데 집중합니다. 장타와 볼넷은 줄어듭니다.'));
    if (canBunt(g)) offense.push(choice('bunt', '희생번트', '스트라이크에 번트를 대고 볼은 골라냅니다. 2스트라이크 번트 파울은 삼진입니다.'));
    offense.push(choice('aggressive', '강공', '장타를 노립니다. 헛스윙이 늘고 볼넷과 단타는 줄어듭니다.'));
    defense.push(choice('standard', '기본 수비', '기본 위치에서 기본 투구로 승부합니다.'));
    if (b[0] && outs < 2) defense.push(choice('double_play', '병살 대비 수비', '병살 가능성을 높이는 대신 땅볼 안타가 조금 늘어납니다.'));
    if (canBunt(g)) defense.push(choice('corners_in', '번트 대비 수비', '코너 내야수가 전진해 번트 성공을 줄입니다.'));
    if (b[2] && outs < 2) defense.push(choice('infield_in', '내야 전진 수비', '3루 주자의 홈 득점을 막습니다. 땅볼 안타가 늘어납니다.'));
    defense.push(choice('outfield_deep', '외야 장타 대비', '외야가 물러나 2루타·3루타를 줄입니다. 짧은 안타는 늘어납니다.'));
    defense.push(choice('attack', '정면 승부', '스트라이크존으로 승부합니다. 볼넷이 줄지만 맞으면 장타가 늘어납니다.'));
    defense.push(choice('pitch_around', '유인구 승부', '유인구로 승부합니다. 볼넷이 늘지만 헛스윙이 늘고 장타는 덜 맞습니다.'));
    if (!b[0]) defense.push(choice('intentional_walk', '고의사구', '타자를 바로 1루로 보냅니다.'));
  } else {
    const off = TACTICS.offense[g.pa.offense].label, def = [TACTICS.alignment[g.pa.alignment].label, TACTICS.approach[g.pa.approach].label].join(' · ');
    offense.push(choice('keep', `현재 작전 유지 (${off})`, '지금 작전을 그대로 이어 갑니다.'));
    if (phase === 'two_strikes') {
      if (g.pa.offense !== 'contact') offense.push(choice('contact', '컨택으로 전환', '삼진을 피하는 데 집중합니다.'));
      if (g.pa.offense === 'bunt') offense.push(choice('normal', '번트 포기 · 기본 타격', '2스트라이크 번트 파울은 삼진이라 강공으로 바꿉니다.'));
      else if (g.pa.offense !== 'aggressive') offense.push(choice('aggressive', '강공으로 전환', '장타를 노립니다.'));
    } else {
      offense.push(choice('wait', '기다리기', '볼넷을 노리고 웬만하면 치지 않습니다.'));
      if (g.pa.offense !== 'aggressive') offense.push(choice('aggressive', '노려 치기', '카운트가 유리할 때 장타를 노립니다.'));
    }
    defense.push(choice('keep', `현재 작전 유지 (${def})`, '지금 수비와 투구를 그대로 이어 갑니다.'));
    // Only approaches that differ from the current one (it is already offered as "현재 작전 유지").
    if (g.pa.approach !== 'attack') defense.push(choice('attack', '정면 승부', '스트라이크존으로 승부합니다.'));
    if (g.pa.approach !== 'pitch_around') defense.push(choice('pitch_around', '유인구 승부', '유인구로 승부합니다.'));
    if (g.pa.approach !== 'standard') defense.push(choice('standard_approach', '기본 투구로 전환', '수비 위치는 그대로 두고 기본 투구로 돌아갑니다.'));
    if (phase === 'three_balls' && !b[0]) defense.push(choice('intentional_walk', '고의사구', '타자를 바로 1루로 보냅니다.'));
  }
  // Show what each choice does to this plate appearance from the current count.
  const from = phase === 'pre_pa' ? '0-0' : `${g.pa.balls}-${g.pa.strikes}`;
  const current = phase === 'pre_pa' ? { offense: 'normal', alignment: 'standard', approach: 'standard' } : { offense: g.pa.offense, alignment: g.pa.alignment, approach: g.pa.approach };
  const profile = batterProfile(g, roster, phase === 'pre_pa' ? null : g.pa);
  const side = phase === 'pre_pa' ? g.half : g.pa.side, withPlans = t => ({ ...t, ...plansFor(g, side, t) });
  for (const c of offense) c.odds = choiceOdds(g, profile, withPlans(applyChoice(current, 'offense', c.id)), from);
  for (const c of defense) c.odds = choiceOdds(g, profile, withPlans(applyChoice(current, 'defense', c.id)), from);
  return { phase, offenseTeamId: offenseTeamId(g), defenseTeamId: defenseTeamId(g), offenseChoices: offense, defenseChoices: defense, count: from };
}

function applyChoice(tactics, role, id) {
  const t = { ...tactics };
  if (!id || id === 'keep') return t;
  if (role === 'offense') { t.offense = id; return t; }
  if (id === 'intentional_walk') { t.ibb = true; return t; }
  if (id === 'standard') { t.alignment = 'standard'; t.approach = 'standard'; return t; }
  if (id === 'standard_approach') { t.approach = 'standard'; return t; }
  if (ALIGNMENTS.has(id)) t.alignment = id; else if (APPROACHES.has(id)) t.approach = id;
  return t;
}

// The profile a ballot is rated with (also used by the AI manager): the coming batter against whoever will pitch to him.
export function batterProfileFor(g, roster) { return batterProfile(g, roster, g.pa); }
function batterProfile(g, roster, pa) {
  const side = pa ? pa.side : g.half, order = roster[sideTeam(g, side)].order;
  const index = pa ? pa.batterIndex : order[g.idx[side] % order.length];
  if (!pa) {
    // Before the plate appearance: if a change is coming, rate the batter against the reliever.
    const c = plannedChange(g, roster);
    if (c) { const team = roster[sideTeam(g, c.side)], prof = calibrateMatchup(roster[sideTeam(g, side)].players[index], team.bullpen[c.index]), d = defenseFactors(team); return d ? { ...prof, defense: d } : prof; }
  }
  return currentProfile(g, roster, side, index);
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

// Which side of the plate the batter stands on: player[12] is 'R', 'L' or 'S' (switch: opposite the
// pitcher's arm, pitcher[6] 'R' or 'L', right-handed when unknown). Right-handed batters stand on the
// left of the zone as drawn (broadcast view), left-handed on the right.
export function battingSide(batter, pitcher) {
  const b = batter?.[12];
  if (b === 'L') return 'L';
  if (b === 'S') return pitcher?.[6] === 'L' ? 'R' : 'L';
  return 'R';
}

// ---------- Pitch locations (display only) ----------
// Where each pitch type usually goes, as MLB Statcast league-wide tendencies (approximate means and
// spreads in feet, catcher's view; not KBO or per-pitcher data). mx is toward the pitcher's ARM side
// (+) or glove side (-); mz is height above the ground. zone: share of that type thrown in the zone;
// whiff: swinging-strike share per swing. Fastballs ride up, sliders and sweepers go low to the glove
// side, changeups and splitters low to the arm side, curves lowest. See docs/PITCH_ENGINE_DESIGN.md.
const PITCH_SHAPES = {
  fastball: { mx: 0.10, mz: 2.75, sx: 0.80, sz: 0.65, zone: 0.55, whiff: 0.20 },
  sinker: { mx: 0.35, mz: 2.25, sx: 0.80, sz: 0.65, zone: 0.53, whiff: 0.13 },
  cutter: { mx: -0.30, mz: 2.40, sx: 0.80, sz: 0.65, zone: 0.50, whiff: 0.23 },
  slider: { mx: -0.50, mz: 1.90, sx: 0.85, sz: 0.70, zone: 0.43, whiff: 0.33 },
  sweeper: { mx: -0.65, mz: 2.00, sx: 0.85, sz: 0.70, zone: 0.42, whiff: 0.32 },
  curve: { mx: -0.20, mz: 1.60, sx: 0.85, sz: 0.75, zone: 0.42, whiff: 0.30 },
  changeup: { mx: 0.40, mz: 1.75, sx: 0.80, sz: 0.65, zone: 0.38, whiff: 0.31 },
  splitter: { mx: 0.20, mz: 1.60, sx: 0.80, sz: 0.65, zone: 0.35, whiff: 0.35 },
};
const PITCH_SHAPE_OF = { '직구': 'fastball', '포심': 'fastball', '투심': 'sinker', '싱커': 'sinker', '커터': 'cutter', '슬라이더': 'slider', '스위퍼': 'sweeper', '커브': 'curve', '너클커브': 'curve', '체인지업': 'changeup', '포크': 'splitter', '스플리터': 'splitter' };
export const pitchShape = type => PITCH_SHAPES[PITCH_SHAPE_OF[type]] || PITCH_SHAPES.fastball;
// Zone and drawn plot in feet: the zone (25-75 on the 0-100 plot) is ±0.83 ft wide, 1.5-3.5 ft high.
const ZONE_X = 0.83, ZONE_LO = 1.5, ZONE_HI = 3.5, PLOT_X = 1.58, PLOT_LO = 0.6, PLOT_HI = 4.4;
// Where a home-run pitch is drawn (user request 2026-11-12: no homers off balls). The zone is x 25-75, y 25-75
// on the plot. A pitch drawn outside moves just inside the zone edge; about 1 in 50 stays just off it (a pitch on
// the black). Uses a hash, not the random stream.
// 2026-11-13 (user report: a double off a pitch well off the plate): hits get the same treatment, keeping a
// pitch just off the zone only rarely: home run 2%, triple 3%, double 4%, single 12% (a bloop off a chase).
const HIT_OFF_ZONE = { HR: 0.02, '3B': 0.03, '2B': 0.04, '1B': 0.12 };
function homeRunSpot(pitch, seed, pitchNo, keep = 0.02) {
  const x = Number(pitch.x), y = Number(pitch.y), inside = x >= 25 && x <= 75 && y >= 25 && y <= 75;
  if (inside || !Number.isFinite(x) || !Number.isFinite(y)) return { x, y };
  const onBlack = hashUnit(seed >>> 0, pitchNo * 13 + 7) < keep, lo = onBlack ? 23 : 26.5, hi = onBlack ? 77 : 73.5;
  const clamp = v => Math.round(Math.min(hi, Math.max(lo, v)) * 10) / 10;
  return { x: clamp(x), y: clamp(y) };
}
const toPlot = (px, pz) => ({ x: Math.round((50 + px / ZONE_X * 25) * 10) / 10, y: Math.round((50 - (pz - 2.5) * 25) * 10) / 10 });
const erf = x => { const t = 1 / (1 + 0.3275911 * Math.abs(x)), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
const cdf = x => 0.5 * (1 + erf(x / Math.SQRT2));
function invCdf(p) { // Acklam's rational approximation
  p = Math.min(1 - 1e-9, Math.max(1e-9, p));
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - 0.02425) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
// One uniform draw u -> a normal(mu, sd) value kept inside [lo, hi].
const truncNormal = (u, mu, sd, lo, hi) => { const a = cdf((lo - mu) / sd), b = cdf((hi - mu) / sd); return Math.min(hi, Math.max(lo, mu + sd * invCdf(a + u * (b - a)))); };

// A pitch's location from its type, the pitcher's arm and the call. Called strikes land in the zone;
// balls out of it, on the side where that pitch type usually misses; swings (whiffs 55%, fouls 28%,
// balls in play 18%) are sometimes chases just off the zone. Three uniform draws (u1-u3) for a ball,
// two for anything else, as before.
// Where the catcher set up, by the pitching approach (display only; user request 2026-11-12). With 유인구 승부
// the pitcher works the edges and just off the plate; with 정면 승부 he comes into the zone. Command is not
// perfect: with chance aim.wobble (higher for wild or tired pitchers) the pitch misses the spot - a 유인구
// that leaks over the middle, or a 정면 승부 pitch that misses just off the plate. Uses only the draws already
// made for the location (a hash of them for the extra choice), so game results never change.
function aimedSpot(call, kind, aim, u1, u2) {
  const approach = aim?.approach, wobble = aim?.wobble ?? 0.15;
  // Display only, result unchanged (2.23, user): a called third strike is rarely taken on a pitch over the
  // heart of the plate, whatever the tactic - mostly drawn to the edge of the zone, a true "down the middle" take now and then.
  if (kind === 'called_strike' && aim?.twoStrikes) {
    const w = hashUnit(Math.floor(u1 * 4294967295) >>> 0, Math.floor(u2 * 65535));
    return w < 0.85 ? 'edge' : 'middle';
  }
  if (approach !== 'pitch_around' && approach !== 'attack') return null;
  const w = hashUnit(Math.floor(u1 * 4294967295) >>> 0, Math.floor(u2 * 65535)), missed = w < wobble;
  const inZone = call !== 'ball' && call !== 'ibb';
  // 유인구: strikes on the black, balls just off the plate where batters chase; a miss hangs over the middle
  // or sails well off the plate.
  if (approach === 'pitch_around') return inZone ? (missed ? 'middle' : 'edge') : (missed ? 'far' : 'near');
  return inZone ? (missed ? 'edge' : 'middle') : (missed ? 'far' : 'near');
}
function pitchLocation(shape, call, kind, lefty, awayFromBatter, u1, u2, u3, aim = null) {
  const spot = aimedSpot(call, kind, aim, u1, u2);
  const mx = lefty ? shape.mx : -shape.mx, { mz, sx, sz } = shape; // right-handers' arm side is the catcher's left
  const outside = (side, a, b, near) => {
    const reach = near ? 0.4 : 9;
    if (side < 2) { const px = side === 0 ? truncNormal(a, mx, sx, Math.max(-PLOT_X, -ZONE_X - reach), -ZONE_X - 0.04) : truncNormal(a, mx, sx, ZONE_X + 0.04, Math.min(PLOT_X, ZONE_X + reach)); return toPlot(px, truncNormal(b, mz, sz, ZONE_LO, ZONE_HI)); }
    const pz = side === 2 ? truncNormal(a, mz, sz, Math.max(PLOT_LO, ZONE_LO - reach), ZONE_LO - 0.04) : truncNormal(a, mz, sz, ZONE_HI + 0.04, Math.min(PLOT_HI, ZONE_HI + reach));
    return toPlot(truncNormal(b, mx, sx, -ZONE_X, ZONE_X), pz);
  };
  // Which edge a miss goes past, in proportion to how much of this pitch type's spread lies beyond it.
  const pickSide = u => { // -> [edge 0 left, 1 right, 2 low, 3 high; leftover uniform]
    const m = [cdf((-ZONE_X - mx) / sx), 1 - cdf((ZONE_X - mx) / sx), cdf((ZONE_LO - mz) / sz), 1 - cdf((ZONE_HI - mz) / sz)];
    let x = u * m.reduce((s, v) => s + v, 0);
    for (let i = 0; i < 4; i++) { if (x < m[i]) return [i, x / m[i]]; x -= m[i]; }
    return [3, 0.5]; // with the leftover of u, uniform again, for reuse as a draw
  };
  if (call === 'ball' || call === 'ibb') {
    if (call === 'ibb') return toPlot(awayFromBatter * 1.42, 2.6 + (u1 - 0.5) * 0.6); // the catcher stands wide
    return outside(pickSide(u1)[0], u2, u3, spot === 'near');
  }
  // 유인구: swings come more often on pitches out of the zone; 정면 승부: fewer (display only).
  const chaseBase = { swinging_strike: 0.55, foul: 0.28, in_play: 0.18 }[kind] || 0;
  const chase = Math.min(0.85, chaseBase * (aim?.approach === 'pitch_around' && spot === 'edge' ? 1.35 : aim?.approach === 'attack' && spot === 'middle' ? 0.5 : 1));
  if (u1 < chase) { const [side, rest] = pickSide(u1 / chase); return outside(side, rest, u2, true); }
  const v = chase ? (u1 - chase) / (1 - chase) : u1;
  if (spot === 'middle') // over the heart of the plate: the inner half of the zone
    return toPlot(truncNormal(v, mx * 0.4, sx * 0.6, -ZONE_X * 0.5, ZONE_X * 0.5), truncNormal(u2, (ZONE_LO + ZONE_HI) / 2, sz * 0.6, ZONE_LO + 0.5, ZONE_HI - 0.5));
  if (spot === 'edge') { // on the black: the outer band of the zone, on the side this pitch type breaks to
    const band = 0.28, side = (mx >= 0 ? 1 : -1) * (v < 0.7 ? 1 : -1), low = u2 < 0.65;
    const x = side * (ZONE_X - 0.06 - band * (v < 0.7 ? v / 0.7 : (v - 0.7) / 0.3)), z = low ? ZONE_LO + 0.06 + band * u2 / 0.65 : ZONE_HI - 0.06 - band * (u2 - 0.65) / 0.35;
    return toPlot(x, (u2 * 7) % 1 < 0.5 ? z : truncNormal(u2, mz, sz, ZONE_LO + 0.06, ZONE_HI - 0.06));
  }
  return toPlot(truncNormal(v, mx, sx, -ZONE_X + 0.06, ZONE_X - 0.06), truncNormal(u2, mz, sz, ZONE_LO + 0.06, ZONE_HI - 0.06));
}

function pitchVisual(call, random, pitcher, batter, kind, slower = 0, aim = null) {
  // Draws, in order: type, location (3 for a ball or hit-by-pitch, else 2), speed - the same count as
  // before, so game results do not change.
  const own = pitcher?.[4] && Object.keys(pitcher[4]).length ? pitcher[4] : null;
  const types = own ? Object.keys(own) : PITCH_TYPES;
  // Type: the pitcher's real usage (pitcher[5]), tilted by what this pitch did. Balls lean to pitch types
  // that are often out of the zone, whiffs to swing-and-miss pitches, called strikes to zone pitches.
  const weight = t => {
    const s = pitchShape(t), use = own && pitcher?.[5] ? (pitcher[5][t] || 0) : 1;
    if (call === 'ball') return use * (1 - s.zone) / 0.52;
    if (kind === 'swinging_strike') return use * s.whiff / 0.27;
    if (kind === 'called_strike') return use * s.zone / 0.48;
    return use;
  };
  const total = types.reduce((a, t) => a + weight(t), 0) || 1;
  let u = random() * total, type = types[types.length - 1];
  for (const t of types) { u -= weight(t); if (u < 0) { type = t; break; } }
  let x, y;
  if (call === 'hbp') {
    // A hit-by-pitch lands on the batter's side, near his body.
    const lefty = battingSide(batter, pitcher) === 'L'; x = lefty ? 80 + random() * 14 : 6 + random() * 14; y = 25 + random() * 55;
  } else {
    const u1 = random(), u2 = random(), u3 = call === 'ball' || call === 'ibb' ? random() : 0;
    ({ x, y } = pitchLocation(pitchShape(type), call, kind, pitcher?.[6] === 'L', battingSide(batter, pitcher) === 'L' ? -1 : 1, u1, u2, u3, aim));
  }
  const range = own?.[type] || DEFAULT_PITCH_SPEEDS[type] || DEFAULT_PITCH_SPEEDS['직구'];
  return { x, y, type, speed: range[0] + Math.floor(random() * (range[1] - range[0] + 1)) - slower };
}

// Throw one pitch (starting a plate appearance if none is in progress). Returns the new state,
// the pitch, and the finished plate appearance when this pitch ended it.
export function stepPitch(state, roster) {
  const g = structuredClone(state);
  if (g.status !== 'running') throw new Error('game is not running');
  if (!g.pa) startPlateAppearance(g, roster);
  const pa = g.pa, count = `${pa.balls}-${pa.strikes}`, profile = currentProfile(g, roster, pa.side, pa.batterIndex);
  const random = rng(g.seed + g.pitchNo * 7919 + 17);
  const fs = fieldSideOf(pa.side), pitcher = currentPitcher(g, roster, fs);
  { const m = g.mound[fs]; m.pc[m.cur] = (m.pc[m.cur] || 0) + 1; pitcherLine(g, pitcher[0]).pc++; }
  const batter = roster[sideTeam(g, pa.side)].players[pa.batterIndex];
  const tactics = { offense: pa.offense, alignment: pa.alignment, approach: pa.approach };
  Object.assign(tactics, plansFor(g, pa.side, tactics));
  const bunting = pa.offense === 'bunt' && canBunt(g);
  const batTeam = roster[sideTeam(g, pa.side)], speeds = { batterSpeed: speedGrade(batter?.[13]), thirdSpeed: runnerSpeed(batTeam, g.base[2]), firstSpeed: runnerSpeed(batTeam, g.base[0]) };
  g.pitchNo++;

  let pitch;
  if (pa.ibb) {
    pitch = { call: 'ibb', result: 'intentional_walk', ...pitchVisual('ibb', random, pitcher, batter, undefined, fatigueOf(g, fs).kmh), pitcher: pitcher[0] };
    pa.pitches.push({ ...pitch, count });
    return finishPlateAppearance(g, roster, 'IBB', pitch, random);
  }
  const shares = bunting ? buntPitchShares(count, profile, tactics) : pitchShares(count, profile, tactics);
  // What a ball in play would turn into at this count (for display; computed before the draw and
  // without using the random stream, so results do not change).
  const pct = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v > 0).map(([k, v]) => [k, Math.round(v * 1000) / 10]));
  const inPlayOdds = bunting
    ? pct(buntResultShares(tactics, speeds.batterSpeed))
    : pct(inPlayShares(count, profile, tactics, { runnerOnFirst: Boolean(g.base[0]), runnerOnThird: Boolean(g.base[2]), outs: g.outs, ...speeds }));
  const { kind, counts } = drawCounts(shares, random, g.trials || PITCH_TRIALS);
  const call = { ball: 'ball', called_strike: 'strike', swinging_strike: 'strike', foul: 'foul', in_play: 'inplay', hbp: 'hbp' }[kind];
  pitch = { call, result: bunting && kind !== 'ball' && kind !== 'hbp' ? `bunt_${kind}` : kind, ...pitchVisual(call, random, pitcher, batter, kind, fatigueOf(g, fs).kmh, aimFor(g, fs, pitcher, tactics)), pitcher: pitcher[0], distribution: { trials: g.trials || PITCH_TRIALS, counts }, inPlayOdds, bunting };
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
    const r = drawOne(buntResultShares(tactics, speeds.batterSpeed), random);
    return finishPlateAppearance(g, roster, { sacrifice: 'SAC', hit: 'BUNT_HIT', roe: 'BUNT_ROE', out: 'BUNT_OUT', fieldersChoice: 'FC', doublePlay: 'BUNT_DP' }[r], pitch, random);
  }
  let bip = bipShares(count, profile, tactics);
  // Situational results only where they can happen; otherwise they are ordinary outs.
  bip = inPlayShares(count, profile, tactics, { runnerOnFirst: Boolean(g.base[0]), runnerOnThird: Boolean(g.base[2]), outs: g.outs, ...speeds });
  const result = drawOne(bip, random);
  pitch.bip = result;
  if (HIT_OFF_ZONE[result] != null) { // display only: a hit comes off a pitch in the zone or, rarely, one on the black
    const spot = homeRunSpot(pitch, g.seed, g.pitchNo, HIT_OFF_ZONE[result]); pitch.x = spot.x; pitch.y = spot.y;
    const shown = pa.pitches[pa.pitches.length - 1]; if (shown) { shown.x = spot.x; shown.y = spot.y; }
  }
  return finishPlateAppearance(g, roster, { DP: 'GDP', SAC_FLY: 'SF', ROE_FC: 'ROE' }[result] || result, pitch, random);
}

// Where a ball in play went, for the play-by-play text ("유격수 땅볼", "우중간 2루타"). Display only: it
// uses a hash of the game seed and plate appearance, never the random stream, so results do not change.
// Low pitches are hit on the ground more, high ones in the air; batters pull the ball a little.
const FIELD_NAMES = { P: '투수', C: '포수', '1B': '1루수', '2B': '2루수', '3B': '3루수', SS: '유격수', LF: '좌익수', CF: '중견수', RF: '우익수' };
function hashUnit(a, b) { let h = (a ^ Math.imul(b + 1, 2654435761)) >>> 0; h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function pickWeighted(u, list) { const total = list.reduce((s, x) => s + x[1], 0); let v = u * total; for (const [k, w] of list) { if (v < w) return k; v -= w; } return list[list.length - 1][0]; }
// About 12% of singles are infield hits ("유격수 내야안타"). Decided from the seed and plate appearance like the
// rest of the play text, and used by the base running too (2.11): on an infield hit runners move up only when
// forced, so nobody scores from 2nd (or from 3rd unless the bases were loaded).
export function infieldSingle(seed, paNo, speed = 3) { return hashUnit(seed >>> 0, paNo * 3) < 0.12 * (SPEED.infieldHit[speedGrade(speed)] || 1); }
// The kind of an out in play (ground, fly, line, pop): from the seed, the plate appearance and the pitch height,
// with no random draws. The play text and, since 2.15, the base running both use it, so they agree.
export function outType(seed, paNo, pitch) {
  const y = Number(pitch?.y ?? 50), ground = y > 62 ? 0.56 : y < 40 ? 0.32 : 0.45;
  return pickWeighted(hashUnit(seed >>> 0, paNo * 3), [['ground', ground], ['fly', 0.85 - ground], ['line', 0.07], ['pop', 0.08]]);
}
// Which way a ball goes (display, 2.21): batters pull, and more so on an inside pitch; an outside pitch goes the
// other way more often (user note 2026-11-13: a right-handed batter rarely lines an inside pitch to the second
// baseman). x is the pitch's spot on the plot as the catcher sees it: a right-handed batter's inside is the left
// (low x), a left-handed batter's the right.
function sprayFactors(pitch, lefty) {
  const x = Number(pitch?.x), lr = Number.isFinite(x) ? (lefty ? 100 - x : x) : 50;
  const inside = lr < 42, outside = lr > 58, pullK = inside ? 1.5 : outside ? 0.8 : 1, oppK = inside ? 0.45 : outside ? 1.3 : 1;
  return lefty ? { left: 0.8 * oppK, right: 1.25 * pullK } : { left: 1.25 * pullK, right: 0.8 * oppK };
}
const infieldPick = (u, pull) => pickWeighted(u, [['3B', 0.2 * pull.left], ['SS', 0.28 * pull.left], ['2B', 0.27 * pull.right], ['1B', 0.15 * pull.right], ['P', 0.1]]);
// Infield hits go mostly to the shortstop (deep in the hole); a third baseman usually throws the batter out, so
// 3B infield hits are rare (2.21, user); 2B and 1B rare (2.18), the pitcher now and then (a deflection).
const infieldHitPick = (u, pull) => pickWeighted(u, [['3B', 0.1 * pull.left], ['SS', 0.55 * pull.left], ['2B', 0.05 * pull.right], ['1B', 0.03 * pull.right], ['P', 0.06]]);
export function playDetail(kind, pitch, seed, paNo, lefty, { infieldHit: knownInfieldHit = null } = {}) {
  const u1 = hashUnit(seed >>> 0, paNo * 3), u2 = hashUnit(seed >>> 0, paNo * 3 + 1);
  const pull = sprayFactors(pitch, lefty);
  const infield = () => infieldPick(u2, pull);
  // infield hits go mostly to the left side (long throw) and up the middle; to the first baseman or the pitcher
  // only now and then (a slow roller with nobody covering) - user report 2026-11-12
  const infieldHit = () => infieldHitPick(u2, pull);
  const outfield = () => pickWeighted(u2, [['LF', 0.33 * pull.left], ['CF', 0.36], ['RF', 0.31 * pull.right]]);
  const zone = () => pickWeighted(u2, [['좌', 0.3 * pull.left], ['좌중간', 0.17 * pull.left], ['중', 0.2], ['우중간', 0.16 * pull.right], ['우', 0.27 * pull.right]]);
  switch (kind) {
    case 'OUT': {
      const t = outType(seed, paNo, pitch);
      if (t === 'ground') return `${FIELD_NAMES[infield()]} 땅볼`;
      if (t === 'fly') return `${FIELD_NAMES[outfield()]} 뜬공`;
      // A line-drive out is mostly caught by an infielder; an outfielder's catch is usually called a fly ball, so
      // "우익수 직선타" stays rare (user note 2026-11-13). Display only: a separate hash, no random draws.
      if (t === 'line') return `${FIELD_NAMES[hashUnit(seed >>> 0, paNo * 3 + 2) < 0.8 ? infield() : outfield()]} 직선타`;
      return `${FIELD_NAMES[pickWeighted(u2, [['C', 0.15], ['1B', 0.2], ['2B', 0.2], ['3B', 0.2], ['SS', 0.25]])]} 뜬공`;
    }
    case 'GO_RBI': return `${FIELD_NAMES[infield()]} 땅볼 · 3루 주자 득점`;
    case 'SF': return `${FIELD_NAMES[outfield()]} 희생플라이`;
    case 'GDP': return `${FIELD_NAMES[pickWeighted(u2, [['SS', 0.4], ['2B', 0.3], ['3B', 0.2], ['P', 0.1]])]} 앞 병살타`;
    case 'ROE': return `${FIELD_NAMES[infield()]} 실책으로 출루`;
    case 'BUNT_ROE': return `${FIELD_NAMES[pickWeighted(u2, [['P', 0.4], ['C', 0.25], ['1B', 0.2], ['3B', 0.15]])]} 번트 실책으로 출루`;
    case 'BUNT_DP': return `${FIELD_NAMES[pickWeighted(u2, [['P', 0.4], ['C', 0.25], ['1B', 0.2], ['3B', 0.15]])]} 앞 번트 병살`;
    case '1B': { const z = zone(); return (knownInfieldHit ?? infieldSingle(seed, paNo)) ? `${FIELD_NAMES[infieldHit()]} 내야안타` : `${z === '좌중간' || z === '우중간' ? '중' : z}전 안타`; }
    case '2B': return `${zone()} 2루타`.replace('좌 ', '좌익선상 ').replace('우 ', '우익선상 ').replace('중 ', '중견수 키 넘는 ');
    case '3B': return `${zone()} 3루타`.replace('좌 ', '좌익선상 ').replace('우 ', '우익선상 ').replace('중 ', '중견수 키 넘는 ');
    case 'HR': return `${{ 좌: '좌월', 좌중간: '좌중월', 중: '중월', 우중간: '우중월', 우: '우월' }[zone()]} 홈런`;
    default: return null;
  }
}

function finishPlateAppearance(g, roster, kind, pitch, random) {
  const pa = g.pa, side = pa.side, inn = pa.inning, name = pa.batter, base = [...g.base], outs = g.outs;
  let runs = 0, newBase = base, newOuts = outs, note = null, detailOverride = null;
  const batTeam = roster[sideTeam(g, side)], lefty = battingSide(batTeam?.players?.[pa.batterIndex], currentPitcher(g, roster, side === 'away' ? 'home' : 'away')) === 'L';
  const batterSpeed = speedGrade(batTeam?.players?.[pa.batterIndex]?.[13]), u2 = hashUnit(g.seed >>> 0, pa.no * 3 + 1), spray = sprayFactors(pitch, lefty);
  // 2.21: a ground-ball out with a runner on 1st and fewer than two outs, by who fields it (SPEED.groundDp).
  let groundPlay = null;
  if (kind === 'OUT' && base[0] && outs < 2 && outType(g.seed, pa.no, pitch) === 'ground') {
    const f = infieldPick(u2, spray), rs = runnerSpeed(batTeam, base[0]);
    if (random() < Math.min(0.92, SPEED.groundDp.turn[f] * SPEED.dp[batterSpeed] * SPEED.dpRunner[rs])) { kind = 'GDP'; detailOverride = `${FIELD_NAMES[f]} 앞 병살타`; }
    else if (random() < Math.min(0.95, SPEED.groundDp.force[f] * SPEED.forceAtSecond.runner[rs])) groundPlay = 'force';
    else groundPlay = 'advance';
  }
  // 2.21: infield hits depend on the batter's speed; the fielder (as the play text names it) decides whether the
  // runner on 2nd can take 3rd.
  const infieldHitNow = kind === '1B' && infieldSingle(g.seed, pa.no, batterSpeed), infieldBy = infieldHitNow ? infieldHitPick(u2, spray) : null;
  const advanceAll = () => { runs = base[2] ? 1 : 0; newBase = [name, base[0], base[1]]; };
  const force = () => { newBase = [...base]; if (newBase[0]) { if (newBase[1]) { if (newBase[2]) runs++; newBase[2] = newBase[1]; } newBase[1] = newBase[0]; } newBase[0] = name; };
  switch (kind) {
    case 'HR': runs = 1 + base.filter(Boolean).length; newBase = [null, null, null]; break;
    case '3B': runs = base.filter(Boolean).length; newBase = [null, null, name]; break;
    case '2B': {
      runs = (base[1] ? 1 : 0) + (base[2] ? 1 : 0); newBase = [null, name, base[0]];
      if (base[0]) { const two = outs === 2 ? 1 : 0, team = roster[sideTeam(g, side)];
        if (random() < Math.min(0.95, SPEED.firstScoresOnDouble[two] * SPEED.extra[runnerSpeed(team, base[0])])) { runs++; newBase[2] = null; } }
      break;
    }
    case '1B': if (infieldHitNow) { // infield hit (2.11): forced runners move up; 2.14/2.21: the runner on 2nd may take 3rd
      force();
      if (base[1] && !base[0] && !base[2]) {
        const team = roster[sideTeam(g, side)], two = outs === 2 ? 1 : 0, by = SPEED.secondToThirdOnInfieldHitBy[infieldBy] || SPEED.secondToThirdOnInfieldSingle;
        if (random() < Math.min(0.95, by[two] * SPEED.extra[runnerSpeed(team, base[1])])) { newBase = [name, null, base[1]]; note = `2루 주자 ${base[1]} 3루까지`; }
      }
      break;
    }
    // falls through: a single to the outfield
    case 'ROE': { // runners may take an extra base (speed 2.10); draws after the result, same pitch stream
      const team = roster[sideTeam(g, side)], two = outs === 2 ? 1 : 0, chance = (b, name2) => Math.min(0.95, b[two] * SPEED.extra[runnerSpeed(team, name2)]);
      runs = base[2] ? 1 : 0; newBase = [name, null, null];
      let thirdFree = true;
      if (base[1]) { if (random() < chance(SPEED.secondScoresOnSingle, base[1])) runs++; else { newBase[2] = base[1]; thirdFree = false; } }
      if (base[0]) { if (thirdFree && random() < chance(SPEED.firstToThirdOnSingle, base[0])) newBase[2] = base[0]; else newBase[1] = base[0]; }
      break;
    }
    case 'BUNT_HIT': case 'BUNT_ROE': advanceAll(); break;
    case 'BB': case 'IBB': case 'HBP': force(); break;
    case 'K': case 'BUNT_OUT': newOuts = outs + 1; break;
    case 'OUT': { // 2.15: runners move on ground outs and tag up on fly outs (before the third out)
      newOuts = outs + 1; newBase = [...base];
      if (newOuts < 3 && base.some(Boolean)) {
        const t = outType(g.seed, pa.no, pitch), team = roster[sideTeam(g, side)];
        if (t === 'ground') {
          // the batter is out at first; the runner on 1st moves up (forced), the runner on 2nd takes 3rd when
          // forced or, if 3rd is open, often; a runner on 3rd holds (a run on a ground out is GO_RBI).
          if (base[0] && base[1] && base[2]) { /* bases loaded: the force is at home, nobody scores */ }
          else if (groundPlay === 'force') {
            // 2.20: the runner from 1st is forced out at 2nd; the batter is safe at 1st, a runner on 2nd is forced
            // to 3rd, a runner on 3rd holds.
            newBase = [name, null, base[1] || base[2]]; note = `1루 주자 ${base[0]} 2루 포스아웃`;
          } else {
            if (base[1] && !base[2] && (base[0] || random() < Math.min(0.95, SPEED.secondToThirdOnGroundOut * SPEED.extra[runnerSpeed(team, base[1])]))) { newBase[2] = base[1]; newBase[1] = null; }
            if (base[0] && !newBase[1]) { newBase[1] = base[0]; newBase[0] = null; }
          }
        } else if (t === 'fly' && base[1] && !base[2] && random() < Math.min(0.95, SPEED.secondToThirdOnFlyOut * SPEED.extra[runnerSpeed(team, base[1])])) { newBase[2] = base[1]; newBase[1] = null; }
      }
      break;
    }
    case 'GO_RBI': { // ground out, the run from 3rd scores; the other runners move up a base (2.15)
      newOuts = outs + 1; runs = 1; newBase = [null, null, null];
      if (base[1]) newBase[2] = base[1];
      if (base[0]) newBase[1] = base[0];
      break;
    }
    case 'GDP': newOuts = outs + 2; newBase = [null, base[1], base[2]]; break;
    case 'SF': newOuts = outs + 1; runs = 1; newBase = [base[0], base[1], null]; break;
    case 'SAC': newOuts = outs + 1; runs = base[2] ? 1 : 0; newBase = [null, base[0], base[1]]; break;
    case 'FC': // retire the lead runner; trailing runners advance only when forced
      newOuts = outs + 1; newBase = fieldersChoiceBases(base, name);
      break;
    case 'BUNT_DP': { // 2.18: the lead runner and the batter are out; runners behind the lead move up one base
      newOuts = outs + 2; newBase = [...base];
      const lead = [2, 1, 0].find(i => base[i]);
      if (lead != null) { newBase[lead] = null; for (let i = lead - 1; i >= 0; i--) if (base[i]) { newBase[i + 1] = base[i]; newBase[i] = null; } }
      break;
    }
    default: throw new Error(`unknown result ${kind}`);
  }
  if (newOuts >= 3) runs = 0; // a third out on the play: no run scores (outs-first simplification)
  { // the pitcher's line (runs charged to whoever is pitching; inherited runners are not tracked)
    const fs = side === 'away' ? 'home' : 'away', m = g.mound?.[fs];
    if (m) { m.outs[m.cur] = (m.outs[m.cur] || 0) + Math.min(3, newOuts) - outs; m.runs[m.cur] = (m.runs[m.cur] || 0) + runs; }
    const pl = pitcherLine(g, pa.pitcher || currentPitcher(g, roster, fs)?.[0] || '?');
    pl.outs += Math.min(3, newOuts) - outs; pl.r += runs;
    if (['1B', '2B', '3B', 'HR', 'BUNT_HIT'].includes(kind)) pl.h++;
    if (kind === 'HR') pl.hr++; if (kind === 'BB' || kind === 'IBB' || kind === 'HBP') pl.bb++; if (kind === 'K') pl.k++;
  }
  g.base = newBase; g.outs = newOuts;
  const b = g.bat[name] || (g.bat[name] = { PA: 0, AB: 0, H: 0, '2B': 0, '3B': 0, HR: 0, BB: 0, HBP: 0, K: 0, GDP: 0, SH: 0, SF: 0, R: 0 });
  b.PA++;
  if (!['BB', 'IBB', 'HBP', 'SAC', 'SF'].includes(kind)) b.AB++;
  if (['1B', '2B', '3B', 'HR', 'BUNT_HIT'].includes(kind)) b.H++;
  if (['2B', '3B', 'HR'].includes(kind)) b[kind]++;
  if (kind === 'BB' || kind === 'IBB') b.BB++;
  if (kind === 'HBP') b.HBP++; if (kind === 'K') b.K++; if (kind === 'GDP' || kind === 'BUNT_DP') b.GDP++; if (kind === 'SAC') b.SH++; if (kind === 'SF') b.SF++;
  b.R += runs;
  g[side] += runs;
  const row = g.innings[inn - 1] || (g.innings[inn - 1] = { away: 0, home: 0 }); row[side] += runs;
  const play = {
    paNo: pa.no, inn, side, batter: name, kind, runs, outs: g.outs, outsBefore: pa.outsBefore, outsAfter: g.outs,
    basesBefore: pa.basesBefore, base: [...g.base], scoreBefore: pa.scoreBefore, scoreAfter: { away: g.away, home: g.home },
    choice: pa.offense, defenseChoice: pa.alignment, approach: pa.approach, votes: pa.votes, pitches: pa.pitches,
    count: `${pa.balls}-${pa.strikes}`,
    detail: detailOverride || [playDetail(kind, pitch, g.seed, pa.no, lefty, { infieldHit: kind === '1B' ? infieldHitNow : null }), note].filter(Boolean).join(' · ') || null,
    pitcher: pa.pitcher, change: pa.change || null,
    rbi: ['GDP', 'ROE', 'BUNT_ROE'].includes(kind) ? 0 : runs,
  };
  g.plays.push(play);
  g.pa = null;
  g.halfPA = (g.halfPA || 0) + 1;
  // Game-end rules (docs/GAME_RULES.md), same as fanball-engine-1.
  if (g.half === 'home' && g.inning >= 9 && g.home > g.away) g.status = 'final';
  if (g.outs >= 3) {
    g.outs = 0; g.base = [null, null, null];
    if (g.half === 'away') { if (g.inning >= 9 && g.home > g.away) g.status = 'final'; else { g.half = 'home'; g.halfPA = 0; } }
    else if (g.inning >= 9 && g.home !== g.away) g.status = 'final';
    else if (g.inning >= MAX_INNINGS) { g.status = 'final'; g.tiebreak = '12회 종료 무승부'; }
    else { g.inning++; g.half = 'away'; g.halfPA = 0; }
  }
  return { game: g, pitch, play };
}

// A bunt fielder's choice (2.19 fix, user report): the fielder throws out the lead FORCED runner (home with the
// bases loaded, third with 1st and 2nd, second with a runner on first); runners behind him move up one base and
// runners not forced stay (1st and 3rd: out at second, the runner on third holds). With nobody forced the lead
// runner is tagged out (at home from third, at third from second). The batter reaches first.
export function fieldersChoiceBases(base, batter) {
  if (base[0] && base[1] && base[2]) return [batter, base[0], base[1]];
  if (base[0] && base[1]) return [batter, base[0], null];
  if (base[0]) return [batter, null, base[2]];
  if (base[2]) return [batter, base[1], null];
  return [batter, null, null];
}

// ---------- tactic score (score-1, docs/TACTIC_SCORE_DESIGN.md) ----------
// Points for the tactics fans vote for: an outcome part (the run value the plate appearance produced, or for a
// tactic that lost the vote, the run value of the same plate appearance replayed with it) and a decision part (how
// much better the pick's expected run value was than the average of the choices offered). Both only add.
// Display and scoring only: nothing here changes a game.
export const SCORE_RULES = 'score-1';
export const SCORE_WEIGHTS = { outcome: 10, decision: 40 };
// Expected runs for the rest of the inning by outs and runners (MLB 2010-2015 RE24; KBO tables were not
// available). Index: runner on 1st + 2 x on 2nd + 4 x on 3rd. Shared with the AI manager.
export const RE24 = [[0.481, 0.859, 1.100, 1.437, 1.350, 1.784, 1.964, 2.292], [0.254, 0.509, 0.664, 0.884, 0.950, 1.130, 1.376, 1.541], [0.098, 0.224, 0.319, 0.429, 0.353, 0.478, 0.580, 0.736]];
export const runExpectancy = (b, outs) => (outs >= 3 ? 0 : RE24[outs][(b?.[0] ? 1 : 0) + (b?.[1] ? 2 : 0) + (b?.[2] ? 4 : 0)]);

// Runs plus expected runs after a result, following the engine's base running in simple form (for expected values).
function runsAfter(kind, b, outs) {
  const on = (b || []).map(Boolean);
  let runs = 0, nb = on, no = outs;
  const force = () => { nb = [...on]; if (nb[0]) { if (nb[1]) { if (nb[2]) runs++; nb[2] = true; } nb[1] = true; } nb[0] = true; };
  switch (kind) {
    case 'HR': runs = 1 + on.filter(Boolean).length; nb = [false, false, false]; break;
    case '3B': runs = on.filter(Boolean).length; nb = [false, false, true]; break;
    case '2B': runs = (on[1] ? 1 : 0) + (on[2] ? 1 : 0); nb = [false, true, on[0]]; break;
    case '1B': case 'ROE': case 'BUNT_HIT': runs = on[2] ? 1 : 0; nb = [true, on[0], on[1]]; break;
    case 'BB': case 'HBP': force(); break;
    case 'K': case 'OUT': case 'BUNT_OUT': no = outs + 1; break;
    case 'GDP': no = outs + 2; nb = [false, on[1], on[2]]; break;
    case 'BUNT_DP': { no = outs + 2; nb = [...on]; const lead = [2, 1, 0].find(i => on[i]); if (lead != null) { nb[lead] = false; for (let i = lead - 1; i >= 0; i--) if (on[i]) { nb[i + 1] = true; nb[i] = false; } } break; }
    case 'SCORE_OUT': no = outs + 1; runs = 1; nb = [on[0], on[1], false]; break; // sac fly or ground out RBI
    case 'SAC': no = outs + 1; runs = on[2] ? 1 : 0; nb = [false, on[0], on[1]]; break;
    case 'FC': no = outs + 1; nb = on[0] && on[1] ? [true, true, on[2]] : on[0] ? [true, false, on[2]] : on[2] ? [true, on[1], false] : [true, false, false]; break;
  }
  if (no >= 3) runs = 0;
  return runs + runExpectancy(nb, no);
}

// Expected runs from this point of the plate appearance with these tactics (the AI manager rates choices with it).
export function expectedRuns(state, profile, tactics, count) {
  const b = state.base, outs = state.outs;
  if (tactics.ibb) return runsAfter('BB', b, outs);
  const bunting = tactics.offense === 'bunt';
  const o = plateAppearanceOdds(profile, tactics, count, { bunting });
  let v = o.K * runsAfter('K', b, outs) + o.BB * runsAfter('BB', b, outs) + o.HBP * runsAfter('HBP', b, outs);
  if (bunting) {
    v += o.bunt.sacrifice * runsAfter('SAC', b, outs) + o.bunt.hit * runsAfter('BUNT_HIT', b, outs) + (o.bunt.roe || 0) * runsAfter('BUNT_HIT', b, outs) + o.bunt.out * runsAfter('BUNT_OUT', b, outs) + (o.bunt.doublePlay || 0) * runsAfter('BUNT_DP', b, outs) + o.bunt.fieldersChoice * runsAfter('FC', b, outs);
    return v;
  }
  const p = o.bip;
  for (const k of ['1B', '2B', '3B', 'HR']) v += p[k] * runsAfter(k, b, outs);
  v += p.ROE_FC * runsAfter('ROE', b, outs);
  const dpOn = b[0] && outs < 2;
  v += p.DP * runsAfter(dpOn ? 'GDP' : 'OUT', b, outs);
  // Outs in play; with a runner on third and fewer than two outs some of them score him (about half; a drawn-in
  // infield cuts the ground-ball part).
  const outsInPlay = p.OUT + (p.SAC_FLY || 0) + (p.GO_RBI || 0) + (p.SAC_BUNT || 0);
  const scoreShare = b[2] && outs < 2 ? (tactics.alignment === 'infield_in' ? 0.4 : 0.55) : 0;
  v += outsInPlay * (scoreShare * runsAfter('SCORE_OUT', b, outs) + (1 - scoreShare) * runsAfter('OUT', b, outs));
  return v;
}

// Expected run value of every choice of a vote (phase 'pre_pa', 'two_strikes' or 'three_balls'), from the state when
// it opened: { offense: { id: value }, defense: { id: value }, offenseAvg, defenseAvg }. A choice's value is its
// expected runs minus the expected runs of the base-out state now; team plans count as in the game.
export function ballotValues(state, roster, phase) {
  const g = state, ballot = makeBallot(g, roster, phase);
  const current = phase === 'pre_pa' ? { offense: 'normal', alignment: 'standard', approach: 'standard' } : { offense: g.pa.offense, alignment: g.pa.alignment, approach: g.pa.approach };
  const from = phase === 'pre_pa' ? '0-0' : `${g.pa.balls}-${g.pa.strikes}`, side = phase === 'pre_pa' ? g.half : g.pa.side;
  const profile = batterProfileFor(g, roster), now = runExpectancy(g.base, g.outs);
  const value = (role, id) => { const t = applyChoice(current, role, id); if (t.offense === 'bunt' && !canBunt(g)) t.offense = 'normal'; return expectedRuns(g, profile, { ...t, ...plansFor(g, side, t) }, from) - now; };
  const out = { offense: {}, defense: {} };
  for (const c of ballot.offenseChoices) out.offense[c.id] = value('offense', c.id);
  for (const c of ballot.defenseChoices) out.defense[c.id] = value('defense', c.id);
  const avg = o => { const v = Object.values(o); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };
  out.offenseAvg = avg(out.offense); out.defenseAvg = avg(out.defense);
  return out;
}

// Run value of a finished plate appearance for the offense, from the base-out state when a vote opened:
// runs on the play + expected runs after it - expected runs at the vote.
export function paValue(play, at) {
  const after = (play.outsAfter ?? play.outs) >= 3 ? 0 : runExpectancy(play.base, play.outsAfter ?? play.outs);
  return (play.runs || 0) + after - runExpectancy(at.base, at.outs);
}

// The rest of the plate appearance as if a vote had gone `pick` ({ offense, defense } choice ids), for a tactic that
// lost the vote. It starts from the state when the vote opened and uses the same per-pitch random seeds as the game
// (fewer samples per pitch, enough for a comparison); later key-count votes keep the current tactics. Returns the
// finished play (null if it did not finish).
export function counterfactualPA(state, roster, phase, pick, { trials = 2000 } = {}) {
  let g = applyVote({ ...state, trials }, roster, phase, pick);
  for (let i = 0; i < 80 && g.status === 'running'; i++) {
    const v = pendingVote(g, roster);
    if (v && g.pa && v.phase !== 'pre_pa' && !g.pa.phasesDone.includes(v.phase)) { g = applyVote(g, roster, v.phase, { offense: 'keep', defense: 'keep' }); continue; }
    const r = stepPitch(g, roster);
    if (r.play) return r.play;
    g = r.game;
  }
  return null;
}

const round2 = v => Math.round(v * 100) / 100;
// Points for one vote: role 'offense' or 'defense', value = run value of its (real or replayed) plate appearance for
// the offense, ev / evAvg = the pick's expected value and the average of the choices offered to that role.
export function voteScore(role, value, ev, evAvg) {
  const result = role === 'offense' ? value : -value, better = role === 'offense' ? ev - evAvg : evAvg - ev;
  const outcome = round2(SCORE_WEIGHTS.outcome * Math.max(0, result)), decision = round2(SCORE_WEIGHTS.decision * Math.max(0, better));
  return { outcome, decision, total: round2(outcome + decision) };
}
