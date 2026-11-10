import { withSupabase } from "npm:@supabase/server@1";
import { runTick } from "../_shared/orchestrator.js";

// Called by Supabase Cron (public.orchestrator_dispatch) with the Secret key in the apikey header.
// Advances every due official game by one step. See docs/ORCHESTRATOR_DESIGN.md.
export default {
  fetch: withSupabase({ auth: "secret", cors: "disabled" }, async (request, ctx) => {
    if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
    const rpc = async (name: string, args: Record<string, unknown> = {}) => {
      const { data, error } = await ctx.supabaseAdmin.rpc(name, args);
      if (error) throw new Error(`${name}: ${error.message}`);
      return data;
    };
    try {
      return Response.json(await runTick(rpc));
    } catch (error) {
      console.error("orchestrator tick failed", error);
      return Response.json({ error: "tick_failed", detail: String((error as Error)?.message || error) }, { status: 500 });
    }
  }),
};
