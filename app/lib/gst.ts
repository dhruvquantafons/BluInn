/**
 * India's GST, as far as a hotel's invoices need it (0036).
 *
 * Pure functions with no database access, unit tested in tests/gst.test.ts.
 * The database applies the same deadlines (gst_cancel_deadline and
 * credit_note_deadline in 0036_gst_invoicing.sql); these copies let a screen
 * say so before anyone presses the button.
 */

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** GST state and union-territory codes, the first two digits of a GSTIN. */
export const GST_STATES: { code: string; name: string }[] = [
  { code: "01", name: "Jammu and Kashmir" },
  { code: "02", name: "Himachal Pradesh" },
  { code: "03", name: "Punjab" },
  { code: "04", name: "Chandigarh" },
  { code: "05", name: "Uttarakhand" },
  { code: "06", name: "Haryana" },
  { code: "07", name: "Delhi" },
  { code: "08", name: "Rajasthan" },
  { code: "09", name: "Uttar Pradesh" },
  { code: "10", name: "Bihar" },
  { code: "11", name: "Sikkim" },
  { code: "12", name: "Arunachal Pradesh" },
  { code: "13", name: "Nagaland" },
  { code: "14", name: "Manipur" },
  { code: "15", name: "Mizoram" },
  { code: "16", name: "Tripura" },
  { code: "17", name: "Meghalaya" },
  { code: "18", name: "Assam" },
  { code: "19", name: "West Bengal" },
  { code: "20", name: "Jharkhand" },
  { code: "21", name: "Odisha" },
  { code: "22", name: "Chhattisgarh" },
  { code: "23", name: "Madhya Pradesh" },
  { code: "24", name: "Gujarat" },
  { code: "26", name: "Dadra and Nagar Haveli and Daman and Diu" },
  { code: "27", name: "Maharashtra" },
  { code: "29", name: "Karnataka" },
  { code: "30", name: "Goa" },
  { code: "31", name: "Lakshadweep" },
  { code: "32", name: "Kerala" },
  { code: "33", name: "Tamil Nadu" },
  { code: "34", name: "Puducherry" },
  { code: "35", name: "Andaman and Nicobar Islands" },
  { code: "36", name: "Telangana" },
  { code: "37", name: "Andhra Pradesh" },
  { code: "38", name: "Ladakh" },
  { code: "97", name: "Other Territory" },
];

const STATE_NAMES = new Map(GST_STATES.map((s) => [s.code, s.name]));

export function stateName(code: string): string {
  return STATE_NAMES.get(code) ?? "";
}

/** "27 – Maharashtra", the way an invoice prints the place of supply. */
export function stateLabel(code: string): string {
  const name = stateName(code);
  return name ? `${code} – ${name}` : code;
}

/** The state code whose name matches, ignoring case and spacing; "" if none. */
export function stateCodeFor(name: string): string {
  const key = name.trim().toLowerCase().replace(/\s+/g, " ").replace(/&/g, "and");
  return GST_STATES.find((s) => s.name.toLowerCase() === key)?.code ?? "";
}

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GSTIN_SHAPE = /^[0-9]{2}[A-Z0-9]{10}[1-9A-Z][A-Z][0-9A-Z]$/;

/** The check character the GSTN computes over the first fourteen. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = GSTIN_CHARS.indexOf(first14[i]);
    if (value < 0) return "";
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

export function normaliseGstin(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

/** Null when the GSTIN is well formed and its check character is right. */
export function gstinError(value: string): string | null {
  const gstin = normaliseGstin(value);
  if (gstin.length !== 15) return "A GSTIN has 15 characters.";
  if (!GSTIN_SHAPE.test(gstin)) return "That does not look like a GSTIN.";
  if (!STATE_NAMES.has(gstin.slice(0, 2))) return `${gstin.slice(0, 2)} is not a GST state code.`;
  if (gstinCheckChar(gstin.slice(0, 14)) !== gstin[14]) return "That GSTIN's check character is wrong — check for a typo.";
  return null;
}

export function stateFromGstin(gstin: string): string {
  const code = normaliseGstin(gstin).slice(0, 2);
  return STATE_NAMES.has(code) ? code : "";
}

export interface GstSplit {
  cgst: number;
  sgst: number;
  igst: number;
}

/**
 * Splits a tax amount: inter-state supplies carry IGST, intra-state ones half
 * CGST and half SGST. SGST takes the odd paisa so the two always add back up.
 */
export function splitGst(tax: number, interstate: boolean): GstSplit {
  if (interstate) return { cgst: 0, sgst: 0, igst: round2(tax) };
  const cgst = round2(tax / 2);
  return { cgst, sgst: round2(tax - cgst), igst: 0 };
}

