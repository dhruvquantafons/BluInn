import "server-only";
import type { PoolClient } from "pg";
import { withContext, type DbContext } from "./db";
import { getSchema, type Fn, type ForeignKey, type Relation, type Schema } from "./schema";

/**
 * PostgREST, in-process.
 *
 * The app talks to the database through supabase-js's query builder
 * (`.from("bookings").select("*, rooms(room_number)").eq(...)`). On Supabase
 * the builder sends an HTTP request to PostgREST, which turns it into SQL. On
 * Neon there is no PostgREST, so the builder is handed this module as its
 * `fetch`: it reads the same request — path, query string, Prefer and Accept
 * headers, JSON body — and runs the equivalent SQL directly, as the caller's
 * role, with the caller's claims, inside one transaction. Row level security
 * therefore applies exactly as it did.
 *
 * Covered: the subset of PostgREST this app uses — column lists, aliases and
 * casts; embedded resources by table, FK column or constraint hint, nested,
 * with !inner and embedded filters; the filter operators (eq, neq, gt, gte,
 * lt, lte, like, ilike, match, imatch, is, isdistinct, in, cs, cd, ov) with
 * not., or= and and= trees; order, limit, offset; count=exact; HEAD;
 * single-object responses; insert, upsert (merge / ignore duplicates, on
 * conflict columns), update and delete with return=representation or
 * minimal; and rpc calls. Anything else is refused with an error naming it,
 * rather than being half-supported.
 */

const BASE_PATH = "/rest/v1/";
export const REST_URL = `http://bluinn.neon${BASE_PATH.slice(0, -1)}`;

class RestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: string | null = null,
    public hint: string | null = null,
  ) {
    super(message);
  }
}

// ── Small parsing helpers ───────────────────────────────────────────────────

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CAST = /^[A-Za-z_][A-Za-z0-9_ ]*(\[\])?$/;

function q(ident: string) {
  return `"${ident.replace(/"/g, '""')}"`;
}

function checkIdent(name: string, what = "column") {
  if (!IDENT.test(name)) throw new RestError(400, "PGRST100", `Unsupported ${what} "${name}"`);
  return name;
}

/** Splits on commas that are not inside parentheses or double quotes. */
function splitTop(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "\\" && quoted && i + 1 < input.length) {
      cur += ch + input[++i];
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "(") depth++;
    else if (!quoted && ch === ")") depth--;
    if (ch === "," && depth === 0 && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur !== "" || out.length) out.push(cur);
  return out;
}

function unquote(value: string) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return value;
}

// ── Select lists ────────────────────────────────────────────────────────────

type SelectItem =
  | { kind: "star" }
  | { kind: "column"; name: string; alias: string; cast?: string }
  | { kind: "embed"; name: string; alias: string; hint?: string; inner: boolean; items: SelectItem[] };

function parseSelect(input: string): SelectItem[] {
  if (!input) return [{ kind: "star" }];
  return splitTop(input).map((raw) => {
    if (raw === "*") return { kind: "star" } as const;

    let alias: string | undefined;
    let rest = raw;
    const colon = raw.search(/(?<!:):(?!:)/);
    const paren = raw.indexOf("(");
    if (colon > 0 && (paren === -1 || colon < paren)) {
      alias = raw.slice(0, colon);
      rest = raw.slice(colon + 1);
    }

    if (rest.includes("(")) {
      const open = rest.indexOf("(");
      if (!rest.endsWith(")")) throw new RestError(400, "PGRST100", `Malformed select "${raw}"`);
      const head = rest.slice(0, open);
      const [name, ...mods] = head.split("!");
      let inner = false;
      let hint: string | undefined;
      for (const m of mods) {
        if (m === "inner") inner = true;
        else if (m === "left") inner = false;
        else hint = m;
      }
      checkIdent(name, "relationship");
      if (hint) checkIdent(hint, "hint");
      return {
        kind: "embed",
        name,
        alias: checkIdent(alias ?? name, "alias"),
        hint,
        inner,
        items: parseSelect(rest.slice(open + 1, -1)),
      } as const;
    }

    const [name, cast] = rest.split("::");
    checkIdent(name);
    if (cast !== undefined && !CAST.test(cast)) throw new RestError(400, "PGRST100", `Unsupported cast "${cast}"`);
    return { kind: "column", name, alias: checkIdent(alias ?? name, "alias"), cast } as const;
  });
}

