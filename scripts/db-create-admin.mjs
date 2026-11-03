#!/usr/bin/env node
// Creates the first administrator login on the Neon database.
//
//   npm run db:create-admin -- admin@yourhotel.com 'A-strong-password' "Full Name"
//
// The database's sign-up trigger makes the first account on an empty staff
// list an administrator; everyone after that is added from Staff in the app.

import crypto from "node:crypto";
import pg from "pg";
import { loadEnv } from "./env.mjs";

loadEnv();
const [email, password, fullName = "Administrator"] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: npm run db:create-admin -- <email> <password> ["Full Name"]');
  process.exit(1);
}
if (password.length < 10) {
  console.error("Use a password of at least 10 characters.");
  process.exit(1);
}
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL to your Neon connection string.");
  process.exit(1);
}

// Same format as app/lib/neon/password.ts.
function hashPassword(plain) {
  const N = 16384, r = 8, p = 1;
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain.normalize("NFKC"), salt, 64, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const { rows: staff } = await client.query("select count(*)::int as n from public.staff");
  if (staff[0].n > 0) {
    console.error("This database already has staff. Add colleagues from Staff in the app instead.");
    process.exitCode = 1;
  } else {
    const { rows } = await client.query(
      `insert into auth.users (email, encrypted_password, raw_user_meta_data, email_confirmed_at)
       values (lower($1), $2, jsonb_build_object('full_name', $3::text), now())
       returning id`,
      [email.trim(), hashPassword(password), fullName],
    );
    const { rows: made } = await client.query("select 1 from public.staff where id = $1", [rows[0].id]);
    if (!made.length) throw new Error("The sign-up trigger did not create a staff row. Has db:migrate run?");
    console.log(`✓ ${email} can now sign in as administrator.`);
  }
} finally {
  await client.end();
}