function isoDate(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * The last day a GST invoice may be cancelled: the 11th of the next month,
 * when the GSTR-1 reporting it is due. After that it is corrected with a
 * credit note.
 */
export function cancelDeadline(issuedOn: string): string {
  const [y, m] = issuedOn.split("-").map(Number);
  return m === 12 ? isoDate(y + 1, 1, 11) : isoDate(y, m + 1, 11);
}

/**
 * The last day a credit note may be raised against an invoice: 30 November
 * after the end of the invoice's financial year (CGST Act s.34(2)).
 */
export function creditNoteDeadline(invoiceDate: string): string {
  const [y, m] = invoiceDate.split("-").map(Number);
  return isoDate(m >= 4 ? y + 1 : y, 11, 30);
}

/** Rule 46: a GST invoice number is at most 16 characters. */
export const MAX_INVOICE_NUMBER_LENGTH = 16;

/**
 * The longest prefix that keeps PREFIX/2026-27/0001 within 16 characters.
 * The sequence is padded to four digits, so a hotel issuing more than 9,999
 * invoices a year needs a prefix one shorter still.
 */
export const MAX_GST_PREFIX_LENGTH = MAX_INVOICE_NUMBER_LENGTH - "/2026-27/0001".length;

/** Rule 46(e): an unregistered buyer's address is required from this value. */
export const B2C_ADDRESS_THRESHOLD = 50000;

export const CREDIT_NOTE_REASONS = [
  { value: "deficiency", label: "Deficiency in service" },
  { value: "discount", label: "Discount after billing" },
  { value: "cancellation", label: "Stay or service cancelled" },
  { value: "billing_error", label: "Billing error" },
  { value: "other", label: "Other" },
] as const;

export const REVENUE_DEPT_LABELS: Record<string, string> = {
  rooms: "Rooms",
  fnb: "Food & beverage",
  laundry: "Laundry",
  spa: "Spa",
  events: "Events & banquets",
  other: "Other income",
  paid_out: "Paid out",
};

export interface BillToInput {
  name: string;
  gstin: string;
  address: string;
}

export interface InvoiceTaxContext {
  regime: "gst" | "simple";
  /** The hotel's own GSTIN and state, from settings. */
  propertyGstin: string;
  propertyStateCode: string;
  /** Free-text state from settings, for plain invoices. */
  propertyState: string;
  invoicePrefix: string;
  grandTotal: number;
}

/** The columns an invoice freezes about who it is to and how it is taxed. */
export interface InvoiceTaxFields {
  bill_to_name: string;
  bill_to_address: string;
  bill_to_gstin: string;
  bill_to_state_code: string;
  place_of_supply: string;
  tax_regime: "gst" | "simple";
  supplier_gstin: string;
  supplier_state_code: string;
  is_interstate: boolean;
}

/**
 * Checks the bill-to details against what a tax invoice must carry (CGST
 * Rule 46) and returns the columns to freeze onto it.
 *
 * Place of supply for a hotel stay, and for anything else supplied at the
 * hotel, is where the hotel is (IGST Act s.12(3)), so even a business guest
 * from another state is billed CGST + SGST. is_interstate therefore stays
 * false; the column exists so a credit note can split tax the same way as
 * the invoice it corrects.
 */
export function invoiceTaxFields(
  input: BillToInput,
  ctx: InvoiceTaxContext,
): { error: string } | { fields: InvoiceTaxFields } {
  const name = input.name.trim();
  const address = input.address.trim();
  const gstin = normaliseGstin(input.gstin);
  if (!name) return { error: "Enter who the invoice is made out to." };

  if (ctx.regime === "simple") {
    return {
      fields: {
        bill_to_name: name,
        bill_to_address: address,
        bill_to_gstin: gstin,
        bill_to_state_code: "",
        place_of_supply: ctx.propertyState,
        tax_regime: "simple",
        supplier_gstin: ctx.propertyGstin,
        supplier_state_code: "",
        is_interstate: false,
      },
    };
  }

  const ownGstin = normaliseGstin(ctx.propertyGstin);
  if (!ownGstin || gstinError(ownGstin)) {
    return { error: "Add the hotel's GSTIN under Settings → Property before issuing GST invoices." };
  }
  const supplierState = ctx.propertyStateCode || stateFromGstin(ownGstin);
  if (`${ctx.invoicePrefix || "INV"}/2026-27/0001`.length > MAX_INVOICE_NUMBER_LENGTH) {
    return {
      error: `A GST invoice number can be at most ${MAX_INVOICE_NUMBER_LENGTH} characters. Shorten the invoice prefix to ${MAX_GST_PREFIX_LENGTH} under Settings.`,
    };
  }

  if (gstin) {
    const problem = gstinError(gstin);
    if (problem) return { error: `Buyer's GSTIN: ${problem}` };
    if (!address) return { error: "A business invoice needs the buyer's registered address." };
  } else if (ctx.grandTotal >= B2C_ADDRESS_THRESHOLD && !address) {
    return {
      error: `An invoice of ₹${B2C_ADDRESS_THRESHOLD.toLocaleString("en-IN")} or more to an unregistered guest needs their address.`,
    };
  }

  return {
    fields: {
      bill_to_name: name,
      bill_to_address: address,
      bill_to_gstin: gstin,
      bill_to_state_code: gstin ? stateFromGstin(gstin) : "",
      place_of_supply: stateLabel(supplierState),
      tax_regime: "gst",
      supplier_gstin: ownGstin,
      supplier_state_code: supplierState,
      is_interstate: false,
    },
  };
}
