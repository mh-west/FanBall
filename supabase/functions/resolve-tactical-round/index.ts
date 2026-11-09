import { withSupabase } from "npm:@supabase/server@1";

const response = (body: unknown, status = 200) => Response.json(body, { status });

// Trusted server code only. The caller sends the default Supabase Secret key in the apikey header.
export default {
  fetch: withSupabase({ auth: "secret", cors: "disabled" }, async (request, ctx) => {
    if (request.method !== "POST") return response({ error: "method_not_allowed" }, 405);

    let body: { round_id?: unknown };
    try { body = await request.json(); } catch { return response({ error: "invalid_json" }, 400); }
    if (typeof body.round_id !== "string") return response({ error: "round_id_required" }, 400);
    const { data, error } = await ctx.supabaseAdmin.rpc("resolve_tactical_round", { p_round_id: body.round_id });
    if (error) return response({ error: "round_not_ready_or_failed", detail: error.message }, 409);
    return response(data);
  }),
};
