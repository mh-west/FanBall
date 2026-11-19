/* Fictional teams and players for the tactic-arena (no real KBO identity — made up names, made up
   stats — so this can be shown publicly while dist/ (real KBO rosters, Namu Wiki sourced) stays
   unlisted). Same array shapes the main engine/app expect (dist/app.js applySquads/pitcher build):
   batter: [name, group(C|IF|OF), AVG, OBP, SLG, ISO, rawAVG, rawOPS, rawPA, kRate, bbRate, positions[],
   bats(R|L|S), speedGrade(1-5), stealTendency(1-3)]; pitcher: [name, avgAllowed, bbRate, kRate, speeds,
   mix, throws, slot]. */

const PITCH_MIXES = [
  { speeds: { 포심: [140, 148], 슬라이더: [128, 134], 커브: [113, 119], 체인지업: [124, 130] }, mix: { 포심: 45, 슬라이더: 25, 커브: 15, 체인지업: 15 } },
  { speeds: { 투심: [138, 145], 슬라이더: [130, 136], 체인지업: [123, 129], 커브: [112, 118] }, mix: { 투심: 50, 슬라이더: 22, 체인지업: 16, 커브: 12 } },
  { speeds: { 포심: [145, 152], 슬라이더: [132, 138], 스플리터: [128, 134] }, mix: { 포심: 55, 슬라이더: 30, 스플리터: 15 } },
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const between = (rng, lo, hi) => lo + rng() * (hi - lo);

const POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'];
const GROUP_OF = pos => pos === 'C' ? 'C' : ['1B', '2B', '3B', 'SS'].includes(pos) ? 'IF' : 'OF';
const BATS = ['R', 'R', 'R', 'L', 'L', 'S'];

function makeBatter(rng, label, pos, tier) {
  // tier: a rough talent dial (-1 weak, 0 average, 1 strong) so lineups have real 1-9 shape, not nine clones.
  const avg = Math.max(0.2, Math.min(0.33, between(rng, 0.245, 0.285) + tier * 0.018));
  const obp = Math.max(avg + 0.02, Math.min(0.42, avg + between(rng, 0.045, 0.085) + tier * 0.012));
  const slg = Math.max(avg + 0.05, Math.min(0.58, avg + between(rng, 0.09, 0.2) + tier * 0.04));
  const pa = Math.round(between(rng, 380, 560));
  const group = GROUP_OF(pos);
  const p = [label, group, avg, obp, slg, slg - avg, avg, obp + slg, pa];
  p[11] = [pos]; p[12] = pick(rng, BATS); p[13] = 1 + Math.floor(rng() * 5); p[14] = 1 + Math.floor(rng() * 3);
  p.group = group; p.positions = p[11]; // ai-manager.js's canPlay()/rating() read these as named properties
  return p;
}

function makePitcher(rng, label, tier) {
  const avg = Math.max(0.21, Math.min(0.29, between(rng, 0.245, 0.265) - tier * 0.015));
  const bb = Math.max(0.045, Math.min(0.11, between(rng, 0.065, 0.085) - tier * 0.01));
  const k = Math.max(0.14, Math.min(0.28, between(rng, 0.17, 0.21) + tier * 0.02));
  const mix = pick(rng, PITCH_MIXES);
  return [label, avg, bb, k, mix.speeds, mix.mix, rng() < 0.82 ? 'R' : 'L', pick(rng, ['over', 'over', 'side'])];
}

// A full team: 9 batters (one per field position, so every position is covered), a starter and 3 relievers.
function makeTeam(rng, id, name, short) {
  const tiers = [0.9, 0.5, 0.2, -0.1, -0.4, -0.7, -0.1, 0.3, -0.3]; // a believable 1-9 batting-talent spread
  const players = POSITIONS.map((pos, i) => makeBatter(rng, `${short} 타자${i + 1}`, pos, tiers[i]));
  players.push(makeBatter(rng, `${short} 타자9`, pick(rng, ['1B', 'LF', 'RF']), -0.5)); // a 9th bat (DH-only bench bat)
  const pitcher = makePitcher(rng, `${short} 선발`, 0.3);
  const bullpen = [makePitcher(rng, `${short} 구원1`, 0.5), makePitcher(rng, `${short} 구원2`, 0.1), makePitcher(rng, `${short} 구원3`, -0.2)];
  return { id, name, short, players, pitcher, bullpen };
}

const TEAM_NAMES = [['blue', '블루', '블루'], ['red', '레드', '레드'], ['green', '그린', '그린'], ['gold', '골드', '골드']];

// A new random matchup (a fresh seed each time — this is a one-off arcade match, not a persisted roster).
export function newMatchup(seed = Date.now() >>> 0) {
  const rng = mulberry32(seed);
  const [a, b] = [...TEAM_NAMES].sort(() => rng() - 0.5).slice(0, 2);
  return { away: makeTeam(rng, a[0], a[1], a[2]), home: makeTeam(rng, b[0], b[1], b[2]), seed };
}
