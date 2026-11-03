import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The Neon backend end to end, against a real Postgres with every migration
 * applied: sign-in, sessions, 2FA, the query translator (embeds, filters,
 * counts, writes, rpc), row level security and storage — through the same
 * supabase-js query builder the app uses.
 *
 * Skipped unless NEON_TEST_DATABASE_URL points at a throwaway database that
 * `npm run db:migrate` has been run against. It creates and deletes its own
 * rows, but do not point it at production.
 *
 *   NEON_TEST_DATABASE_URL=postgres://... npx vitest run tests/neon.integration.test.ts
 */

const url = process.env.NEON_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

type Jar = Map<string, string>;
const jarAdapter = (jar: Jar) => ({
  get: (name: string) => jar.get(name),
  set: (name: string, value: string) => {
    if (value) jar.set(name, value);
    else jar.delete(name);
  },
});

suite("Neon backend", async () => {
  if (url) {
    process.env.DATABASE_URL = url;
    process.env.AUTH_SECRET ??= "test-secret-test-secret-test-secret-0123";
  }
  const { createNeonServiceClient, createNeonUserClient } = await import("../app/lib/neon/client");
  const { serviceQuery, pool } = await import("../app/lib/neon/db");
  const { __test, currentStep } = await import("../app/lib/neon/totp");

  const stamp = Date.now().toString(36);
  const email = `neon-test-${stamp}@example.com`;
  const password = "Correct-Horse-9-Battery";
  const jar: Jar = new Map();
  let userId = "";
  let createdStaffBefore = 0;

  const service = createNeonServiceClient();
  const user = () => createNeonUserClient(jarAdapter(jar));
  const anon = () => createNeonUserClient(jarAdapter(new Map()));

  beforeAll(async () => {
    const [{ n }] = await serviceQuery<{ n: number }>("select count(*)::int as n from public.staff");
    createdStaffBefore = n;
    const { data, error } = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: "Neon Test" },
    });
    expect(error).toBeNull();
    userId = data.user!.id;
    // The bootstrap trigger only makes the first account staff; make this one
    // an administrator the way actions.ts does for colleagues.
    const { error: staffError } = await service
      .from("staff")
      .upsert({ id: userId, email, full_name: "Neon Test", role: "admin", is_active: true }, { onConflict: "id" });
    expect(staffError).toBeNull();
  });

  afterAll(async () => {
    await serviceQuery("delete from public.bookings where contact_name like 'NT %'");
    if (userId) await service.auth.admin.deleteUser(userId);
    await serviceQuery("delete from public.guests where full_name like $1", [`NT ${stamp}%`]);
    await serviceQuery("delete from public.rooms where room_number like $1", [`T${stamp}%`]);
    await pool().end();
  });

  it("refuses a wrong password and accepts the right one", async () => {
    const bad = await user().auth.signInWithPassword({ email, password: "nope" });
    expect(bad.error?.message).toBe("Invalid login credentials");
    const good = await user().auth.signInWithPassword({ email: email.toUpperCase(), password });
    expect(good.error).toBeNull();
    expect([...jar.keys()]).toContain("sb-bluinn-session");
    const { data } = await user().auth.getUser();
    expect(data.user?.id).toBe(userId);
  });

  it("loads the session the way lib/auth.ts does", async () => {
    const db = user();
    const { data, error } = await db.from("staff").select("*, roles(*)").eq("id", userId).single();
    expect(error).toBeNull();
    expect(data.roles.key).toBe("admin");
    const { data: perms } = await db.from("role_permissions").select("permission").eq("role_key", "manager");
    expect(perms!.length).toBeGreaterThan(5);
    const { error: rpcError, data: none } = await db.rpc("touch_staff_seen");
    expect(rpcError).toBeNull();
    expect(none).toBeNull();
    const { data: prop } = await db.rpc("current_property");
    expect(typeof prop).toBe("string");
  });

  it("hides everything from a signed-out visitor (RLS)", async () => {
    const { data, error } = await anon().from("staff").select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);
    const { error: insertError } = await anon().from("guests").insert({ full_name: `NT ${stamp} anon` });
    expect(insertError?.code).toBe("42501");
  });

  it("writes and reads bookings with embeds, filters and counts", async () => {
    const db = user();
    const { data: type } = await db.from("room_types").select("id, name").limit(1).single();
    const { data: room, error: roomError } = await db
      .from("rooms")
      .insert({ room_number: `T${stamp}1`, room_type_id: type!.id })
      .select("*, room_types(name, slug)")
      .single();
    expect(roomError).toBeNull();
    expect(room.room_types.name).toBe(type!.name);

    const { data: guest } = await db
      .from("guests")
      .insert({ full_name: `NT ${stamp} Guest`, email: `g-${stamp}@example.com`, tags: ["VIP"] })
      .select()
      .single();

    const { data: booking, error: bookingError } = await db
      .from("bookings")
      .insert({
        guest_id: guest.id,
        room_type_id: type!.id,
        room_id: room.id,
        check_in: "2031-01-10",
        check_out: "2031-01-12",
        contact_name: `NT ${stamp} Guest`,
      })
      .select("*, guests(id, full_name), rooms(id, room_number)")
      .single();
    expect(bookingError).toBeNull();
    expect(booking.guests.full_name).toBe(`NT ${stamp} Guest`);
    expect(booking.rooms.room_number).toBe(`T${stamp}1`);

    // The list page: count, range, order, or= with ilike, in., not.is.null.
    const term = `%${stamp}%`;
    const { data: list, count, error: listError } = await db
      .from("bookings")
      .select("*, guests(id, full_name, email, phone), room_types(id, name), rooms(id, room_number)", { count: "exact" })
      .or(`reference.ilike.${term},contact_name.ilike.${term}`)
      .in("status", ["confirmed", "checked_in", "tentative"])
      .not("room_id", "is", null)
      .gte("check_in", "2031-01-01")
      .order("check_in", { ascending: false })
      .range(0, 24);
    expect(listError).toBeNull();
    expect(count).toBe(list!.length);

    // Nested embed, and a reverse (one-to-many) embed.
    const { data: nested } = await db
      .from("bookings")
      .select("id, rooms(room_number, room_types(name))")
      .eq("id", booking.id)
      .single<{ rooms: { room_types: { name: string } } }>();
    expect(nested!.rooms.room_types.name).toBe(type!.name);
    const { data: withBookings } = await db.from("guests").select("id, bookings(id, check_in)").eq("id", guest.id).single<{ bookings: unknown[] }>();
    expect(withBookings!.bookings).toHaveLength(1);

    // Head count, contains, maybeSingle with no row, single with no row.
    const { count: headCount } = await db.from("guests").select("id", { count: "exact", head: true }).eq("id", guest.id);
    expect(headCount).toBe(1);
    const { data: vip } = await db.from("guests").select("id").contains("tags", ["VIP"]).eq("id", guest.id);
    expect(vip).toHaveLength(1);
    const { data: missing, error: missingError } = await db
      .from("guests")
      .select("id")
      .eq("id", "00000000-0000-0000-0000-000000000000")
      .maybeSingle();
    expect(missing).toBeNull();
    expect(missingError).toBeNull();
    const { error: singleError } = await db.from("guests").select("id").eq("id", "00000000-0000-0000-0000-000000000000").single();
    expect(singleError?.code).toBe("PGRST116");

    // Hinted embeds, an FK-column embed with an alias, and !inner with an
    // embedded filter.
    const { data: room2 } = await db.from("rooms").insert({ room_number: `T${stamp}2`, room_type_id: type!.id }).select().single();
    await db.from("room_moves").insert({ booking_id: booking.id, from_room_id: room.id, to_room_id: room2.id, moved_by: userId });
    const { data: moves, error: movesError } = await db
      .from("room_moves")
      .select("*, from:rooms!room_moves_from_room_id_fkey(room_number), to:rooms!room_moves_to_room_id_fkey(room_number)")
      .eq("booking_id", booking.id);
    expect(movesError).toBeNull();
    expect(moves![0].from.room_number).toBe(`T${stamp}1`);
    expect(moves![0].to.room_number).toBe(`T${stamp}2`);

    const { error: docInsertError } = await db.from("guest_documents").insert({ guest_id: guest.id, booking_id: booking.id, kind: "id_front", storage_path: `${stamp}/doc.jpg`, uploaded_by: userId });
    expect(docInsertError).toBeNull();
    const { data: docs, error: docsError } = await db
      .from("guest_documents")
      .select("*, bookings(reference, check_in), staff:uploaded_by(full_name)")
      .eq("guest_id", guest.id);
    expect(docsError).toBeNull();
    expect(docs![0].staff.full_name).toBe("Neon Test");

    await db.from("registration_cards").insert({ booking_id: booking.id, guest_name: "x", signature_path: `${stamp}/sig.png` });
    const { data: cards, error: cardsError } = await db
      .from("registration_cards")
      .select("signature_path, bookings!inner(guest_id)")
      .eq("bookings.guest_id", guest.id);
    expect(cardsError).toBeNull();
    expect(cards).toHaveLength(1);
    const { data: noCards } = await db
      .from("registration_cards")
      .select("signature_path, bookings!inner(guest_id)")
      .eq("bookings.guest_id", "00000000-0000-0000-0000-000000000000");
    expect(noCards).toHaveLength(0);

    // Update with representation, then upsert, then delete.
    const { data: updated, error: updateError } = await db
      .from("bookings")
      .update({ contact_phone: "+91 99999 00000", is_vip: true })
      .eq("id", booking.id)
      .select("id, contact_phone, is_vip")
      .single();
    expect(updateError).toBeNull();
    expect(updated).toEqual({ id: booking.id, contact_phone: "+91 99999 00000", is_vip: true });

    const { error: upsertError } = await db
      .from("message_templates")
      .upsert(
        { property_id: await db.rpc("current_property").then((r) => r.data), template: "request_received", language: "en", subject: `S ${stamp}` },
        { onConflict: "property_id,template,language" },
      );
    expect(upsertError).toBeNull();

    // A database function's typed arguments, and a scalar result.
    const { data: balance, error: balanceError } = await db.rpc("folio_balance", { p_booking: booking.id });
    expect(balanceError).toBeNull();
    expect(typeof balance).toBe("number");
    const { error: logError } = await db.rpc("log_event", { p_module: "test", p_action: "neon", p_record_id: booking.id, p_summary: "neon test" });
    expect(logError).toBeNull();

    const { error: deleteError } = await db.from("room_moves").delete().eq("booking_id", booking.id);
    expect(deleteError).toBeNull();
  });

  it("stores files behind the bucket policies", async () => {
    const db = user();
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const { error } = await db.storage.from("guest-documents").upload(`${stamp}/a.png`, png, { contentType: "image/png" });
    expect(error).toBeNull();
    const { data: signed } = await db.storage.from("guest-documents").createSignedUrl(`${stamp}/a.png`, 60);
    expect(signed?.signedUrl).toMatch(/^\/api\/storage\/v1\/object\/sign\/guest-documents\//);
    const { error: typeError } = await db.storage.from("guest-documents").upload(`${stamp}/a.exe`, png, { contentType: "application/x-msdownload" });
    expect(typeError).not.toBeNull();
    const { error: anonError } = await anon().storage.from("guest-documents").upload(`${stamp}/b.png`, png, { contentType: "image/png" });
    expect(anonError?.statusCode).toBe("403");
    const { data: removed } = await db.storage.from("guest-documents").remove([`${stamp}/a.png`]);
    expect(removed).toHaveLength(1);
    expect(db.storage.from("room-photos").getPublicUrl("x.jpg").data.publicUrl).toContain("/storage/v1/object/public/room-photos/x.jpg");
  });

  it("enrols an authenticator and raises the session to aal2", async () => {
    const db = user();
    const { data: enrol, error } = await db.auth.mfa.enroll({ factorType: "totp", friendlyName: "test" });
    expect(error).toBeNull();
    expect(enrol!.totp.qr_code).toMatch(/^data:image\/png;base64,/);
    const code = __test.codeAt(__test.base32Decode(enrol!.totp.secret), currentStep());
    const wrong = await db.auth.mfa.challengeAndVerify({ factorId: enrol!.id, code: code === "000000" ? "111111" : "000000" });
    expect(wrong.error).not.toBeNull();
    const ok = await db.auth.mfa.challengeAndVerify({ factorId: enrol!.id, code });
    expect(ok.error).toBeNull();
    const replay = await db.auth.mfa.challengeAndVerify({ factorId: enrol!.id, code });
    expect(replay.error).not.toBeNull();
    const { data: aal } = await user().auth.mfa.getAuthenticatorAssuranceLevel();
    expect(aal).toMatchObject({ currentLevel: "aal2", nextLevel: "aal2" });
  });

  it("signs out", async () => {
    await user().auth.signOut();
    expect(jar.has("sb-bluinn-session")).toBe(false);
    const [{ n }] = await serviceQuery<{ n: number }>("select count(*)::int as n from auth.sessions where user_id = $1", [userId]);
    expect(n).toBe(0);
    expect(createdStaffBefore).toBeGreaterThanOrEqual(0);
  });
});
