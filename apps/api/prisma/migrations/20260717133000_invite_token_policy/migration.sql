-- Lets an invitee read their own invite before they have a tenant.
--
-- THE BUG THIS FIXES: /join/:token is public by necessity — the invitee has no
-- account yet, so there is no JWT and no app.restaurant_id. But staff_invites
-- is RLS-protected, so the lookup matched nothing and every valid invite
-- returned 404. Caught by the e2e suite.
--
-- Same shape as the exception already made for memberships and restaurants:
-- identity-adjacent reads have to work before tenant context exists.
--
-- The rule is precise, and it is the honest statement of what an invite IS:
-- possession of the token is the authorization. A caller may read exactly the
-- one row whose token they hold, and nothing else. They cannot enumerate, and
-- they cannot see any other invite for the same restaurant.
--
-- Writes stay strict: WITH CHECK still demands the row be the current tenant,
-- so this grants no ability to create or alter an invite.

CREATE OR REPLACE FUNCTION current_invite_token() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.invite_token_hash', true), '');
$$;

DROP POLICY IF EXISTS tenant_isolation ON staff_invites;
CREATE POLICY tenant_isolation ON staff_invites
  USING (
    restaurant_id = current_restaurant_id()
    OR token_hash = current_invite_token()
  )
  WITH CHECK (restaurant_id = current_restaurant_id());
