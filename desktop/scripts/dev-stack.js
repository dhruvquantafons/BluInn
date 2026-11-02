// A local Supabase-compatible backend for `npm run dev`, without Docker:
// the desktop build's own stack (Postgres, Supabase Auth, PostgREST and the
// storage gateway) run from the terminal, with no window, licence or bundled
// Next server.
//
//   npm run dev:db        (from the repo root; leave it running)
//   npm run dev           (in a second terminal)
//
// First run: applies every migration, creates a demo administrator and a few
// demo rooms, and points the repo's .env.local at http://127.0.0.1:54321.
// Data is kept in desktop/.devdata between runs; delete that folder to start
// again from an empty database.
//
// Needs `node scripts/stage-runtime.mjs` (from desktop/) to have been run once.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const desktop = path.join(__dirname, "..");
const root = path.join(desktop, "..");
process.env.BLUINN_DATA ||= path.join(desktop, ".devdata");

const paths = require("../lib/paths");
const { PORTS, HOST, GATEWAY_URL, installConfig } = require("../lib/config");
const database = require("../lib/database");
const services = require("../lib/services");
const { startGateway } = require("../lib/gateway");

const DEMO = { email: "admin@bluinn.local", password: "BluInn#Demo2026", name: "Demo Admin" };

function jwt(payload, secret) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = `${enc({ alg: "HS256", typ: "JWT" })}.${enc(payload)}`;
  return `${head}.${crypto.createHmac("sha256", secret).update(head).digest("base64url")}`;
}

/** The JWT secret and the keys signed with it, kept with the dev data so they survive restarts. */
function devSecrets() {
  const file = path.join(paths.data, "dev-secrets.json");
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const jwtSecret = crypto.randomBytes(48).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 10 * 365 * 24 * 60 * 60;
  const secrets = {
    jwtSecret,
    anonKey: jwt({ iss: "supabase", role: "anon", iat, exp }, jwtSecret),
    serviceRoleKey: jwt({ iss: "supabase", role: "service_role", iat, exp }, jwtSecret),
    appEnv: {},
    smtp: null,
  };
  fs.mkdirSync(paths.data, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  return secrets;
}

/** Sets (or adds) each key in the repo's .env.local, leaving every other line alone. */
function writeEnvLocal(values) {
  const file = path.join(root, ".env.local");
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : `${text.replace(/\n?$/, "\n")}${line}\n`;
  }
  fs.writeFileSync(file, text);
}

async function seedDemo(config, secrets) {
  const users = await database.withClient(config, async (db) => (await db.query("select count(*)::int as n from auth.users")).rows[0].n);
  if (users > 0) return false;

  const res = await fetch(`http://${HOST}:${PORTS.gotrue}/admin/users`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secrets.serviceRoleKey}` },
    body: JSON.stringify({ email: DEMO.email, password: DEMO.password, email_confirm: true, user_metadata: { full_name: DEMO.name } }),
  });
  if (!res.ok) throw new Error(`Could not create the demo user: ${res.status} ${await res.text()}`);

  // A name for the hotel and something to put guests in. The first account
  // became the administrator through the sign-up trigger (0001).
  await database.withClient(config, async (db) => {
    await db.query(`update properties set name = 'BluInn Demo Hotel', city = 'Mumbai', state = 'Maharashtra'
                     where name = 'Your Hotel'`);
    await db.query(`
      insert into rooms (room_number, room_type_id, floor)
      select n, (select id from room_types where slug = t), f
        from (values ('101','premier-room',1), ('102','premier-room',1), ('103','premier-room',1), ('104','premier-room',1),
                     ('201','luxury-room',2),  ('202','luxury-room',2),  ('203','luxury-room',2),  ('204','luxury-room',2))
             as v(n, t, f)
      on conflict do nothing`);
  });
  return true;
}

async function main() {
  if (!fs.existsSync(paths.gotrue) || !fs.existsSync(paths.postgrest)) {
    console.error("The runtime is not staged. Run once:  cd desktop && npm install && node scripts/stage-runtime.mjs");
    process.exit(1);
  }

  // The app's migrations, fresh from the repo each start.
  fs.rmSync(paths.appMigrations, { recursive: true, force: true });
  fs.cpSync(path.join(root, "supabase", "migrations"), paths.appMigrations, { recursive: true });

  const config = installConfig();
  const secrets = devSecrets();
  const onCrash = (name) => (code) => {
    console.error(`${name} stopped (${code}). Logs: ${paths.logs}`);
    process.exit(1);
  };

  console.log(`Data: ${paths.data}`);
  console.log("Starting the database…");
  await database.initCluster(config);
  await database.start();
  await database.ensureRoles(config);
  await services.migrateGotrue(config, secrets);
  await database.migrate(config, (s) => console.log(`  ${s}`));

  console.log("Starting Auth, PostgREST and the gateway…");
  await services.startGotrue(config, secrets, onCrash("Supabase Auth"));
  await services.startPostgrest(config, secrets, onCrash("PostgREST"));
  const gateway = await startGateway(config, secrets);

  const seeded = await seedDemo(config, secrets);
  writeEnvLocal({
    NEXT_PUBLIC_SUPABASE_URL: GATEWAY_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: secrets.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: secrets.serviceRoleKey,
    // No Realtime server here: LiveRefresh polls instead, and next.config
    // allows room photos from the local storage gateway.
    NEXT_PUBLIC_LOCAL_DEMO: "1",
    DEMO_BUILD: "1",
  });

  console.log(`
Local backend ready at ${GATEWAY_URL}${seeded ? " (demo data created)" : ""}.
.env.local now points at it. In another terminal:  npm run dev
Then open http://localhost:3000 and sign in:

  email     ${DEMO.email}
  password  ${DEMO.password}
  2FA code  123456

Ctrl-C stops everything.`);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log("\nStopping…");
    await gateway.close();
    await services.stopAll();
    await database.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(async (error) => {
  console.error(error);
  await services.stopAll().catch(() => {});
  await database.stop();
  process.exit(1);
});
