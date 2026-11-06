import { } from "lucide-react";
import { requireSession } from "../../../lib/auth";
import { can, canAny } from "../../../lib/permissions";
import { PageHeader } from "../../components/ui";
import LiveRefresh from "../../components/LiveRefresh";
import SectionTabs from "../../components/SectionTabs";

export default async function HrLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const view = canAny(session, ["hr.view", "hr.manage"]);
  const tabs = [
    { href: "/hr", label: "My work" },
    { href: "/hr/profile", label: "My profile" },
    view && { href: "/hr/roster", label: "Roster" },
    canAny(session, ["hr.view", "hr.manage", "hr.export"]) && { href: "/hr/attendance", label: "Attendance" },
    canAny(session, ["hr.view", "hr.approve_time"]) && { href: "/hr/timesheets", label: "Timesheets" },
    canAny(session, ["hr.approve_leave", "hr.view"]) && { href: "/hr/leave", label: "Leave" },
    view && { href: "/hr/staff", label: "Staff" },
    can(session, "hr.manage") && { href: "/hr/setup", label: "Setup" },
  ].filter(Boolean) as { href: string; label: string }[];

  return (
    <>
      <LiveRefresh tables={["attendance", "leave_requests"]} />
      <PageHeader title="HR & attendance" description="Shifts, clock-in, leave and staff records." />
      <SectionTabs tabs={tabs} label="HR sections" />
      {children}
    </>
  );
}
