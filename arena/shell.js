/* Minimal globals the copied production files (server-game.js, ai-game.js) expect from dist/app.js in
   the main site — same pattern, much smaller: one page, one team lookup, no accounts, no navigation.
   Classic script (not a module) so these become true globals, loaded before server-game.js and the
   ai-game.js module (same load order dist/index.html uses for app.js → server-game.js → ai-game.js). */
const MATCH = { id: 'arena', away: null, home: null, date: '', time: '', venue: '아레나 구장' };
const ADMIN_MODE = false;
let page = 'ai';
const $ = s => document.querySelector(s), app = $('#app');
function safe(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function notify(s) { const t = $('#toast'); if (!t) return; t.textContent = s; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2300); }
function persist() {}
function header(label, title, sub, right = '') { return `<div class="page-head"><div><div class="eyebrow">${label}</div><h1>${title}</h1><div class="sub">${sub}</div></div>${right}</div>`; }
// Copied from dist/app.js / dist/enhancements.js (same functions, unchanged) — the result screen's
// per-inning play log, which server-game.js's result page calls directly.
window.sideKey = (awayId, homeId, side) => side === 'away' ? (awayId === homeId ? awayId + '@away' : awayId) : homeId;
let selectedLogInning = 1;
window.selectLogInning = function (inning) { selectedLogInning = Number(inning); render(); };
function inningTabs(maxInning = 9) { const total = Math.max(9, maxInning); return `<div role="tablist" class="inning-tabs" aria-label="이닝 선택">${Array.from({ length: total }, (_, i) => `<button class="${selectedLogInning === i + 1 ? 'active' : ''}" onclick="selectLogInning(${i + 1})">${i + 1}회</button>`).join('')}</div>`; }
function sideSuffix(side) { return MATCH.away === MATCH.home ? (side === 'away' ? ' (원정)' : ' (홈)') : ''; }
function situationText(bases = [], outs = 0) { const label = { '000': '주자 없음', '100': '1루', '010': '2루', '001': '3루', '110': '1,2루', '101': '1,3루', '011': '2,3루', '111': '만루' }[`${bases[0] ? 1 : 0}${bases[1] ? 1 : 0}${bases[2] ? 1 : 0}`]; return `${outs}아웃 · ${label}`; }
function runnerNames(bases) { const r = [0, 1, 2].filter(i => bases?.[i]).map(i => `${i + 1}루 ${safe(bases[i])}`); return r.length ? `<small class="runner-names">${r.join(' · ')}</small>` : ''; }
function gameLine(p, g) { const plays = g?.plays || [], upto = plays.slice(0, plays.indexOf(p) + 1).filter(x => x.batter === p.batter && x.side === p.side); let ab = 0, h = 0; for (const x of upto) { if (!['BB', 'IBB', 'HBP', 'SAC', 'SF'].includes(x.kind)) ab++; if (['1B', '2B', '3B', 'HR', 'BUNT_HIT'].includes(x.kind)) h++; } return `${h}/${ab}`; }
function playCard(p, g) {
  const battingId = p.side === 'away' ? g.awayId : g.homeId, teamName = team(battingId).name + sideSuffix(p.side), score = p.scoreAfter || { away: g.away, home: g.home }, bases = p.base || [], outs = p.outsAfter ?? p.outs ?? 0,
    offenseNames = { normal: '기본 타격', contact: '컨택', aggressive: '강공', bunt: '희생번트', wait: '기다리기' }, defenseNames = { standard: '기본 수비', double_play: '병살 대비', corners_in: '번트 대비(코너 전진)', infield_in: '내야 전진', outfield_deep: '외야 장타 대비' }, approachNames = { attack: '정면 승부', pitch_around: '유인구 승부' };
  return `<article class="play-card">${p.change ? `<div class="play-change">⇄ 투수 교체 · ${safe(p.change.from || '')}${p.change.pitches ? ` (${p.change.pitches}구)` : ''} → <b>${safe(p.change.to)}</b></div>` : ''}<div class="play-card-top"><span class="inning-label">${p.inn}회 ${p.side === 'away' ? '초' : '말'}</span><b>${teamName} 공격</b><span class="play-score">${score.away} : ${score.home}</span></div><div class="play-card-main"><strong>${safe(p.batter)}<small class="game-line">${gameLine(p, g)}</small></strong><span class="play-outcome">${p.kindLabel || kindName(p.kind)}${p.runs ? ` · ${p.runs}득점` : ''}</span><button class="detail-button" onclick="showDistribution(${g.plays.indexOf(p)})">결과 분포</button></div><div class="play-card-state">${baseDiamond(bases)}<span>타석 후 · ${situationText(bases, outs)}${runnerNames(bases)}</span></div>${(Array.isArray(p.votes) ? p.votes.length > 0 : (p.choice && p.choice !== 'normal') || (p.defenseChoice && p.defenseChoice !== 'standard')) ? `<div class="play-tactic-summary"><span class="tactic-chip offense"><b>공격</b>${offenseNames[p.choice] || '기본 타격'}</span><span class="tactic-chip defense"><b>수비</b>${defenseNames[p.defenseChoice] || '기본 수비'}${approachNames[p.approach] ? ` · ${approachNames[p.approach]}` : ''}</span></div>` : ''}</article>`;
}
function renderInningLogs(g, inning) {
  const plays = (g?.plays || []).filter(p => Number(p.inn) === Number(inning)), half = (side, id, label) => { const list = plays.filter(p => p.side === side), t = team(id); return `<section class="inning-half ${side}"><div class="team-log-heading"><span>${label}</span><b>${t.name} 공격</b><small>${list.length}타석</small></div><div class="inning-half-plays">${list.length ? list.map(p => playCard(p, g)).join('') : '<p class="empty-log">이 이닝의 타석이 아직 없습니다.</p>'}</div></section>`; };
  return `<div class="inning-selected-heading"><strong>${inning}회</strong><span>${plays.length}타석 기록</span></div><div class="inning-flow">${half('away', g?.awayId || MATCH.away, '초 · 원정팀')}${plays.some(p => p.side === 'home') || !plays.length ? half('home', g?.homeId || MATCH.home, '말 · 홈팀') : ''}</div>`;
}
function baseDiamond(bases = []) { return `<span class="base-diamond" aria-label="주자 ${bases.map((b, i) => b ? ['1루', '2루', '3루'][i] : null).filter(Boolean).join(', ') || '없음'}"><i class="base-second ${bases[1] ? 'occupied' : ''}"></i><i class="base-third ${bases[2] ? 'occupied' : ''}"></i><i class="base-first ${bases[0] ? 'occupied' : ''}"></i><small>주자</small></span>`; }
function kindName(k) { return ({ HR: '홈런', '3B': '3루타', '2B': '2루타', '1B': '단타', BB: '볼넷', HBP: '몸에 맞는 공', GDP: '병살타', K: '삼진', OUT: '아웃', SAC: '희생번트 성공' })[k] || k; }
// Copied from dist/app.js (same function, unchanged) — the final-result inning scoreboard.
function scoreTable(g) { let n = Math.max(9, g.innings.length); const tally = side => { const ps = (g.plays || []).filter(p => p.side === side), opp = (g.plays || []).filter(p => p.side && p.side !== side); return { H: ps.filter(p => ['1B', '2B', '3B', 'HR', 'BUNT_HIT'].includes(p.kind)).length, E: opp.filter(p => ['ROE', 'BUNT_ROE'].includes(p.kind)).length, B: ps.filter(p => ['BB', 'IBB', 'HBP'].includes(p.kind)).length }; }, A = tally('away'), Hm = tally('home'), cur = g.last?.payload?.inning ? { inn: g.last.payload.inning, side: g.last.payload.side } : (g.inning ? { inn: g.inning, side: g.half } : null), homeBatted = i => (g.plays || []).some(p => p.inn === i + 1 && p.side === 'home') || (g.plays || []).some(p => p.inn > i + 1) || Boolean(cur && (cur.inn > i + 1 || (cur.inn === i + 1 && cur.side === 'home'))), cell = (side, i) => { const v = g.innings[i]?.[side]; if (v == null) return '·'; if (side === 'home' && !homeBatted(i)) return g.status === 'final' ? 'X' : '-'; return v; }, row = (side, t, runs) => `<tr><td>${team(side === 'away' ? g.awayId : g.homeId).short}${g.awayId === g.homeId ? ` <small>${side === 'away' ? '원정' : '홈'}</small>` : ''}</td>${Array.from({ length: n }, (_, i) => `<td>${cell(side, i)}</td>`).join('')}<td class="total">${runs}</td><td class="rheb">${t.H}</td><td class="rheb">${t.E}</td><td class="rheb">${t.B}</td></tr>`; return `<div style="overflow:auto"><table class="score-table"><thead><tr><th>팀</th>${Array.from({ length: n }, (_, i) => `<th>${i + 1}</th>`).join('')}<th>R</th><th title="안타">H</th><th title="실책">E</th><th title="볼넷·사구">B</th></tr></thead><tbody>${row('away', A, g.away)}${row('home', Hm, g.home)}</tbody></table></div>`; }
function render() { app.innerHTML = typeof window.gamePage === 'function' ? window.gamePage() : ''; }
function go(p) { page = p; render(); }
window.go = go;
// Teams: registered by ai-game.js (roster.js builds them fresh each match — no real KBO identity).
window.ARENA_TEAMS = {};
const team = id => window.ARENA_TEAMS[String(id).split('@')[0]];
// Safe fallbacks for the "not an active local match" branches server-game.js falls back to; arena
// always has an active local match once one is started, so these should never actually run.
window.showDistribution = () => '';
window.gamePage = () => '<div class="empty">불러오는 중…</div>';
window.homeLiveCard = () => '';

