import { IndianRupee } from "lucide-react";
import { requireAnyPermission } from "../../../lib/auth";
import { PageHeader } from "../../components/ui";
import SectionTabs from "../../components/SectionTabs";

const TABS = [
  { href: "/rates", label: "Room types" },
  { href: "/rates/plans", label: "Rate plans" },
  { href: "/rates/seasons", label: "Seasons" },
  { href: "/rates/restrictions", label: "Restrictions" },
  { href: "/rates/allocations", label: "Channel allocation" },
];

export default async function RatesLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission(["rates.view", "rates.manage"]);
  return (
    <>
      <PageHeader
        icon={<IndianRupee />}
        title="Rates & inventory"
        description="Room types, rate plans, seasonal pricing, stay restrictions and channel allocation. Changes apply to new quotes immediately."
      />
      <SectionTabs tabs={TABS} label="Rates sections" />
      {children}
    </>
  );
}
