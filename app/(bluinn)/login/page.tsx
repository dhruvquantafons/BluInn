import { Suspense } from "react";
import { connection } from "next/server";
import type { Metadata } from "next";
import LoginForm from "./LoginForm";
import { hasSupabaseConfig } from "../../lib/supabase/config";
import SetupNotice from "../components/SetupNotice";
import BrandMark from "../components/BrandMark";
import { adminFonts } from "../fonts";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

export default async function LoginPage() {
  await connection();
  if (!hasSupabaseConfig()) return <SetupNotice />;

  return (
    <main className={`admin-theme ${adminFonts} min-h-screen bg-slate-50 grid lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]`}>
      {/* Brand panel: the hero gradient of the app, with the BluInn mark. */}
      <section className="admin-hero hidden lg:flex flex-col justify-between rounded-none! p-12 xl:p-16">
        <div className="flex items-center gap-3">
          <span className="w-12 h-12 rounded-2xl bg-white/10 ring-1 ring-white/25 flex items-center justify-center">
            <BrandMark className="w-9 h-9" />
          </span>
          <span>
            <span className="admin-display block text-xl leading-none">BluInn</span>
            <span className="block text-[10px] uppercase tracking-[0.2em] text-white/70 mt-1.5">Property management</span>
          </span>
        </div>
        <div className="max-w-md">
          <h1 className="text-4xl! leading-tight!">Every room, every guest, one desk.</h1>
          <p className="text-[15px] text-white/80 mt-4 leading-relaxed">
            Front office, housekeeping, outlets, billing and reports for the hotel, in one place.
          </p>
        </div>
        <p className="text-xs text-white/60">Staff access only.</p>
      </section>

      <div className="flex items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <span className="lg:hidden admin-topbar mx-auto w-16 h-16 rounded-2xl flex items-center justify-center shadow-md">
              <BrandMark className="w-11 h-11" />
            </span>
            <p className="admin-display text-3xl text-slate-900 mt-4 lg:mt-0">Welcome back</p>
            <p className="text-sm text-slate-500 mt-1">Sign in to BluInn</p>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-7">
            <Suspense
              fallback={<p className="text-sm text-slate-500 text-center py-8">Loading…</p>}
            >
              <LoginForm />
            </Suspense>
          </div>

          <p className="text-center text-[11px] text-slate-400 mt-6">
            Staff access only. Ask an administrator for an account.
          </p>
        </div>
      </div>
    </main>
  );
}
