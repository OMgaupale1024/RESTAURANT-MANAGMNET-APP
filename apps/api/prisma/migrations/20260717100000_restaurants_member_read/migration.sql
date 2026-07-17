-- Lets a user read the restaurants they are a member of, without having
-- selected one yet.
--
-- THE BUG THIS FIXES (found by the restaurants e2e "lists only the caller's
-- restaurants" test): the original policy was `id = current_restaurant_id()`.
-- Before selecting a restaurant there IS no current_restaurant_id, so every
-- restaurant row was invisible — including the user's own. GET /restaurants
-- and GET /auth/me returned memberships whose `restaurant` relation was null.
--
-- A restaurant switcher is therefore impossible: you cannot see the thing you
-- must choose in order to see it.
--
-- The fix mirrors the exception already made for memberships, and for the same
-- reason: identity-scoped reads have to work before tenant context exists.
--
-- This does NOT widen the boundary. A user may read only restaurants they hold
-- an ACTIVE membership in — which they are, by definition, entitled to see.
-- Writes stay strict: WITH CHECK still demands the row be the current tenant,
-- so this grants no ability to create or modify anything.
--
-- The EXISTS subquery reads memberships, which is itself RLS-protected and
-- scoped to the calling user. No recursion: the memberships policy does not
-- reference restaurants.

DROP POLICY IF EXISTS tenant_isolation ON restaurants;
CREATE POLICY tenant_isolation ON restaurants
  USING (
    id = current_restaurant_id()
    OR EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.restaurant_id = restaurants.id
        AND m.user_id = current_user_id()
        AND m.is_active
    )
  )
  WITH CHECK (id = current_restaurant_id());
