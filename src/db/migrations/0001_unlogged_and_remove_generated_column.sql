-- Make the table unlogged: skips WAL writes for massive insert throughput gains.
-- Trade-off: data is lost on an unclean Postgres crash. Acceptable for a logs
-- table with a retention policy that already discards data after 30 days.
ALTER TABLE logs SET UNLOGGED;
--> statement-breakpoint

-- Drop the GIN index and generated column used for attr.<key> filtering.
-- Both added meaningful CPU cost to every INSERT (function call + index
-- maintenance). Given the 15,000 logs/sec target and the 1-CPU Postgres
-- limit, prioritizing ingestion throughput over attr.<key> query speed.
DROP INDEX IF EXISTS idx_logs_attributes_search_gin;
--> statement-breakpoint
ALTER TABLE logs DROP COLUMN IF EXISTS attributes_search;