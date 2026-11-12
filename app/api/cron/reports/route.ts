import { createServiceClient } from "../../../lib/supabase/server";
import { withJobRun } from "../../../lib/job-runs";
import { hasBearer } from "../../../lib/bearer";
import { buildScheduledReport, isDue, scheduleCreatorProblem, sendScheduledReport } from "../../../lib/report-email";
import type { ReportSchedule } from "../../../lib/types";
import { hasServiceAccess } from "../../../lib/supabase/config";

/**
 * Scheduled report job (Module 13: "Scheduled email reports
 * (daily/weekly/monthly) to management").
 *
 * Call it once a morning from a scheduler (e.g. Vercel Cron, which sends
 * "Authorization: Bearer <CRON_SECRET>"). Disabled until CRON_SECRET is set.
 *
 * Safe to call more than once a day: a schedule that has already gone out
 * today is skipped, so a retry cannot send the owner the same report twice.
 * Daily reports cover yesterday, weekly go out on Monday for the last seven
 * days, and monthly on the 1st for the whole of last month — a report covers
 * a period that has finished, never a half-finished one.
 */
async function run(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !hasServiceAccess()) {
    return Response.json({ error: "The scheduled report job is not configured." }, { status: 503 });
  }
  if (!hasBearer(request, secret)) return Response.json({ error: "Unauthorized." }, { status: 401 });

  // Each schedule is built for the hotel it belongs to, on that hotel's
  // calendar, with that hotel's figures (0041). Every schedule used to be
  // built from the default hotel's data.
  const { data: hotels } = await createServiceClient().from("properties").select("id, name, timezone").eq("is_active", true);
  const results: { property: string; name: string; status: string }[] = [];
  let active = 0;
  let dueCount = 0;
  for (const hotel of hotels ?? []) {
    const supabase = createServiceClient(hotel.id as string);
    const { today, weekday } = hotelDay((hotel.timezone as string) || "Asia/Kolkata");

    const { data } = await supabase.from("report_schedules").select("*").eq("is_active", true).eq("property_id", hotel.id);
    const schedules = (data ?? []) as ReportSchedule[];
    const due = schedules.filter((s) => isDue(s, today, weekday));
    active += schedules.length;
    dueCount += due.length;

    for (const schedule of due) {
      const refused = await scheduleCreatorProblem(supabase, schedule);
      if (refused) {
        await supabase
          .from("report_schedules")
          .update({ last_sent_at: new Date().toISOString(), last_status: `Not sent: ${refused}.` })
          .eq("id", schedule.id);
        results.push({ property: hotel.name as string, name: schedule.name, status: `not sent: ${refused}` });
        continue;
      }
      const built = await buildScheduledReport(supabase, schedule);
      if (built.error) {
        await supabase
          .from("report_schedules")
          .update({ last_sent_at: new Date().toISOString(), last_status: built.error })
          .eq("id", schedule.id);
        results.push({ property: hotel.name as string, name: schedule.name, status: `not built: ${built.error}` });
        continue;
      }
      const sent = await sendScheduledReport(supabase, schedule, built);
      results.push({ property: hotel.name as string, name: schedule.name, status: sent.status });
    }
  }

  return Response.json({ active, due: dueCount, results });
}

/** The hotel's own date and weekday (0 = Sunday), not the server's. */
function hotelDay(timezone: string) {
  const now = new Date();
  const today = now.toLocaleDateString("en-CA", { timeZone: timezone });
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(now),
  );
  return { today, weekday };
}

export async function GET(request: Request) {
  return withJobRun("reports", () => run(request));
}
