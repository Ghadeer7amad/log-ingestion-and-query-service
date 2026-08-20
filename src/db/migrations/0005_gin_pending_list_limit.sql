-- Raises the GIN index's pending-list limit above the 4MB default.
-- fastupdate (on by default) batches new entries into a pending list for
-- fast writes, then does a synchronous flush into the main index once
-- that list fills -- a CPU/IO spike right at that moment. Given this
-- project's confirmed event-loop-starvation mechanism (see copyInsert.ts,
-- ingestQueue.ts), a bigger pending list means fewer, larger flushes
-- instead of frequent small ones -- untested against the real CLI yet.
ALTER INDEX idx_logs_attributes_search_gin SET (gin_pending_list_limit = 65536); -- 64MB, in KB
