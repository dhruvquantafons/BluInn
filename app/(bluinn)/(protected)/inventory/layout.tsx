import { } from "lucide-react";
import { requireAnyPermission } from "../../../lib/auth";
import { can } from "../../../lib/permissions";
import { PageHeader } from "../../components/ui";
import SectionTabs from "../../components/SectionTabs";

export default async function InventoryLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAnyPermission(["inventory.view", "inventory.manage"]);
  const tabs = [
    { href: "/inventory", label: "Stock" },
    { href: "/inventory/movements", label: "Movements" },
    can(session, "inventory.manage") && { href: "/inventory/setup", label: "Items & locations" },
  ].filter(Boolean) as { href: string; label: string }[];

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Amenities, linen, minibar, cleaning and engineering stock: where it is, what is low, and every movement."
      />
      <SectionTabs tabs={tabs} label="Inventory sections" />
      {children}
    </>
  );
}
