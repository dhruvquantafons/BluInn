-- ============================================================================
-- Front Office & Operations build-out, part 2: night audit closes the day
--
-- Night audit is back (docs/pms-review.md §3). Closing a day only means
-- something if what was closed stays closed, and until now nothing in the
-- database stopped a posted folio line from being edited: the folio_void
-- policy allows any column to change for folio.adjust (0007:423).
--
-- From here on a folio line, once posted:
--
--   • keeps its money, tax, kind, description, dates and author for ever;
--   • may be voided (with a reason) — but not once night audit has closed its
--     day. A closed day is corrected with an adjustment posted today, which is
--     what every PMS does and what an auditor expects to find;
--   • may move to another folio of the same stay (split billing; the existing
--     folio_entries_check trigger keeps it on the same booking);
--   • is stamped once with the business date that closed it, never re-stamped;
--   • is never deleted.
--
-- Run after 0027_front_office_roles.sql.
-- ============================================================================

create or replace function folio_entry_guard()
returns trigger language plpgsql as $$
declare
  -- Columns that may change after posting. Everything else is frozen,
  -- including any column a later migration adds, until it is listed here.
  v_mutable text[] := array['voided_at', 'voided_by', 'void_reason', 'folio_id',
                            'night_audit_date', 'reference', 'shift_id'];
begin
  if tg_op = 'DELETE' then
    raise exception 'FOLIO_IMMUTABLE: folio lines are never deleted; void the line instead';
  end if;

  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    raise exception 'FOLIO_IMMUTABLE: a posted folio line cannot be changed; void it and post it again';
  end if;

  if old.night_audit_date is not null
     and new.night_audit_date is distinct from old.night_audit_date then
    raise exception 'FOLIO_IMMUTABLE: this line was closed by night audit for %', old.night_audit_date;
  end if;

  if old.voided_at is not null and new.voided_at is distinct from old.voided_at then
    raise exception 'FOLIO_IMMUTABLE: a voided line stays voided; post it again instead';
  end if;

  if old.voided_at is null and new.voided_at is not null then
    if old.night_audit_date is not null then
      raise exception 'FOLIO_DAY_CLOSED: % is closed; post an adjustment today instead of voiding', old.night_audit_date;
    end if;
    if coalesce(btrim(new.void_reason), '') = '' then
      raise exception 'FOLIO_VOID_REASON: give a reason for the void';
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists folio_entries_guard on folio_entries;
create trigger folio_entries_guard
  before update or delete on folio_entries
  for each row execute function folio_entry_guard();
