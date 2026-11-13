import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail } from "./integrations";
import {
  flashKpis,
  FLASH_DEPARTMENTS,
  kpisFrom,
  lastClosedDay,
  reportByKind,
  resolveRange,
  scheduleNeedsFinancial,
  toGrid,
  type DailyRow,
  type FlashReport,
} from "./reports";
import { runReport } from "./report-data";
import type { PropertySettings, ReportSchedule } from "./types";
import { APP_URL, PRODUCT } from "./app-config";

/**
 * Building and sending a scheduled report (Module 13: "Scheduled email
 * reports (daily/weekly/monthly) to management").
 *
 * Shared by the cron endpoint and the "send now" button so a manager's test
 * email is byte-for-byte what the scheduler will send. With no email keys the
 * send is recorded as skipped, exactly like every other notification in the
 * system — nothing breaks, and the schedule page says so plainly.
 */

/** How far back each frequency looks when it runs. */
export function rangeForFrequency(frequency: ReportSchedule["frequency"], today: string) {
  switch (frequency) {
    case "daily":
      return resolveRange("yesterday", today);
    case "weekly":
      return resolveRange("last7", today);
    case "monthly":
      return resolveRange("last_month", today);
  }
}

export interface BuiltReport {
  subject: string;
  html: string;
  text: string;
  error: string | null;
}

const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Renders a report as a plain HTML table and a text fallback. Deliberately
 * unstyled: these land in Outlook and Gmail on a phone, where a layout is a
 * liability and a readable table is not.
 */
export async function buildScheduledReport(
  db: SupabaseClient,
  schedule: ReportSchedule,
): Promise<BuiltReport> {
  const built = await buildReportBody(db, schedule);
  if (built.error) return built;
  // A quiet sign-off, so a manager knows where the email came from and where
  // to change it. Staff mail only: guest messages carry the hotel's name alone.
  const manage = `${APP_URL}/reports/schedules`;
  return {
    ...built,
    html:
      built.html +
      `<p style="color:#999;font-size:11px;margin-top:24px">Sent by ${escape(PRODUCT.name)} · ` +
      `<a href="${escape(manage)}" style="color:#999">Manage scheduled reports</a></p>`,
    text: `${built.text}\n\n— Sent by ${PRODUCT.name} · ${manage}`,
  };
}

