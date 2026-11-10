import { withSupabase } from "npm:@supabase/server@1";
import { runLoop } from "../_shared/orchestrator.js";

// Called by Supabase Cron (public.orchestrator_dispatch) with the Secret key in the apikey header.
// Answers at once, then keeps advancing due official games in the background for up to ~50 s so
// pitches land on a steady 2-second beat. See docs/ORCHESTRATOR_DESIGN.md.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };
const BUDGET_MS = 50_000; // well inside the 150 s wall-clock limit of the Free plan

export default {
  fetch: withSupabase({ auth: "secret", cors: "disabled" }, async (request, ctx) => {
    if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
    const rpc = async (name: string, args: Record<string, unknown> = {}) => {
      const { data, error } = await ctx.supabaseAdmin.rpc(name, args);
      if (error) throw new Error(`${name}: ${error.message}`);
      return data;
    };
    const work = runLoop(rpc, { budgetMs: BUDGET_MS })
      .then(steps => {
        const errors = steps.filter((s: { error?: string }) => s.error);
        if (errors.length) console.error("orchestrator loop errors", errors);
      })
      .catch(error => console.error("orchestrator loop failed", error));
    EdgeRuntime.waitUntil(work);
    return Response.json({ accepted: true }, { status: 202 });
  }),
};
