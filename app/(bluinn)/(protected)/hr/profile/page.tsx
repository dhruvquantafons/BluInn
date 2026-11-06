import Link from "next/link";
import { createClient } from "../../../../lib/supabase/server";
import { requireSession } from "../../../../lib/auth";
import { BLOOD_GROUPS, type Staff } from "../../../../lib/types";
import { saveMyProfile } from "../../../hr-actions";
import { Card, Field, SectionTitle, fmtDate, inputClass } from "../../../components/ui";
import ActionForm from "../../../components/ActionForm";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * My profile (0038): every staff member keeps their own contact details up
 * to date. What HR decides (job, department, shift, joining date) is shown
 * but not editable here.
 */
export default async function MyProfilePage() {
  const session = await requireSession();
  const supabase = await createClient();
  const [{ data: me }, { data: role }, { data: dept }, { data: shift }, { data: hotels }] = await Promise.all([
    supabase.from("staff").select("*").eq("id", session.staff.id).single(),
    supabase.from("roles").select("name").eq("key", session.staff.role).maybeSingle(),
    session.staff.department_id
      ? supabase.from("departments").select("name").eq("id", session.staff.department_id).maybeSingle()
      : Promise.resolve({ data: null }),
    session.staff.default_shift_id
      ? supabase.from("shift_types").select("name").eq("id", session.staff.default_shift_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("properties").select("id, name").order("sort_order"),
  ]);
  const person = me as Staff;
  const home = (hotels ?? []).find((h) => h.id === person.property_id);

  const facts: [string, string][] = [
    ["Name", person.full_name],
    ["Sign-in email", person.email],
    ["Employee ID", person.employee_code ?? "—"],
    ["Designation", person.job_title || "—"],
    ["Department", (dept as { name: string } | null)?.name ?? "—"],
    ["Joined", person.joining_date ? fmtDate(person.joining_date) : "—"],
    ["Usual shift", (shift as { name: string } | null)?.name ?? "—"],
    ["Weekly day off", person.weekly_off === null || person.weekly_off === undefined ? "—" : WEEKDAYS[person.weekly_off]],
    ["Role", (role as { name: string } | null)?.name ?? person.role],
    ["Works at", person.all_properties ? "Every hotel (head office)" : (home?.name ?? "—")],
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
      <Card className="p-5 lg:col-span-3">
        <SectionTitle>My details</SectionTitle>
        <p className="text-[11px] text-slate-500 -mt-2 mb-4">
          Kept up to date by you. HR and your manager see them on your staff record.
        </p>
        <ActionForm action={saveMyProfile} submitLabel="Save my details" className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Phone">
              <input name="phone" type="tel" maxLength={30} defaultValue={person.phone ?? ""} className={inputClass} />
            </Field>
            <Field label="Emergency contact" hint="Name, relation and number.">
              <input name="emergency_contact" maxLength={200} defaultValue={person.emergency_contact ?? ""} className={inputClass} />
            </Field>
            <Field label="Date of birth">
              <input type="date" name="date_of_birth" defaultValue={person.date_of_birth ?? ""} className={inputClass} />
            </Field>
            <Field label="Blood group">
              <select name="blood_group" defaultValue={person.blood_group ?? ""} className={inputClass}>
                <option value="">Not given</option>
                {BLOOD_GROUPS.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Home address">
            <textarea name="address" rows={2} maxLength={500} defaultValue={person.address ?? ""} className={inputClass} />
          </Field>
        </ActionForm>
      </Card>

      <Card className="p-5 lg:col-span-2">
        <SectionTitle>Set by HR</SectionTitle>
        <dl className="text-sm divide-y divide-slate-100">
          {facts.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 py-2">
              <dt className="text-slate-500">{k}</dt>
              <dd className="text-slate-900 text-right">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="text-[11px] text-slate-500 mt-3">
          Something wrong here? Ask HR. Your password and two-step sign-in are under{" "}
          <Link href="/security" className="text-brand-700 hover:underline">
            Password &amp; 2FA
          </Link>
          .
        </p>
      </Card>
    </div>
  );
}
