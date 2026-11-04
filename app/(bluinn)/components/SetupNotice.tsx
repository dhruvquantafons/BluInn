import { Database } from "lucide-react";
import AuthShell from "./AuthShell";
import { PRODUCT } from "../../lib/app-config";

const codeClass = "bg-slate-100 px-1.5 py-0.5 rounded text-[13px]";

/** Shown in place of the app until the database is configured. */
export default function SetupNotice() {
  return (
    <AuthShell
      badge={<Database strokeWidth={1.75} />}
      title={`${PRODUCT.name} is not configured`}
      subtitle={
        process.env.DATABASE_URL
          ? "DATABASE_URL is set, but AUTH_SECRET is missing or shorter than 32 characters."
          : `${PRODUCT.name} needs a database before it can run.`
      }
    >
      <ol className="text-sm text-slate-700 space-y-2.5 list-decimal pl-5 mb-5">
        <li>
          Create a Postgres database at{" "}
          <a
            href="https://console.neon.tech"
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand-700 underline"
          >
            console.neon.tech
          </a>
          .
        </li>
        <li>
          Set <code className={codeClass}>DATABASE_URL</code> to its connection string and{" "}
          <code className={codeClass}>AUTH_SECRET</code> to a random string of 32+ characters.
        </li>
        <li>
          Run <code className={codeClass}>npm run db:migrate</code>, then{" "}
          <code className={codeClass}>npm run db:create-admin -- you@hotel.com &apos;password&apos;</code>.
        </li>
      </ol>

      <p className="text-xs text-slate-500">Full instructions are in the project README.</p>
    </AuthShell>
  );
}
