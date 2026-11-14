/* AI manager for the AI match (dist/ai-game.js): lineup and tactic choices. Pure functions on the
   pitch engine, so tests can import them (tests/ai-manager.test.mjs).
   - Lineup: the twelve best hitters (by the engine's own PA-weighted OBP and SLG) claim their main
     positions, best first; open positions then go, scarcest first, to the best hitter left who can play
     them (canPlay); the best remaining hitter is the DH - this part never changes with style, since it is
     about who can field a spot, not batting-order philosophy.
   - Batting order ("style", LINEUP_STYLES): 'ops' (default, also always used for the AI's own team) is the
     usual sabermetric shape - best on-base hitter of the top five leads off, the best two left bat 2nd and
     4th (4th the more powerful), the next two 3rd and 5th, the rest 6-9. 'obp' bats the nine straight by
     on-base percentage. 'platoon' bats the nine by rating plus a bonus for batters with the platoon
     advantage over the given opposing starter's throwing hand (switch hitters always get it). 'kbo' bats
     the two best on-base hitters 1st-2nd, the three best sluggers 3rd-5th, the rest 6-9 by rating - the
     "출루 1·2번, 장타 3~5번" shape KBO lineups commonly use. The viewer picks one of these four for "AI
     추천" on their own lineup (dist/ai-game.js); the AI's own team always uses 'ops'.
   - Tactics: every ballot choice is scored by expected runs from the engine's outcome odds for this
     batter, count and situation: runs on the play plus the run expectancy of the base-out state after it
     (RE24). Offense takes the highest, defense the lowest; near-ties go to the first, plainest choice. */
import * as E from './engine/pitch-engine.js?v=4006d49bf8';

const rating = p => (p[3] ?? 0.33) * 1.8 + (p[4] ?? 0.39); // engine OBP and SLG, OBP weighted (as in wOBA-style ratings)
const POS_IF = ['SS', '2B', '3B', '1B'], POS_OF = ['CF', 'RF', 'LF'];

// Whether a player can field a position (same rule as canPlayPosition in dist/app.js): his own
// positions, any outfielder at a corner, a center fielder anywhere in the outfield, a shortstop at 2B or
// 3B, any infielder at 1B, a generic 내야수/외야수 anywhere in that group, anyone at DH; only catchers catch.
export function canPlay(p, position) {
  if (position === 'DH') return true;
  if (position === 'C') return p.group === 'C'; // infoboxes keep 포수 for converted players (강백호, 안현민)
  const own = p.positions?.length ? p.positions : [p.group];
  if (own.includes(position)) return true;
  if (POS_IF.includes(position) && own.includes('IF')) return true;
  if (POS_OF.includes(position) && own.includes('OF')) return true;
  if ((position === 'LF' || position === 'RF') && own.some(x => POS_OF.includes(x))) return true;
  if ((position === '2B' || position === '3B') && own.includes('SS')) return true;
  if (position === '1B' && own.some(x => POS_IF.includes(x) || x === 'IF')) return true;
  return false;
}

export const LINEUP_STYLES = ['ops', 'obp', 'platoon', 'kbo'];

function platoonEdge(bats, pitcherHand) {
  if (!pitcherHand) return false;
  return bats === 'S' || (!!bats && bats !== pitcherHand);
}

function battingOrderFor(style, nine, t, oppHand) {
  if (style === 'obp') return [...nine].sort((a, b) => (t.players[b][3] ?? 0) - (t.players[a][3] ?? 0));
  if (style === 'platoon') {
    const score = i => rating(t.players[i]) + (platoonEdge(t.players[i][12], oppHand) ? 0.25 : 0);
    return [...nine].sort((a, b) => score(b) - score(a));
  }
  if (style === 'kbo') {
    // The best hitter bats 3rd-4th even if his OBP also leads the team, so the power trio is picked
    // first (by SLG); the table-setters (1st-2nd, by OBP) come from whoever is left.
    const bySlg = (a, b) => (t.players[b][4] ?? 0) - (t.players[a][4] ?? 0), byObp = (a, b) => (t.players[b][3] ?? 0) - (t.players[a][3] ?? 0);
    const left = [...nine];
    const top3Slg = [...left].sort(bySlg).slice(0, 3); for (const i of top3Slg) left.splice(left.indexOf(i), 1);
    const top2Obp = [...left].sort(byObp).slice(0, 2); for (const i of top2Obp) left.splice(left.indexOf(i), 1);
    return [...top2Obp.sort(byObp), ...top3Slg.sort(bySlg), ...left.sort((a, b) => rating(t.players[b]) - rating(t.players[a]))];
  }
  // 'ops': slot 1 best OBP of the top five, 2 and 4 the best two left (4 the more powerful), 3 and 5 the next two, 6-9 the rest by rating.
  const top5 = nine.slice(0, 5), rest = nine.slice(5);
  const lead = top5.reduce((a, b) => (t.players[b][3] > t.players[a][3] ? b : a));
  const others = top5.filter(i => i !== lead);
  const [x, y] = others.slice(0, 2), second = t.players[x][4] >= t.players[y][4] ? y : x, fourth = second === x ? y : x;
  const [five, three] = others.slice(2);
  return [lead, second, three, fourth, five, ...rest];
}