// ── Filters ─────────────────────────────────────────────────────────────────

type Cond =
  | { kind: "op"; column: string; op: string; negate: boolean; value: string }
  | { kind: "logic"; op: "and" | "or"; negate: boolean; items: Cond[] };

const OPS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "match", "imatch", "is", "isdistinct", "in", "cs", "cd", "ov"]);

/** `eq.5`, `not.is.null`, `in.(a,b)` → operator, negation and raw value. */
function parseOpValue(column: string, raw: string): Cond {
  let negate = false;
  let rest = raw;
  if (rest.startsWith("not.")) {
    negate = true;
    rest = rest.slice(4);
  }
  const dot = rest.indexOf(".");
  const op = dot === -1 ? rest : rest.slice(0, dot);
  const value = dot === -1 ? "" : rest.slice(dot + 1);
  if (!OPS.has(op)) throw new RestError(400, "PGRST100", `Unsupported filter operator "${op}"`);
  return { kind: "op", column, op, negate, value };
}

/** The inside of or=(…) / and=(…): a comma list of conditions and groups. */
function parseLogic(op: "and" | "or", negate: boolean, raw: string): Cond {
  const body = raw.startsWith("(") && raw.endsWith(")") ? raw.slice(1, -1) : raw;
  const items = splitTop(body).map((part): Cond => {
    const group = part.match(/^(not\.)?(and|or)\(([\s\S]*)\)$/);
    if (group) return parseLogic(group[2] as "and" | "or", Boolean(group[1]), `(${group[3]})`);
    const dot = part.indexOf(".");
    if (dot === -1) throw new RestError(400, "PGRST100", `Malformed logic tree "${part}"`);
    return parseOpValue(part.slice(0, dot), part.slice(dot + 1));
  });
  return { kind: "logic", op, negate, items };
}

/** Parses "(a,b,\"c,d\")" from an in. filter. */
function parseList(value: string): string[] {
  const body = value.startsWith("(") && value.endsWith(")") ? value.slice(1, -1) : value;
  if (body === "") return [];
  return splitTop(body).map(unquote);
}

interface Params {
  values: unknown[];
  add(v: unknown): string;
}

function newParams(): Params {
  const values: unknown[] = [];
  return { values, add: (v) => `$${values.push(v)}` };
}

function renderCond(cond: Cond, alias: string, rel: Relation | null, params: Params): string {
  if (cond.kind === "logic") {
    if (!cond.items.length) return cond.negate ? "false" : "true";
    const joined = cond.items.map((c) => renderCond(c, alias, rel, params)).join(cond.op === "and" ? " and " : " or ");
    return cond.negate ? `not (${joined})` : `(${joined})`;
  }
  checkIdent(cond.column);
  if (rel && !rel.columns.has(cond.column)) {
    throw new RestError(400, "42703", `column ${rel.name}.${cond.column} does not exist`);
  }
  const col = `${alias}.${q(cond.column)}`;
  const type = rel?.columns.get(cond.column) ?? "";
  const isText = /^(text|character varying|varchar|character|citext)/.test(type);
  const value = unquote(cond.value);
  let sql: string;
  switch (cond.op) {
    case "eq": sql = `${col} = ${params.add(value)}`; break;
    case "neq": sql = `${col} <> ${params.add(value)}`; break;
    case "gt": sql = `${col} > ${params.add(value)}`; break;
    case "gte": sql = `${col} >= ${params.add(value)}`; break;
    case "lt": sql = `${col} < ${params.add(value)}`; break;
    case "lte": sql = `${col} <= ${params.add(value)}`; break;
    case "like":
    case "ilike": {
      const target = isText ? col : `${col}::text`;
      sql = `${target} ${cond.op === "like" ? "like" : "ilike"} ${params.add(value.replace(/\*/g, "%"))}::text`;
      break;
    }
    case "match": sql = `${isText ? col : `${col}::text`} ~ ${params.add(value)}::text`; break;
    case "imatch": sql = `${isText ? col : `${col}::text`} ~* ${params.add(value)}::text`; break;
    case "is": {
      const v = value.toLowerCase();
      if (v === "null") sql = `${col} is null`;
      else if (v === "not_null") sql = `${col} is not null`;
      else if (v === "true" || v === "false" || v === "unknown") sql = `${col} is ${v}`;
      else throw new RestError(400, "PGRST100", `Unsupported is. value "${value}"`);
      break;
    }
    case "isdistinct": sql = `${col} is distinct from ${params.add(value)}`; break;
    case "in": {
      const list = parseList(cond.value);
      sql = list.length ? `${col} = any(${params.add(list)})` : "false";
      break;
    }
    case "cs": sql = `${col} @> ${params.add(value)}`; break;
    case "cd": sql = `${col} <@ ${params.add(value)}`; break;
    case "ov": {
      // PostgREST accepts ov.(a,b) as well as ov.{a,b}.
      const v = value.startsWith("(") ? `{${value.slice(1, -1)}}` : value;
      sql = `${col} && ${params.add(v)}`;
      break;
    }
    default:
      throw new RestError(400, "PGRST100", `Unsupported filter operator "${cond.op}"`);
  }
  return cond.negate ? `not (${sql})` : sql;
}

