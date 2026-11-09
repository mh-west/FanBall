import { withSupabase } from "npm:@supabase/server@1";

const response = (body: unknown, status = 200) => Response.json(body, { status });

// Trusted game orchestrator only. The caller sends the default Supabase Secret key in the apikey header.
// Never call this endpoint from browser code.
export default {
  fetch: withSupabase({ auth: "secret", cors: "disabled" }, async (request, ctx) => {
    if (request.method !== "POST") return response({ error: "method_not_allowed" }, 405);

    let input: Record<string, unknown>;
    try { input = await request.json(); } catch { return response({ error: "invalid_json" }, 400); }
    const gameId = typeof input.game_id === "string" ? input.game_id : "";
    const paNo = Number(input.pa_no);
    const offenseTeam = typeof input.offense_team_id === "string" ? input.offense_team_id : "";
    const defenseTeam = typeof input.defense_team_id === "string" ? input.defense_team_id : "";
    const choices = input.choices;
    if (!gameId || !Number.isInteger(paNo) || paNo < 1 || !offenseTeam || !defenseTeam || offenseTeam === defenseTeam || !Array.isArray(choices)) {
      return response({ error: "invalid_round_payload" }, 400);
    }
    if (choices.length < 2 || choices.length > 20 || !choices.some((c) => c?.role === "offense" && c?.default === true) || !choices.some((c) => c?.role === "defense" && c?.default === true)) {
      return response({ error: "both_roles_need_choices_and_defaults" }, 400);
    }
    for (const choice of choices) {
      if (!choice || !["offense", "defense"].includes(choice.role) || typeof choice.key !== "string" || typeof choice.label !== "string" || choice.key.length > 64 || choice.label.length > 80) {
        return response({ error: "invalid_choice" }, 400);
      }
    }

    const admin = ctx.supabaseAdmin;
    const { data, error } = await admin.rpc("open_tactical_round", {
      p_game_id: gameId,
      p_pa_no: paNo,
      p_state_snapshot: input.state_snapshot && typeof input.state_snapshot === "object" ? input.state_snapshot : {},
      p_offense_team_id: offenseTeam,
      p_defense_team_id: defenseTeam,
      p_choices: choices,
    });
    if (error) return response({ error: "round_open_failed", detail: error.message }, 409);

    const round = data as { id: string; closes_at: string; status: string };
    if (round.status === "open") {
      // The invocation holds a server task for the shared 15-second window. Client disconnects do not cancel it.
      const resolver = (async () => {
        const waitMs = Math.max(0, Date.parse(round.closes_at) - Date.now() + 100);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        const { error: resolveError } = await admin.rpc("resolve_tactical_round", { p_round_id: round.id });
        if (resolveError) console.error("resolve_tactical_round failed", round.id, resolveError.message);
      })();
      const runtime = (globalThis as typeof globalThis & { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
      if (runtime?.waitUntil) runtime.waitUntil(resolver);
      else await resolver;
    }
    return response({ round_id: round.id, closes_at: round.closes_at, status: round.status });
  }),
};