async function buildReportBody(db: SupabaseClient, schedule: ReportSchedule): Promise<BuiltReport> {
  const { data: settingsRow } = await db.from("property_settings").select("*").maybeSingle();
  const settings = (settingsRow ?? {}) as Partial<PropertySettings>;
  const timezone = settings.timezone ?? "Asia/Kolkata";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
  const range = rangeForFrequency(schedule.frequency, today);
  const hotel = settings.name ?? "Your Hotel";

  // The flash report (0037): the last day night audit closed, with month and
  // year to date, as the screen shows it. Frequency does not change it.
  if (schedule.report === "flash") {
    const day = settings.business_date ? lastClosedDay(settings.business_date) : today;
    const { data, error } = await db.rpc("report_flash", { p_date: day });
    if (error || !data) return { subject: "", html: "", text: "", error: error?.message ?? "The flash report could not be built." };
    const report = data as FlashReport;
    const money = (n: number) => `${settings.currency ?? "INR"} ${n.toFixed(2)}`;
    const cols = [
      ["Day", report.periods.day],
      ["Month to date", report.periods.mtd],
      ["Year to date", report.periods.ytd],
    ] as const;
    const rows: [string, string[]][] = [
      ["Occupancy", cols.map(([, p]) => `${flashKpis(p).occupancy}%`)],
      ["ADR", cols.map(([, p]) => money(flashKpis(p).adr))],
      ["RevPAR", cols.map(([, p]) => money(flashKpis(p).revpar))],
      ...FLASH_DEPARTMENTS.map(
        (d) => [`Revenue: ${d === "fnb" ? "F&B" : d}`, cols.map(([, p]) => money(Number(p?.revenue?.[d] ?? 0)))] as [string, string[]],
      ),
      ["Total revenue", cols.map(([, p]) => money(flashKpis(p).totalRevenue))],
    ];
    const subject = `${hotel} — flash report, ${day}`;
    return {
      subject,
      html:
        `<p>${escape(hotel)}<br><strong>Flash report for ${escape(day)}</strong></p>` +
        `<table cellpadding="6" style="border-collapse:collapse;font-size:13px">` +
        `<tr><th></th>${cols.map(([l]) => `<th align="right" style="border-bottom:2px solid #333">${escape(l)}</th>`).join("")}</tr>` +
        rows
          .map(
            ([label, values]) =>
              `<tr><td style="border-bottom:1px solid #eee">${escape(label)}</td>` +
              values.map((v) => `<td style="border-bottom:1px solid #eee;text-align:right">${escape(v)}</td>`).join("") +
              `</tr>`,
          )
          .join("") +
        `</table>` +
        `<p style="color:#666;font-size:12px">In house: ${report.today.in_house_rooms} rooms, ${report.today.in_house_guests} guests. ` +
        `Owed by guests in house: ${escape(money(Number(report.in_house_balance)))}.</p>`,
      text:
        `${hotel}\nFlash report for ${day}\n\n` +
        `\t${cols.map(([l]) => l).join("\t")}\n` +
        rows.map(([label, values]) => `${label}\t${values.join("\t")}`).join("\n"),
      error: null,
    };
  }

  // The KPI summary is not one of the report functions: it is the headline
  // figures a GM wants in the body of an email, not a table to scroll.
  if (schedule.report === "kpi_summary") {
    const definition = reportByKind("daily_revenue")!;
    const { rows, error } = await runReport(db, definition, range);
    if (error) return { subject: "", html: "", text: "", error };

    const k = kpisFrom(rows as unknown as DailyRow[], Number(settings.monthly_operating_cost ?? 0));
    const money = (n: number) => `${settings.currency ?? "INR"} ${n.toFixed(2)}`;
    const lines: [string, string][] = [
      ["Occupancy", `${k.occupancy}%`],
      ["Rooms sold", `${k.roomsSold} of ${k.availableRoomNights} room-nights`],
      ["ADR", money(k.adr)],
      ["RevPAR", money(k.revpar)],
      ["GOPPAR", k.goppar === null ? "not reported (no operating cost set)" : money(k.goppar)],
      ["Room revenue", money(k.roomRevenue)],
      ["Other revenue", money(k.otherRevenue)],
      ["Total revenue (excl. tax)", money(k.netRevenue)],
      ["Tax charged", money(k.taxTotal)],
    ];

    const subject = `${hotel} — performance ${range.from === range.to ? range.from : `${range.from} to ${range.to}`}`;
    return {
      subject,
      html:
        `<p>${escape(hotel)}<br><strong>${escape(range.from)} to ${escape(range.to)}</strong></p>` +
        `<table cellpadding="6" style="border-collapse:collapse">` +
        lines
          .map(
            ([label, value]) =>
              `<tr><td style="border-bottom:1px solid #eee">${escape(label)}</td>` +
              `<td style="border-bottom:1px solid #eee;text-align:right"><strong>${escape(value)}</strong></td></tr>`,
          )
          .join("") +
        `</table>` +
        `<p style="color:#666;font-size:12px">${k.auditedDays} of ${k.days} day(s) closed by night audit. ` +
        `Figures for days not yet closed may still change.</p>`,
      text:
        `${hotel}\n${range.from} to ${range.to}\n\n` +
        lines.map(([label, value]) => `${label}: ${value}`).join("\n") +
        `\n\n${k.auditedDays} of ${k.days} day(s) closed by night audit.`,
      error: null,
    };
  }

  const definition = reportByKind(schedule.report);
  if (!definition) return { subject: "", html: "", text: "", error: "That report no longer exists." };

  const { rows, error } = await runReport(db, definition, range);
  if (error) return { subject: "", html: "", text: "", error };

  const grid = toGrid(definition, rows);
  const period = definition.ranged
    ? range.from === range.to
      ? range.from
      : `${range.from} to ${range.to}`
    : `as at ${today}`;
  const subject = `${hotel} — ${definition.label}, ${period}`;

  if (rows.length === 0) {
    return {
      subject,
      html: `<p>${escape(hotel)}<br><strong>${escape(definition.label)}</strong><br>${escape(period)}</p><p>Nothing to report.</p>`,
      text: `${hotel}\n${definition.label}\n${period}\n\nNothing to report.`,
      error: null,
    };
  }

  const cell = (value: string | number, align: boolean) =>
    `<td style="border-bottom:1px solid #eee;${align ? "text-align:right" : ""}">${escape(String(value))}</td>`;

  return {
    subject,
    html:
      `<p>${escape(hotel)}<br><strong>${escape(definition.label)}</strong><br>${escape(period)}</p>` +
      `<table cellpadding="6" style="border-collapse:collapse;font-size:13px">` +
      `<tr>${grid.header.map((h) => `<th align="left" style="border-bottom:2px solid #333">${escape(h)}</th>`).join("")}</tr>` +
      grid.body
        .map((row) => `<tr>${row.map((v, i) => cell(v, Boolean(definition.columns[i].money))).join("")}</tr>`)
        .join("") +
      `</table>`,
    text:
      `${hotel}\n${definition.label}\n${period}\n\n` +
      [grid.header, ...grid.body].map((row) => row.join("\t")).join("\n"),
    error: null,
  };
}

