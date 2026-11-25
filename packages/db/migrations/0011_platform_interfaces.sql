CREATE TABLE "idempotency_keys" (
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"response_status" integer,
	"response_body" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_pk" PRIMARY KEY("workspace_id","key"),
	CONSTRAINT "idempotency_keys_key_format" CHECK ("idempotency_keys"."key" ~ '^[!-~]{1,255}$'),
	CONSTRAINT "idempotency_keys_hash_format" CHECK ("idempotency_keys"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "idempotency_keys_status_known" CHECK ("idempotency_keys"."status" in ('in_progress', 'completed')),
	CONSTRAINT "idempotency_keys_completed_has_response" CHECK (("idempotency_keys"."status" = 'completed') = ("idempotency_keys"."response_status" is not null and "idempotency_keys"."response_body" is not null)),
	CONSTRAINT "idempotency_keys_response_is_success" CHECK ("idempotency_keys"."response_status" is null or "idempotency_keys"."response_status" between 200 and 299),
	CONSTRAINT "idempotency_keys_response_size" CHECK ("idempotency_keys"."response_body" is null or octet_length("idempotency_keys"."response_body") <= 262144)
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"run_id" uuid,
	"event_type" text NOT NULL,
	"event_key" text NOT NULL,
	"data" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_status_code" integer,
	"last_error" text,
	"last_response_excerpt" text,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_endpoint_event_unique" UNIQUE("endpoint_id","event_key"),
	CONSTRAINT "webhook_deliveries_status_known" CHECK ("webhook_deliveries"."status" in ('pending', 'delivered', 'failed')),
	CONSTRAINT "webhook_deliveries_event_type_known" CHECK ("webhook_deliveries"."event_type" in ('run.completed', 'run.failed', 'run.cancelled', 'approval.requested', 'webhook.test')),
	CONSTRAINT "webhook_deliveries_event_key_length" CHECK (char_length("webhook_deliveries"."event_key") between 1 and 200),
	CONSTRAINT "webhook_deliveries_attempts_bounded" CHECK ("webhook_deliveries"."attempts" between 0 and 20),
	CONSTRAINT "webhook_deliveries_pending_has_next_attempt" CHECK (("webhook_deliveries"."status" = 'pending') = ("webhook_deliveries"."next_attempt_at" is not null)),
	CONSTRAINT "webhook_deliveries_delivered_consistent" CHECK (("webhook_deliveries"."status" = 'delivered') = ("webhook_deliveries"."delivered_at" is not null)),
	CONSTRAINT "webhook_deliveries_status_code_range" CHECK ("webhook_deliveries"."last_status_code" is null or "webhook_deliveries"."last_status_code" between 100 and 599),
	CONSTRAINT "webhook_deliveries_error_short" CHECK ("webhook_deliveries"."last_error" is null or char_length("webhook_deliveries"."last_error") <= 60),
	CONSTRAINT "webhook_deliveries_excerpt_short" CHECK ("webhook_deliveries"."last_response_excerpt" is null or char_length("webhook_deliveries"."last_response_excerpt") <= 200),
	CONSTRAINT "webhook_deliveries_data_is_object" CHECK (jsonb_typeof("webhook_deliveries"."data") = 'object')
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
	"url" text NOT NULL,
	"origin" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"events" text[] NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"secret_rotated_at" timestamp with time zone,
	CONSTRAINT "webhook_endpoints_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "webhook_endpoints_workspace_url_unique" UNIQUE("workspace_id","url"),
	CONSTRAINT "webhook_endpoints_url_https" CHECK ("webhook_endpoints"."url" ~ '^https://' and char_length("webhook_endpoints"."url") <= 2048),
	CONSTRAINT "webhook_endpoints_origin_format" CHECK ("webhook_endpoints"."origin" ~ '^https?://[^/]+$' and char_length("webhook_endpoints"."origin") <= 300),
	CONSTRAINT "webhook_endpoints_description_length" CHECK (char_length("webhook_endpoints"."description") <= 120),
	CONSTRAINT "webhook_endpoints_events_known" CHECK (cardinality("webhook_endpoints"."events") between 1 and 4 and "webhook_endpoints"."events" <@ array['run.completed', 'run.failed', 'run.cancelled', 'approval.requested']::text[])
);
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_fk" FOREIGN KEY ("endpoint_id","workspace_id") REFERENCES "public"."webhook_endpoints"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_run_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."runs"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idempotency_keys_expiry_idx" ON "idempotency_keys" USING btree ("workspace_id","expires_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("workspace_id","status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint_created_idx" ON "webhook_deliveries" USING btree ("endpoint_id","created_at");--> statement-breakpoint
CREATE POLICY "idempotency_keys_definer_select" ON "idempotency_keys" AS PERMISSIVE FOR SELECT TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "idempotency_keys_definer_insert" ON "idempotency_keys" AS PERMISSIVE FOR INSERT TO "delegate_definer" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "idempotency_keys_definer_update" ON "idempotency_keys" AS PERMISSIVE FOR UPDATE TO "delegate_definer" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "idempotency_keys_definer_delete" ON "idempotency_keys" AS PERMISSIVE FOR DELETE TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "webhook_deliveries_select" ON "webhook_deliveries" AS PERMISSIVE FOR SELECT TO "delegate_app" USING (app_workspace_role("webhook_deliveries"."workspace_id") in ('owner', 'admin'));--> statement-breakpoint
CREATE POLICY "webhook_deliveries_definer_select" ON "webhook_deliveries" AS PERMISSIVE FOR SELECT TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "webhook_deliveries_definer_insert" ON "webhook_deliveries" AS PERMISSIVE FOR INSERT TO "delegate_definer" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "webhook_deliveries_definer_update" ON "webhook_deliveries" AS PERMISSIVE FOR UPDATE TO "delegate_definer" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "webhook_deliveries_definer_delete" ON "webhook_deliveries" AS PERMISSIVE FOR DELETE TO "delegate_definer" USING (true);--> statement-breakpoint
CREATE POLICY "webhook_endpoints_select" ON "webhook_endpoints" AS PERMISSIVE FOR SELECT TO "delegate_app" USING (app_workspace_role("webhook_endpoints"."workspace_id") in ('owner', 'admin'));--> statement-breakpoint
CREATE POLICY "webhook_endpoints_insert" ON "webhook_endpoints" AS PERMISSIVE FOR INSERT TO "delegate_app" WITH CHECK (app_workspace_role("webhook_endpoints"."workspace_id") in ('owner', 'admin') and "webhook_endpoints"."created_by" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "webhook_endpoints_update" ON "webhook_endpoints" AS PERMISSIVE FOR UPDATE TO "delegate_app" USING (app_workspace_role("webhook_endpoints"."workspace_id") in ('owner', 'admin')) WITH CHECK (app_workspace_role("webhook_endpoints"."workspace_id") in ('owner', 'admin'));--> statement-breakpoint
CREATE POLICY "webhook_endpoints_delete" ON "webhook_endpoints" AS PERMISSIVE FOR DELETE TO "delegate_app" USING (app_workspace_role("webhook_endpoints"."workspace_id") in ('owner', 'admin'));--> statement-breakpoint
CREATE POLICY "webhook_endpoints_definer_select" ON "webhook_endpoints" AS PERMISSIVE FOR SELECT TO "delegate_definer" USING (true);
--> statement-breakpoint
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT (id, workspace_id, created_by, url, origin, description, events, created_at, secret_rotated_at) ON TABLE webhook_endpoints TO delegate_app;
--> statement-breakpoint
GRANT INSERT, DELETE ON TABLE webhook_endpoints TO delegate_app;
--> statement-breakpoint
GRANT UPDATE (secret_ciphertext, secret_rotated_at) ON TABLE webhook_endpoints TO delegate_app;
--> statement-breakpoint
GRANT SELECT ON TABLE webhook_deliveries TO delegate_app;
--> statement-breakpoint
GRANT SELECT ON TABLE webhook_endpoints TO delegate_definer;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE webhook_deliveries, idempotency_keys TO delegate_definer;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_guard_webhook_endpoint_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.url IS DISTINCT FROM OLD.url
    OR NEW.origin IS DISTINCT FROM OLD.origin
    OR NEW.events IS DISTINCT FROM OLD.events
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'webhook endpoint % can only have its secret rotated; delete it and add a new one to change it', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER webhook_endpoints_guard_update
BEFORE UPDATE ON webhook_endpoints
FOR EACH ROW EXECUTE FUNCTION app_guard_webhook_endpoint_update();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION idempotency_begin(
  p_workspace_id uuid,
  p_key text,
  p_request_hash text,
  p_lock_seconds integer,
  p_ttl_seconds integer
)
RETURNS TABLE (outcome text, stored_status integer, stored_body text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  caller_role text;
  existing public.idempotency_keys%ROWTYPE;
  attempt integer := 0;
BEGIN
  caller_role := public.app_workspace_role(p_workspace_id)::text;
  IF caller_role IS NULL OR caller_role NOT IN ('owner', 'admin', 'operator') THEN
    RAISE EXCEPTION 'only an operator of the workspace may use its idempotency keys'
      USING ERRCODE = '42501';
  END IF;
  IF p_lock_seconds IS NULL OR p_lock_seconds NOT BETWEEN 1 AND 3600
    OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 60 AND 604800 THEN
    RAISE EXCEPTION 'idempotency lock or lifetime is out of range' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.idempotency_keys k
  WHERE k.workspace_id = p_workspace_id AND k.expires_at <= now();
  LOOP
    attempt := attempt + 1;
    INSERT INTO public.idempotency_keys AS k
      (workspace_id, key, request_hash, created_by, locked_until, expires_at)
    VALUES (
      p_workspace_id,
      p_key,
      p_request_hash,
      nullif(current_setting('app.user_id', true), '')::uuid,
      now() + make_interval(secs => p_lock_seconds),
      now() + make_interval(secs => p_ttl_seconds)
    )
    ON CONFLICT ON CONSTRAINT idempotency_keys_pk DO NOTHING;
    IF FOUND THEN
      outcome := 'started';
      RETURN NEXT;
      RETURN;
    END IF;
    SELECT * INTO existing FROM public.idempotency_keys k
    WHERE k.workspace_id = p_workspace_id AND k.key = p_key
    FOR UPDATE;
    IF NOT FOUND THEN
      IF attempt >= 3 THEN
        RAISE EXCEPTION 'idempotency key % is changing too fast to claim', p_key
          USING ERRCODE = '40001';
      END IF;
      CONTINUE;
    END IF;
    IF existing.request_hash <> p_request_hash THEN
      outcome := 'mismatch';
    ELSIF existing.status = 'completed' THEN
      outcome := 'replay';
      stored_status := existing.response_status;
      stored_body := existing.response_body;
    ELSIF existing.locked_until > now() THEN
      outcome := 'in_progress';
    ELSE
      UPDATE public.idempotency_keys k
      SET locked_until = now() + make_interval(secs => p_lock_seconds)
      WHERE k.workspace_id = p_workspace_id AND k.key = p_key;
      outcome := 'started';
    END IF;
    RETURN NEXT;
    RETURN;
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION idempotency_complete(
  p_workspace_id uuid,
  p_key text,
  p_request_hash text,
  p_status integer,
  p_body text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  caller_role text;
BEGIN
  caller_role := public.app_workspace_role(p_workspace_id)::text;
  IF caller_role IS NULL OR caller_role NOT IN ('owner', 'admin', 'operator') THEN
    RAISE EXCEPTION 'only an operator of the workspace may use its idempotency keys'
      USING ERRCODE = '42501';
  END IF;
  UPDATE public.idempotency_keys k
  SET status = 'completed', response_status = p_status, response_body = p_body
  WHERE k.workspace_id = p_workspace_id
    AND k.key = p_key
    AND k.request_hash = p_request_hash
    AND k.status = 'in_progress';
  RETURN FOUND;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION idempotency_release(
  p_workspace_id uuid,
  p_key text,
  p_request_hash text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  caller_role text;
BEGIN
  caller_role := public.app_workspace_role(p_workspace_id)::text;
  IF caller_role IS NULL OR caller_role NOT IN ('owner', 'admin', 'operator') THEN
    RAISE EXCEPTION 'only an operator of the workspace may use its idempotency keys'
      USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.idempotency_keys k
  WHERE k.workspace_id = p_workspace_id
    AND k.key = p_key
    AND k.request_hash = p_request_hash
    AND k.status = 'in_progress';
  RETURN FOUND;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enqueue_webhook_deliveries(
  p_run_id uuid,
  p_event_type text,
  p_event_key text,
  p_data jsonb
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_workspace uuid;
  caller_role text;
  enqueued integer;
BEGIN
  SELECT r.workspace_id INTO target_workspace FROM public.runs r WHERE r.id = p_run_id;
  IF target_workspace IS NOT NULL THEN
    caller_role := public.app_workspace_role(target_workspace)::text;
  END IF;
  IF caller_role IS NULL OR caller_role NOT IN ('owner', 'admin', 'operator') THEN
    RAISE EXCEPTION 'only an operator of the run''s workspace may notify its webhook endpoints'
      USING ERRCODE = '42501';
  END IF;
  IF p_event_type NOT IN ('run.completed', 'run.failed', 'run.cancelled', 'approval.requested') THEN
    RAISE EXCEPTION 'unknown webhook event type %', p_event_type USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR octet_length(p_data::text) > 32768 THEN
    RAISE EXCEPTION 'webhook data must be a JSON object of at most 32 KB' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.webhook_deliveries d
  WHERE d.workspace_id = target_workspace
    AND d.status <> 'pending'
    AND d.created_at < now() - interval '30 days';
  INSERT INTO public.webhook_deliveries AS d
    (workspace_id, endpoint_id, run_id, event_type, event_key, data, next_attempt_at)
  SELECT target_workspace, e.id, p_run_id, p_event_type, p_event_key, p_data, now()
  FROM public.webhook_endpoints e
  WHERE e.workspace_id = target_workspace AND p_event_type = ANY (e.events)
  ON CONFLICT ON CONSTRAINT webhook_deliveries_endpoint_event_unique DO NOTHING;
  GET DIAGNOSTICS enqueued = ROW_COUNT;
  RETURN enqueued;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enqueue_webhook_test(p_endpoint_id uuid, p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_workspace uuid;
  caller_role text;
  created uuid;
BEGIN
  SELECT e.workspace_id INTO target_workspace
  FROM public.webhook_endpoints e WHERE e.id = p_endpoint_id;
  IF target_workspace IS NOT NULL THEN
    caller_role := public.app_workspace_role(target_workspace)::text;
  END IF;
  IF caller_role IS NULL OR caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'only an admin of the endpoint''s workspace may send it a test delivery'
      USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR octet_length(p_data::text) > 4096 THEN
    RAISE EXCEPTION 'webhook test data must be a JSON object of at most 4 KB'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.webhook_deliveries AS d
    (workspace_id, endpoint_id, event_type, event_key, data, next_attempt_at)
  VALUES (
    target_workspace,
    p_endpoint_id,
    'webhook.test',
    'test:' || gen_random_uuid()::text,
    p_data,
    now()
  )
  RETURNING d.id INTO created;
  RETURN created;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION claim_webhook_deliveries(
  p_workspace_id uuid,
  p_limit integer,
  p_lease_seconds integer,
  p_max_attempts integer,
  p_delivery_id uuid
)
RETURNS TABLE (
  delivery_id uuid,
  endpoint_id uuid,
  endpoint_url text,
  endpoint_origin text,
  secret_ciphertext text,
  event_type text,
  data jsonb,
  attempt integer,
  created_at timestamp with time zone
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  caller_role text;
BEGIN
  caller_role := public.app_workspace_role(p_workspace_id)::text;
  IF caller_role IS NULL OR caller_role NOT IN ('owner', 'admin', 'operator') THEN
    RAISE EXCEPTION 'only an operator of the workspace may deliver its webhooks'
      USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50
    OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 600
    OR p_max_attempts IS NULL OR p_max_attempts NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'webhook claim limit, lease or attempt cap is out of range'
      USING ERRCODE = '22023';
  END IF;
  UPDATE public.webhook_deliveries d
  SET status = 'failed', next_attempt_at = NULL, locked_until = NULL, last_error = 'abandoned'
  WHERE d.workspace_id = p_workspace_id
    AND d.status = 'pending'
    AND d.attempts >= p_max_attempts
    AND (d.locked_until IS NULL OR d.locked_until <= now());
  RETURN QUERY
  WITH due AS (
    SELECT d.id
    FROM public.webhook_deliveries d
    WHERE d.workspace_id = p_workspace_id
      AND d.status = 'pending'
      AND (d.locked_until IS NULL OR d.locked_until <= now())
      AND CASE
        WHEN p_delivery_id IS NULL THEN d.next_attempt_at <= now()
        ELSE d.id = p_delivery_id
      END
    ORDER BY d.next_attempt_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.webhook_deliveries d
    SET locked_until = now() + make_interval(secs => p_lease_seconds),
        attempts = d.attempts + 1,
        last_attempt_at = now()
    FROM due
    WHERE d.id = due.id
    RETURNING d.id AS claimed_id, d.endpoint_id AS claimed_endpoint, d.event_type AS claimed_type,
      d.data AS claimed_data, d.attempts AS claimed_attempts, d.created_at AS claimed_created
  )
  SELECT c.claimed_id, c.claimed_endpoint, e.url, e.origin, e.secret_ciphertext, c.claimed_type,
    c.claimed_data, c.claimed_attempts, c.claimed_created
  FROM claimed c
  JOIN public.webhook_endpoints e ON e.id = c.claimed_endpoint
  ORDER BY c.claimed_created;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION settle_webhook_delivery(
  p_delivery_id uuid,
  p_attempt integer,
  p_outcome text,
  p_status_code integer,
  p_error text,
  p_excerpt text,
  p_next_attempt_at timestamp with time zone
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target public.webhook_deliveries%ROWTYPE;
  caller_role text;
BEGIN
  SELECT * INTO target FROM public.webhook_deliveries d WHERE d.id = p_delivery_id FOR UPDATE;
  IF FOUND THEN
    caller_role := public.app_workspace_role(target.workspace_id)::text;
  END IF;
  IF caller_role IS NULL OR caller_role NOT IN ('owner', 'admin', 'operator') THEN
    RAISE EXCEPTION 'only an operator of the workspace may record its webhook deliveries'
      USING ERRCODE = '42501';
  END IF;
  IF p_outcome NOT IN ('delivered', 'retry', 'failed') THEN
    RAISE EXCEPTION 'unknown webhook delivery outcome %', p_outcome USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'retry' AND (p_next_attempt_at IS NULL OR p_next_attempt_at <= now()) THEN
    RAISE EXCEPTION 'a retry needs a next attempt time in the future' USING ERRCODE = '22023';
  END IF;
  IF target.status <> 'pending' OR target.attempts <> p_attempt THEN
    RETURN false;
  END IF;
  UPDATE public.webhook_deliveries d
  SET status = CASE p_outcome WHEN 'retry' THEN 'pending' ELSE p_outcome END,
      delivered_at = CASE p_outcome WHEN 'delivered' THEN now() ELSE NULL END,
      next_attempt_at = CASE p_outcome WHEN 'retry' THEN p_next_attempt_at ELSE NULL END,
      locked_until = NULL,
      last_status_code = p_status_code,
      last_error = CASE p_outcome WHEN 'delivered' THEN NULL ELSE left(p_error, 60) END,
      last_response_excerpt = left(p_excerpt, 200)
  WHERE d.id = p_delivery_id;
  RETURN true;
END
$$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO delegate_definer;
--> statement-breakpoint
ALTER FUNCTION idempotency_begin(uuid, text, text, integer, integer) OWNER TO delegate_definer;
--> statement-breakpoint
ALTER FUNCTION idempotency_complete(uuid, text, text, integer, text) OWNER TO delegate_definer;
--> statement-breakpoint
ALTER FUNCTION idempotency_release(uuid, text, text) OWNER TO delegate_definer;
--> statement-breakpoint
ALTER FUNCTION enqueue_webhook_deliveries(uuid, text, text, jsonb) OWNER TO delegate_definer;
--> statement-breakpoint
ALTER FUNCTION enqueue_webhook_test(uuid, jsonb) OWNER TO delegate_definer;
--> statement-breakpoint
ALTER FUNCTION claim_webhook_deliveries(uuid, integer, integer, integer, uuid) OWNER TO delegate_definer;
--> statement-breakpoint
ALTER FUNCTION settle_webhook_delivery(uuid, integer, text, integer, text, text, timestamp with time zone) OWNER TO delegate_definer;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM delegate_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  idempotency_begin(uuid, text, text, integer, integer),
  idempotency_complete(uuid, text, text, integer, text),
  idempotency_release(uuid, text, text),
  enqueue_webhook_deliveries(uuid, text, text, jsonb),
  enqueue_webhook_test(uuid, jsonb),
  claim_webhook_deliveries(uuid, integer, integer, integer, uuid),
  settle_webhook_delivery(uuid, integer, text, integer, text, text, timestamp with time zone)
FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  idempotency_begin(uuid, text, text, integer, integer),
  idempotency_complete(uuid, text, text, integer, text),
  idempotency_release(uuid, text, text),
  enqueue_webhook_deliveries(uuid, text, text, jsonb),
  enqueue_webhook_test(uuid, jsonb),
  claim_webhook_deliveries(uuid, integer, integer, integer, uuid),
  settle_webhook_delivery(uuid, integer, text, integer, text, text, timestamp with time zone)
TO delegate_app;
