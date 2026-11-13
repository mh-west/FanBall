import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// Admin-only: daily visit counts from Cloudflare Web Analytics, for the admin page's own display
// (dist/admin-games.js). The caller's Supabase session is used only to check is_admin(); the
// Cloudflare API token stays server-side (Supabase secret CF_API_TOKEN) and is never sent to the browser.
// FanBall is a single-page app (internal pages don't reload the document), so one pageload beacon
// per day is a close stand-in for "one browser visited that day" - not Cloudflare's own distinct-visitor count.
const CF_ACCOUNT_ID = "74e6f3b6bdb4580c475581a20decc192";
const CF_SITE_TAG = "6aea4f58390a4d5aa04d9b9d41209cd7";
const DAYS = 30;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return response({ error: "method_not_allowed" }, 405);

  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
  });
  const { data: isAdmin, error: adminError } = await userClient.rpc("is_admin");
  if (adminError || isAdmin !== true) return response({ error: "admin only" }, 403);

  const until = new Date();
  const since = new Date(until.getTime() - DAYS * 86400000);
  const cfResp = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("CF_API_TOKEN")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query($accountTag: String!, $siteTag: String!, $since: Time!, $until: Time!) {
        viewer { accounts(filter: {accountTag: $accountTag}) {
          rumPageloadEventsAdaptiveGroups(filter: {siteTag: $siteTag, datetime_geq: $since, datetime_leq: $until}, limit: 31, orderBy: [date_DESC]) {
            count
            dimensions { date }
          }
        } }
      }`,
      variables: { accountTag: CF_ACCOUNT_ID, siteTag: CF_SITE_TAG, since: since.toISOString(), until: until.toISOString() },
    }),
  });
  const cfJson = await cfResp.json();
  if (!cfResp.ok || cfJson.errors) return response({ error: "cloudflare_query_failed", detail: cfJson.errors }, 502);

  const rows = cfJson.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || [];
  const days = rows.map((r: { count: number; dimensions: { date: string } }) => ({ date: r.dimensions.date, visits: r.count }))
    .sort((a: { date: string }, b: { date: string }) => (a.date < b.date ? 1 : -1));
  return response({ days });
});
