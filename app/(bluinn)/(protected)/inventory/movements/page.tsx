import { redirect } from "next/navigation";
import { ArrowLeftRight } from "lucide-react";
import { createClient } from "../../../../lib/supabase/server";
import { requireAnyPermission } from "../../../../lib/auth";
import { INVENTORY_MOVEMENT_LABELS, type InventoryMovement } from "../../../../lib/types";
import {
  Card,
  EmptyState,
  Tag,
  fmtDateTime,
  tableHeadClass,
  Pagination,
  pageParam,
  pageRange,
  pageHref,
  outOfRange,
} from "../../../components/ui";

const PAGE = 20;

type Row = InventoryMovement & {
  inventory_items: { name: string; unit: string } | null;
  inventory_locations: { name: string } | null;
  staff: { full_name: string; email: string } | null;
};

/** Every stock movement, newest first: the ledger behind the stock figures. */
export default async function MovementsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  await requireAnyPermission(["inventory.view", "inventory.manage"]);
  const page = pageParam((await searchParams).page);
  const supabase = await createClient();
  const { data, error, count } = await supabase
    .from("inventory_movements")
    .select("*, inventory_items(name, unit), inventory_locations(name), staff:created_by(full_name, email)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(...pageRange(page, PAGE));
  if (outOfRange(error)) redirect(pageHref("/inventory/movements", {}, 1));
  const rows = (data ?? []) as unknown as Row[];

  return (
    <Card>
      {rows.length === 0 ? (
        <EmptyState icon={<ArrowLeftRight />} message="No stock has moved yet." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className={tableHeadClass}>
                <th className="py-2.5 px-4 font-semibold">When</th>
                <th className="py-2.5 px-4 font-semibold">Item</th>
                <th className="py-2.5 px-4 font-semibold">Where</th>
                <th className="py-2.5 px-4 font-semibold">What</th>
                <th className="py-2.5 px-4 font-semibold text-right">Qty</th>
                <th className="py-2.5 px-4 font-semibold">Why</th>
                <th className="py-2.5 px-4 font-semibold">By</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((m) => (
                <tr key={m.id}>
                  <td className="py-2 px-4 whitespace-nowrap text-slate-600">{fmtDateTime(m.created_at)}</td>
                  <td className="py-2 px-4">{m.inventory_items?.name}</td>
                  <td className="py-2 px-4 text-slate-600">{m.inventory_locations?.name}</td>
                  <td className="py-2 px-4">
                    <Tag tone={m.qty > 0 ? "green" : m.kind === "wastage" ? "red" : "neutral"}>{INVENTORY_MOVEMENT_LABELS[m.kind]}</Tag>
                  </td>
                  <td className={`py-2 px-4 text-right tabular-nums ${m.qty < 0 ? "text-rose-700" : "text-emerald-700"}`}>
                    {m.qty > 0 ? "+" : ""}
                    {Number(m.qty)} {m.inventory_items?.unit}
                  </td>
                  <td className="py-2 px-4 text-slate-600">
                    {m.reason}
                    {m.reference ? <span className="text-slate-400"> · {m.reference}</span> : ""}
                  </td>
                  <td className="py-2 px-4 text-slate-600">{m.staff?.full_name || m.staff?.email || "System"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} total={count ?? 0} pageSize={PAGE} path="/inventory/movements" />
    </Card>
  );
}
