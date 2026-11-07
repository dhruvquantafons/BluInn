import Link from "next/link";
import { Boxes } from "lucide-react";
import { createClient } from "../../../lib/supabase/server";
import { requireAnyPermission } from "../../../lib/auth";
import { can } from "../../../lib/permissions";
import { stockState, toOrder, totalsByItem, type StockRow } from "../../../lib/inventory";
import {
  INVENTORY_CATEGORY_LABELS,
  type InventoryCategory,
  type InventoryItem,
  type InventoryLocation,
} from "../../../lib/types";
import { moveStock } from "../../inventory-actions";
import {
  Card,
  CardHeader,
  EmptyState,
  Field,
  Pagination,
  StatCard,
  Tag,
  clampPage,
  fmtMoney,
  pageParam,
  pageRange,
  inputClass,
  secondaryButtonClass,
  tableHeadClass,
} from "../../components/ui";
import ActionForm from "../../components/ActionForm";

const STATE_TAG = {
  out: { text: "Out", tone: "red" },
  reorder: { text: "Re-order", tone: "amber" },
  below_par: { text: "Below par", tone: "neutral" },
  ok: { text: "OK", tone: "green" },
} as const;

/**
 * Stock on hand per item and location, what is low, and a form to receive,
 * issue, count or write off stock.
 */
