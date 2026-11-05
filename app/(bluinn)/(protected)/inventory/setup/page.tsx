import { createClient } from "../../../../lib/supabase/server";
import { requirePermission } from "../../../../lib/auth";
import {
  INVENTORY_CATEGORY_LABELS,
  INVENTORY_LOCATION_LABELS,
  type InventoryItem,
  type InventoryLocation,
} from "../../../../lib/types";
import { saveInventoryItem, saveInventoryLocation } from "../../../inventory-actions";
import { Card, Check, Field, SectionTitle, Tag, inputClass, secondaryButtonClass } from "../../../components/ui";
import ActionForm from "../../../components/ActionForm";

type Option = { id: string; label: string };

/**
 * Where stock is kept, and what is stocked — with the links that make it
 * move on its own: a location attached to an outlet loses stock as its bills
 * are settled; an item linked to a housekeeping checklist line is used up
 * when a room is cleaned (0033).
 */
export default async function InventorySetupPage() {
  await requirePermission("inventory.manage");
  const supabase = await createClient();
  const [{ data: locationRows }, { data: itemRows }, { data: outletRows }, { data: posItemRows }, { data: checklistRows }] =
    await Promise.all([
      supabase.from("inventory_locations").select("*").order("sort_order").order("name"),
      supabase.from("inventory_items").select("*").order("category").order("name"),
      supabase.from("pos_outlets").select("id, name").order("sort_order"),
      supabase.from("pos_items").select("id, name, pos_outlets(name)").eq("is_active", true).order("name"),
      supabase.from("hk_checklist_items").select("id, label, category").eq("is_active", true).order("sort_order"),
    ]);
  const locations = (locationRows ?? []) as InventoryLocation[];
  const items = (itemRows ?? []) as InventoryItem[];
  const outlets: Option[] = (outletRows ?? []).map((o) => ({ id: o.id as string, label: o.name as string }));
  const posItems: Option[] = (posItemRows ?? []).map((p) => ({
    id: p.id as string,
    label: `${p.name} (${(p.pos_outlets as unknown as { name: string } | null)?.name ?? ""})`,
  }));
  const checklist: Option[] = (checklistRows ?? []).map((c) => ({ id: c.id as string, label: `${c.label} (${c.category})` }));

  const select = (name: string, options: Option[], value: string | null, empty: string) => (
    <select name={name} defaultValue={value ?? ""} className={inputClass}>
      <option value="">{empty}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );

  const LocationFields = ({ l }: { l?: InventoryLocation }) => (
    <>
      {l && <input type="hidden" name="id" value={l.id} />}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <Field label="Name">
          <input name="name" required defaultValue={l?.name} placeholder="Main store, Floor 2 pantry…" className={inputClass} />
        </Field>
        <Field label="Kind">
          <select name="kind" defaultValue={l?.kind ?? "store"} className={inputClass}>
            {Object.entries(INVENTORY_LOCATION_LABELS).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Outlet it supplies" hint="Its bills use stock from here.">
          {select("outlet_id", outlets, l?.outlet_id ?? null, "None")}
        </Field>
        <Field label="Order">
          <input type="number" name="sort_order" min={0} defaultValue={l?.sort_order ?? 0} className={inputClass} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-6">
        <Check name="hk_default" defaultChecked={l?.hk_default} label="Housekeeping draws amenities from here" />
        {l && <Check name="is_active" defaultChecked={l.is_active} label="In use" />}
      </div>
    </>
  );

  const ItemFields = ({ i }: { i?: InventoryItem }) => (
    <>
      {i && <input type="hidden" name="id" value={i.id} />}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <Field label="Name">
          <input name="name" required defaultValue={i?.name} className={inputClass} />
        </Field>
        <Field label="SKU">
          <input name="sku" defaultValue={i?.sku} className={inputClass} />
        </Field>
        <Field label="Category">
          <select name="category" defaultValue={i?.category ?? "amenity"} className={inputClass}>
            {Object.entries(INVENTORY_CATEGORY_LABELS).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Unit">
          <input name="unit" defaultValue={i?.unit ?? "each"} placeholder="each, bottle, kg…" className={inputClass} />
        </Field>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
        <Field label="Par level" hint="What a full shelf holds.">
          <input type="number" name="par_level" min={0} step="0.001" defaultValue={i?.par_level ?? 0} className={inputClass} />
        </Field>
        <Field label="Re-order at">
          <input type="number" name="reorder_level" min={0} step="0.001" defaultValue={i?.reorder_level ?? 0} className={inputClass} />
        </Field>
        <Field label="Unit cost (₹)">
          <input type="number" name="unit_cost" min={0} step="0.01" defaultValue={i?.unit_cost ?? 0} className={inputClass} />
        </Field>
        <Field label="Sold as (POS item)">{select("pos_item_id", posItems, i?.pos_item_id ?? null, "Not sold")}</Field>
        <Field label="Housekeeping checklist line">
          {select("hk_checklist_item_id", checklist, i?.hk_checklist_item_id ?? null, "None")}
        </Field>
      </div>
      {i && <Check name="is_active" defaultChecked={i.is_active} label="Stocked" />}
    </>
  );

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <SectionTitle>Locations</SectionTitle>
        <div className="space-y-3 mb-5">
          {locations.map((l) => (
            <details key={l.id} className="border border-slate-100 rounded-lg px-4 py-2.5">
              <summary className="cursor-pointer text-sm flex flex-wrap items-center gap-2">
                <span className="font-medium text-slate-900">{l.name}</span>
                <Tag>{INVENTORY_LOCATION_LABELS[l.kind]}</Tag>
                {l.outlet_id && <Tag tone="blue">Supplies {outlets.find((o) => o.id === l.outlet_id)?.label}</Tag>}
                {l.hk_default && <Tag tone="violet">Housekeeping</Tag>}
                {!l.is_active && <Tag tone="red">Not in use</Tag>}
              </summary>
              <ActionForm action={saveInventoryLocation} submitLabel="Save" submitClassName={secondaryButtonClass} className="space-y-3 mt-3">
                <LocationFields l={l} />
              </ActionForm>
            </details>
          ))}
        </div>
        <p className="text-xs font-medium text-brand-700 mb-2">Add a location</p>
        <ActionForm action={saveInventoryLocation} submitLabel="Add location" submitClassName={secondaryButtonClass} className="space-y-3">
          <LocationFields />
        </ActionForm>
      </Card>

      <Card className="p-5">
        <SectionTitle>Items</SectionTitle>
        <div className="space-y-3 mb-5">
          {items.map((i) => (
            <details key={i.id} className="border border-slate-100 rounded-lg px-4 py-2.5">
              <summary className="cursor-pointer text-sm flex flex-wrap items-center gap-2">
                <span className="font-medium text-slate-900">{i.name}</span>
                <span className="text-xs text-slate-500">
                  {i.sku ? `${i.sku} · ` : ""}
                  {INVENTORY_CATEGORY_LABELS[i.category]}
                </span>
                {i.pos_item_id && <Tag tone="blue">Sold at POS</Tag>}
                {i.hk_checklist_item_id && <Tag tone="violet">Housekeeping</Tag>}
                {!i.is_active && <Tag tone="red">Not stocked</Tag>}
              </summary>
              <ActionForm action={saveInventoryItem} submitLabel="Save" submitClassName={secondaryButtonClass} className="space-y-3 mt-3">
                <ItemFields i={i} />
              </ActionForm>
            </details>
          ))}
        </div>
        <p className="text-xs font-medium text-brand-700 mb-2">Add an item</p>
        <ActionForm action={saveInventoryItem} submitLabel="Add item" submitClassName={secondaryButtonClass} className="space-y-3">
          <ItemFields />
        </ActionForm>
      </Card>
    </div>
  );
}
