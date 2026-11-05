import type { createClient } from "./supabase/server";
import type { PropertySettings } from "./types";
import { monthEndOf, todayIn, zonedTime, addDays } from "./dates";
import type { OutletSalesRow, RegisterCreditNote, RegisterInput } from "./gst-register";
import { stateLabel } from "./gst";

type Client = Awaited<ReturnType<typeof createClient>>;

/** "2026-11" → its first day; anything else → the current month. */
export function registerMonth(value: string | undefined, today: string): string {
  return value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? `${value}-01` : `${today.slice(0, 7)}-01`;
}

/**
 * Everything issued in one month, in the hotel's time zone: the invoices
 * (cancelled ones too, for the document summary), the credit notes with the
 * invoices they correct, and outlet bills settled at the outlet.
 */
export async function loadRegister(
  supabase: Client,
  settings: PropertySettings,
  monthStart: string,
): Promise<{ input: RegisterInput; error: string | null }> {
  const tz = settings.timezone;
  const monthEnd = monthEndOf(monthStart);
  const from = zonedTime(monthStart, "00:00", tz).toISOString();
  const to = zonedTime(addDays(monthEnd, 1), "00:00", tz).toISOString();

  const [{ data: invoices, error: invError }, { data: notes, error: cnError }, { data: outlets, error: posError }] =
    await Promise.all([
      supabase
        .from("invoices")
        .select(
          "number, series, seq, issued_at, status, bill_to_name, bill_to_gstin, place_of_supply, is_interstate, grand_total, tax_breakdown, tax_regime",
        )
        .gte("issued_at", from)
        .lt("issued_at", to)
        .order("series")
        .order("seq"),
      supabase
        .from("credit_notes")
        .select(
          "number, series, seq, issued_at, bill_to_name, bill_to_gstin, place_of_supply, is_interstate, grand_total, tax_breakdown, invoices(number, issued_at)",
        )
        .gte("issued_at", from)
        .lt("issued_at", to)
        .order("seq"),
      supabase.rpc("gst_outlet_sales", { p_from: monthStart, p_to: monthEnd }),
    ]);

  const dayOf = (iso: string) => todayIn(tz, new Date(iso));
  const creditNotes: RegisterCreditNote[] = (
    (notes ?? []) as unknown as (Omit<RegisterCreditNote, "invoice_number" | "invoice_date"> & {
      invoices: { number: string; issued_at: string } | null;
    })[]
  ).map(({ invoices: inv, ...c }) => ({
    ...c,
    invoice_number: inv?.number ?? "",
    invoice_date: inv ? dayOf(inv.issued_at) : "",
  }));

  return {
    input: {
      invoices: (invoices ?? []) as RegisterInput["invoices"],
      creditNotes,
      outlets: ((outlets ?? []) as OutletSalesRow[]).map((o) => ({
        sac: o.sac,
        rate: Number(o.rate),
        net: Number(o.net),
        tax: Number(o.tax),
        bills: Number(o.bills),
      })),
      placeOfSupply: settings.gst_state_code ? stateLabel(settings.gst_state_code) : settings.state,
      dayOf,
    },
    error: invError?.message ?? cnError?.message ?? posError?.message ?? null,
  };
}
