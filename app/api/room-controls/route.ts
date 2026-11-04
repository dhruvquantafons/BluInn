import { timingSafeEqual } from "node:crypto";
import { createServiceClient } from "../../lib/supabase/server";
import { hasServiceAccess } from "../../lib/supabase/config";

/**
 * Integration hook for in-room controls (Module 5: Do Not Disturb synced from
 * the guest room's controls). The room-control system posts:
 *
 *   POST /api/room-controls
 *   Authorization: Bearer <ROOM_CONTROLS_SECRET>
 *   { "room_number": "203", "dnd": true, "property": "H1" }
 *
 * `property` is the hotel's code (Admin → Properties). Room numbers are only
 * unique within one hotel, so in a group with more than one hotel holding the
 * room number it is required; without it the request is refused rather than
 * flagging the same room number at every hotel.
 *
 * Disabled until ROOM_CONTROLS_SECRET is set.
 */
export async function POST(request: Request) {
  const secret = process.env.ROOM_CONTROLS_SECRET;
  if (!secret || !hasServiceAccess()) {
    return Response.json({ error: "Room controls integration is not configured." }, { status: 503 });
  }

  const given = Buffer.from(request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const expected = Buffer.from(secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as
    | { room_number?: unknown; dnd?: unknown; property?: unknown }
    | null;
  const roomNumber = typeof body?.room_number === "string" ? body.room_number.trim().slice(0, 20) : "";
  const propertyCode = typeof body?.property === "string" ? body.property.trim().toLowerCase() : "";
  if (!roomNumber || typeof body?.dnd !== "boolean") {
    return Response.json(
      { error: 'Send {"room_number": string, "dnd": boolean, "property"?: string}.' },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  let propertyId: string | null = null;
  if (propertyCode) {
    const { data: properties } = await supabase.from("properties").select("id, code");
    propertyId =
      (properties ?? []).find((p: { id: string; code: string }) => p.code.toLowerCase() === propertyCode)?.id ?? null;
    if (!propertyId) return Response.json({ error: "Unknown property." }, { status: 404 });
  }

  let lookup = supabase.from("rooms").select("id").eq("room_number", roomNumber);
  if (propertyId) lookup = lookup.eq("property_id", propertyId);
  const { data: rooms, error: lookupError } = await lookup.limit(2);
  if (lookupError) return Response.json({ error: "Could not update the room." }, { status: 500 });
  if (!rooms?.length) return Response.json({ error: "Unknown room." }, { status: 404 });
  if (rooms.length > 1) {
    return Response.json(
      { error: "More than one hotel has this room number. Send the hotel's code as \"property\"." },
      { status: 409 },
    );
  }

  const { data, error } = await supabase
    .from("rooms")
    .update({ dnd: body.dnd, dnd_updated_at: new Date().toISOString() })
    .eq("id", rooms[0].id)
    .select("room_number, dnd");
  if (error || !data?.length) return Response.json({ error: "Could not update the room." }, { status: 500 });

  return Response.json({ room_number: data[0].room_number, dnd: data[0].dnd });
}
