import { connection } from "next/server";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { ArrowLeft, Info, ShieldCheck, Smartphone } from "lucide-react";
import { getSession } from "../../../lib/auth";
import { verifyTotp } from "../../security-actions";
import { isDemoTwoFactor, demoCode } from "../../../lib/two-factor";
import { signOut } from "../../actions";
import { buttonClass } from "../../components/ui";
import ActionForm from "../../components/ActionForm";
import AuthShell from "../../components/AuthShell";
import CodeInput from "./CodeInput";

export const metadata: Metadata = { title: "Verify sign-in", robots: { index: false, follow: false } };

export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  await connection();
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.aal.current === "aal2" || session.aal.next !== "aal2") redirect("/");
  const { next = "/" } = await searchParams;
  const demo = isDemoTwoFactor();

  return (
    <AuthShell
      badge={<ShieldCheck strokeWidth={1.75} />}
      title="Two-step verification"
      subtitle={demo ? "Enter the 6-digit demo code to continue." : "Enter the 6-digit code from your authenticator app."}
    >
      <div className="space-y-5">
        <p className="flex items-center gap-2.5 rounded-xl bg-slate-50 border border-slate-200 px-3.5 py-2.5 text-[13px] text-slate-600">
          <Smartphone className="w-4 h-4 shrink-0 text-slate-400" />
          <span className="min-w-0 truncate">
            Signing in as <strong className="font-semibold text-slate-900">{session.staff.email}</strong>
          </span>
        </p>

        {demo && (
          <div className="flex items-start gap-2.5 rounded-xl bg-amber-50 border border-amber-200 px-3.5 py-3 text-[13px] text-amber-900">
            <Info className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
            <span>
              Demo mode — the code is{" "}
              <strong className="font-mono text-[14px] tracking-[0.25em] bg-white/70 rounded-md px-1.5 py-0.5 ring-1 ring-amber-200">
                {demoCode()}
              </strong>
              .
            </span>
          </div>
        )}

        <ActionForm
          action={verifyTotp}
          submitLabel="Verify and continue"
          pendingLabel="Checking…"
          className="space-y-5"
          submitClassName={`${buttonClass} admin-btn-glow w-full h-11 text-[15px]`}
        >
          <input type="hidden" name="next" value={next} />
          <CodeInput />
          <p className="text-[12px] text-slate-500 -mt-2">
            {demo ? "" : "Codes refresh every 30 seconds. "}The form submits once all six digits are in.
          </p>
        </ActionForm>

        <form action={signOut} className="pt-1 text-center">
          <button className="inline-flex items-center gap-1.5 text-[13px] font-medium text-slate-500 hover:text-brand-700 transition-colors duration-150 cursor-pointer">
            <ArrowLeft className="w-3.5 h-3.5" />
            Use a different account
          </button>
        </form>
      </div>
    </AuthShell>
  );
}
