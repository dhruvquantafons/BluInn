import Link from "next/link";
import { ArrowLeft, DatabaseBackup } from "lucide-react";
import { requirePermission } from "../../../../lib/auth";
import { getCurrentProperty } from "../../../../lib/properties";
import { EXPORT_TABLES } from "../../../../lib/data-export";
import { Card, Check, Notice, PageHeader, SectionTitle, buttonClass } from "../../../components/ui";

/**
 * Data export (0038): everything about this property as CSVs in one ZIP,
 * for the hotel's own backup or for moving to another system.
 */
export default async function DataExportPage() {
  await requirePermission("data.export");
  const property = await getCurrentProperty();
  const groups = new Map<string, string[]>();
  for (const t of EXPORT_TABLES) {
    const folder = t.file.split("/")[0];
    groups.set(folder, [...(groups.get(folder) ?? []), t.label]);
  }

  return (
    <>
      <Link href="/settings" className="inline-flex items-center gap-1.5 text-xs text-slate-600 hover:text-brand-700 mb-4">
        <ArrowLeft className="w-3.5 h-3.5" /> Settings
      </Link>
      <PageHeader
        icon={<DatabaseBackup />}
        title="Data export"
        description="Download this property's data as CSV files, for your own records or to move to another system."
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="p-5 space-y-4 lg:col-span-1">
          <SectionTitle>Download</SectionTitle>
          <p className="text-sm text-slate-700">
            {property?.name ?? "This property"}: one ZIP with a CSV for each table. Large hotels can take a minute.
          </p>
          <form action="/settings/export/download" method="get" className="space-y-3">
            <Check name="audit" value="1" label="Include the audit log" hint="Every change ever recorded; can be large." />
            <button className={buttonClass}>Download ZIP</button>
          </form>
          <Notice tone="warn">
            The file holds guests&apos; personal details. Keep it somewhere safe and delete it when you no longer need it. The
            download is recorded in the audit log.
          </Notice>
        </Card>

        <Card className="p-5 lg:col-span-2">
          <SectionTitle>What is in it</SectionTitle>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            {[...groups.entries()].map(([folder, labels]) => (
              <div key={folder}>
                <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">{folder}</p>
                <p className="text-slate-700">{labels.join(", ")}</p>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-500 mt-4">
            Not included: identity-document numbers and scans, room and maintenance photos, sign-in history and passwords.
          </p>
        </Card>
      </div>
    </>
  );
}
