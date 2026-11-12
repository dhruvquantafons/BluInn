"use client";

import { useActionState } from "react";
import type { ActionState } from "../../form-utils";
import { updateHousekeepingStatus } from "../../rooms-actions";
import { HOUSEKEEPING_STATUS_LABELS, type HousekeepingStatus } from "../../../lib/types";

/**
 * The quick housekeeping-status buttons on a room tile. A refusal (no
 * permission to mark it inspected, a database error) is shown under the
 * buttons; it used to be dropped without a word (0043).
 */
export default function RoomStatusButtons({
  roomId,
  current,
  statuses,
}: {
  roomId: string;
  current: HousekeepingStatus;
  statuses: HousekeepingStatus[];
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(updateHousekeepingStatus, {});
  return (
    <form action={action} className="mt-1.5">
      <input type="hidden" name="id" value={roomId} />
      <div className="flex flex-wrap gap-1">
        {statuses.map((hk) => (
          <button
            key={hk}
            type="submit"
            name="housekeeping_status"
            value={hk}
            disabled={pending}
            title={`Mark ${HOUSEKEEPING_STATUS_LABELS[hk].toLowerCase()}`}
            className={`text-[9px] px-1.5 py-0.5 rounded-md border cursor-pointer transition-colors duration-150 disabled:opacity-60 ${
              current === hk
                ? "bg-brand-600 text-white border-brand-600"
                : "bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:text-slate-900"
            }`}
          >
            {HOUSEKEEPING_STATUS_LABELS[hk]}
          </button>
        ))}
      </div>
      {state.error && (
        <p role="alert" className="mt-1 text-[10px] text-rose-700">
          {state.error}
        </p>
      )}
    </form>
  );
}
