import Link from "next/link";
import { ScanSearch } from "lucide-react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Card, CardHeader, Tag, fmtDateTime } from "./ui";

export type Discrepancy = {
  room_id: string;
  room_number: string;
  kind: "skip" | "sleeper";
  luggage: boolean;
  notes: string;
  reported_at: string;
  booking_id: string | null;
  reference: string | null;
  contact_name: string | null;
};

export async function loadDiscrepancies(supabase: SupabaseClient): Promise<Discrepancy[]> {
  const { data } = await supabase.from("room_discrepancies").select("*").order("room_number");
  return (data ?? []) as Discrepancy[];
}

/**
 * Rooms where what housekeeping saw today disagrees with the front desk
 * (0032): a skip (the desk has a guest in house, the room is empty — they may
 * have left without paying) or a sleeper (the desk has the room vacant, but
 * someone is in it). Renders nothing when everything agrees.
 */
export default function DiscrepancyCard({ rows }: { rows: Discrepancy[] }) {
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader icon={<ScanSearch />} title="Room discrepancies" count={rows.length} description="Housekeeping's report today against the front desk" />
      <ul className="divide-y divide-slate-100">
        {rows.map((d) => (
          <li key={d.room_id} className="flex flex-wrap items-center gap-3 px-5 py-2.5 text-sm">
            <span className="font-semibold text-slate-900">Room {d.room_number}</span>
            <Tag tone={d.kind === "skip" ? "red" : "amber"}>{d.kind === "skip" ? "Skip" : "Sleeper"}</Tag>
            <span className="text-slate-600">
              {d.kind === "skip"
                ? <>In house as {d.booking_id ? <Link href={`/bookings/${d.booking_id}`} className="text-brand-700 hover:underline">{d.contact_name} ({d.reference})</Link> : "a guest"}, but housekeeping found it empty{d.luggage ? " (luggage still there)" : ""}.</>
                : <>Vacant at the desk, but housekeeping found it in use{d.luggage ? ", with luggage" : ""}.</>}
              {d.notes ? ` “${d.notes}”` : ""}
            </span>
            <span className="ml-auto text-[11px] text-slate-500">{fmtDateTime(d.reported_at)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
