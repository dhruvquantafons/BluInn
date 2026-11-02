import { SprayCan } from "lucide-react";
import { requireAnyPermission } from "../../../lib/auth";
import { can } from "../../../lib/permissions";
import { PageHeader } from "../../components/ui";
import LiveRefresh from "../../components/LiveRefresh";
import SectionTabs from "../../components/SectionTabs";

export default async function HousekeepingLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAnyPermission([
    "housekeeping.tasks",
    "housekeeping.inspect",
    "housekeeping.assign",
    "housekeeping.lost_found",
  ]);
  const tabs = [
    (can(session, "housekeeping.assign") || can(session, "housekeeping.inspect")) && { href: "/housekeeping", label: "Board" },
    can(session, "housekeeping.tasks") && { href: "/housekeeping/my-tasks", label: "My tasks" },
    can(session, "housekeeping.lost_found") && { href: "/housekeeping/lost-found", label: "Lost & found" },
    can(session, "housekeeping.assign") && { href: "/housekeeping/setup", label: "Setup" },
  ].filter(Boolean) as { href: string; label: string }[];

  return (
    <>
      <LiveRefresh tables={["housekeeping_tasks", "rooms"]} />
      <PageHeader title="Housekeeping" description="Cleaning tasks, inspections and lost property." icon={<SprayCan />} />
      <SectionTabs tabs={tabs} label="Housekeeping sections" />
      {children}
    </>
  );
}
