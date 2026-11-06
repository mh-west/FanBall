import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, "Content-Type": "application/json" },
});

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return response({ error: "method_not_allowed" }, 405);
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return response({ error: "server_not_configured" }, 503);
  if (request.headers.get("Authorization") !== `Bearer ${serviceKey}`) return response({ error: "service_auth_required" }, 401);

  let body: { round_id?: unknown };
  try { body = await request.json(); } catch { return response({ error: "invalid_json" }, 400); }
  if (typeof body.round_id !== "string") return response({ error: "round_id_required" }, 400);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data, error } = await admin.rpc("resolve_tactical_round", { p_round_id: body.round_id });
  if (error) return response({ error: "round_not_ready_or_failed", detail: error.message }, 409);
  return response(data);
});
