import { Wrench } from "lucide-react";
import { after } from "next/server";
import { requireAnyPermission } from "../../../lib/auth";
import { can } from "../../../lib/permissions";
import { createClient } from "../../../lib/supabase/server";
import { escalateOverdueTickets } from "../../../lib/staff-alerts";
import { PageHeader } from "../../components/ui";
import LiveRefresh from "../../components/LiveRefresh";
import SectionTabs from "../../components/SectionTabs";

export default async function MaintenanceLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAnyPermission(["maintenance.report", "maintenance.work", "maintenance.manage"]);
  const supabase = await createClient();
  // Tickets past their target are escalated whenever the board is in use;
  // the scheduled job and night audit catch the rest.
  after(() => escalateOverdueTickets(supabase, session.staff.id));

  const work = can(session, "maintenance.work");
  const manage = can(session, "maintenance.manage");
  const tabs = [
    { href: "/maintenance", label: "Tickets" },
    work && { href: "/maintenance/mine", label: "My tickets" },
    (work || manage) && { href: "/maintenance/assets", label: "Assets" },
    (work || manage) && { href: "/maintenance/preventive", label: "Preventive" },
    manage && { href: "/maintenance/setup", label: "Targets" },
  ].filter(Boolean) as { href: string; label: string }[];

  return (
    <>
      <LiveRefresh tables={["maintenance_tickets", "room_blocks"]} />
      <PageHeader icon={<Wrench />} title="Maintenance" description="Repairs and upkeep for rooms, equipment and common areas." />
      <SectionTabs tabs={tabs} label="Maintenance sections" />
      {children}
    </>
  );
}