// ── Request options, grouped by the embed path they apply to ───────────────

interface PathOptions {
  conds: Cond[];
  order?: string;
  limit?: number;
  offset?: number;
}

const RESERVED = new Set(["select", "order", "limit", "offset", "columns", "on_conflict"]);

function collectOptions(search: URLSearchParams, skipArgs = false): Map<string, PathOptions> {
  const byPath = new Map<string, PathOptions>();
  const get = (path: string) => {
    let o = byPath.get(path);
    if (!o) byPath.set(path, (o = { conds: [] }));
    return o;
  };
  for (const [key, value] of search) {
    if (key === "select" || key === "columns" || key === "on_conflict") continue;
    const parts = key.split(".");
    let last = parts[parts.length - 1];
    let negateLogic = false;
    if (parts.length >= 2 && parts[parts.length - 2] === "not" && (last === "or" || last === "and")) {
      negateLogic = true;
      parts.splice(parts.length - 2, 1);
      last = parts[parts.length - 1];
    }
    if (last === "or" || last === "and") {
      get(parts.slice(0, -1).join(".")).conds.push(parseLogic(last, negateLogic, value));
    } else if (RESERVED.has(last) && (last === "order" || last === "limit" || last === "offset")) {
      const o = get(parts.slice(0, -1).join("."));
      if (last === "order") o.order = value;
      else o[last] = Number.parseInt(value, 10);
    } else if (!skipArgs) {
      const column = parts.pop()!;
      get(parts.join(".")).conds.push(parseOpValue(column, value));
    }
  }
  return byPath;
}

function renderOrder(order: string | undefined, alias: string, rel: Relation | null) {
  if (!order) return "";
  const terms = splitTop(order).map((term) => {
    const [column, ...mods] = term.split(".");
    checkIdent(column);
    if (rel && !rel.columns.has(column)) throw new RestError(400, "42703", `column ${rel.name}.${column} does not exist`);
    let sql = `${alias}.${q(column)}`;
    for (const m of mods) {
      if (m === "asc") sql += " asc";
      else if (m === "desc") sql += " desc";
      else if (m === "nullsfirst") sql += " nulls first";
      else if (m === "nullslast") sql += " nulls last";
      else throw new RestError(400, "PGRST100", `Unsupported order modifier "${m}"`);
    }
    return sql;
  });
  return terms.length ? ` order by ${terms.join(", ")}` : "";
}

// ── Embedded resources ──────────────────────────────────────────────────────

interface Join {
  /** parent column → child column pairs */
  pairs: [string, string][];
  target: string;
  toOne: boolean;
}

