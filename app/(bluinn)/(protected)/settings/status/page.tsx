import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { createClient } from "../../../../lib/supabase/server";
import { requirePermission } from "../../../../lib/auth";
import { getSettings } from "../../../../lib/settings";
import { emailConfigured, smsConfigured } from "../../../../lib/integrations";
import { isTestMode, razorpayConfigured, webhookConfigured } from "../../../../lib/razorpay";
import { hasServiceAccess, usesNeon } from "../../../../lib/supabase/config";
import { isDemoTwoFactor } from "../../../../lib/two-factor";
import { addDays } from "../../../../lib/dates";
import { sendTestEmail, sendTestSms } from "../../../admin-actions";
import { Card, Notice, PageHeader, SectionTitle, Tag, fmtDate, fmtDateTime, secondaryButtonClass, tableHeadClass } from "../../../components/ui";
import ActionForm from "../../../components/ActionForm";

type Status = {
  migrations: { count: number; latest: string | null; latest_at: string | null };
  database: { version: string; now: string };
  hotels: {
    id: string;
    code: string;
    name: string;
    is_active: boolean;
    business_date: string;
    today: string;
    last_audit: { date: string; status: string; at: string } | null;
  }[];
  jobs: { job: string; started_at: string; finished_at: string | null; ok: boolean | null; detail: string }[];
};

type Row = { name: string; state: "ok" | "off" | "warn"; detail: string };

const TONE = { ok: "green", off: "neutral", warn: "amber" } as const;
const LABEL = { ok: "Working", off: "Not set up", warn: "Check" } as const;

/** The scheduled jobs BluInn expects, and how often each should run. */
const JOBS: { job: string; label: string; everyHours: number }[] = [
  { job: "notifications", label: "Guest and staff messages", everyHours: 24 },
  { job: "maintenance", label: "Maintenance escalation and preventive tickets", everyHours: 1 },
  { job: "reports", label: "Scheduled report emails", everyHours: 24 },
];

/**
 * System status (0038): whether each integration is set up, the database
 * and its migrations, each hotel's business date and last night audit, and
 * the last run of every scheduled job. No secret is ever shown, only whether
 * it is set.
 */
