// Prints SQL that schedules one demo official game (provider 'demo') with the site's sample
// rosters and default batting order fixed as the lineup snapshot.
// Usage: node tools/demo-game-sql.mjs <kbo_game_id> <away_team_id> <home_team_id> [minutes_from_now]
// Run the output with: npx supabase@3.0.0 db query --remote --yes -f <file>
// Demo games are test data, not KBO schedule data. Clean up by deleting the kbo_games/fanball_games rows.
import { loadBrowserEngine, sampleRoster } from './browser-sandbox.mjs';

const [kboId, awayId, homeId, minutes = '1'] = process.argv.slice(2);
if (!kboId || !awayId || !homeId || awayId === homeId) {
  console.error('usage: node tools/demo-game-sql.mjs <kbo_game_id> <away_team_id> <home_team_id> [minutes_from_now]');
  process.exit(1);
}
const roster = sampleRoster(loadBrowserEngine(), [awayId, homeId]);
const literal = value => `'${String(value).replace(/'/g, "''")}'`;
const snapshot = JSON.stringify({ source: 'demo-sample-rosters', teams: roster });

console.log(`insert into public.kbo_games(id, game_date, scheduled_at, away_team_id, home_team_id, status, provider)
values (${literal(kboId)}, (now() at time zone 'Asia/Seoul')::date, now() + interval '${Number(minutes)} minutes', ${literal(awayId)}, ${literal(homeId)}, 'scheduled', 'demo');
insert into public.fanball_games(kbo_game_id, lineup_snapshot) values (${literal(kboId)}, ${literal(snapshot)}::jsonb);
select f.id, k.scheduled_at from public.fanball_games f join public.kbo_games k on k.id = f.kbo_game_id where k.id = ${literal(kboId)};`);