function sameCols(a: string[], b: string[]) {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

function resolveEmbed(schema: Schema, parent: string, name: string, hint?: string): Join {
  const candidates: (Join & { fk: ForeignKey })[] = [];
  for (const fk of schema.foreignKeys) {
    // Many-to-one: the parent holds the key. Reachable by the target table's
    // name, the FK column's name, or the constraint's name.
    if (fk.table === parent && (fk.refTable === name || fk.name === name || sameCols(fk.columns, [name]))) {
      candidates.push({
        fk,
        target: fk.refTable,
        toOne: true,
        pairs: fk.columns.map((c, i) => [c, fk.refColumns[i]] as [string, string]),
      });
    }
    // One-to-many (or one-to-one when the child's key columns are unique).
    if (fk.refTable === parent && (fk.table === name || fk.name === name)) {
      const child = schema.relations.get(fk.table);
      const unique = Boolean(child?.unique.some((u) => sameCols([...u].sort(), [...fk.columns].sort())));
      candidates.push({
        fk,
        target: fk.table,
        toOne: unique,
        pairs: fk.refColumns.map((c, i) => [c, fk.columns[i]] as [string, string]),
      });
    }
  }
  const matching = hint
    ? candidates.filter((c) => c.fk.name === hint || sameCols(c.fk.columns, [hint]) || c.target === hint)
    : candidates;
  // Without a hint, an embed named after a table prefers relationships to
  // that table over ones that merely share a column name.
  const narrowed = matching.length > 1 ? matching.filter((c) => c.target === name) : matching;
  const found = narrowed.length ? narrowed : matching;
  if (found.length === 1) return found[0];
  if (!found.length) {
    throw new RestError(400, "PGRST200", `Could not find a relationship between '${parent}' and '${name}' in the schema cache`);
  }
  throw new RestError(
    300,
    "PGRST201",
    `Could not embed because more than one relationship was found for '${parent}' and '${name}'`,
    found.map((f) => f.fk.name).join(", "),
  );
}

interface Built {
  projection: string[];
  joins: string[];
  /** Joins that must stay in a count query: the !inner ones. */
  innerJoins: string[];
  where: string[];
}

interface Ctx {
  schema: Schema;
  params: Params;
  options: Map<string, PathOptions>;
  seq: { n: number };
}

/** Projection, lateral joins and where clauses for one level of a select. */
function buildLevel(ctx: Ctx, rel: Relation, alias: string, items: SelectItem[], path: string): Built {
  const built: Built = { projection: [], joins: [], innerJoins: [], where: [] };
  for (const item of items) {
    if (item.kind === "star") {
      built.projection.push(`${alias}.*`);
    } else if (item.kind === "column") {
      if (!rel.columns.has(item.name)) {
        throw new RestError(400, "42703", `column ${rel.name}.${item.name} does not exist`);
      }
      const expr = `${alias}.${q(item.name)}${item.cast ? `::${item.cast}` : ""}`;
      built.projection.push(`${expr} as ${q(item.alias)}`);
    } else {
      const join = resolveEmbed(ctx.schema, rel.name, item.name, item.hint);
      const child = ctx.schema.relations.get(join.target);
      if (!child) throw new RestError(400, "PGRST200", `Unknown table '${join.target}'`);
      const n = ++ctx.seq.n;
      const childAlias = `_t${n}`;
      const childPath = path ? `${path}.${item.alias}` : item.alias;
      // Filters address an embed by its alias when it has one, else its name.
      const opts = ctx.options.get(childPath) ?? (item.alias !== item.name ? ctx.options.get(path ? `${path}.${item.name}` : item.name) : undefined);

      const inner = buildLevel(ctx, child, childAlias, item.items, childPath);
      const where = [
        ...join.pairs.map(([p, c]) => `${childAlias}.${q(c)} = ${alias}.${q(p)}`),
        ...(opts?.conds ?? []).map((c) => renderCond(c, childAlias, child, ctx.params)),
        ...inner.where,
      ];
      let sub =
        `select ${inner.projection.join(", ") || "1"} from public.${q(child.name)} as ${childAlias}` +
        inner.joins.map((j) => ` ${j}`).join("") +
        ` where ${where.join(" and ")}` +
        renderOrder(opts?.order, childAlias, child);
      if (join.toOne) sub += " limit 1";
      else {
        if (opts?.limit !== undefined) sub += ` limit ${Math.max(0, opts.limit)}`;
        if (opts?.offset !== undefined) sub += ` offset ${Math.max(0, opts.offset)}`;
      }
      const lateral = join.toOne
        ? `left join lateral (select row_to_json(_x) as v from (${sub}) _x) as _l${n} on true`
        : `left join lateral (select coalesce(json_agg(_x), '[]'::json) as v from (${sub}) _x) as _l${n} on true`;
      built.joins.push(lateral);
      built.projection.push(`_l${n}.v as ${q(item.alias)}`);
      if (item.inner) {
        built.innerJoins.push(lateral);
        built.where.push(join.toOne ? `_l${n}.v is not null` : `json_array_length(_l${n}.v) > 0`);
      }
    }
  }
  return built;
}

// ── Request handling ────────────────────────────────────────────────────────

interface Request {
  method: string;
  path: string;
  search: URLSearchParams;
  prefer: Map<string, string>;
  wantsObject: boolean;
  body: unknown;
}

interface Result {
  status: number;
  body: string | null;
  headers?: Record<string, string>;
}

function parsePrefer(headers: Headers): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of (headers.get("prefer") ?? "").split(",")) {
    const [k, v] = part.trim().split("=");
    if (k) map.set(k, v ?? "");
  }
  return map;
}

