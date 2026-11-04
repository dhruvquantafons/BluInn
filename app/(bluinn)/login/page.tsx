import { Suspense } from "react";
import { connection } from "next/server";
import type { Metadata } from "next";
import LoginForm from "./LoginForm";
import { hasSupabaseConfig } from "../../lib/supabase/config";
import SetupNotice from "../components/SetupNotice";
import AuthShell from "../components/AuthShell";
import { PRODUCT } from "../../lib/app-config";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

export default async function LoginPage() {
  await connection();
  if (!hasSupabaseConfig()) return <SetupNotice />;

  return (
    <AuthShell title="Welcome back" subtitle={`Sign in to ${PRODUCT.name} with your staff account.`}>
      <Suspense fallback={<p className="text-sm text-slate-500 text-center py-8">Loading…</p>}>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
