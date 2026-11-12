import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { friendlyDbError } from "./db-errors";
import { addDays, todayIn } from "./dates";
import { proposeRates, type RuleLimits } from "./revenue";
import type { ForecastRow, PricingAdjustment, PricingRule, PropertySettings, RateSeason, RoomType } from "./types";

export interface PricingRunResult {
  until: string;
  applied: number;
  pending: number;
  withdrawn: number;
  /** No active rules: every dynamic rate still live was withdrawn. */
  noRules: boolean;
}

/**
 * Prices every night in the forecast window with the current rules: from
 * "Run the rules" on the Revenue page, and nightly from /api/cron/pricing
 * (0041), so rates follow the forecast without anyone remembering to click.
 *
 * Reconciliation, night by night:
 *   • a proposal matching a live rate from the same rule is left alone, so an
 *     approval survives the engine running again
 *   • any other proposal replaces what is there — the old row is expired and
 *     the new one goes live or into the queue, by the threshold
 *   • a live or waiting rate with no proposal behind it any more is expired,
 *     because the condition that justified it has stopped being true. With
 *     every rule switched off that is all of them (it used to leave them live).
 *
 * `propertyId` is given by the nightly job, whose service client sees every
 * hotel: each query is then held to that hotel.
 */
export async function runPricing(
  supabase: SupabaseClient,
  settings: PropertySettings,
  opts: { staffId: string | null; days: number; propertyId?: string },
): Promise<{ error: string } | PricingRunResult> {
  const today = todayIn(settings.timezone);
  const until = addDays(today, opts.days);
  const scoped = <T extends { eq: (c: string, v: string) => T }>(q: T) =>
    opts.propertyId ? q.eq("property_id", opts.propertyId) : q;

  const [forecast, rules, roomTypes, seasons, existing] = await Promise.all([
    supabase.rpc("revenue_forecast", { p_from: today, p_to: until }),
    scoped(supabase.from("pricing_rules").select("*").eq("is_active", true)),
    scoped(supabase.from("room_types").select("*").eq("is_active", true)),
    scoped(supabase.from("rate_seasons").select("*").gte("end_date", today)),
    scoped(
      supabase
        .from("pricing_adjustments")
        .select("*")
        .in("status", ["pending", "applied"])
        .gte("stay_date", today)
        .lte("stay_date", until),
    ),
  ]);
  if (forecast.error) return { error: friendlyDbError(forecast.error.message) };

  const live = (existing.data ?? []) as PricingAdjustment[];
  const activeRules = (rules.data ?? []) as PricingRule[];

  const limits: RuleLimits = {
    floorRate: Number(settings.revenue_floor_rate),
    ceilingRate: Number(settings.revenue_ceiling_rate),
    autoApprovePercent: Number(settings.revenue_auto_approve_percent),
  };
  const proposals = activeRules.length
    ? proposeRates(
        (forecast.data ?? []) as ForecastRow[],
        activeRules,
        (roomTypes.data ?? []) as RoomType[],
        (seasons.data ?? []) as RateSeason[],
        limits,
        today,
      )
    : [];

  const keyOf = (stayDate: string, roomTypeId: string) => `${stayDate}|${roomTypeId}`;
  const liveByKey = new Map(live.map((a) => [keyOf(a.stay_date, a.room_type_id), a]));
  const proposedKeys = new Set(proposals.map((p) => keyOf(p.stay_date, p.room_type_id)));

  const expire: string[] = [];
  const insert: Record<string, unknown>[] = [];

  for (const p of proposals) {
    const current = liveByKey.get(keyOf(p.stay_date, p.room_type_id));
    const unchanged =
      current &&
      current.rule_id === p.rule_id &&
      Number(current.proposed_rate) === p.proposed_rate &&
      Number(current.base_rate) === p.base_rate;
    if (unchanged) continue;

    if (current) expire.push(current.id);
    insert.push({
      stay_date: p.stay_date,
      room_type_id: p.room_type_id,
      rule_id: p.rule_id,
      rule_name: p.rule_name,
      occasion: p.occasion,
      base_rate: p.base_rate,
      proposed_rate: p.proposed_rate,
      change_percent: p.change_percent,
      occupancy_percent: p.occupancy_percent,
      rooms_sold: p.rooms_sold,
      capacity: p.capacity,
      status: p.autoApproves ? "applied" : "pending",
      threshold_percent: limits.autoApprovePercent,
      created_by: opts.staffId,
      // A change that needs nobody's approval is decided the moment it is made.
      decided_at: p.autoApproves ? new Date().toISOString() : null,
    });
  }

  // Rates whose rule no longer matches this night (all of them with no rules).
  for (const a of live) {
    if (!proposedKeys.has(keyOf(a.stay_date, a.room_type_id))) expire.push(a.id);
  }

  // Expire first: a night may hold only one live or waiting rate per type.
  if (expire.length > 0) {
    const { error } = await supabase
      .from("pricing_adjustments")
      .update({ status: "expired", decided_at: new Date().toISOString() })
      .in("id", expire);
    if (error) return { error: friendlyDbError(error.message) };
  }
  if (insert.length > 0) {
    const { error } = await supabase.from("pricing_adjustments").insert(insert);
    if (error) return { error: friendlyDbError(error.message) };
  }

  const applied = insert.filter((r) => r.status === "applied").length;
  return { until, applied, pending: insert.length - applied, withdrawn: expire.length, noRules: activeRules.length === 0 };
}

/** The sentence the Revenue page shows after a run. */
export function describePricingRun(r: PricingRunResult): string {
  if (r.noRules) {
    return r.withdrawn > 0
      ? `No pricing rules are switched on, so the ${r.withdrawn} dynamic rate${r.withdrawn === 1 ? "" : "s"} still live ${r.withdrawn === 1 ? "was" : "were"} withdrawn. Rates are back to the rate plans.`
      : "No pricing rules are switched on, and no dynamic rates are live.";
  }
  if (r.applied + r.pending + r.withdrawn === 0) {
    return `Rules run to ${r.until}. Every night is already at the rate the rules ask for.`;
  }
  const parts = [
    r.applied > 0 ? `${r.applied} rate${r.applied === 1 ? "" : "s"} live` : "",
    r.pending > 0 ? `${r.pending} waiting for approval` : "",
    r.withdrawn > 0 ? `${r.withdrawn} withdrawn` : "",
  ].filter(Boolean);
  return `Rules run to ${r.until}: ${parts.join(", ")}.`;
}