function relationOrThrow(schema: Schema, name: string): Relation {
  checkIdent(name, "table");
  const rel = schema.relations.get(name);
  if (!rel) throw new RestError(404, "42P01", `relation "public.${name}" does not exist`);
  return rel;
}

function contentRange(offset: number, rows: number, total: number | null) {
  const range = rows > 0 ? `${offset}-${offset + rows - 1}` : "*";
  return `${range}/${total ?? "*"}`;
}

/** Wraps a level into `select json_agg(...) from (select … from source …)`. */
function selectSql(rel: Relation, source: string, built: Built, extraWhere: string[], tail: string) {
  const where = [...extraWhere, ...built.where];
  return (
    `select coalesce(json_agg(_r), '[]'::json)::text as body, count(*)::int as n from (` +
    `select ${built.projection.join(", ") || "1"} from ${source} as _t0` +
    built.joins.map((j) => ` ${j}`).join("") +
    (where.length ? ` where ${where.join(" and ")}` : "") +
    tail +
    `) _r`
  );
}

function finish(req: Request, json: string, rows: number, extra: Record<string, string> = {}, status = 200): Result {
  if (req.wantsObject) {
    if (rows !== 1) {
      throw new RestError(
        406,
        "PGRST116",
        "JSON object requested, multiple (or no) rows returned",
        `The result contains ${rows} rows`,
      );
    }
    const parsed = JSON.parse(json) as unknown[];
    return { status, body: JSON.stringify(parsed[0]), headers: extra };
  }
  return { status, body: json, headers: extra };
}

async function handleRead(client: PoolClient, schema: Schema, req: Request, table: string): Promise<Result> {
  const rel = relationOrThrow(schema, table);
  const params = newParams();
  const options = collectOptions(req.search);
  const ctx: Ctx = { schema, params, options, seq: { n: 0 } };
  const top = options.get("") ?? { conds: [] };
  const built = buildLevel(ctx, rel, "_t0", parseSelect(req.search.get("select") ?? "*"), "");
  const where = top.conds.map((c) => renderCond(c, "_t0", rel, params));

  const offset = Math.max(0, top.offset ?? 0);
  let tail = renderOrder(top.order, "_t0", rel);
  if (top.limit !== undefined) tail += ` limit ${Math.max(0, top.limit)}`;
  if (top.offset !== undefined) tail += ` offset ${offset}`;

  let total: number | null = null;
  if (req.prefer.get("count") === "exact") {
    const allWhere = [...where, ...built.where];
    const countSql =
      `select count(*)::int as n from public.${q(rel.name)} as _t0` +
      built.innerJoins.map((j) => ` ${j}`).join("") +
      (allWhere.length ? ` where ${allWhere.join(" and ")}` : "");
    total = (await client.query<{ n: number }>(countSql, params.values)).rows[0].n;
    // As PostgREST does: a page that starts past the last row is refused, so a
    // stale ?page= can be sent back to page 1 (outOfRange in components/paging).
    if (offset > 0 && offset >= total) {
      throw new RestError(416, "PGRST103", "Requested range not satisfiable");
    }
  }

  if (req.method === "HEAD") {
    return { status: 200, body: null, headers: { "content-range": contentRange(offset, 0, total) } };
  }

  const { rows } = await client.query<{ body: string; n: number }>(
    selectSql(rel, `public.${q(rel.name)}`, built, where, tail),
    params.values,
  );
  return finish(req, rows[0].body, rows[0].n, { "content-range": contentRange(offset, rows[0].n, total) });
}

