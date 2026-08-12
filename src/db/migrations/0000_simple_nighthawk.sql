CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION jsonb_stringify_values(data jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(jsonb_object_agg(key, to_jsonb(value)), '{}'::jsonb)
  FROM jsonb_each_text(data) AS t(key, value);
$$;
--> statement-breakpoint
CREATE TABLE "logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"level" varchar(10) NOT NULL,
	"service" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attributes_search" jsonb GENERATED ALWAYS AS (jsonb_stringify_values(attributes)) STORED
);
--> statement-breakpoint
CREATE INDEX "idx_logs_timestamp_id" ON "logs" USING btree ("timestamp" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "idx_logs_service_timestamp" ON "logs" USING btree ("service","timestamp");
--> statement-breakpoint
CREATE INDEX "idx_logs_level_timestamp" ON "logs" USING btree ("level","timestamp");
--> statement-breakpoint
CREATE INDEX "idx_logs_attributes_search_gin" ON "logs" USING gin ("attributes_search" jsonb_path_ops);