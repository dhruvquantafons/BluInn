import { hasDatabaseConfig, serviceQuery } from "../../../../../lib/neon/db";
import { verifySignedObject } from "../../../../../lib/neon/storage";

/**
 * Serves stored files on Neon deployments (see app/lib/neon/storage.ts):
 *
 *   GET /api/storage/v1/object/public/<bucket>/<path>          public buckets only
 *   GET /api/storage/v1/object/sign/<bucket>/<path>?token=…    a link signed for
 *                                                              someone allowed to read it
 *
 * Outside the proxy's sign-in check on purpose: the signature is the
 * permission, as with Supabase's signed URLs.
 */
export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  if (!hasDatabaseConfig()) return new Response("Not found", { status: 404 });

  const [mode, bucket, ...rest] = (await params).path.map((p) => decodeURIComponent(p));
  const name = rest.join("/");
  if (!bucket || !name || (mode !== "public" && mode !== "sign")) return new Response("Not found", { status: 404 });

  if (mode === "sign" && !verifySignedObject(bucket, name, new URL(request.url).searchParams.get("token"))) {
    return new Response("This link has expired. Reload the page for a new one.", { status: 403 });
  }

  const [row] = await serviceQuery<{ data: Buffer; content_type: string | null; public: boolean; updated_at: Date }>(
    `select o.data, o.content_type, b.public, o.updated_at
       from storage.objects o join storage.buckets b on b.id = o.bucket_id
      where o.bucket_id = $1 and o.name = $2`,
    [bucket, name],
  );
  if (!row || !row.data || (mode === "public" && !row.public)) return new Response("Not found", { status: 404 });

  return new Response(new Uint8Array(row.data), {
    headers: {
      "content-type": row.content_type || "application/octet-stream",
      "content-length": String(row.data.length),
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
      // Public photos have unique names, so they never change in place.
      "cache-control": mode === "public" ? "public, max-age=31536000, immutable" : "private, no-store",
      "last-modified": new Date(row.updated_at).toUTCString(),
    },
  });
}