function bodyRows(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (body && typeof body === "object") return [body as Record<string, unknown>];
  throw new RestError(400, "PGRST102", "Empty or invalid json");
}

/** Runs a write; with return=representation, selects the affected rows. */
async function representWrite(
  client: PoolClient,
  schema: Schema,
  req: Request,
  rel: Relation,
  params: Params,
  writeSql: string,
  status: number,
): Promise<Result> {
  if (req.prefer.get("return") !== "representation") {
    const res = await client.query(writeSql, params.values);
    const headers: Record<string, string> = {};
    if (req.prefer.get("count") === "exact") headers["content-range"] = contentRange(0, res.rowCount ?? 0, res.rowCount ?? 0);
    return { status: status === 201 ? 201 : 204, body: null, headers };
  }
  const options = collectOptions(req.search, true);
  const ctx: Ctx = { schema, params, options, seq: { n: 0 } };
  const built = buildLevel(ctx, rel, "_t0", parseSelect(req.search.get("select") ?? "*"), "");
  const sql = `with _w as (${writeSql}) ` + selectSql(rel, "_w", built, [], "");
  const { rows } = await client.query<{ body: string; n: number }>(sql, params.values);
  return finish(req, rows[0].body, rows[0].n, { "content-range": contentRange(0, rows[0].n, rows[0].n) }, status);
}

function writeColumns(rel: Relation, req: Request, rows: Record<string, unknown>[]): string[] {
  const param = req.search.get("columns");
  const cols = param
    ? splitTop(param).map(unquote)
    : [...new Set(rows.flatMap((r) => Object.keys(r)))];
  for (const c of cols) {
    checkIdent(c);
    if (!rel.columns.has(c)) throw new RestError(400, "PGRST204", `Could not find the '${c}' column of '${rel.name}' in the schema cache`);
  }
  return cols;
}

async function handleInsert(client: PoolClient, schema: Schema, req: Request, table: string): Promise<Result> {
  const rel = relationOrThrow(schema, table);
  const rows = bodyRows(req.body);
  if (!rows.length) return finish(req, "[]", 0, {}, 201);
  const cols = writeColumns(rel, req, rows);
  const params = newParams();
  const data = params.add(JSON.stringify(rows));
  const list = cols.map(q).join(", ");
  const target = `public.${q(rel.name)}`;

  let sql = cols.length
    ? `insert into ${target} as _t0 (${list}) select ${list} from json_populate_recordset(null::${target}, ${data}::json)`
    : `insert into ${target} as _t0 select from json_populate_recordset(null::${target}, ${data}::json)`;

  const resolution = req.prefer.get("resolution");
  if (resolution === "merge-duplicates" || resolution === "ignore-duplicates") {
    const conflict = req.search.get("on_conflict")
      ? splitTop(req.search.get("on_conflict")!).map((c) => checkIdent(c.trim()))
      : rel.primaryKey;
    if (!conflict.length) throw new RestError(400, "PGRST100", `'${rel.name}' has no primary key to upsert on`);
    sql += ` on conflict (${conflict.map(q).join(", ")})`;
    const updatable = cols.length ? cols : conflict;
    sql +=
      resolution === "ignore-duplicates"
        ? " do nothing"
        : ` do update set ${updatable.map((c) => `${q(c)} = excluded.${q(c)}`).join(", ")}`;
  }
  sql += " returning _t0.*";
  return representWrite(client, schema, req, rel, params, sql, 201);
}

