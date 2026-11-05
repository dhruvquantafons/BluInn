import { createClient } from "../../../../../lib/supabase/server";
import { getSession } from "../../../../../lib/auth";
import { can } from "../../../../../lib/permissions";
import { getSettings } from "../../../../../lib/settings";
import { todayIn } from "../../../../../lib/dates";
import { toCsv } from "../../../../../lib/hr";
import { buildRegister, REGISTER_LABELS, REGISTER_SECTIONS, type RegisterSection } from "../../../../../lib/gst-register";
import { loadRegister, registerMonth } from "../../../../../lib/gst-register-data";

/** One section of the month's GST register as CSV (0036). */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return new Response("Not signed in.", { status: 401 });
  if (!can(session, "reports.financial")) return new Response("Your role does not allow this report.", { status: 403 });

  const url = new URL(request.url);
  const section = url.searchParams.get("section") as RegisterSection | null;
  if (!section || !REGISTER_SECTIONS.includes(section)) return new Response("No such section.", { status: 404 });

  const settings = await getSettings();
  const month = registerMonth(url.searchParams.get("month") ?? undefined, todayIn(settings.timezone));
  const supabase = await createClient();
  const { input, error } = await loadRegister(supabase, settings, month);
  if (error) return new Response(error, { status: 403 });

  const grid = buildRegister(input)[section];
  const csv = toCsv([
    [`${REGISTER_LABELS[section]} — ${month.slice(0, 7)}`],
    [`${settings.legal_name || settings.name}${settings.gstin ? ` — GSTIN ${settings.gstin}` : ""}`],
    [],
    grid.header,
    ...grid.body.map((row) => row.map((c) => (typeof c === "number" ? Math.round(c * 100) / 100 : c))),
  ]);

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="gst_${section}_${month.slice(0, 7)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
