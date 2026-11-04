import { ChartColumn } from "lucide-react";
import { requireAnyPermission } from "../../../lib/auth";
import { can } from "../../../lib/permissions";
import { PageHeader } from "../../components/ui";
import SectionTabs from "../../components/SectionTabs";

/** Module 13 — the reports management and the owner actually read. */
export default async function ReportsLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAnyPermission(["reports.view", "reports.financial", "reports.schedule"]);
  const financial = can(session, "reports.financial");

  const tabs = [
    { href: "/reports", label: "Overview" },
    financial && { href: "/reports/financial", label: "Financial" },
    { href: "/reports/operations", label: "Operations" },
    { href: "/reports/guests", label: "Guests" },
    { href: "/reports/builder", label: "Build a report" },
    can(session, "reports.schedule") && { href: "/reports/schedules", label: "Scheduled" },
  ].filter(Boolean) as { href: string; label: string }[];

  return (
    <>
      <PageHeader
        icon={<ChartColumn />}
        title="Reports"
        description="Occupancy, revenue and performance, computed live from bookings and folios."
      />
      <SectionTabs tabs={tabs} label="Report sections" />
      {children}
    </>
  );
}
