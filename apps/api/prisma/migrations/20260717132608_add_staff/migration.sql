-- CreateEnum
CREATE TYPE "attendance_event_type" AS ENUM ('CLOCK_IN', 'CLOCK_OUT');

-- CreateTable
CREATE TABLE "staff_invites" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "invited_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_events" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "type" "attendance_event_type" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "recorded_by" UUID,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_invites_token_hash_key" ON "staff_invites"("token_hash");

-- CreateIndex
CREATE INDEX "staff_invites_restaurant_id_accepted_at_idx" ON "staff_invites"("restaurant_id", "accepted_at");

-- CreateIndex
CREATE INDEX "staff_invites_expires_at_idx" ON "staff_invites"("expires_at");

-- CreateIndex
CREATE INDEX "attendance_events_restaurant_id_membership_id_at_idx" ON "attendance_events"("restaurant_id", "membership_id", "at");

-- AddForeignKey
ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- RLS
-- ===========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff_invites', 'attendance_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (restaurant_id = current_restaurant_id())
         WITH CHECK (restaurant_id = current_restaurant_id())', t);
  END LOOP;
END $$;

-- ===========================================================================
-- Attendance is pay, so it is immutable like money.
-- ===========================================================================
--
-- A forgotten clock-out is corrected by APPENDING a corrected event, never by
-- editing the original. Otherwise "adjust the hours" becomes indistinguishable
-- from "quietly pay someone less", and the record cannot settle a dispute.
DROP TRIGGER IF EXISTS attendance_events_append_only ON attendance_events;
CREATE TRIGGER attendance_events_append_only
  BEFORE UPDATE OR DELETE ON attendance_events
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

REVOKE UPDATE, DELETE ON attendance_events FROM oraos_api;

-- Invites expire. An invitation that is valid forever is a permanent unguarded
-- door into the tenant.
ALTER TABLE staff_invites DROP CONSTRAINT IF EXISTS staff_invites_expiry_future;
ALTER TABLE staff_invites ADD CONSTRAINT staff_invites_expiry_future
  CHECK (expires_at > created_at);

-- Email stored lowercase, same rationale as users.email and customers.email.
ALTER TABLE staff_invites DROP CONSTRAINT IF EXISTS staff_invites_email_lowercase;
ALTER TABLE staff_invites ADD CONSTRAINT staff_invites_email_lowercase
  CHECK (email = lower(email));

-- One live invite per email per restaurant. Without this, spamming invites
-- leaves several working tokens for one person and revoking one means nothing.
CREATE UNIQUE INDEX IF NOT EXISTS staff_invites_one_pending
  ON staff_invites (restaurant_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
