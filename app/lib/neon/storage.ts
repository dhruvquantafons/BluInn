import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { serviceQuery, withContext, type DbContext } from "./db";

/**
 * File storage on Neon: the bytes live in storage.objects.data, beside the
 * rows that point at them. Same method names and results as supabase-js's
 * `storage.from(bucket)` for the calls this app makes.
 *
 * Authorization is unchanged. Uploads and deletes run as the caller, so the
 * bucket policies in the migrations ("guest documents uploaded at check-in",
 * "admins upload room photos", …) decide. A signed link is only issued when
 * the caller may read the object, and is then an HMAC over bucket, path and
 * expiry that /api/storage checks.
 *
 * Files are served by app/api/storage/v1/object/[...path]/route.ts:
 *   /api/storage/v1/object/public/<bucket>/<path>          public buckets
 *   /api/storage/v1/object/sign/<bucket>/<path>?token=…    signed, expiring
 * The public form keeps Supabase's "/storage/v1/object/public/" marker, which
 * rates-actions.ts reads to find a photo's path from its URL.
 */

export const STORAGE_ROUTE = "/api/storage/v1/object";

interface StorageError {
  message: string;
  statusCode: string;
}

function fail(message: string, statusCode = "400"): StorageError {
  return { message, statusCode };
}

function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set");
  return `storage:${s}`;
}

function encodePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function signObject(bucket: string, path: string, expires: number) {
  return createHmac("sha256", secret()).update(`${bucket}/${path}:${expires}`).digest("base64url");
}

export function verifySignedObject(bucket: string, path: string, token: string | null): boolean {
  if (!token) return false;
  const [expRaw, mac] = token.split(".");
  const expires = Number(expRaw);
  if (!Number.isFinite(expires) || expires * 1000 < Date.now() || !mac) return false;
  const expected = Buffer.from(signObject(bucket, path, expires));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

async function toBuffer(body: Blob | Buffer | ArrayBuffer | Uint8Array): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return Buffer.from(await (body as Blob).arrayBuffer());
}

function pgMessage(err: unknown) {
  const e = err as { code?: string; message?: string };
  if (e.code === "42501") return fail("new row violates row-level security policy", "403");
  if (e.code === "23505") return fail("The resource already exists", "409");
  return fail(e.message ?? String(err), "500");
}

export function createNeonStorage(context: () => Promise<DbContext>) {
  return {
    from(bucket: string) {
      return {
        async upload(
          path: string,
          body: Blob | Buffer | ArrayBuffer | Uint8Array,
          options: { contentType?: string; upsert?: boolean } = {},
        ) {
          try {
            const [b] = await serviceQuery<{ file_size_limit: string | null; allowed_mime_types: string[] | null }>(
              "select file_size_limit, allowed_mime_types from storage.buckets where id = $1",
              [bucket],
            );
            if (!b) return { data: null, error: fail("Bucket not found", "404") };
            const bytes = await toBuffer(body);
            const type = options.contentType || (body as Blob).type || "application/octet-stream";
            if (b.file_size_limit && bytes.length > Number(b.file_size_limit)) {
              return { data: null, error: fail("The object exceeded the maximum allowed size", "413") };
            }
            if (b.allowed_mime_types?.length && !b.allowed_mime_types.includes(type)) {
              return { data: null, error: fail(`mime type ${type} is not supported`, "415") };
            }
            const ctx = await context();
            await withContext(ctx, (c) =>
              c.query(
                `insert into storage.objects (bucket_id, name, owner, content_type, size, data)
                 values ($1, $2, auth.uid(), $3, $4, $5)` +
                  (options.upsert
                    ? ` on conflict (bucket_id, name) do update set content_type = excluded.content_type,
                        size = excluded.size, data = excluded.data, updated_at = now()`
                    : ""),
                [bucket, path, type, bytes.length, bytes],
              ),
            );
            return { data: { path, id: path, fullPath: `${bucket}/${path}` }, error: null };
          } catch (err) {
            return { data: null, error: pgMessage(err) };
          }
        },

        async remove(paths: string[]) {
          try {
            const ctx = await context();
            const rows = await withContext(ctx, async (c) =>
              (
                await c.query<{ name: string }>(
                  "delete from storage.objects where bucket_id = $1 and name = any($2::text[]) returning name",
                  [bucket, paths],
                )
              ).rows,
            );
            return { data: rows.map((r) => ({ name: r.name, bucket_id: bucket })), error: null };
          } catch (err) {
            return { data: null, error: pgMessage(err) };
          }
        },

        getPublicUrl(path: string) {
          return { data: { publicUrl: `${STORAGE_ROUTE}/public/${encodeURIComponent(bucket)}/${encodePath(path)}` } };
        },

        async createSignedUrls(paths: string[], expiresIn: number) {
          try {
            const ctx = await context();
            // Only what the caller's policies let them see gets a link.
            const visible = await withContext(
              ctx,
              async (c) =>
                new Set(
                  (
                    await c.query<{ name: string }>(
                      "select name from storage.objects where bucket_id = $1 and name = any($2::text[])",
                      [bucket, paths],
                    )
                  ).rows.map((r) => r.name),
                ),
              { readOnly: true },
            );
            const expires = Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(expiresIn));
            const data = paths.map((path) =>
              visible.has(path)
                ? {
                    path,
                    error: null,
                    signedUrl: `${STORAGE_ROUTE}/sign/${encodeURIComponent(bucket)}/${encodePath(path)}?token=${expires}.${signObject(bucket, path, expires)}`,
                  }
                : { path, error: "Object not found", signedUrl: null },
            );
            return { data, error: null };
          } catch (err) {
            return { data: null, error: pgMessage(err) };
          }
        },

        async createSignedUrl(path: string, expiresIn: number) {
          const { data, error } = await this.createSignedUrls([path], expiresIn);
          if (error) return { data: null, error };
          const [one] = data!;
          if (!one.signedUrl) return { data: null, error: fail("Object not found", "404") };
          return { data: { signedUrl: one.signedUrl }, error: null };
        },
      };
    },
  };
}

export type NeonStorage = ReturnType<typeof createNeonStorage>;
