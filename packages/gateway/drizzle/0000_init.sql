-- Switchyard initial schema.
-- Hand-edited after `drizzle-kit generate`:
--   * no "public". qualifiers: objects are created in the first schema of search_path
--     (the tests run every file in its own schema);
--   * usage_events is RANGE-partitioned by month (drizzle-kit has no syntax for it);
--   * sy_ensure_usage_partition() creates monthly partitions (used here and by the worker).
CREATE TYPE "budget_action" AS ENUM('block', 'alert');--> statement-breakpoint
CREATE TYPE "budget_period" AS ENUM('daily', 'monthly');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_prefix" varchar(12) NOT NULL,
	"key_hash" char(64) NOT NULL,
	"allowed_routes" text[],
	"rpm_limit" integer,
	"tpm_limit" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_from" uuid,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash"),
	CONSTRAINT "api_keys_rpm_positive" CHECK ("api_keys"."rpm_limit" IS NULL OR "api_keys"."rpm_limit" > 0),
	CONSTRAINT "api_keys_tpm_positive" CHECK ("api_keys"."tpm_limit" IS NULL OR "api_keys"."tpm_limit" > 0)
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"period" "budget_period" NOT NULL,
	"limit_usd" numeric(14, 6) NOT NULL,
	"soft_threshold" numeric(4, 3) DEFAULT 0.8 NOT NULL,
	"action" "budget_action" DEFAULT 'block' NOT NULL,
	"webhook_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_team_period_uq" UNIQUE("team_id","period"),
	CONSTRAINT "budgets_limit_nonneg" CHECK ("budgets"."limit_usd" >= 0),
	CONSTRAINT "budgets_soft_range" CHECK ("budgets"."soft_threshold" > 0 AND "budgets"."soft_threshold" <= 1)
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rpm_limit" integer,
	"tpm_limit" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "teams_slug_unique" UNIQUE("slug"),
	CONSTRAINT "teams_slug_format" CHECK ("teams"."slug" ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
	CONSTRAINT "teams_rpm_positive" CHECK ("teams"."rpm_limit" IS NULL OR "teams"."rpm_limit" > 0),
	CONSTRAINT "teams_tpm_positive" CHECK ("teams"."tpm_limit" IS NULL OR "teams"."tpm_limit" > 0)
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"day" date NOT NULL,
	"team" text NOT NULL,
	"route" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"requests" bigint DEFAULT 0 NOT NULL,
	"errors" bigint DEFAULT 0 NOT NULL,
	"cache_hits" bigint DEFAULT 0 NOT NULL,
	"prompt_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_tokens" bigint DEFAULT 0 NOT NULL,
	"completion_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric(20, 10) DEFAULT 0 NOT NULL,
	"saved_usd" numeric(20, 10) DEFAULT 0 NOT NULL,
	"latency_ms_sum" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_day_team_route_provider_model_pk" PRIMARY KEY("day","team","route","provider","model")
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"ts" timestamp with time zone NOT NULL,
	"request_id" text NOT NULL,
	"team_id" text NOT NULL,
	"team" text NOT NULL,
	"key_id" text NOT NULL,
	"route" text NOT NULL,
	"kind" text NOT NULL,
	"provider" text,
	"model" text,
	"status" smallint NOT NULL,
	"error_code" text,
	"cache" text NOT NULL,
	"stream" boolean NOT NULL,
	"prompt_tokens" integer NOT NULL,
	"cached_tokens" integer NOT NULL,
	"completion_tokens" integer NOT NULL,
	"reasoning_tokens" integer NOT NULL,
	"cost_usd" numeric(18, 10) NOT NULL,
	"saved_usd" numeric(18, 10) NOT NULL,
	"latency_ms" integer NOT NULL,
	"ttft_ms" integer,
	"attempts" smallint NOT NULL,
	"fallbacks" smallint NOT NULL,
	"end_user" text,
	"tags" text[] NOT NULL,
	CONSTRAINT "usage_events_ts_request_id_pk" PRIMARY KEY("ts","request_id")
) PARTITION BY RANGE ("ts");
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_team_idx" ON "api_keys" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "usage_daily_team_day_idx" ON "usage_daily" USING btree ("team","day");--> statement-breakpoint
CREATE INDEX "usage_events_team_ts_idx" ON "usage_events" USING btree ("team","ts");--> statement-breakpoint
CREATE INDEX "usage_events_key_ts_idx" ON "usage_events" USING btree ("key_id","ts");--> statement-breakpoint
CREATE OR REPLACE FUNCTION sy_ensure_usage_partition(p_month date) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_from date := date_trunc('month', p_month)::date;
  v_to   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name text := format('usage_events_y%sm%s', to_char(v_from, 'YYYY'), to_char(v_from, 'MM'));
BEGIN
  IF to_regclass(v_name) IS NULL THEN
    BEGIN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF usage_events FOR VALUES FROM (%L) TO (%L)',
        v_name, v_from::text || ' 00:00:00+00', v_to::text || ' 00:00:00+00');
    EXCEPTION WHEN duplicate_table THEN
      NULL; -- created concurrently by another worker
    END;
  END IF;
  RETURN v_name;
END;
$$;--> statement-breakpoint
DO $$
DECLARE i int;
BEGIN
  FOR i IN 0..2 LOOP
    PERFORM sy_ensure_usage_partition(((now() AT TIME ZONE 'UTC')::date + make_interval(months => i))::date);
  END LOOP;
END;
$$;
