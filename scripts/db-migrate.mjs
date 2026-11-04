#!/usr/bin/env node
// Applies the database schema to the Postgres at DATABASE_URL (Neon).
//
//   DATABASE_URL=postgres://... npm run db:migrate
//
// First db/platform.sql (the roles, auth and storage schemas Supabase would
// otherwise provide), then every neon/migrations/*.sql not yet applied, in
// name order, each in its own transaction. Applied names are recorded in
// bluinn_meta.migrations, so running it again only applies what is new.
//
// Use Neon's *direct* connection string (no "-pooler" in the host) for this:
// the pooler is for the app's short queries, not for long DDL.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadEnv } from "./env.mjs";

loadEnv();
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL (or DATABASE_URL_UNPOOLED) to your Neon connection string.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
client.on("notice", () => {});

try {
  await client.query(fs.readFileSync(path.join(root, "db/platform.sql"), "utf8"));
  console.log("✓ platform (roles, auth, storage)");

  const dir = path.join(root, "neon/migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const { rows } = await client.query("select name from bluinn_meta.migrations");
  const done = new Set(rows.map((r) => r.name));

  let applied = 0;
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into bluinn_meta.migrations (name) values ($1)", [file]);
      await client.query("commit");
      console.log(`✓ ${file}`);
      applied++;
    } catch (err) {
      await client.query("rollback").catch(() => {});
      console.error(`✗ ${file}: ${err.message}`);
      process.exitCode = 1;
      break;
    }
  }

  // Tables created by the migrations after platform.sql's blanket grant are
  // covered by its default privileges; this catches anything created by
  // another role.
  await client.query("grant all on all tables in schema public to anon, authenticated, service_role");
  await client.query("grant all on all sequences in schema public to anon, authenticated, service_role");

  if (!process.exitCode) {
    console.log(applied ? `Applied ${applied} migration(s).` : "Database is up to date.");
  }
} finally {
  await client.end();
}
