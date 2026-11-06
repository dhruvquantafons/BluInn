"use server";

import { requirePermission } from "../lib/auth";
import { getSettings } from "../lib/settings";
import { sendEmail, sendSms, normalisePhone } from "../lib/integrations";
import type { ActionState } from "./form-utils";

/** System status (0038): prove email and SMS work by sending yourself one. */

export async function sendTestEmail(): Promise<ActionState> {
  const session = await requirePermission("settings.manage");
  const settings = await getSettings();
  const to = session.staff.email;
  const result = await sendEmail({
    to,
    subject: `${settings.name}: test email from BluInn`,
    text: `This is a test from System status. If you can read it, guest and staff emails will reach their inboxes.`,
    html: `<p>This is a test from <strong>System status</strong>.</p><p>If you can read it, guest and staff emails will reach their inboxes.</p>`,
  });
  if (result.status === "sent") return { success: `Sent to ${to}. Check the inbox (and the spam folder).` };
  if (result.status === "skipped") return { error: `Not sent: ${result.error || "email is not configured."}` };
  return { error: `The email provider refused it: ${result.error}` };
}

export async function sendTestSms(): Promise<ActionState> {
  const session = await requirePermission("settings.manage");
  const settings = await getSettings();
  const phone = (session.staff.phone ?? "").trim();
  if (!phone) return { error: "Add your phone number under HR → My profile first." };
  const to = normalisePhone(phone);
  const result = await sendSms({ to, body: `${settings.name}: test SMS from BluInn System status.` });
  if (result.status === "sent") return { success: `Sent to ${to}.` };
  if (result.status === "skipped") return { error: `Not sent: ${result.error || "SMS is not configured."}` };
  return { error: `The SMS provider refused it: ${result.error}` };
}
