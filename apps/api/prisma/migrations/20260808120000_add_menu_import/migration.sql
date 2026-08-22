-- CreateEnum
CREATE TYPE "menu_import_status" AS ENUM ('UPLOADED', 'PROCESSING', 'REVIEW_REQUIRED', 'APPROVED', 'IMPORTED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "menu_import_sessions" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "status" "menu_import_status" NOT NULL DEFAULT 'UPLOADED',
    "page_count" INTEGER NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "created_by" UUID,
    "imported_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "menu_import_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "menu_import_sessions_restaurant_id_created_at_idx" ON "menu_import_sessions"("restaurant_id", "created_at");

-- ===========================================================================
-- Tenant isolation — the same policy as every tenant-scoped table. This table
-- is MUTABLE (the review draft changes as the user edits), so like
-- purchase_orders there is deliberately no append-only trigger: the app role
-- keeps the CRUD it receives by default privilege. The permanent record of what
-- an import actually wrote lives in the immutable audit_logs row it appends.
-- ===========================================================================
ALTER TABLE menu_import_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_import_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON menu_import_sessions;
CREATE POLICY tenant_isolation ON menu_import_sessions
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());
