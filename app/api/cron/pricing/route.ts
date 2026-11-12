import { createServiceClient } from "../../../lib/supabase/server";
import { withJobRun } from "../../../lib/job-runs";
import { hasBearer } from "../../../lib/bearer";
import { DEFAULT_SETTINGS } from "../../../lib/settings";
import { runPricing } from "../../../lib/pricing-run";
import type { PropertySettings } from "../../../lib/types";
import { hasServiceAccess } from "../../../lib/supabase/config";

/**
 * Nightly pricing job (0041): runs every hotel's pricing rules over its
 * forecast window, exactly as "Run the rules" on the Revenue page does, so
 * rates follow the forecast without anyone remembering to press it. Small
 * changes go live on their own; larger ones wait in Approvals. A hotel with
 * every rule switched off has its leftover dynamic rates withdrawn.
 *
 * Call it once a night from a scheduler (Vercel Cron sends
 * "Authorization: Bearer <CRON_SECRET>"; see vercel.json). Disabled until
 * CRON_SECRET is set. Safe to run more than once: an unchanged proposal is
 * left as it is.
 */
async function run(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !hasServiceAccess()) {
    return Response.json({ error: "The pricing job is not configured." }, { status: 503 });
  }
  if (!hasBearer(request, secret)) return Response.json({ error: "Unauthorized." }, { status: 401 });

  const { data: hotels } = await createServiceClient().from("properties").select("id, name").eq("is_active", true);
  const results: Record<string, unknown>[] = [];
  for (const hotel of hotels ?? []) {
    const supabase = createServiceClient(hotel.id as string);
    const { data } = await supabase.from("property_settings").select("*").maybeSingle();
    const settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) } as PropertySettings;
    const r = await runPricing(supabase, settings, {
      staffId: null,
      days: Number(settings.revenue_forecast_days) || 60,
      propertyId: hotel.id as string,
    });
    results.push({ property: hotel.name, ...r });
  }
  return Response.json({ properties: results });
}

export async function GET(request: Request) {
  return withJobRun("pricing", () => run(request));
}