export default async function SystemStatusPage() {
  await requirePermission("settings.manage");
  const settings = await getSettings();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("system_status");
  const status = data as Status | null;

  const set = (v: string | undefined) => Boolean(v && v.trim());
  const integrations: Row[] = [
    {
      name: "Email (Resend)",
      state: emailConfigured() ? "ok" : "off",
      detail: emailConfigured() ? `Sends from ${process.env.NOTIFY_FROM_EMAIL}` : "Set RESEND_API_KEY and NOTIFY_FROM_EMAIL. Guest messages are skipped until then.",
    },
    {
      name: "SMS (Twilio)",
      state: smsConfigured() ? "ok" : "off",
      detail: smsConfigured() ? "Configured" : "Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER.",
    },
    {
      name: "Online payments (Razorpay)",
      state: !razorpayConfigured() ? "off" : isTestMode() || !webhookConfigured() || !settings.online_payments_enabled ? "warn" : "ok",
      detail: !razorpayConfigured()
        ? "Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET."
        : [
            isTestMode() ? "Test keys — no real money moves" : "Live keys",
            webhookConfigured() ? "webhook secret set" : "RAZORPAY_WEBHOOK_SECRET missing, so payments are never confirmed",
            settings.online_payments_enabled ? "switched on in Settings" : "switched off in Settings",
          ].join(" · "),
    },
    {
      name: "Kitchen display (KOT)",
      state: set(process.env.KOT_WEBHOOK_URL) ? "ok" : "off",
      detail: set(process.env.KOT_WEBHOOK_URL) ? "Tickets are sent to the kitchen display" : "Optional. Tickets are printed from the browser.",
    },
    {
      name: "Door locks",
      state: set(process.env.DOOR_LOCK_WEBHOOK_URL) ? "ok" : "off",
      detail: set(process.env.DOOR_LOCK_WEBHOOK_URL) ? "Key cards are issued through the lock system" : "Optional. Key cards are cut at the lock's own desk.",
    },
    {
      name: "Biometric attendance",
      state: set(process.env.ATTENDANCE_API_SECRET) ? "ok" : "off",
      detail: set(process.env.ATTENDANCE_API_SECRET) ? "Devices can post clock-ins" : "Optional. Set ATTENDANCE_API_SECRET to accept device clock-ins.",
    },
    {
      name: "Scheduled jobs",
      state: set(process.env.CRON_SECRET) ? "ok" : "warn",
      detail: set(process.env.CRON_SECRET) ? "CRON_SECRET set" : "Set CRON_SECRET, or reminders, escalations and report emails never run.",
    },
  ];
  const security: Row[] = [
    {
      name: "Two-step sign-in",
      state: isDemoTwoFactor() ? "warn" : "ok",
      detail: isDemoTwoFactor()
        ? "DEMO MODE: every code is the same fixed code. Set TWO_FACTOR_MODE=totp before go-live."
        : "Authenticator apps (TOTP)",
    },
    {
      name: "Session signing",
      state: usesNeon() ? (set(process.env.AUTH_SECRET) ? "ok" : "warn") : "ok",
      detail: usesNeon() ? (set(process.env.AUTH_SECRET) ? "AUTH_SECRET set" : "AUTH_SECRET missing") : "Managed by Supabase",
    },
    {
      name: "Server access",
      state: hasServiceAccess() ? "ok" : "warn",
      detail: hasServiceAccess() ? "Scheduled jobs and sign-in history can run" : "No service key: sign-in history and scheduled jobs are unavailable.",
    },
  ];

  const table = (rows: Row[]) => (
    <ul className="divide-y divide-slate-100">
      {rows.map((r) => (
        <li key={r.name} className="py-2.5 flex flex-wrap items-start gap-3 text-sm">
          <span className="w-56 shrink-0 text-slate-900">{r.name}</span>
          <Tag tone={TONE[r.state]}>{LABEL[r.state]}</Tag>
          <span className="flex-1 min-w-[200px] text-xs text-slate-600">{r.detail}</span>
        </li>
      ))}
    </ul>
  );

  const now = status ? new Date(status.database.now).getTime() : 0;

  return (
    <>
      <Link href="/settings" className="inline-flex items-center gap-1.5 text-xs text-slate-600 hover:text-brand-700 mb-4">
        <ArrowLeft className="w-3.5 h-3.5" /> Settings
      </Link>
      <PageHeader title="System status" description="What is connected, what is running, and what still needs setting up." />

      {isDemoTwoFactor() && (
        <div className="mb-6">
          <Notice tone="error">
            Two-step sign-in is in demo mode: anyone who knows a password can pass the second step with the demo code. Set
            TWO_FACTOR_MODE=totp before real staff use this system.
          </Notice>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-5">
          <SectionTitle>Integrations</SectionTitle>
          {table(integrations)}
          <div className="flex flex-wrap gap-3 pt-4 mt-2 border-t border-slate-100">
            <ActionForm action={sendTestEmail} submitLabel="Send me a test email" submitClassName={secondaryButtonClass}>
              {null}
            </ActionForm>
            <ActionForm action={sendTestSms} submitLabel="Send me a test SMS" submitClassName={secondaryButtonClass}>
              {null}
            </ActionForm>
          </div>
        </Card>

        <div className="space-y-6">
          <Card className="p-5">
            <SectionTitle>Security</SectionTitle>
            {table(security)}
          </Card>

          <Card className="p-5">
            <SectionTitle>Database</SectionTitle>
            {error || !status ? (
              <Notice tone="warn">{error?.message ?? "Could not read the database status."}</Notice>
            ) : (
              <dl className="text-sm divide-y divide-slate-100">
                <div className="flex justify-between py-2">
                  <dt className="text-slate-500">Engine</dt>
                  <dd>{usesNeon() ? "Neon Postgres" : "Supabase Postgres"} {status.database.version}</dd>
                </div>
                <div className="flex justify-between py-2">
                  <dt className="text-slate-500">Schema version</dt>
                  <dd className="font-mono text-xs">
                    {status.migrations.latest ?? "—"} ({status.migrations.count} migrations)
                  </dd>
                </div>
                {status.migrations.latest_at && (
                  <div className="flex justify-between py-2">
                    <dt className="text-slate-500">Last updated</dt>
                    <dd>{fmtDateTime(status.migrations.latest_at)}</dd>
                  </div>
                )}
                <div className="flex justify-between py-2">
                  <dt className="text-slate-500">Database clock</dt>
                  <dd>{fmtDateTime(status.database.now)}</dd>
                </div>
              </dl>
            )}
          </Card>
        </div>
      </div>

      {status && (
        <>
          <Card className="mt-6">
            <div className="px-4 pt-4">
              <SectionTitle>Hotels</SectionTitle>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className={tableHeadClass}>
                    <th className="px-4 py-2 font-semibold">Hotel</th>
                    <th className="px-4 py-2 font-semibold">Business date</th>
                    <th className="px-4 py-2 font-semibold">Last night audit</th>
                    <th className="px-4 py-2 font-semibold">State</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {status.hotels.map((h) => {
                    const behind = h.business_date < addDays(h.today, -1);
                    return (
                      <tr key={h.id}>
                        <td className="px-4 py-2">
                          <span className="font-mono text-slate-500">{h.code}</span> {h.name}
                          {!h.is_active && <span className="text-slate-400"> (closed)</span>}
                        </td>
                        <td className="px-4 py-2">{fmtDate(h.business_date)}</td>
                        <td className="px-4 py-2">
                          {h.last_audit ? `${fmtDate(h.last_audit.date)} · ${h.last_audit.status}` : "Never run"}
                        </td>
                        <td className="px-4 py-2">
                          {behind ? (
                            <Tag tone="amber">Night audit is behind</Tag>
                          ) : (
                            <Tag tone="green">Up to date</Tag>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="mt-6">
            <div className="px-4 pt-4">
              <SectionTitle>Scheduled jobs</SectionTitle>
            </div>
            <ul className="divide-y divide-slate-100 px-4 pb-2">
              {JOBS.map((j) => {
                const run = status.jobs.find((r) => r.job === j.job);
                const stale = run && now - new Date(run.started_at).getTime() > j.everyHours * 2 * 3600 * 1000;
                return (
                  <li key={j.job} className="py-2.5 flex flex-wrap items-start gap-3 text-sm">
                    <span className="w-72 shrink-0 text-slate-900">{j.label}</span>
                    {!run ? (
                      <Tag tone="neutral">Never run</Tag>
                    ) : run.ok === false ? (
                      <Tag tone="red">Failed</Tag>
                    ) : stale ? (
                      <Tag tone="amber">Overdue</Tag>
                    ) : (
                      <Tag tone="green">Ran</Tag>
                    )}
                    <span className="flex-1 min-w-[200px] text-xs text-slate-600">
                      {run ? `Last run ${fmtDateTime(run.started_at)}` : `Expected every ${j.everyHours === 1 ? "hour" : "day"} from the scheduler.`}
                      {run?.ok === false && run.detail && <span className="block text-rose-700 break-all">{run.detail}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Card>
        </>
      )}
    </>
  );
}
