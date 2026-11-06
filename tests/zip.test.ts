import { describe, it, expect } from "vitest";
import { inflateRawSync } from "node:zlib";
import { ZipWriter } from "../app/lib/zip";

describe("zip writer", () => {
  it("writes entries that read back, with a directory that lists them", () => {
    const zip = new ZipWriter(new Date(2026, 10, 6, 10, 30, 0));
    const a = zip.entry("bookings.csv", "reference,guest\nBK-1,Asha\n");
    const b = zip.entry("guests/हिंदी.csv", "name\nअ\n");
    const end = zip.finish();
    const all = Buffer.concat([a, b, end]);

    // End of central directory: two entries.
    const eocd = all.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(all.readUInt16LE(eocd + 10)).toBe(2);
    // First entry: name, then the deflated body inflates back to the CSV.
    const nameLen = all.readUInt16LE(26);
    expect(all.subarray(30, 30 + nameLen).toString()).toBe("bookings.csv");
    const size = all.readUInt32LE(18);
    expect(inflateRawSync(all.subarray(30 + nameLen, 30 + nameLen + size)).toString()).toBe("reference,guest\nBK-1,Asha\n");
    // The directory points at the second entry's real offset.
    const dir2 = all.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), all.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 1);
    expect(all.readUInt32LE(dir2 + 42)).toBe(a.length);
  });
});

import { rowsToCsvGrid, EXPORT_TABLES } from "../app/lib/data-export";

describe("data export", () => {
  it("never includes identity documents", () => {
    expect(EXPORT_TABLES.map((t) => t.table)).not.toContain("guest_identities");
    expect(EXPORT_TABLES.map((t) => t.table)).not.toContain("guest_documents");
  });
  it("turns rows into a grid, objects as JSON, skipping signatures", () => {
    expect(rowsToCsvGrid([{ id: 1, tags: ["vip"], signature: "data:…", note: null }])).toEqual([
      ["id", "tags", "note"],
      [1, '["vip"]', ""],
    ]);
  });
});
