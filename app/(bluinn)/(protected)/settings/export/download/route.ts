import { createClient } from "../../../../../lib/supabase/server";
import { getSession } from "../../../../../lib/auth";
import { can } from "../../../../../lib/permissions";
import { getCurrentProperty } from "../../../../../lib/properties";
import { toCsv } from "../../../../../lib/hr";
import { EXPORT_TABLES, rowsToCsvGrid } from "../../../../../lib/data-export";
import { ZipWriter } from "../../../../../lib/zip";

const PAGE = 1000;

/**
 * The current property's data as a ZIP of CSVs (0038), streamed table by
 * table so a large hotel never builds the whole archive in memory or hits a
 * response-size limit. Every read goes through the downloader's own client;
 * the download is logged.
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return new Response("Not signed in.", { status: 401 });
  if (!can(session, "data.export")) return new Response("Your role does not allow data export.", { status: 403 });

  const property = await getCurrentProperty();
  if (!property) return new Response("No property selected.", { status: 400 });
  const withAudit = new URL(request.url).searchParams.get("audit") === "1";
  const supabase = await createClient();

  const tables = [
    ...EXPORT_TABLES,
    ...(withAudit ? [{ table: "audit_log", file: "audit_log.csv", label: "Audit log" }] : []),
  ];
  const zip = new ZipWriter();
  const counts: string[] = [];
  const stamp = new Date().toISOString().slice(0, 10);

  async function readAll(table: string, order = "id") {
    const rows: Record<string, unknown>[] = [];
    for (let start = 0; ; start += PAGE) {
      const { data, error } = await supabase
        .from(table)
        .select("*")
        .eq("property_id", property!.id)
        .order(order)
        .range(start, start + PAGE - 1);
      if (error) return { rows, error: error.message };
      rows.push(...((data ?? []) as Record<string, unknown>[]));
      if (!data || data.length < PAGE) return { rows, error: null };
    }
  }

  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index === 0) {
        const { data: me } = await supabase.from("properties").select("*").eq("id", property.id).maybeSingle();
        controller.enqueue(zip.entry("property.csv", toCsv(rowsToCsvGrid(me ? [me] : []))));
      }
      if (index < tables.length) {
        const t = tables[index++];
        const { rows, error } = await readAll(t.table, "order" in t ? t.order : undefined);
        counts.push(`${t.label}: ${error ? `not exported (${error})` : rows.length}`);
        controller.enqueue(zip.entry(t.file, `﻿${toCsv(rowsToCsvGrid(rows))}`));
        return;
      }
      controller.enqueue(
        zip.entry(
          "README.txt",
          [
            `${property.name}: data export of ${stamp}, by ${session.staff.full_name || session.staff.email}.`,
            "",
            "One CSV per table, UTF-8. Columns are the database's own; amounts are in the property's currency.",
            "Identity-document numbers and scans, photos and sign-in history are not included.",
            "",
            ...counts,
          ].join("\r\n"),
        ),
      );
      controller.enqueue(zip.finish());
      controller.close();
      await supabase.rpc("log_event", {
        p_module: "admin",
        p_action: "data_export",
        p_record_id: property.id,
        p_summary: `${property.name} data downloaded${withAudit ? " with the audit log" : ""} by ${session.staff.full_name || session.staff.email}`,
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${(property.code || "hotel").toLowerCase()}-data-${stamp}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
