import { createServiceClient } from "./supabase/server";
import { hasServiceAccess } from "./supabase/config";

/**
 * Records each run of a scheduled job in job_runs (0038), so System status
 * can say when it last ran and whether it worked. Refused calls (no secret,
 * wrong secret) are not runs and are not recorded. Recording never gets in
 * the way of the job: if it fails, the job's own response still goes back.
 */
export async function withJobRun(job: string, run: () => Promise<Response>): Promise<Response> {
  const startedAt = new Date().toISOString();
  const response = await run();
  if (response.status === 401 || response.status === 503 || !hasServiceAccess()) return response;

  try {
    let detail = "";
    try {
      detail = (await response.clone().text()).slice(0, 500);
    } catch {
      detail = "";
    }
    await createServiceClient().from("job_runs").insert({
      job,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      ok: response.ok,
      detail,
    });
  } catch {
    // The run already happened; a missing record is not worth failing it.
  }
  return response;
}
