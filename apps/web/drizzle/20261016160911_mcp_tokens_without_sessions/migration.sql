-- An MCP grant must outlive the browser session that consented. The OAuth
-- provider stamps each token with that session, treats the token as dead once
-- the session expires, and copies the stamp onto refreshed tokens. Tokens here
-- never carry one, so a grant ends only when it is revoked or lapses.
CREATE FUNCTION oauth_token_without_session() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.session_id := NULL;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER oauth_access_token_without_session
  BEFORE INSERT OR UPDATE OF session_id ON "oauth_access_token"
  FOR EACH ROW EXECUTE FUNCTION oauth_token_without_session();--> statement-breakpoint
CREATE TRIGGER oauth_refresh_token_without_session
  BEFORE INSERT OR UPDATE OF session_id ON "oauth_refresh_token"
  FOR EACH ROW EXECUTE FUNCTION oauth_token_without_session();