async function handleUpdate(client: PoolClient, schema: Schema, req: Request, table: string): Promise<Result> {
  const rel = relationOrThrow(schema, table);
  const [row] = bodyRows(req.body);
  const cols = writeColumns(rel, { ...req, search: new URLSearchParams() }, [row ?? {}]);
  const params = newParams();
  const top = collectOptions(req.search).get("") ?? { conds: [] };
  if (!cols.length) return finish(req, "[]", 0);
  const data = params.add(JSON.stringify(row));
  const target = `public.${q(rel.name)}`;
  const where = top.conds.map((c) => renderCond(c, "_t0", rel, params));
  const sql =
    `update ${target} as _t0 set ${cols.map((c) => `${q(c)} = _v.${q(c)}`).join(", ")}` +
    ` from json_populate_record(null::${target}, ${data}::json) as _v` +
    (where.length ? ` where ${where.join(" and ")}` : "") +
    " returning _t0.*";
  return representWrite(client, schema, req, rel, params, sql, 200);
}

async function handleDelete(client: PoolClient, schema: Schema, req: Request, table: string): Promise<Result> {
  const rel = relationOrThrow(schema, table);
  const params = newParams();
  const top = collectOptions(req.search).get("") ?? { conds: [] };
  const where = top.conds.map((c) => renderCond(c, "_t0", rel, params));
  const sql =
    `delete from public.${q(rel.name)} as _t0` +
    (where.length ? ` where ${where.join(" and ")}` : "") +
    " returning _t0.*";
  return representWrite(client, schema, req, rel, params, sql, 200);
}

function pickFunction(schema: Schema, name: string, given: string[]): Fn {
  checkIdent(name, "function");
  const overloads = schema.functions.get(name) ?? [];
  const fit = overloads.filter((f) => {
    const names = new Set(f.args.map((a) => a.name));
    return given.every((g) => names.has(g)) && f.args.every((a) => a.hasDefault || given.includes(a.name));
  });
  if (fit.length === 1) return fit[0];
  if (fit.length > 1) {
    // Prefer the overload with the fewest unused arguments.
    return fit.sort((a, b) => a.args.length - b.args.length)[0];
  }
  throw new RestError(
    404,
    "PGRST202",
    `Could not find the function public.${name}(${given.join(", ")}) in the schema cache`,
  );
}

async function handleRpc(client: PoolClient, schema: Schema, req: Request, name: string): Promise<Result> {
  let args: Record<string, unknown> = {};
  if (req.method === "GET" || req.method === "HEAD") {
    for (const [k, v] of req.search) if (!RESERVED.has(k)) args[k] = v;
  } else if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
    args = req.body as Record<string, unknown>;
  }
  const given = Object.keys(args).filter((k) => args[k] !== undefined);
  const fn = pickFunction(schema, name, given);
  const params = newParams();

  const used = fn.args.filter((a) => given.includes(a.name));
  const call = `public.${q(fn.name)}(${used.map((a) => `${q(a.name)} := _a.${q(a.name)}`).join(", ")})`;
  const argFrom = used.length
    ? `json_to_record(${params.add(JSON.stringify(args))}::json) as _a(${used.map((a) => `${q(a.name)} ${a.type}`).join(", ")})`
    : "";

  if (fn.returnsVoid) {
    await client.query(`select ${call}${argFrom ? ` from ${argFrom}` : ""}`, params.values);
    return { status: 204, body: null };
  }

  if (fn.returnsSet) {
    // For GET calls the query string carries the arguments, not filters.
    const top =
      req.method === "GET" || req.method === "HEAD"
        ? { conds: [] as Cond[] }
        : (collectOptions(req.search).get("") ?? { conds: [] });
    const where = top.conds.map((c) => renderCond(c, "_f", null, params));
    let tail = renderOrder(top.order, "_f", null);
    if (top.limit !== undefined) tail += ` limit ${Math.max(0, top.limit)}`;
    if (top.offset !== undefined) tail += ` offset ${Math.max(0, top.offset)}`;
    const from = argFrom ? `${argFrom} cross join lateral ${call} as _f` : `${call} as _f`;
    const sql =
      `select coalesce(json_agg(_r._f), '[]'::json)::text as body, count(*)::int as n from (` +
      `select _f from ${from}${where.length ? ` where ${where.join(" and ")}` : ""}${tail}) _r`;
    const { rows } = await client.query<{ body: string; n: number }>(sql, params.values);
    return finish(req, rows[0].body, rows[0].n);
  }

  const sql = fn.returnsRow
    ? `select row_to_json(_f)::text as body from ${argFrom ? `${argFrom} cross join lateral ` : ""}${call} as _f`
    : `select to_json(${call})::text as body${argFrom ? ` from ${argFrom}` : ""}`;
  const { rows } = await client.query<{ body: string | null }>(sql, params.values);
  return { status: 200, body: rows[0]?.body ?? "null" };
}

