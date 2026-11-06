import { crc32, deflateRawSync } from "node:zlib";

/**
 * A minimal ZIP writer for the data export (0038): deflated entries, written
 * one after another so the archive can stream, then the central directory.
 * No ZIP64, so each file and the whole archive must stay under 4 GB, far
 * beyond any one hotel's CSVs.
 *
 * Usage: for each file, `entry(name, bytes)` returns the bytes to send now;
 * `finish()` returns the closing directory.
 */
export class ZipWriter {
  private offset = 0;
  private central: Buffer[] = [];
  private count = 0;
  private readonly time: number;
  private readonly date: number;

  constructor(now = new Date()) {
    // MS-DOS date and time, local to the server.
    this.time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    this.date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  }

  entry(name: string, data: Buffer | string): Buffer {
    const raw = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const packed = deflateRawSync(raw);
    const crc = crc32(raw) >>> 0;
    const fileName = Buffer.from(name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(this.time, 10);
    local.writeUInt16LE(this.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    local.writeUInt16LE(0, 28);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // made by
    dir.writeUInt16LE(20, 6); // needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(this.time, 12);
    dir.writeUInt16LE(this.date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(fileName.length, 28);
    dir.writeUInt32LE(this.offset, 42);
    this.central.push(dir, fileName);
    this.count += 1;

    const out = Buffer.concat([local, fileName, packed]);
    this.offset += out.length;
    return out;
  }

  finish(): Buffer {
    const directory = Buffer.concat(this.central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.count, 8);
    end.writeUInt16LE(this.count, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(this.offset, 16);
    return Buffer.concat([directory, end]);
  }
}