// Copied from dist/enhancements.js (same functions, unchanged) — the vote dock (remoteTacticalPanel)
// server-game.js's pitchBoard renders during a tactic vote, local matches included.
function batterAverage(name, teamId) { const p = team(teamId)?.players?.find(x => x[0] === name)?.[2]; return Number.isFinite(p) ? p.toFixed(3).replace(/^0/, '') : null; }
function remoteSituation(round) {
  const s = round?.state_snapshot || {}, phase = { pre_pa: '타석 전 작전', two_strikes: '2스트라이크 작전', three_balls: '3볼 작전', pitcher_change: '구원투수 투표' }[round?.phase || s.phase] || '작전';
  if (s.inning == null) return `${round.pa_no}번째 타석 · ${phase}`;
  const b = s.base || [], bases = { '000': '주자 없음', '100': '1루', '010': '2루', '001': '3루', '110': '1,2루', '101': '1,3루', '011': '2,3루', '111': '만루' }[`${b[0] ? 1 : 0}${b[1] ? 1 : 0}${b[2] ? 1 : 0}`];
  const attack = (team(round.offense_team_id)?.short || '') + (MATCH.away === MATCH.home ? sideSuffix(String(round.offense_team_id).endsWith('@away') ? 'away' : 'home') : ''), away = team(MATCH.away)?.short || '원정', home = team(MATCH.home)?.short || '홈';
  return `${s.inning}회 ${s.half === 'away' ? '초' : '말'} · ${s.outs || 0}아웃 ${bases}${s.count && s.count !== '0-0' ? ` · 카운트 ${s.count}` : ''}${s.batter ? ` · 타자 ${safe(s.batter)}${batterAverage(s.batter, round.offense_team_id) ? ` (타율 ${batterAverage(s.batter, round.offense_team_id)})` : ''}` : ''} · ${attack} 공격 · ${away} ${s.score?.away ?? 0}:${s.score?.home ?? 0} ${home}<br><b>${phase}</b>`;
}
function remoteChoiceOdds(round, choice) {
  const b = round?.state_snapshot?.ballot, list = choice.role === 'offense' ? b?.offenseChoices : b?.defenseChoices, c = list?.find(x => x.id === choice.choice_key);
  if (!c?.odds) return '';
  const o = c.odds, base = list[0]?.odds, names = { walk: '볼넷', strikeout: '삼진', hit: '안타', extraBase: '장타', sacrifice: '희생 진루', out: '아웃' }, goodForOffense = { walk: true, hit: true, extraBase: true, sacrifice: true, strikeout: false, out: false };
  const chips = base && c !== list[0] ? Object.keys(names).map(k => ({ k, d: Math.round(((o[k] || 0) - (base[k] || 0)) * 10) / 10 })).filter(x => Math.abs(x.d) >= 0.1).map(x => { const good = (x.d > 0) === goodForOffense[x.k] === (choice.role === 'offense'); return { good, text: `${names[x.k]} ${x.d > 0 ? '+' : '−'}${Math.abs(x.d).toFixed(1)}%p` }; }).sort((x, y) => Number(y.good) - Number(x.good)) : [];
  const effects = chips.length ? `<span class="choice-effects">${chips.map(e => `<span class="choice-effect ${e.good ? 'good' : 'bad'}">${e.text}</span>`).join('')}</span>` : '';
  return `${effects}<small>이번 타석 확률 · 볼넷 ${o.walk}% · 삼진 ${o.strikeout}% · 안타 ${o.hit}% (장타 ${o.extraBase}%)${o.sacrifice ? ` · 희생 진루 ${o.sacrifice}%` : ''} · 아웃 ${o.out}%</small>${c.detail ? `<small class="choice-detail">${safe(c.detail)}</small>` : ''}`;
}
function remoteChoiceOrder(round, choices) {
  const b = round?.state_snapshot?.ballot, order = [...(b?.offenseChoices || []), ...(b?.defenseChoices || [])].map(c => c.id), at = c => { const i = order.indexOf(c.choice_key); return i < 0 ? (c.is_default ? -1 : 999) : i; };
  return [...choices].sort((x, y) => at(x) - at(y));
}
function remoteTacticalPanel(remote) {
  if (!remote) return '';
  if (remote.round?.status === 'resolved') {
    const find = id => remote.choices.find(c => c.id === id)?.label || '기본 작전';
    return `<div class="vote-box remote-vote resolved"><b>작전 투표 완료</b><div class="ballot-situation">${remoteSituation(remote.round)} · 양 팀 작전 확정</div><div class="remote-resolution"><span>공격 · ${safe(find(remote.resolution?.offense_choice_id))}</span><span>수비 · ${safe(find(remote.resolution?.defense_choice_id))}</span></div></div>`;
  }
  if (remote.round?.status === 'closing') return `<div class="vote-box remote-vote"><b>투표 마감 · 작전 확정 중</b><p class="tiny muted">서버가 양 팀의 표를 집계하고 있습니다.</p></div>`;
  if (remote.round?.status === 'open') {
    const remain = Math.ceil(remote.remainingMs / 1000), end = new Date(remote.round.closes_at).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (!remote.role) return `<div class="vote-box remote-vote spectator"><div class="remote-vote-title"><b>작전 선택 중입니다</b><span id="server-countdown">${remain}초</span></div><div class="ballot-situation">${remoteSituation(remote.round)} · ${end} 마감</div></div>`;
    const teamName = (team(remote.teamId)?.name || '내 응원팀') + (remote.teamId && MATCH.away === MATCH.home ? sideSuffix(String(remote.teamId).endsWith('@away') ? 'away' : 'home') : ''), roleName = remote.role === 'offense' ? '공격 작전 선택' : '수비 작전 선택';
    return `<div class="vote-box remote-vote ${remote.role}"><div class="remote-vote-title"><b>${teamName} · ${roleName}</b>${remote.noTimer ? '<span>고르면 바로 진행</span>' : `<span id="server-countdown">${remain}초</span>`}</div><div class="ballot-situation">${remoteSituation(remote.round)}${remote.noTimer ? '' : ` · ${end} 마감`}</div><div class="vote-options">${remoteChoiceOrder(remote.round, remote.choices).map(c => `<button class="${remote.vote?.choice_id === c.id ? 'voted' : ''}" onclick="submitServerTacticalVote('${c.id}')"><b>${safe(c.label)}${remote.vote?.choice_id === c.id ? ' · 내 선택' : ''}</b>${remoteChoiceOdds(remote.round, c)}</button>`).join('')}</div><p class="tiny muted">${remote.instantPick ? '고르면 바로 적용됩니다. 시간이 지나면 지금 작전(첫 번째 선택지)으로 진행합니다.' : '마감 전에는 선택을 바꿀 수 있습니다.'}</p></div>`;
  }
  return '';
}
window.submitServerTacticalVote = id => window.FANBALL_SERVER_GAME?.isLocal?.() ? window.FANBALL_SERVER_GAME.voteLocal(id) : null;