async function handle(ctx: DbContext, req: Request): Promise<Result> {
  const schema = await getSchema();
  const readOnly = req.method === "GET" || req.method === "HEAD";
  return withContext(
    ctx,
    async (client) => {
      if (req.path.startsWith("rpc/")) return handleRpc(client, schema, req, req.path.slice(4));
      switch (req.method) {
        case "GET":
        case "HEAD":
          return handleRead(client, schema, req, req.path);
        case "POST":
          return handleInsert(client, schema, req, req.path);
        case "PATCH":
          return handleUpdate(client, schema, req, req.path);
        case "DELETE":
          return handleDelete(client, schema, req, req.path);
        default:
          throw new RestError(405, "PGRST117", `Unsupported HTTP method ${req.method}`);
      }
    },
    { readOnly },
  );
}

const PG_STATUS: Record<string, number> = {
  "23505": 409,
  "23503": 409,
  "23502": 400,
  "23514": 400,
  "22P02": 400,
  "42501": 403,
  "42883": 404,
  "42P01": 404,
  "P0001": 400,
  "40001": 409,
  "40P01": 409,
};

function errorResponse(err: unknown): Response {
  let status = 400;
  let body: Record<string, unknown>;
  if (err instanceof RestError) {
    status = err.status;
    body = { code: err.code, message: err.message, details: err.details, hint: err.hint };
  } else if (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string") {
    const e = err as { code: string; message: string; detail?: string; hint?: string };
    status = PG_STATUS[e.code] ?? (e.code.startsWith("08") || e.code.startsWith("57") ? 503 : 400);
    body = { code: e.code, message: e.message, details: e.detail ?? null, hint: e.hint ?? null };
  } else {
    status = 500;
    body = { code: "PGRST000", message: err instanceof Error ? err.message : String(err), details: null, hint: null };
  }
  // A server error here is a gap in the translator or a lost connection, not
  // a refusal by the database, so make it visible in the function logs.
  if (status >= 500 || (err instanceof RestError && err.code !== "PGRST116")) {
    console.error("[neon/rest]", body.code, body.message);
  }
  // 503 would make postgrest-js retry; a connection failure is not
  // guaranteed to be safe to replay for writes, so report it as 500.
  return new Response(JSON.stringify(body), {
    status: status === 503 ? 500 : status,
    headers: { "content-type": "application/json" },
  });
}

/** A `fetch` for supabase-js's PostgrestClient that runs the request on Neon. */
export function restFetch(context: () => Promise<DbContext> | DbContext): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const at = url.pathname.indexOf(BASE_PATH);
      const path = decodeURIComponent(url.pathname.slice(at + BASE_PATH.length));
      const headers = new Headers(init?.headers);
      const raw = typeof init?.body === "string" ? init.body : "";
      const req: Request = {
        method: (init?.method ?? "GET").toUpperCase(),
        path,
        search: url.searchParams,
        prefer: parsePrefer(headers),
        wantsObject: (headers.get("accept") ?? "").includes("vnd.pgrst.object"),
        body: raw ? JSON.parse(raw) : undefined,
      };
      const result = await handle(await context(), req);
      const out = new Headers({ "content-type": "application/json", ...(result.headers ?? {}) });
      if (result.body === null) return new Response(null, { status: result.status === 200 ? 200 : result.status, headers: out });
      return new Response(result.body, { status: result.status, headers: out });
    } catch (err) {
      return errorResponse(err);
    }
  }) as typeof fetch;
}