/**
 * Sends a built report to every recipient and records the outcome on the
 * schedule, so the page can show when it last went and whether it worked.
 */
export async function sendScheduledReport(
  db: SupabaseClient,
  schedule: ReportSchedule,
  built: BuiltReport,
): Promise<{ status: "sent" | "skipped" | "failed"; error: string }> {
  const recipients = schedule.recipients
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

  if (recipients.length === 0) {
    await db
      .from("report_schedules")
      .update({ last_status: "no recipients", last_sent_at: new Date().toISOString() })
      .eq("id", schedule.id);
    return { status: "failed", error: "No recipients." };
  }

  const results = await Promise.all(
    recipients.map((to) => sendEmail({ to, subject: built.subject, html: built.html, text: built.text })),
  );

  const failed = results.filter((r) => r.status === "failed");
  const skipped = results.filter((r) => r.status === "skipped");
  const status = failed.length === results.length && failed.length > 0
    ? "failed"
    : skipped.length === results.length
      ? "skipped"
      : "sent";

  await db
    .from("report_schedules")
    .update({
      last_sent_at: new Date().toISOString(),
      last_status:
        status === "sent"
          ? `sent to ${results.length - failed.length - skipped.length} of ${results.length}`
          : status === "skipped"
            ? "skipped — email not configured"
            : (failed[0]?.error ?? "failed"),
    })
    .eq("id", schedule.id);

  return { status, error: failed[0]?.error ?? "" };
}

/** Whether a schedule is due on a given date, in the property's timezone. */
export function isDue(schedule: Pick<ReportSchedule, "frequency" | "last_sent_at">, today: string, weekday: number) {
  const lastDay = schedule.last_sent_at ? schedule.last_sent_at.slice(0, 10) : "";
  // Never send the same schedule twice in one day, however often cron runs.
  if (lastDay === today) return false;

  switch (schedule.frequency) {
    case "daily":
      return true;
    case "weekly":
      return weekday === 1; // Monday
    case "monthly":
      return today.endsWith("-01");
  }
}

/**
 * Whether the person who set a schedule up may still see what it sends
 * (0043). The cron runs as the hotel, not as anyone, so it asks: a revenue
 * report stops going out once its creator loses financial reports or leaves.
 * Returns null when it may be sent, or the reason it may not.
 */
export async function scheduleCreatorProblem(db: SupabaseClient, schedule: ReportSchedule): Promise<string | null> {
  if (!scheduleNeedsFinancial(schedule.report)) return null;
  if (!schedule.created_by) return "no one is recorded as setting it up; save it again";
  const { data: staff } = await db.from("staff").select("role, is_active").eq("id", schedule.created_by).maybeSingle();
  if (!staff || !staff.is_active) return "the person who set it up no longer works here; save it again";
  const [{ data: role }, { data: grant }] = await Promise.all([
    db.from("roles").select("is_superuser").eq("key", staff.role).maybeSingle(),
    db.from("role_permissions").select("permission").eq("role_key", staff.role).eq("permission", "reports.financial").maybeSingle(),
  ]);
  if (role?.is_superuser || grant) return null;
  return "the person who set it up can no longer see financial reports";
}
