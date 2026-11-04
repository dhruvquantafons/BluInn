import Link from "next/link";
import { ArrowLeft, LogOut, ShieldCheck } from "lucide-react";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "../../lib/auth";
import { PRODUCT } from "../../lib/app-config";
import { getSettings } from "../../lib/settings";
import { passwordExpired } from "../../lib/password-policy";
import { changeOwnPassword } from "../security-actions";
import { signOut } from "../actions";
import { Card, Field, Notice, inputClass } from "../components/ui";
import ActionForm from "../components/ActionForm";
import BrandMark, { Wordmark } from "../components/BrandMark";
import TwoFactorPanel from "./TwoFactorPanel";
import { isDemoTwoFactor, demoCode } from "../../lib/two-factor";
import { adminFonts } from "../fonts";

export const metadata: Metadata = { title: "Password & 2FA", robots: { index: false, follow: false } };

/**
 * Lives outside the (protected) layout on purpose: the layout redirects here
 * when 2FA or a password change is required, so this page must not apply
 * those same checks or it would loop.
 */
export default async function SecurityPage({ searchParams }: { searchParams: Promise<{ required?: string }> }) {
  await connection();
  const session = await getSession();
  if (!session) redirect("/login");
  // A second factor already enrolled must be used before changing anything.
  if (session.aal.next === "aal2" && session.aal.current !== "aal2") redirect("/login/verify?next=/security");

  const { required } = await searchParams;
  const settings = await getSettings();
  const mustChange =
    session.staff.must_change_password || passwordExpired(session.staff.password_changed_at, settings.password_max_age_days);
  const needs2fa = session.role.requires_2fa && !session.hasTotp;
  const blocked = mustChange || needs2fa;

  return (
    <main className={`admin-theme ${adminFonts} min-h-screen bg-slate-50`}>
      {/* The app's own top bar, minus the navigation: this page sits outside
          the (protected) layout, but should not look like a different product. */}
      <header className="admin-topbar sticky top-0 z-30 h-14 flex items-center gap-3 px-3 sm:px-5 text-white">
        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          <span className="w-9 h-9 rounded-xl bg-white/10 ring-1 ring-white/20 flex items-center justify-center">
            <BrandMark className="w-7 h-7" />
          </span>
          <span>
            <Wordmark className="block text-[15px] leading-none" />
            <span className="block text-[8.5px] uppercase tracking-[0.2em] text-white/65 leading-none mt-1.5">
              {PRODUCT.descriptor}
            </span>
          </span>
        </Link>
        <div className="ml-auto">
          {blocked ? (
            <form action={signOut}>
              <button className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm text-white/90 ring-1 ring-white/20 hover:bg-white/10 cursor-pointer">
                <LogOut className="w-4 h-4" /> Sign out
              </button>
            </form>
          ) : (
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm text-white/90 ring-1 ring-white/20 hover:bg-white/10"
            >
              <ArrowLeft className="w-4 h-4" /> Back to {PRODUCT.name}
            </Link>
          )}
        </div>
      </header>

      <div className="max-w-xl mx-auto space-y-6 px-4 py-8 sm:py-10">
        <div className="flex items-center gap-4">
          <span className="w-12 h-12 shrink-0 rounded-2xl bg-brand-50 text-brand-600 ring-1 ring-brand-100 flex items-center justify-center">
            <ShieldCheck className="w-6 h-6" strokeWidth={1.75} />
          </span>
          <div>
            <h1>Password &amp; two-factor</h1>
            <p className="text-sm text-slate-600 mt-0.5">
              {session.staff.full_name || session.staff.email} · {session.role.name}
            </p>
          </div>
        </div>

        {required && blocked && (
          <Notice tone="warn">
            {mustChange && <p>Please choose a new password before continuing.</p>}
            {needs2fa && <p>Your role requires two-factor authentication. Set it up below to continue.</p>}
          </Notice>
        )}

        <Card className="p-5">
          <p className="text-base font-semibold mb-4">Change password</p>
          <ActionForm action={changeOwnPassword} submitLabel="Change password">
            <Field label="Current password">
              <input type="password" name="current_password" required autoComplete="current-password" className={inputClass} />
            </Field>
            <Field
              label="New password"
              hint={`At least ${settings.password_min_length} characters with upper and lower case, a number and a symbol.`}
            >
              <input type="password" name="password" required autoComplete="new-password" className={inputClass} />
            </Field>
            <Field label="Repeat new password">
              <input type="password" name="confirm" required autoComplete="new-password" className={inputClass} />
            </Field>
          </ActionForm>
        </Card>

        <Card className="p-5">
          <p className="text-base font-semibold mb-1">Two-factor authentication</p>
          <p className="text-sm text-slate-600 mb-4">
            {session.hasTotp
              ? session.role.requires_2fa && isDemoTwoFactor()
                ? "On — required by your role. You enter a code at each sign-in."
                : "On. You enter a code at each sign-in."
              : isDemoTwoFactor()
                ? "Off."
                : "Off. Use Google Authenticator, Microsoft Authenticator, 1Password or similar."}
          </p>
          <TwoFactorPanel
            enabled={session.hasTotp}
            required={session.role.requires_2fa}
            demoCode={isDemoTwoFactor() ? demoCode() : null}
          />
        </Card>
      </div>
    </main>
  );
}
