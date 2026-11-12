/* AI manager for the AI match (dist/ai-game.js): lineup and tactic choices. Pure functions on the
   pitch engine, so tests can import them (tests/ai-manager.test.mjs).
   - Lineup: the twelve best hitters (by the engine's own PA-weighted OBP and SLG) claim their main
     positions, best first; open positions then go, scarcest first, to the best hitter left who can play
     them (canPlay); the best remaining hitter is the DH. Batting
     order in the usual sabermetric shape: best on-base hitter of the top five leads off, the best two left
     bat 2nd and 4th (4th the more powerful), the next two 3rd and 5th, the rest 6-9.
   - Tactics: every ballot choice is scored by expected runs from the engine's outcome odds for this
     batter, count and situation: runs on the play plus the run expectancy of the base-out state after it
     (RE24). Offense takes the highest, defense the lowest; near-ties go to the first, plainest choice. */
import * as E from './engine/pitch-engine.js?v=23a58a8a92';

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

export function aiLineupFor(t) {
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
  // Batting order: slot 1 best OBP of the top five, 2 and 4 the best two left (4 the more powerful),
  // 3 and 5 the next two, 6-9 the rest by rating.
  const nine = [...used].sort((a, b) => rating(t.players[b]) - rating(t.players[a]));
  const top5 = nine.slice(0, 5), rest = nine.slice(5);
  const lead = top5.reduce((a, b) => (t.players[b][3] > t.players[a][3] ? b : a));
  const others = top5.filter(i => i !== lead);
  const [x, y] = others.slice(0, 2), second = t.players[x][4] >= t.players[y][4] ? y : x, fourth = second === x ? y : x;
  const [five, three] = others.slice(2);
  const order = [lead, second, three, fourth, five, ...rest];
  return { order, pos: Object.fromEntries(order.map(i => [i, pos[i]])) };
}

// ---------- AI tactics ----------
// Expected runs for the rest of the inning by outs and runners (MLB 2010-2015 RE24; KBO tables were
// not available). Index: runner on 1st + 2 × on 2nd + 4 × on 3rd.
const RE24 = [[0.481, 0.859, 1.100, 1.437, 1.350, 1.784, 1.964, 2.292], [0.254, 0.509, 0.664, 0.884, 0.950, 1.130, 1.376, 1.541], [0.098, 0.224, 0.319, 0.429, 0.353, 0.478, 0.580, 0.736]];
const re = (b, outs) => (outs >= 3 ? 0 : RE24[outs][(b[0] ? 1 : 0) + (b[1] ? 2 : 0) + (b[2] ? 4 : 0)]);

// Runs and base-out state after a result, following the engine's own base-running rules.
function after(kind, b, outs) {
  const on = b.map(Boolean);
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
    case 'FC': no = outs + 1; nb = on[0] && on[1] ? [true, true, on[2]] : on[0] ? [true, false, on[2]] : on[2] ? [true, on[1], false] : [true, false, false]; break; // engine fieldersChoiceBases (2.19)
  }
  if (no >= 3) runs = 0;
  return runs + re(nb, no);
}

// Expected runs from this point of the plate appearance with these tactics.
export function expectedRuns(state, profile, tactics, count) {
  const b = state.base, outs = state.outs;
  if (tactics.ibb) return after('BB', b, outs);
  const bunting = tactics.offense === 'bunt';
  const o = E.plateAppearanceOdds(profile, tactics, count, { bunting });
  let v = o.K * after('K', b, outs) + o.BB * after('BB', b, outs) + o.HBP * after('HBP', b, outs);
  if (bunting) {
    v += o.bunt.sacrifice * after('SAC', b, outs) + o.bunt.hit * after('BUNT_HIT', b, outs) + o.bunt.out * after('BUNT_OUT', b, outs) + (o.bunt.doublePlay || 0) * after('BUNT_DP', b, outs) + o.bunt.fieldersChoice * after('FC', b, outs);
    return v;
  }
  const p = o.bip;
  for (const k of ['1B', '2B', '3B', 'HR']) v += p[k] * after(k, b, outs);
  v += p.ROE_FC * after('ROE', b, outs);
  const dpOn = b[0] && outs < 2;
  v += p.DP * after(dpOn ? 'GDP' : 'OUT', b, outs);
  // Outs in play; with a runner on third and fewer than two outs some of them score him (the engine
  // uses measured rates, about half; a drawn-in infield cuts the ground-ball part).
  const outsInPlay = p.OUT + (p.SAC_FLY || 0) + (p.GO_RBI || 0) + (p.SAC_BUNT || 0);
  const scoreShare = b[2] && outs < 2 ? (tactics.alignment === 'infield_in' ? 0.4 : 0.55) : 0;
  v += outsInPlay * (scoreShare * after('SCORE_OUT', b, outs) + (1 - scoreShare) * after('OUT', b, outs));
  return v;
}

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

