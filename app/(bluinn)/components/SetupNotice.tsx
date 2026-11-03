import { Database } from "lucide-react";

/** Shown in place of the app until the database is configured. */
export default function SetupNotice() {
  return (
    <main className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white rounded-lg border border-slate-200 p-7 shadow-sm">
        <div className="w-11 h-11 rounded-full bg-yellow-50 text-yellow-700 flex items-center justify-center mb-4">
          <Database className="w-5 h-5" />
        </div>

        <h1 className="text-lg font-semibold text-slate-900 mb-2">
          Reservations desk not configured
        </h1>
        <p className="text-sm text-slate-700 leading-relaxed mb-5">
          {process.env.DATABASE_URL
            ? "DATABASE_URL is set, but AUTH_SECRET is missing or shorter than 32 characters."
            : "BluInn needs a database before it can run."}
        </p>

        <ol className="text-sm text-slate-700 space-y-2.5 list-decimal pl-5 mb-5">
          <li>
            Create a Postgres database at{" "}
            <a
              href="https://console.neon.tech"
              target="_blank"
              rel="noopener noreferrer"
              className="text-yellow-700 underline"
            >
              console.neon.tech
            </a>
            .
          </li>
          <li>
            Set <code className="bg-slate-100 px-1.5 py-0.5 rounded text-[13px]">DATABASE_URL</code> to its connection string and{" "}
            <code className="bg-slate-100 px-1.5 py-0.5 rounded text-[13px]">AUTH_SECRET</code> to a random string of 32+ characters.
          </li>
          <li>
            Run <code className="bg-slate-100 px-1.5 py-0.5 rounded text-[13px]">npm run db:migrate</code>, then{" "}
            <code className="bg-slate-100 px-1.5 py-0.5 rounded text-[13px]">npm run db:create-admin -- you@hotel.com &apos;password&apos;</code>.
          </li>
        </ol>

        <p className="text-xs text-slate-500">
          Full instructions are in the project README.
        </p>
      </div>
    </main>
  );
}
