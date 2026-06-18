-- Migration 0010: add signup_bonus to entitlement_ledger reason enum
--
-- Required so that the 3 free trial sessions granted at registration
-- are tracked with their own reason code in the append-only ledger.

BEGIN;

ALTER TABLE entitlement_ledger DROP CONSTRAINT entitlement_ledger_reason_enum;
ALTER TABLE entitlement_ledger ADD CONSTRAINT entitlement_ledger_reason_enum
  CHECK (reason IN (
    'pack_purchase',
    'lifetime_grant',
    'session_start',
    'session_refund',
    'admin_adjustment',
    'signup_bonus'
  ));

COMMIT;
