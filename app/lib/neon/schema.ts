import "server-only";
import { serviceQuery } from "./db";

/**
 * What the query translator needs to know about the public schema: columns,
 * foreign keys (to resolve embeds like `rooms(room_number)`) and function
 * signatures (to call `.rpc()`). Read once per process and refreshed every few
 * minutes, so a migration applied without a redeploy is picked up.
 */

export interface Relation {
  name: string;
  columns: Map<string, string>; // column → formatted type
  primaryKey: string[];
  unique: string[][];
  isView: boolean;
}

export interface ForeignKey {
  name: string;
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
}

export interface FnArg {
  name: string;
  type: string;
  hasDefault: boolean;
}

export interface Fn {
  name: string;
  args: FnArg[];
  returnsSet: boolean;
  returnsVoid: boolean;
  /** Returns a row type (a table, composite or OUT parameters). */
  returnsRow: boolean;
}

export interface Schema {
  relations: Map<string, Relation>;
  foreignKeys: ForeignKey[];
  functions: Map<string, Fn[]>;
}

const TTL_MS = 5 * 60 * 1000;
let cached: { at: number; schema: Promise<Schema> } | null = null;

export function getSchema(): Promise<Schema> {
  if (!cached || Date.now() - cached.at > TTL_MS) {
    const schema = load();
    cached = { at: Date.now(), schema };
    schema.catch(() => {
      cached = null;
    });
  }
  return cached.schema;
}

async function load(): Promise<Schema> {
  const [cols, keys, fks, fns] = await Promise.all([
    serviceQuery<{ rel: string; kind: string; col: string; type: string }>(`
      select c.relname as rel, c.relkind::text as kind, a.attname as col,
             format_type(a.atttypid, a.atttypmod) as type
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
       where n.nspname = 'public' and c.relkind in ('r','v','m','p','f')
       order by c.relname, a.attnum`),
    serviceQuery<{ rel: string; cols: string[]; primary: boolean }>(`
      select c.relname as rel, i.indisprimary as primary,
             array(select a.attname from unnest(i.indkey) with ordinality k(attnum, ord)
                     join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
                    order by k.ord)::text[] as cols
        from pg_index i
        join pg_class c on c.oid = i.indrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and i.indisunique and i.indpred is null
         and not (0 = any(i.indkey::int2[]))`),
    serviceQuery<{ name: string; tbl: string; cols: string[]; ref: string; refcols: string[] }>(`
      select con.conname as name, c.relname as tbl, r.relname as ref,
             array(select a.attname from unnest(con.conkey) with ordinality k(attnum, ord)
                     join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
                    order by k.ord)::text[] as cols,
             array(select a.attname from unnest(con.confkey) with ordinality k(attnum, ord)
                     join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum
                    order by k.ord)::text[] as refcols
        from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        join pg_namespace n on n.oid = c.relnamespace
        join pg_class r on r.oid = con.confrelid
        join pg_namespace rn on rn.oid = r.relnamespace
       where con.contype = 'f' and n.nspname = 'public' and rn.nspname = 'public'`),
    serviceQuery<{
      name: string;
      argnames: string[] | null;
      argtypes: string[];
      argmodes: string[] | null;
      ndefaults: number;
      retset: boolean;
      rettype: string;
      rettyptype: string;
      retrelid: number;
    }>(`
      select p.proname as name, p.proargnames as argnames, p.pronargdefaults as ndefaults,
             p.proretset as retset, t.typname as rettype, t.typtype::text as rettyptype,
             t.typrelid::int as retrelid, p.proargmodes::text[] as argmodes,
             array(select format_type(x, null) from unnest(p.proargtypes) x)::text[] as argtypes
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join pg_type t on t.oid = p.prorettype
       where n.nspname = 'public' and p.prokind = 'f'`),
  ]);

  const relations = new Map<string, Relation>();
  for (const c of cols) {
    let rel = relations.get(c.rel);
    if (!rel) {
      rel = { name: c.rel, columns: new Map(), primaryKey: [], unique: [], isView: c.kind === "v" || c.kind === "m" };
      relations.set(c.rel, rel);
    }
    rel.columns.set(c.col, c.type);
  }
  for (const k of keys) {
    const rel = relations.get(k.rel);
    if (!rel) continue;
    rel.unique.push(k.cols);
    if (k.primary) rel.primaryKey = k.cols;
  }

  const foreignKeys: ForeignKey[] = fks.map((f) => ({
    name: f.name,
    table: f.tbl,
    columns: f.cols,
    refTable: f.ref,
    refColumns: f.refcols,
  }));

  const functions = new Map<string, Fn[]>();
  for (const f of fns) {
    // proargnames covers every argument including OUT ones; proargtypes only
    // the inputs. Keep the input names, in order.
    const modes = f.argmodes ?? [];
    const names = f.argnames ?? [];
    const inputNames = names.filter((_, i) => !modes[i] || modes[i] === "i" || modes[i] === "b" || modes[i] === "v");
    const args: FnArg[] = f.argtypes.map((type, i) => ({
      name: inputNames[i] ?? "",
      type,
      hasDefault: i >= f.argtypes.length - f.ndefaults,
    }));
    const fn: Fn = {
      name: f.name,
      args,
      returnsSet: f.retset,
      returnsVoid: f.rettype === "void",
      returnsRow: f.rettyptype === "c" || f.retrelid !== 0 || f.rettype === "record",
    };
    functions.set(f.name, [...(functions.get(f.name) ?? []), fn]);
  }

  return { relations, foreignKeys, functions };
}
