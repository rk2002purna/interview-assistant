-- Migration 0017: serialize bootstrap-admin election (finding F2)
--
-- The bootstrap-admin trigger defined in migration 0001 counts existing admins
-- and, when it finds none, promotes the newly inserted user to `admin`. That
-- count-and-promote is not serialized, so two registrations racing on a fresh
-- deployment each run their AFTER INSERT trigger in its own transaction, each
-- sees other_admin_count = 0 (neither can see the other's uncommitted
-- promotion under READ COMMITTED), and both are promoted — yielding more than
-- one bootstrap admin, including an attacker who raced the operator's first
-- sign-up.
--
-- This migration redefines the trigger function (the applied 0001 is left
-- untouched) to take a transaction-scoped advisory lock on a fixed key before
-- the count. Concurrent inserts then serialize on that key: the first to
-- acquire it promotes and commits; the second blocks until the first's
-- transaction ends, then sees the committed admin and does nothing. The lock
-- is released automatically at transaction end.
--
-- Depends on: 0001 (users, users_bootstrap_admin, audit_log).

BEGIN;

CREATE OR REPLACE FUNCTION users_bootstrap_admin() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    other_admin_count integer;
BEGIN
    -- Serialize every bootstrap-admin decision on a single fixed key so two
    -- concurrent first-registrations cannot both observe zero admins and both
    -- promote (finding F2). Held until the surrounding transaction commits or
    -- rolls back.
    PERFORM pg_advisory_xact_lock(2000401);

    SELECT count(*) INTO other_admin_count
        FROM users
        WHERE role = 'admin' AND id <> NEW.id;

    IF other_admin_count = 0 THEN
        -- Promote the newly inserted user. UPDATE on the same row from
        -- an AFTER INSERT trigger is permitted and does not re-fire
        -- this INSERT trigger.
        IF NEW.role <> 'admin' THEN
            UPDATE users SET role = 'admin' WHERE id = NEW.id;
        END IF;

        -- Append the audit_log row only if the table exists. In
        -- production all migrations 0001..0006 run before any insert,
        -- so this branch is always taken; in test scenarios that run
        -- only this migration the guard prevents a failure.
        IF to_regclass('public.audit_log') IS NOT NULL THEN
            INSERT INTO audit_log (
                id, ts, actor_user_id, target_user_id,
                target_resource, event_type, outcome, reason_code, metadata
            ) VALUES (
                gen_random_uuid(),
                now(),
                NULL,
                NEW.id,
                'user:' || NEW.id::text,
                'role_assigned',
                'success',
                'bootstrap_admin',
                jsonb_build_object(
                    'assigned_role', 'admin',
                    'previous_role', NEW.role
                )
            );
        END IF;
    END IF;

    RETURN NULL;  -- AFTER trigger return value is ignored
END;
$$;

COMMIT;
