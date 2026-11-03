// Loads .env.local (then .env) into process.env for the scripts in this
// folder, without overriding anything already set in the shell.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadEnv() {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let value = m[2];
      if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
      process.env[m[1]] = value;
    }
  }
}