export function aiLineupFor(t, style = 'ops', oppHand = null) {
  const idx = t.players.map((p, i) => i).sort((a, b) => rating(t.players[b]) - rating(t.players[a]));
  const used = new Set(), pos = {};
  const take = (i, position) => { used.add(i); pos[i] = position; };
  const best = test => idx.find(i => !used.has(i) && test(t.players[i]));
  // 1) Best hitters first, each at his main position if it is still open (catchers only if registered).
  const FIELD = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'], taken = new Set();
  for (const i of idx) {
    if (taken.size === FIELD.length) break;
    const main = (t.players[i].positions || [])[0];
    if (FIELD.includes(main) && !taken.has(main) && canPlay(t.players[i], main)) { take(i, main); taken.add(main); }
    if (idx.indexOf(i) >= 12) break; // only regulars claim main positions; the rest fill in below
  }
  // 2) Open positions, scarcest first, to the best hitter left who can play them (a listed position
  // preferred), falling back to the position group only when nobody on the roster plays it.
  for (const position of ['C', 'SS', 'CF', '2B', '3B', 'RF', 'LF', '1B'].filter(x => !taken.has(x))) {
    const group = position === 'C' ? 'C' : POS_IF.includes(position) ? 'IF' : 'OF';
    // A recorded position counts most (+0.10); a generic 내야수/외야수 label (no 2026 game notes) least.
    const fit = i => { const own = t.players[i].positions || []; return rating(t.players[i]) + (own.includes(position) ? 0.10 : own.some(x => x === 'IF' || x === 'OF') ? 0 : 0.04); };
    const eligible = idx.filter(i => !used.has(i) && canPlay(t.players[i], position));
    const i = eligible.length ? eligible.reduce((a, b) => (fit(b) > fit(a) ? b : a)) : best(p => p.group === group) ?? best(p => p.group !== 'C');
    if (i !== undefined) { take(i, position); taken.add(position); }
  }
  const dh = best(p => p.group !== 'C') ?? best(() => true); if (dh !== undefined) take(dh, 'DH');
  const nine = [...used].sort((a, b) => rating(t.players[b]) - rating(t.players[a]));
  const order = battingOrderFor(style, nine, t, oppHand);
  return { order, pos: Object.fromEntries(order.map(i => [i, pos[i]])) };
}

// ---------- AI tactics ----------
// Expected runs (MLB RE24 table and the engine's base running) now live in the engine, shared with the tactic
// score (docs/TACTIC_SCORE_DESIGN.md); same numbers as before.
export const expectedRuns = E.expectedRuns;

const DEFENSE_ALIGN = new Set(['standard', 'double_play', 'corners_in', 'infield_in', 'outfield_deep']);
function withChoice(current, role, id) {
  const t = { ...current };
  if (!id || id === 'keep') return t;
  if (role === 'offense') { t.offense = id; return t; }
  if (id === 'intentional_walk') { t.ibb = true; return t; }
  if (id === 'standard') { t.alignment = 'standard'; t.approach = 'standard'; return t; }
  if (id === 'standard_approach') { t.approach = 'standard'; return t; }
  if (DEFENSE_ALIGN.has(id)) t.alignment = id; else t.approach = id;
  return t;
}

// The AI's pick for one side of a ballot. Ties (within 0.005 runs) go to the first, plainest choice.
export function aiChoice(state, roster, ballot, role, phase) {
  const g = state, side = g.pa ? g.pa.side : g.half, teamId = side === 'away' ? g.awayId : g.homeId;
  const order = roster[teamId].order, index = g.pa ? g.pa.batterIndex : order[g.idx[side] % order.length];
  const profile = g.pa ? E.currentProfile(g, roster, side, index) : (E.batterProfileFor ? E.batterProfileFor(g, roster) : E.currentProfile(g, roster, side, index));
  const current = g.pa ? { offense: g.pa.offense, alignment: g.pa.alignment, approach: g.pa.approach } : { offense: 'normal', alignment: 'standard', approach: 'standard' };
  const count = g.pa ? `${g.pa.balls}-${g.pa.strikes}` : '0-0';
  const list = role === 'offense' ? ballot.offenseChoices : ballot.defenseChoices;
  let bestId = list[0].id, bestV = null;
  for (const c of list) {
    const t = withChoice(current, role, c.id);
    if (t.offense === 'bunt' && phase !== 'pre_pa' && current.offense !== 'bunt') continue;
    const v = expectedRuns(g, profile, t, count);
    if (bestV === null || (role === 'offense' ? v > bestV + 0.005 : v < bestV - 0.005)) { bestV = v; bestId = c.id; }
  }
  return bestId;
}