export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ category?: string; low?: string; page?: string }> }) {
  const session = await requireAnyPermission(["inventory.view", "inventory.manage"]);
  const sp = await searchParams;
  const supabase = await createClient();
  const manage = can(session, "inventory.manage");

  const [{ data: itemRows }, { data: locationRows }, { data: levelRows }] = await Promise.all([
    supabase.from("inventory_items").select("*").eq("is_active", true).order("category").order("name"),
    supabase.from("inventory_locations").select("*").eq("is_active", true).order("sort_order").order("name"),
    supabase.from("stock_levels").select("item_id, location_id, qty"),
  ]);
  const items = (itemRows ?? []) as InventoryItem[];
  const locations = (locationRows ?? []) as InventoryLocation[];
  const levels = (levelRows ?? []) as StockRow[];
  const totals = totalsByItem(levels);
  const at = (itemId: string, locationId: string) =>
    Number(levels.find((l) => l.item_id === itemId && l.location_id === locationId)?.qty ?? 0);

  const category = (Object.keys(INVENTORY_CATEGORY_LABELS) as InventoryCategory[]).find((c) => c === sp.category);
  const onlyLow = sp.low === "1";
  const rows = items
    .map((i) => {
      const onHand = totals.get(i.id) ?? 0;
      return { item: i, onHand, state: stockState(onHand, Number(i.reorder_level), Number(i.par_level)) };
    })
    .filter((r) => (!category || r.item.category === category) && (!onlyLow || r.state === "out" || r.state === "reorder"));
  const low = items.filter((i) => ["out", "reorder"].includes(stockState(totals.get(i.id) ?? 0, Number(i.reorder_level), Number(i.par_level))));
  // Stock state is worked out per item here, so the table pages in memory.
  const page = clampPage(pageParam(sp.page), rows.length);
  const [from, to] = pageRange(page);
  const listParams = { category: category ?? null, low: onlyLow ? "1" : null };
  const value = items.reduce((s, i) => s + Math.max(0, totals.get(i.id) ?? 0) * Number(i.unit_cost), 0);

  if (items.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Boxes />}
          message={manage ? "Nothing is stocked yet. Add locations and items under Items & locations." : "Nothing is stocked yet."}
        />
        {manage && (
          <p className="px-5 pb-5 text-center">
            <Link href="/inventory/setup" className="text-sm text-brand-700 hover:underline">
              Set up items and locations
            </Link>
          </p>
        )}
      </Card>
    );
  }

  const chip = (href: string, label: string, active: boolean) => (
    <Link
      key={href}
      href={href}
      className={`px-2.5 py-1 rounded-md text-xs border ${active ? "border-brand-500 bg-brand-50 text-brand-800" : "border-slate-200 text-slate-600"}`}
    >
      {label}
    </Link>
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Items stocked" value={items.length} />
        <StatCard label="To re-order" value={low.length} hint={low.length ? "At or under the re-order level" : "Nothing low"} />
        <StatCard label="Locations" value={locations.length} />
        <StatCard label="Stock value" value={fmtMoney(Math.round(value))} hint="At last purchase cost" />
      </div>

      {manage && (
        <Card>
          <CardHeader icon={<Boxes />} title="Move stock" />
          <ActionForm action={moveStock} submitLabel="Record" submitClassName={secondaryButtonClass} className="p-5 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-6 gap-3">
              <div className="sm:col-span-2">
                <Field label="Item">
                  <select name="item_id" required defaultValue="" className={inputClass}>
                    <option value="" disabled>
                      Choose…
                    </option>
                    {items.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name} ({i.unit})
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="What happened">
                <select name="kind" defaultValue="receive" className={inputClass}>
                  <option value="receive">Received from supplier</option>
                  <option value="issue">Issued (from → to)</option>
                  <option value="consume">Used</option>
                  <option value="wastage">Wastage / write-off</option>
                  <option value="adjust">Stock count</option>
                </select>
              </Field>
              <Field label="Quantity" hint="For a count: what you counted.">
                <input type="number" name="qty" min={0} step="0.001" required className={inputClass} />
              </Field>
              <Field label="From">
                <select name="from_location" defaultValue="" className={inputClass}>
                  <option value="">—</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="To / at">
                <select name="to_location" defaultValue="" className={inputClass}>
                  <option value="">—</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Reason">
                <input name="reason" placeholder="Restock floor 2, broken in transit…" className={inputClass} />
              </Field>
              <Field label="Reference">
                <input name="reference" placeholder="Supplier invoice, requisition no." className={inputClass} />
              </Field>
              <Field label="Unit cost (₹)" hint="Receipts only; becomes the item's cost.">
                <input type="number" name="unit_cost" min={0} step="0.01" className={inputClass} />
              </Field>
            </div>
          </ActionForm>
        </Card>
      )}

      <Card>
        <div className="px-5 py-3 border-b border-slate-100 flex flex-wrap gap-2">
          {chip("/inventory", "All", !category && !onlyLow)}
          {chip("/inventory?low=1", `To re-order (${low.length})`, onlyLow)}
          {(Object.entries(INVENTORY_CATEGORY_LABELS) as [InventoryCategory, string][])
            .filter(([c]) => items.some((i) => i.category === c))
            .map(([c, l]) => chip(`/inventory?category=${c}`, l, category === c))}
        </div>
        {rows.length === 0 ? (
          <EmptyState icon={<Boxes />} message="Nothing matches." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={tableHeadClass}>
                  <th className="py-2.5 px-4 font-semibold">Item</th>
                  {locations.map((l) => (
                    <th key={l.id} className="py-2.5 px-3 font-semibold text-right whitespace-nowrap">
                      {l.name}
                    </th>
                  ))}
                  <th className="py-2.5 px-3 font-semibold text-right">On hand</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Par</th>
                  <th className="py-2.5 px-3 font-semibold text-right">To order</th>
                  <th className="py-2.5 px-4 font-semibold" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.slice(from, to + 1).map(({ item, onHand, state }) => (
                  <tr key={item.id} className="hover:bg-slate-50/60">
                    <td className="py-2.5 px-4">
                      <span className="text-slate-900">{item.name}</span>
                      <span className="block text-[11px] text-slate-500">
                        {item.sku ? `${item.sku} · ` : ""}
                        {INVENTORY_CATEGORY_LABELS[item.category]} · {item.unit}
                      </span>
                    </td>
                    {locations.map((l) => (
                      <td key={l.id} className="py-2.5 px-3 text-right tabular-nums text-slate-700">
                        {at(item.id, l.id) || "—"}
                      </td>
                    ))}
                    <td className="py-2.5 px-3 text-right tabular-nums font-medium">{onHand}</td>
                    <td className="py-2.5 px-3 text-right tabular-nums text-slate-600">{Number(item.par_level) || "—"}</td>
                    <td className="py-2.5 px-3 text-right tabular-nums">{toOrder(onHand, Number(item.par_level)) || "—"}</td>
                    <td className="py-2.5 px-4">
                      <Tag tone={STATE_TAG[state].tone}>{STATE_TAG[state].text}</Tag>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} total={rows.length} path="/inventory" params={listParams} />
      </Card>
    </div>
  );
}
