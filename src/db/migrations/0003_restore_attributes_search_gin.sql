-- attr.<key> filters (get_logs.ts, aggregate_logs.ts) compare against a
-- value that always arrives as a plain string from the query string (e.g.
-- ?attr.retries=3). Filtering directly against `attributes` via `@>`
-- requires exact JSONB type equality, so it silently fails to match any
-- attribute stored as a number or boolean (e.g. {"retries": 3}) -- only
-- string-valued attributes ever matched. Confirmed live: a log stored with
-- {"retries": 3} is invisible to GET /logs?attr.retries=3.
--
-- Restore the stringified generated column so every attribute value,
-- regardless of original type, is compared as text. jsonb_stringify_values()
-- was never dropped (migration 0001 only dropped the column and its index),
-- so it's reused as-is here.
ALTER TABLE logs ADD COLUMN attributes_search jsonb GENERATED ALWAYS AS (jsonb_stringify_values(attributes)) STORED;
--> statement-breakpoint
CREATE INDEX idx_logs_attributes_search_gin ON logs USING gin (attributes_search jsonb_path_ops);
--> statement-breakpoint
-- Superseded by idx_logs_attributes_search_gin above: read paths now filter
-- on attributes_search, so keeping this one too would just double the GIN
-- maintenance cost on every insert for no remaining benefit.
DROP INDEX IF EXISTS idx_logs_attributes_gin;
