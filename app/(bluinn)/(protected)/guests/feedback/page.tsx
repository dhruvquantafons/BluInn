import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "../../../../lib/supabase/server";
import { requirePermission } from "../../../../lib/auth";
import type { GuestFeedback } from "../../../../lib/types";
import {
  Card,
  EmptyState,
  StatCard,
  fmtDateTime,
  Pagination,
  pageParam,
  pageRange,
  pageHref,
  outOfRange,
} from "../../../components/ui";

type Row = GuestFeedback & { guests: { id: string; full_name: string } | null; bookings: { reference: string } | null };

const ASPECTS = ["room", "service", "cleanliness", "food"] as const;

export default async function FeedbackListPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  await requirePermission("guests.view");
  const page = pageParam((await searchParams).page);
  const supabase = await createClient();
  // The averages cover the 200 most recent responses; the list below pages.
  const [{ data, error, count }, { data: scoreRows }] = await Promise.all([
    supabase
      .from("guest_feedback")
      .select("*, guests(id, full_name), bookings(reference)", { count: "exact" })
      .not("submitted_at", "is", null)
      .order("submitted_at", { ascending: false })
      .range(...pageRange(page)),
    supabase
      .from("guest_feedback")
      .select("overall, room, service, cleanliness, food")
      .not("submitted_at", "is", null)
      .order("submitted_at", { ascending: false })
      .limit(200),
  ]);
  if (outOfRange(error)) redirect(pageHref("/guests/feedback", {}, 1));
  const rows = (data ?? []) as Row[];
  const scored = (scoreRows ?? []) as Pick<GuestFeedback, "overall" | (typeof ASPECTS)[number]>[];
  const avg = (k: "overall" | (typeof ASPECTS)[number]) => {
    const vals = scored.map((r) => r[k]).filter((v): v is number => !!v);
    return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : "—";
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard label="Overall" value={avg("overall")} hint={`${scored.length} response(s)`} />
        <StatCard label="Room" value={avg("room")} />
        <StatCard label="Service" value={avg("service")} />
        <StatCard label="Cleanliness" value={avg("cleanliness")} />
        <StatCard label="Food" value={avg("food")} />
      </div>
      <Card>
        {rows.length === 0 ? (
          <EmptyState message="No feedback yet. Record what a guest tells the desk from their profile." />
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((f) => (
              <li key={f.id} className="px-4 py-3 text-sm">
                <p>
                  <span className="text-brand-600">{"★".repeat(f.overall ?? 0)}</span>
                  <span className="text-slate-300">{"★".repeat(5 - (f.overall ?? 0))}</span>{" "}
                  {f.guests ? (
                    <Link href={`/guests/${f.guests.id}`} className="font-medium text-slate-900 hover:text-brand-800">
                      {f.guests.full_name}
                    </Link>
                  ) : (
                    "Guest"
                  )}
                  <span className="text-xs text-slate-500">
                    {f.bookings && ` · ${f.bookings.reference}`} · {f.source === "guest" ? "online" : "via the desk"} ·{" "}
                    {fmtDateTime(f.submitted_at!)}
                  </span>
                </p>
                <p className="text-xs text-slate-600 mt-0.5">
                  {ASPECTS.filter((k) => f[k])
                    .map((k) => `${k[0].toUpperCase()}${k.slice(1)} ${f[k]}/5`)
                    .join(" · ")}
                </p>
                {f.comment && <p className="text-slate-700 mt-1">{f.comment}</p>}
              </li>
            ))}
          </ul>
        )}
        <Pagination page={page} total={count ?? 0} path="/guests/feedback" />
      </Card>
    </div>
  );
}
