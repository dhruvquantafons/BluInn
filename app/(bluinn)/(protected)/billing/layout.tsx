import { ReceiptIndianRupee } from "lucide-react";
import { requireAnyPermission } from "../../../lib/auth";
import { can } from "../../../lib/permissions";
import { PageHeader } from "../../components/ui";
import SectionTabs from "../../components/SectionTabs";

/** Module 7 — invoices and credit notes, the GST register, refund approvals. */
export default async function BillingLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAnyPermission([
    "folio.view",
    "folio.invoice",
    "folio.refund_approve",
    "folio.credit_note",
    "reports.financial",
  ]);

  const tabs = [
    { href: "/billing/invoices", label: "Invoices" },
    { href: "/billing/credit-notes", label: "Credit notes" },
    can(session, "reports.financial") && { href: "/billing/gst-register", label: "GST register" },
    { href: "/billing/refunds", label: "Refunds" },
    { href: "/billing/currencies", label: "Currencies" },
  ].filter(Boolean) as { href: string; label: string }[];

  return (
    <>
      <PageHeader
        icon={<ReceiptIndianRupee />}
        title="Billing"
        description="Tax invoices and credit notes, the monthly GST register, refund approvals and exchange rates."
        action={
          can(session, "folio.invoice") ? undefined : (
            <span className="text-xs text-slate-500">You can view invoices but not issue them.</span>
          )
        }
      />
      <SectionTabs tabs={tabs} label="Billing sections" />
      {children}
    </>
  );
}
