import { } from "lucide-react";
import { requireAnyPermission } from "../../../lib/auth";
import { PageHeader } from "../../components/ui";
import SectionTabs from "../../components/SectionTabs";

const TABS = [
  { href: "/revenue", label: "Forecast" },
  { href: "/revenue/rules", label: "Pricing rules" },
  { href: "/revenue/approvals", label: "Approvals" },
  { href: "/revenue/competitors", label: "Competitors" },
  { href: "/revenue/promos", label: "Promo codes" },
  { href: "/revenue/packages", label: "Packages" },
];

export default async function RevenueLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission(["revenue.view", "revenue.manage", "revenue.approve"]);
  return (
    <>
      <PageHeader
        title="Revenue & pricing"
        description="What the hotel is selling, at what price, and what the rules would change it to. A rule proposes a rate; small changes go live on their own and larger ones wait for approval."
      />
      <SectionTabs tabs={TABS} label="Revenue sections" />
      {children}
    </>
  );
}
