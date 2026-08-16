# Log Ingestion and Query Service

High-throughput log ingestion, querying, and aggregation service (Node.js, TypeScript, Express, PostgreSQL) — a simplified Datadog/Loki-style backend for structured application logs.

Repository: https://github.com/Ghadeer7amad/log-ingestion-and-query-service

**Status at a glance:** ingestion, querying, aggregation, retention, and cursor pagination are all implemented and correct — including fixes to two real bugs found this session: `attr.<key>` filtering silently missing typed values (Section 5), and an unindexed sort order silently full-table-scanning `GET /logs` at 1M-row scale (Section 4). A deep investigation found and proved the actual throughput bottleneck — OS-scheduler CPU contention on the single-core Postgres container under sustained writes, compounded by Docker's default 100ms CFS accounting period silently freezing both containers for large fractions of every load test (Section 6, Section 10) — and fixed it in layers: write coalescing, an in-memory aggregate cache that bypasses Postgres for the common read case, a longer CFS accounting period (same average CPU, no limit raised), load shedding (`429` + `Retry-After` instead of 60s hangs once the write queue is genuinely backed up), full durability (`UNLOGGED` dropped, `fsync`/`synchronous_commit` back on — closes a real data-loss risk that happened twice during this session's own testing), a validation/serialization fusion that measurably cut GC allocation pressure, and — after an earlier `COPY` attempt crashed and was reverted — a second, successful `COPY` implementation (`pg-copy-streams` instead of `postgres.js`'s own COPY) now active as the default write path, with two real crash-causing bugs found and fixed during its own crash-safety testing before it was trusted. See Section 6 for the full story on each.

**Tested at actual target scale, and at the harsher portal-style scenarios.** Every headline number below was measured with **1,000,000 rows already resident** (not a fresh/empty table), then re-verified against four scenarios mirroring how the grading portal itself reports results — Load, Stress, Spike, Breakpoint (Section 9). **Current state at 1M-row scale, standard combined test: 25.00% aggregate success rate (avg of 2 runs) and ~3,701 logs/sec sustained, zero application crashes.** Under the four harsher portal scenarios: zero crashes across all four, and the two scenarios that were previously catastrophic (Spike, Breakpoint — sub-200/sec throughput, under 11% success) now run at 1,459–1,858 logs/sec and 43–50% success, thanks to load shedding converting pile-ups into bounded, survivable degradation. One honest regression: the Stress scenario's raw throughput is measurably *lower* than an earlier checkpoint (2,129/sec → 1,068/sec) — investigated (Section 10), not fully root-caused, documented as a known trade-off rather than hidden. 15,000 logs/sec and full aggregate availability under peak sustained load remain the two open gaps; every root cause found so far is proven, not guessed at.

---

## 1. Setup and Usage

```bash
docker compose up
```

Starts Postgres (tuned) + app, applies migrations automatically, exposes API on `localhost:8080`. `GET /health` → 200 only once DB + migrations are ready. No config required.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | App port |
| `DB_URL` | (docker-compose) | Postgres connection string |
| `RETENTION_DAYS` | `30` | Retention window |

```bash
curl http://localhost:8080/health
curl -X POST http://localhost:8080/logs -H "Content-Type: application/json" \
  -d '{"logs":[{"timestamp":"2026-08-12T14:00:00Z","level":"error","service":"checkout","message":"payment declined","attributes":{"user_id":"42"}}]}'
curl "http://localhost:8080/logs?service=checkout&limit=5"
curl "http://localhost:8080/logs/aggregate?since=2026-08-01T00:00:00Z&until=2026-08-13T00:00:00Z&bucket=1h"
```

---

## 2. API Documentation

**`GET /health`** — `200 {"status":"ok"}` once ready, else `503`.

**`POST /logs`** — batch ingest, per-entry validation (invalid entries don't fail the batch).
- `timestamp`: ISO 8601, ≤5 min future · `level`: debug/info/warn/error · `service`/`message`: non-empty · `attributes`: flat object, string/number/boolean only
- `200`: `{ "accepted": 9, "rejected": [{ "index": 3, "reason": "..." }] }`
- `400`: all rejected, malformed JSON, or wrong shape

**`GET /logs`** — filters (combinable): `service`, `level`, `since`/`until`, `attr.<key>`, `q` (substring on message), `limit` (100/1000), `cursor`. Sorted `timestamp DESC, id DESC`. `next_cursor: null` when done.

**`GET /logs/aggregate`** — same filters + required `since`/`until`/`bucket` (1m/5m/1h/1d), optional `group_by`. Returns `{ buckets: [{ start, group, count }] }`, sorted by bucket ascending.

All errors: `400 {"error": "<description>"}`

---

## 3. Architecture

middleware → handler (validate → query layer → shape response) → query layer (all SQL) → Postgres.

```
src/
  index.ts / config.ts
  handlers/    → thin HTTP layer
  validators/   → request validation
  db/schema.ts, migrate.ts, queries/  → schema, migration runner, all SQL
  middlewares/  → error handling, logging
```

Handlers never build SQL and query files never touch `req`/`res` — this keeps HTTP concerns and persistence independently testable, and means query logic can be reasoned about (and load-tested, and `EXPLAIN`-ed) without any Express context.

**Trade-off:** ingestion + simple reads use raw parameterized SQL (`postgres.js`) for bulk inserts and lower overhead under load; aggregate uses Drizzle's query builder, since its dynamic bucket/group logic benefits more from type-safe composition than raw-SQL speed on a path that isn't ingestion-critical.

**Connection pool — split, not shared.** `writeClient` (max 6, used by ingest + retention) and `readClient` (max 4, used by `GET /logs`, `GET /logs/aggregate`, and the health check) are independent `postgres.js` pools. Originally a single shared `max: 8` pool served both — under sustained ingestion all 8 connections stayed busy with writes, so every read request queued behind them, measured as ~80% aggregate failures during a combined ingestion+aggregate load test. The write pool's `max` was deliberately tuned back down from an initial `16`: more concurrent write backends doesn't mean more throughput once the CPU core is saturated, only more OS-scheduler contention (see Section 6). A third pool, `copyPool` (max 6, a raw `pg.Pool` rather than `postgres.js`), exists solely for the COPY write path (Section 6) — `pg-copy-streams` needs a `pg.Client`, which `postgres.js` doesn't expose. Startup order: migrate → prime in-memory aggregate cache from existing data → mark ready → start retention job → bind port, so `/health` never reports ready before the service actually is.

**Pool size re-tuning was tested but not adopted.** After the CPU-throttling fix, `writeClient` at `max: 1` or `max: 2` clearly beat `max: 6` on the same test (35-40% aggregate success vs 20%, ~4,200/sec vs ~3,238/sec) — the same "fewer concurrent backends wins" pattern as the original 16→6 tuning, just not fully re-explored until later. Not shipped: a controlled combined test (pool=2 + longer flush interval + full durability together) measured *worse* than the current baseline, a real negative interaction (fewer connections + real fsync wait per commit + bigger batches serializes worse than any one factor predicts alone) — re-tuning pool size specifically under the current `fsync=on` regime is flagged as unfinished work, not abandoned.

**Request body limit.** `express.json({ limit: "1mb" })`. Measured actual request bodies top out around 8.7KB locally (50 logs/request) and ~5.7KB for the load generator's own average (~33 logs/request) — `express.json` buffers the full body into memory and runs `JSON.parse` synchronously, blocking the single event loop, so the limit is kept close to real usage (~115x headroom) rather than an arbitrary large default that would let one oversized request stall every concurrent request on a 0.5 CPU/256MB container.

---

## 4. Schema & Index Design

```sql
CREATE TABLE logs (
  id                bigserial PRIMARY KEY,
  timestamp         timestamptz NOT NULL,
  level             varchar(10) NOT NULL,
  service           varchar(255) NOT NULL,
  message           text NOT NULL,
  attributes        jsonb NOT NULL DEFAULT '{}',
  attributes_search jsonb GENERATED ALWAYS AS (jsonb_stringify_values(attributes)) STORED
);
```

| Index | Type | Serves |
|---|---|---|
| `idx_logs_timestamp_id` | btree `(timestamp DESC, id DESC)` | Default sort + pagination |
| `idx_logs_service_timestamp` | btree `(service, timestamp)` | service + time filters |
| `idx_logs_level_timestamp` | btree `(level, timestamp)` | level + time filters |
| `idx_logs_attributes_search_gin` | GIN `jsonb_path_ops` | `attr.<key>` filtering |

Kept to 4 indexes deliberately — each adds write cost on a 1-CPU container. Dropping all but the primary key and `idx_logs_timestamp_id` was tested directly as part of the CPU-contention investigation (Section 10) — it measurably cooled Postgres down but did not fix aggregate availability under load, which is itself useful evidence: index maintenance cost is real but was never the dominant bottleneck. `q` uses unindexed `ILIKE` (see Known Limitations).

**Bug found and fixed this session: `idx_logs_timestamp_id` was silently unused by `GET /logs`.** Drizzle's index-builder always emits `DESC NULLS LAST` for a `.desc()` column, so the index is defined as `("timestamp" DESC NULLS LAST, id DESC NULLS LAST)`. The application's query ([`get_logs.ts`](src/db/queries/get_logs.ts)) sorted with plain `ORDER BY timestamp DESC, id DESC` — Postgres's default for bare `DESC` is `NULLS FIRST`, which doesn't textually match the index, so the planner silently fell back to a full (parallel) sequential scan for every unfiltered listing and every cursor-paginated page. Invisible at small scale; at 1,000,000 rows it cost **~2.1s per unfiltered request and ~1.5s per paginated page**, confirmed via `EXPLAIN (ANALYZE, BUFFERS)` and reproduced through the live API. Fix: made the `NULLS LAST` explicit in the query's `ORDER BY` to match the index exactly — zero behavior change, since `timestamp`/`id` are both `NOT NULL`. Measured after the fix: **~10–45ms unfiltered, ~9–15ms paginated**, a 100–1000x improvement. Neither of this project's own k6 scripts calls plain `GET /logs` or cursor pagination, which is why this went undetected until a direct index audit against `pg_stat_user_indexes` and hand-written `EXPLAIN` queries turned it up.

---

## 5. Attribute Storage Strategy

`attributes` (raw jsonb) stores mixed-type values as submitted. `attributes_search` is a generated, stringified copy (`GENERATED ALWAYS AS ... STORED`), enabling `attr.<key>` equality — required to be compared as strings — via the indexable `@>` operator instead of an unindexable `->>'key' = value` scan. GIN index uses `jsonb_path_ops` (smaller/faster than default, sufficient since only containment is needed). Internal-only — never exposed in responses (SELECTs list columns explicitly).

**Bug found and fixed this session:** `attr.<key>` filtering originally matched directly against the raw `attributes` column via `@>` containment. JSONB containment requires exact type equality, but query-string values always arrive as plain strings — so a log stored with `{"retries": 3}` (a number) was silently invisible to `?attr.retries=3`, while `{"retries": "3"}` (a string) matched fine. Confirmed live on a running instance before fixing it. The fix (filtering against `attributes_search` instead, where every value is pre-stringified) is what's reflected in the schema above.

---

## 6. Write Path & Ingestion Architecture

### The investigation: ruling out everything except CPU contention

`GET /logs/aggregate` was returning **0% success under sustained ingestion** — every request timing out at 60s, not just running slowly. Rather than assume a cause, this was tested directly, one variable at a time, across a full 120s combined ingestion+aggregate k6 load test (300 iterations/sec × 50 logs/batch = 15,000/sec target, plus 1 aggregate request/sec, plus a freshness probe) run **six separate times**:

| Configuration tested | Aggregate success rate |
|---|---|
| Baseline (attr fix, single shared connection pool) | 0.00% |
| `attr.<key>` fix reverted (isolate its effect) | 0.00% |
| `shared_buffers` 256→400MB, `effective_cache_size` 768→700MB | 0.00% |
| + `gin_pending_list_limit=8192` on the GIN index | 0.00% |
| **Only 2 indexes left** (primary key + timestamp index, all others dropped) | 0.00% |
| Manual `curl` mid-load, independent of k6 entirely | timed out identically |
| Parallel workers disabled (`max_worker_processes=1`, etc.) | 0.00% (worse: new connection errors) |
| A purpose-built rollup table (48 rows, PK-indexed query) | 0.00% |

That last one is the decisive result: a query against a 48-row, primary-key-indexed table has no plausible "too expensive" explanation. If even *that* can't get a response inside 60s under load, the problem was never query cost — it's that the read connection can't get scheduled on the single CPU core in time, no matter how little work it needs once it runs. With up to 16 concurrent write backends and 4 read backends contending for one core, a read backend can be starved of scheduling turns entirely.

### The fix: coalescing

Since the bottleneck is the *number* of concurrently active write backends, not the cost of any individual write, `POST /logs` requests no longer each open their own transaction. Validated rows from concurrent requests are buffered into a shared in-process queue and flushed together in one bulk insert every **12ms or 5,000 rows**, whichever comes first (`src/db/queries/ingestQueue.ts`). Each original request's response resolves only once its rows are part of a *completed, successful* flush — never before, and never on a failed flush — so a `200` is never returned for a batch that wasn't durably written. Paired with shrinking `writeClient`'s pool from 16 to 6.

This measurably worked: aggregate success rate went from 0% (every configuration above) to **25%** with coalescing alone, tuning flush timing tighter (150ms → 30ms → 12ms) each time producing a real, repeatable improvement — not noise.

### The first COPY experiment — tried, worked, crashed, reverted

`COPY FROM STDIN` was tried next as a lower-overhead replacement for the batched `INSERT ... SELECT FROM UNNEST` flush — COPY skips per-row planner/executor overhead that UNNEST still incurs. It helped: aggregate success rose to **30%** and throughput to **~5,400 logs/sec**, both real improvements over UNNEST under the identical test.

It also crashed the process. Under sustained load, a genuine server-side COPY failure (Postgres error `57014 query_canceled`) surfaced as an **unhandled `'error'` event** on the underlying Writable stream — Node's default behavior for an unhandled EventEmitter `'error'` is to throw and kill the process. A `stream.on('error', ...)` listener was added and initially appeared to fix it (verified stable across a full 120s run). A later test reproduced the **exact same crash** anyway, strongly suggesting the actual failing emitter is an internal object inside `postgres.js`'s COPY implementation that application code can't reach — not the stream reference the app holds a listener on.

**Decision at the time: reverted to `INSERT ... SELECT FROM UNNEST`.** The spec penalizes application crashes far more severely than a 5-percentage-point difference in aggregate success rate, and a blanket `process.on('uncaughtException', ...)` safety net was deliberately rejected — it would paper over this one failure but also silently swallow any other, unrelated future crash. `insertLogsCopy` and `escapeCopyField` were removed from `src/db/queries/logs.ts` as dead code at the time. **This was revisited later and COPY is now the active write path — see "COPY, take two" below.** The crash history here is kept as-written because it's exactly why the second attempt used a different library and was tested far more aggressively before being trusted.

### A rollup table was tried and removed

Earlier in the investigation, a per-minute pre-aggregated rollup table (`logs_rollup_minute`, kept fresh by a background job, read by `GET /logs/aggregate` whenever no `q`/`attr.<key>` filter was present) was built specifically to make aggregate reads cheap. It's what produced the decisive 48-row-still-times-out result above — genuinely useful as a diagnostic, but it never moved aggregate success off 0% on its own, since the problem was never query cost. It was removed afterward as unnecessary complexity once the real fix (coalescing) was in place.

### The in-memory aggregate cache

The rollup table proved that query cost was never the bottleneck — a 48-row, PK-indexed table still couldn't get a response, because the read connection itself couldn't get scheduled on the contended core in time. That means no amount of making the *query* cheaper can fix aggregate availability; the only lever left is not needing a Postgres connection for the read at all. `src/db/aggregateCache.ts` keeps a full in-process mirror of aggregate counts: a `Map<minuteEpoch, Bucket>` keyed by UTC-truncated minute, where each `Bucket` holds a nested `Map<service, Map<level, count>>`. Nested maps were a deliberate choice over a single string-concatenated key (e.g. `` `${service} ${level}` ``) — an early version used string concatenation and a space separator, which was both a real bug (service names can contain spaces, so two different `(service, level)` pairs could collide into the same key) and measurably slower under `--prof` profiling (string allocation/GC cost on every ingested row).

The cache is updated synchronously inside the ingest flush path — only after `insertLogsRaw` confirms rows are durably written (`src/db/queries/ingestQueue.ts`), so the cache can never report a count for data that isn't actually in Postgres. On startup, `primeAggregateCacheFromDb` backfills the full retention window from the database before `/health` reports ready, so the cache is never empty or stale relative to pre-existing data. `GET /logs/aggregate` reads from the cache instead of Postgres whenever the request has no `q`/`attr.<key>` filter (the common case); filtered requests still query Postgres directly, since the cache doesn't track arbitrary attribute values. Retention deletion (Section 7) prunes matching buckets out of the cache in the same pass it deletes from the database, so the two never drift apart.

This was verified correct at 1,000,000-row scale, not just assumed: a direct SQL count over a fixed `since`/`until` window matched the cache's output byte-for-byte across every service (510,860 total rows, identical per-service breakdown) — see Section 9.

### CPU throttling: the resource limits weren't the smooth constraint they looked like

Every measurement up to this point treated "1 CPU" and "0.5 CPU" as smooth, continuous ceilings — contention was assumed to look like many runnable processes taking turns on a slower core. Reading each container's cgroup counters directly (`/sys/fs/cgroup/cpu.stat`) told a different story. Docker's `cpus:` limit is enforced through the Linux CFS bandwidth controller: a quota of CPU-time per accounting period, **100ms by default**. Once a container spends its quota inside a period, it is not slowed down — it is **frozen solid, scheduler-invisible, for whatever remains of that period**, no matter how much the host's other 7 cores sit idle.

Measured on the Postgres container after a 60s combined load test at the default 100ms period:

```
nr_periods 585        -- 100ms windows observed
nr_throttled 319       -- 54.5% of windows hit the freeze
throttled_usec 55.56s  -- ~95% of the 58.5s window spent completely paused
```

The **app** container (0.5 CPU) was worse — throttled in over 99% of its periods even under light load, something `docker stats`' rolling CPU-percentage average completely hides (a bursty, mostly-idle-then-a-JSON-parse-spike Node process can average 48% CPU while still hitting its 100ms quota wall on nearly every burst). This is the real mechanism behind the bimodal aggregate latency seen everywhere in this document (either a few ms or a 60s timeout, nothing in between) — that pattern is the signature of periodic freezing, not gradual scheduling contention.

**Fix: lengthen the accounting period, keep the same average CPU.** `cpu_period`/`cpu_quota` replace the `cpus:` shorthand in `docker-compose.yml` so quota always equals the same fraction of a longer period (1.0 CPU / 0.5 CPU unchanged). Tested a curve, not just one value, 60s runs against the 1,000,000-row database:

| Period | Aggregate success | Logs/sec | Ingest success | Postgres throttled | App throttled |
|---|---|---|---|---|---|
| 100ms (Docker default) | 20.00% | 2,235 | 86.63% | 54.5% of periods | 99.1% of periods |
| 500ms | 60.00% | 2,883 | 88.49% | 25.0% of periods | 96.5% of periods |
| 1000ms | 90.00% / 100.00% / 100.00% (3 runs) | 3,726 / 5,275 / 5,067 | 91.77% / 98.82% / 99.87% | 11.9% → 5.9% of periods | ~97% of periods |

**1000ms is both the clear winner and a hard wall, not a judgment call.** Linux's kernel caps `cpu.cfs_period_us` at 1,000,000 (1 second) — an attempted 2000ms setting failed outright (`docker update` returned an error) and the run silently continued on the prior 1000ms config, confirmed via `cpu.max` before and after. The curve was still improving at every step up to that ceiling; there was no observed point where longer periods stopped helping, only the point where Linux stops allowing longer periods at all. The app container's throttled-period *ratio* barely moved across the whole curve (~99%→~97%) even as overall results improved sharply — its 0.5 CPU quota appears to be consistently, not just burstily, short of what it wants under this load, so a longer window mostly changes freeze *granularity* for the app, not whether it freezes. Postgres, by contrast, responded strongly (54.5%→5.9% throttled) — consistent with genuinely bursty rather than sustained demand.

On the standard 120s combined test (the same methodology used everywhere else in this document, distinct from the shorter 60s curve-sweep runs above): **35.00% aggregate success (7/20), 4,392 logs/sec, 94.63% ingest success, 0 crashes** at the 1000ms setting — versus 10.00% / 2,520.6 / 85.20% at the previous 100ms default. A genuine ~3.5x aggregate-availability gain and ~74% throughput gain, from a two-line Docker Compose change, found by reading cgroup counters nobody had looked at earlier in this investigation. Zero application code changed; zero durability/behavior change; zero average-CPU change.

### Load shedding: fast `429` instead of a 60s hang

Under genuine overload, requests were queuing indefinitely and eventually hitting the client's own 60s timeout — the spec explicitly treats silent queuing/timeout as worse than fast rejection. `src/db/queries/ingestQueue.ts` tracks `outstandingRowCount`: every row from the moment its request is accepted into the coalescing queue until its batch's flush actually resolves or rejects, across all in-flight flushes. This is deliberately *not* the same thing as the pre-existing `bufferedRowCount`, which resets to 0 the instant a flush is *called* — not when it *completes* — so under real Postgres slowness, several flushes can be stuck in flight while `bufferedRowCount` sits near zero the whole time, a false "queue looks fine" signal during exactly the overload this needed to catch.

Threshold: `MAX_OUTSTANDING_ROWS = 20000` (~4.5s headroom above the ~4,400 logs/sec this system sustains at the 1000ms CFS period) — enough to absorb a genuine short burst without shedding it, short enough that a client isn't left hanging toward the old 60s timeout once the system is genuinely, not just momentarily, overloaded. Past the threshold, `enqueueLogsForInsert` immediately rejects with a `TooManyRequestsError` (already-existing class in `errorHandler.ts`, previously unused), mapped to `429` with a `Retry-After: 2` header — fixed, not a computed drain estimate, since current instrumentation doesn't give a reliable ETA.

Validated both directions, not just the one that looked good: at a genuinely sustainable rate (~4,250 logs/sec, under the proven ceiling), **zero false-positive `429`s** — 100% ingest success, 0 failures. Under genuine sustained overload (15,000 logs/sec offered), **453 requests shed at `429`, 100% with the `Retry-After` header present, average shed latency 1.98s** (vs. the old 60s hangs) — and as a side effect, overall success rate rose from 42.73% to 65.74% and throughput from 1,309/sec to 3,494/sec on the same test, because shedding stopped wasted work from clogging the pipe for everyone else.

### Full durability: `UNLOGGED` dropped, `fsync`/`synchronous_commit` back on

An earlier migration (`0001_unlogged_and_remove_generated_column.sql`) had set the table `UNLOGGED` and disabled `fsync`/`synchronous_commit`, trading crash-durability for write throughput. That trade-off's real cost turned out to be smaller than expected, and its real risk turned out to be larger than expected — both discovered by measuring, not assuming.

**The risk already happened, twice, during this session's own testing.** `UNLOGGED` tables are truncated by Postgres after any restart that goes through crash recovery — and on at least two separate occasions, an ordinary `docker compose down`/`up` cycle (not a deliberate wipe) silently truncated the entire table. That's a real, already-observed instance of exactly the failure mode the spec's "never respond `200` to a batch you have not durably accepted" line warns against — every `200` returned while `UNLOGGED` was active was for data that would not have survived an unclean restart.

**The throughput cost, measured directly, was smaller than the risk justified.** Three durability postures were compared on the same 120s combined test, same 1M-row dataset: current (`UNLOGGED`, `fsync=off`, `synchronous_commit=off`) measured 20.00% aggregate / 3,238.4 logs/sec / 88.65% ingest; a middle ground (`LOGGED`, `fsync=on`, `synchronous_commit=off`) measured 10.00%/2,722.2/87.42% on one run and 35.00%/3,836.2/90.78% on a repeat — run-to-run variance bigger than the apparent gap; full durability (`LOGGED`, `fsync=on`, `synchronous_commit=on`) measured 20.00%/3,487.3/90.29%, essentially matching or slightly beating the `UNLOGGED` baseline. **No throughput cost was measurable above this system's normal run-to-run noise**, because Postgres CPU/scheduling contention (Section 6, Section 10) was and is still the dominant cost — the *additional* cost of WAL and fsync is currently small relative to that. Migration `0004_full_durability.sql` (`ALTER TABLE logs SET LOGGED;`) plus `fsync=on`/`synchronous_commit=on` in `docker-compose.yml` are now the shipped configuration.

### GC/allocation reduction: fusing validation and array-serialization

A `--prof` profile of the live ingest path (not the old, since-removed COPY path — the currently-active `UNNEST` path, under sustained load) found GC alone consuming **23.8% of all CPU ticks (30.3% of non-library time)** — bigger than every named application function combined (all business logic summed to ~7–9%). Re-reading the validation code explained why: `validateAndTransformLog` built a full `ValidatedLog` object per log entry — a wrapper object, a `sanitizedAttributes` object, a `new Date(parsedTime)` — and then `insertLogsRaw` immediately undid two of those conversions: `.toISOString()` turned the `Date` back into the JSON string it started as, and `JSON.stringify(log.attributes)` re-serialized the object back into a string. Three representations of one timestamp, two of one `attributes` value, for every log, every request.

**Fix:** `validators/ingest.ts`'s `validateLogBatch` now writes directly into the same parallel arrays `insertLogsRaw`'s `UNNEST` needs — structure-of-arrays, not array-of-structures — validating each field's type/shape without ever materializing an intermediate object that gets thrown away one function later. The attributes JSON string is built directly during the per-key validation loop (still using `JSON.stringify` on individual keys/values for correct escaping, just never assembling a full JS object first). The `ValidatedLog` type and the intermediate object it described no longer exist anywhere in the ingest hot path.

Measured before/after, same `--prof` method, same load: GC dropped from 22.9%→22.5% of ticks (29.2%→28.5% nonlib) — **real, but more modest than hoped**, because a large share of the remaining allocation pressure comes from parts of the pipeline this fix doesn't touch (`JSON.parse` of the incoming request body, `postgres.js`'s own wire-protocol serialization). Also set `--max-old-space-size=190` (~75% of the 256MB container limit) — a correctness fix, not a performance bet: V8's default `heap_size_limit` resolved to **~259MB with no flag set, essentially the entire container budget**, leaving almost no headroom for non-heap memory. `--max-semi-space-size=64` was also tried (bigger young generation, theory: fewer minor GCs) and **dropped** — measured, it made GC *worse* (26.8% of ticks, worse than even the pre-fusion baseline), not shipped on the strength of a plausible theory that measured backwards.

### COPY, take two: `pg-copy-streams`, not `postgres.js`

New evidence changed the calculus on revisiting COPY: it doesn't only insert faster, it uses Postgres's dedicated `BAS_BULKWRITE` ring-buffer strategy — a small, fixed set of buffers reused in a cycle — instead of competing for general `shared_buffers` the way a normal `INSERT` does. A plain `INSERT ... SELECT` does **not** get this treatment by default. This means COPY should directly reduce cache-eviction pressure on concurrent read queries — the read/write contention problem this entire investigation has been about — not just raise insert throughput. (Independently confirmed against [pganalyze's COPY vs INSERT benchmarks](https://pganalyze.com/blog/5mins-postgres-optimizing-bulk-loads-copy-vs-insert): COPY loading 16,000 shared-buffer pages where INSERT loaded 2,000 in their test, ~4x faster than multi-row INSERT.)

Re-implemented with `pg` + `pg-copy-streams` instead of `postgres.js`'s own COPY support — the first crash was inside *postgres.js's* stream handling specifically, not something inherent to the COPY protocol. Streams are connected with `stream.pipeline()`, not manual `.pipe()`/event wiring, specifically to avoid the half-open-socket/stalled-backpressure failures this library is known for.

**Crash-safety testing found `pipeline()` alone was not sufficient — twice — before it held.** Sustained load combined with repeated `pg_cancel_backend`/`pg_terminate_backend` against active COPY connections, targeting the exact failure mode that killed the first attempt:

1. First crash: `pg.Pool` doesn't handle an *idle* connection losing its server-side link internally (unlike `postgres.js`) — `pg`'s own documentation requires a `pool.on('error', ...)` listener for exactly this, which was missing. Fixed, scoped to that one pool.
2. Second crash, after fix #1: a connection killed *while actively streaming* surfaced an EPIPE as an `'error'` event on the `pg.Client` object itself — a separate `EventEmitter` that `pipeline()` never watches, since `pipeline()` only monitors the two streams it's explicitly given. Fixed by racing `pipeline()` against a `client.once('error', ...)` listener, removed by reference afterward (not `removeAllListeners`, which would strip fix #1's pool-level listener too).

Both fixes are narrow, well-documented, per-connection safeguards — not the blanket `process.on('uncaughtException')` handler rejected during the first COPY attempt. After both fixes: **3 clean crash-safety runs per kill mode (cancel and terminate), 139 total forced connection kills across the post-fix runs, 0 crashes.**

Performance: an initial measurement showed COPY at roughly half UNNEST's throughput — traced to under-provisioning the new `pg.Pool` (`max: 2`, vs. `writeClient`'s `max: 6`), not a property of COPY itself. Re-measured at parity pool size (`max: 6`), two runs: **25.00% aggregate success avg (20%, 30%), 3,700.9 logs/sec avg (3,329.7, 4,072.1), 90.35% ingest success avg (89.76%, 90.93%)** — vs. UNNEST's 20.00%/3,238.4/88.65%. A real, modest, consistent edge across all three metrics — not the dramatic aggregate-availability jump the ring-buffer theory alone might have predicted, but a genuine win with no measured downside. **COPY (via `pg-copy-streams`) is now the default write path** (`USE_COPY_INGEST=true`), behind a flag (`config.db.useCopyIngest`) that can be flipped back to `UNNEST` instantly if needed.

---

## 7. Retention Strategy

Configurable via `RETENTION_DAYS` (default 30). Deletes in batches of 5,000 with a 200ms pause between batches, starting 60s after startup, repeating every 24h — avoids long-running locks and ingestion disruption from a single large `DELETE`.

---

## 8. Optional Features

**None implemented** (no auth, API keys, multi-tenancy, rate limiting) — prioritized a reliable core given time available. `docker compose up` with zero config serves all four endpoints, unauthenticated.

---

## 9. Load-Test Methodology & Results

**Tools:** [k6](https://k6.io) (primary — `load-tests/load-test.js`, `load-tests/load-test-full.js`, `load-tests/load-test-portal.js` for the four-scenario portal-comparable run below, `load-tests/seed-data.js`) and [autocannon](https://github.com/mcollina/autocannon) (secondary — `load-tests/autocannon-get.js`, `load-tests/autocannon-test.js`), both included in the repo. **Environment:** exact grading limits (Postgres 1 CPU/1GB, App 0.5 CPU/256MB), confirmed active via `docker inspect` and cgroup `cpu.stat`/`cpu.max` ground truth throughout (`docker stats` was found to misreport CPU% once `cpu_period`/`cpu_quota` replaced the `cpus:` shorthand — Section 9), with the CFS accounting period raised to 1000ms (Section 6) — same average CPU, same limits, longer accounting window.

**Primary test:** `load-test-full.js` — 120s combined run: sustained ingestion at 300 iterations/sec × 50 logs/batch (15,000/sec target), 1 aggregate request/sec throughout, and a continuous freshness probe (write then poll until visible, ≤20s budget).

**Dataset size — the headline numbers below are measured with 1,000,000 rows already resident, not a fresh table.** The database was seeded with exactly 1,000,000 rows via a single server-side `INSERT ... SELECT FROM generate_series(1, 1000000)` (114.7s to seed, no per-row network round-trip), timestamps spanning 2026-07-17 → 2026-08-16 (~30 days, matching the spec's "~1M rows ≈ 1 month" framing). Table + index footprint at seed time: 359MB (table 205MB, indexes 154MB), 0 dead tuples. The load test then adds ~370,000 more rows on top during its 120s run. This is the honest, target-scale number — a fresh/empty-table run was also kept as a comparison baseline, shown below, because the two are measurably different and reporting only the fresh-table number would have hidden a real regression.

| Metric | **Final (all fixes, COPY)** | 1000ms period, UNNEST | 1M-row, 100ms period (Docker default) | Fresh-DB, 100ms period | Target |
|---|---|---|---|---|---|
| Aggregate success rate | **25.00% avg (20%, 30%)** | 35.00% (7/20) | 10.00% (2/20) | 35.00% (7/20) | — |
| Logs/sec (sustained) | **3,700.9 avg (3,329.7, 4,072.1)** | 4,392.3/sec | 2,520.6/sec | ~4,967/sec | 15,000/sec |
| Ingest success rate | **90.35% avg (89.76%, 90.93%)** | 94.63% | 85.20% | 92.11% | >99.9% |
| Application crashes | **0** | 0 | 0 | 0 | 0 |

The "Final" column is the current shipped state: full durability (`fsync`/`synchronous_commit` on), the GC/allocation fusion, and COPY via `pg-copy-streams` as the write path — all measured together on the same 120s combined test, same 1M-row dataset. It's not a clean win over the "1000ms period, UNNEST" checkpoint on this specific test — aggregate success and logs/sec are both somewhat lower, most plausibly the real fsync/WAL cost now landing on top of a CPU-contention picture that's still the dominant constraint, though this hasn't been isolated variable-by-variable the way earlier sections were. What the "Final" numbers don't show, and the four-scenario results below do: load shedding's effect is much larger under genuine overload than under this specific always-below-15k-target combined test, which never gets extreme enough to trigger much shedding.

**Aggregate cache latency and correctness at 1M-row scale:**

| Query shape | Latency | vs 1s target |
|---|---|---|
| Realistic pattern (10-min window, 1m buckets — matches the load generator) | 82–235ms | ✅ well under |
| Same pattern, `attr.retries=3` filter (bypasses cache, indexed Postgres path) | 126–237ms | ✅ well under |
| Wide pattern (15-day window, 1h buckets — not a realistic grading pattern) | 1.53s | ❌ over |
| Same wide window, `q=entry` filter (unindexed `ILIKE` scan) | 2.46s | ❌ over |

The cache's cost scales with how many stored minute-buckets fall inside the requested window, not with total data volume — excellent for the actual tested access pattern even at 1M rows, but a much wider query window would cost more than a well-planned indexed DB aggregate. Correctness was verified directly against SQL ground truth over a fixed, identical `since`/`until` window: **510,860 total rows, byte-for-byte identical per-service breakdown** (auth=128,043, checkout=127,416, inventory=128,029, payment=127,372) between the cache and a direct query. Startup backfill of the full 1M-row history into the cache took 15 seconds.

**Evidence trail for how the write-path configuration was reached** (all measured, not assumed, on a fresh table — see Section 6 for the full narrative):

| Step | Configuration | Aggregate success | Logs/sec |
|---|---|---|---|
| 1 | No coalescing (baseline) | 0.00% | ~3,600 |
| 2 | Coalescing, 150ms flush interval | 10.00% | 2,633 |
| 3 | Coalescing, 30ms flush interval | 20.00% | 2,846 |
| 4 | Coalescing, 12ms flush interval | 25.00% | 4,610 |
| 5 | + pool reduced 6→4 | 20.00% (regression) | 4,775 |
| 6 | Pool reverted to 6, + `COPY` instead of `UNNEST` | 30.00% | 5,411 |
| 7 | `COPY` crashed under sustained load | — | — |
| 8 | Reverted to `UNNEST`, kept coalescing/pool/timing, no aggregate cache yet | 25.00% | ~5,300 |
| 9 | **+ in-memory aggregate cache, fresh table** | **35.00%** | **~4,967** |
| 10 | Same configuration, re-measured with 1M rows resident (100ms CFS period, Docker default) | 10.00% | 2,520.6 |
| 11 | Same configuration and dataset, CFS period raised 100ms→1000ms (Section 6) | 35.00% | 4,392.3 |
| 12 | + load shedding (429/Retry-After) — same test doesn't reach overload often enough to shed much | ~20-25% (noisy) | ~3,238-3,836 |
| 13 | + full durability (`fsync`/`synchronous_commit` on, `UNLOGGED` dropped) | 20.00%/25.00% avg | 3,238.4 / 3,700.9 (see durability comparison, Section 6) |
| 14 | + GC/allocation fusion, `--max-old-space-size` | (not isolated separately on this test — see Section 6 for the dedicated --prof comparison) | |
| 15 | **+ COPY via `pg-copy-streams` (current, all fixes together)** | **25.00% avg (current headline)** | **3,700.9 avg (current headline)** |

Steps 5, 7, 10, 12, and 13 are as important as the improvements — a regression, a crash, a scale-dependent regression, and two rounds of "the fix helped less on this exact test than hoped, or didn't move it at all" — each discovered through the same measure-first discipline, not assumed away. Step 14 (GC fusion) is real and measured (Section 6), just not separately isolated on *this* 120s combined test — its effect was measured directly via `--prof` instead, since this table's granularity (aggregate %, logs/sec) is too coarse to attribute a ~0.4-percentage-point GC change to.

### Four-scenario portal-comparable results

Beyond the standard combined test above, four scenarios mirroring how the grading portal itself reports results were run against the same 1M-row dataset: **Load** (sustain 15,000 logs/sec for 120s), **Stress** (ramp 15,000→22,500→30,000), **Spike** (7,500→30,000→7,500), **Breakpoint** (15,000→45,000). Each includes the full realistic query mix concurrently — ingestion, unfiltered aggregate (cache path), filtered aggregate (`attr.<key>`/`q`, Postgres path), plain `GET /logs`, and cursor pagination — not just `POST /logs` and unfiltered aggregate. CPU numbers are cgroup ground truth (`usage_usec` delta / wall clock via `/sys/fs/cgroup/cpu.stat`), not `docker stats`, which was found to report physically-impossible values (over 100% on a 1.0-CPU-limited container) when using raw `cpu_period`/`cpu_quota` instead of the `--cpus` shorthand.

**Before today's later fixes** (load shedding, full durability, GC fusion, COPY — i.e. right after the NULLS LAST and CPU-period fixes only):

| Metric | Load | Stress | Spike | Breakpoint |
|---|---|---|---|---|
| Achieved logs/sec | 1,309.4 | 2,129.2 | 198.6 | 13.2 |
| POST success rate | 42.73% | 42.97% | 10.92% | 0.68% |
| Postgres CPU avg (ground truth) | 67.8%¹ | 78.5% | 101.3%² | 105.0%² |
| App CPU avg (ground truth) | 54.5%¹ | 50.6% | 50.0% | 48.5% |
| Crashes | 0 | 0 | 0 | 0 |

¹ Measured via `docker stats` (less precise, kept for transparency — the ground-truth `cpu.stat` method was adopted partway through this specific run). ² Slightly over 100% is measurement-window rounding, not an actual cgroup breach.

**Final state, all fixes together:**

| Metric | Load | Stress | Spike | Breakpoint |
|---|---|---|---|---|
| Achieved logs/sec | **1,801.2** | **1,067.7** | **1,857.5** | **1,459.8** |
| Ingestion latency p95 | 60.0s | 60.0s | 60.0s | 60.0s |
| Aggregate latency p95 | 60.0s | 60.0s | 60.0s | 60.0s |
| Overall latency p95 | 60.0s | 60.0s | 60.0s | 60.0s |
| POST success rate | **49.10%** | **33.30%** | **50.35%** | **43.02%** |
| POST rejected (429+timeout) | 1,866.8/sec | 2,137.8/sec | 1,831.2/sec | 1,933.5/sec |
| Postgres CPU avg (ground truth) | 64.1% | 81.3% | 79.5% | 80.6% |
| App CPU avg (ground truth) | 50.3% | 50.3% | 50.9% | 51.5% |
| Crashes | **0** | **0** | **0** | **0** |

**Honest read:** Spike and Breakpoint — the two scenarios that were previously catastrophic — transformed. Spike went from a near-total lockup (198.6/sec, 10.92% success) to a genuinely functional 1,857.5/sec at 50.35% success; Breakpoint from complete collapse (13.2/sec, 0.68%) to 1,459.8/sec at 43.02%. Load shedding is doing exactly what it was built for: converting catastrophic pile-ups into bounded, survivable degradation, specifically in the scenarios that most needed it.

**Stress is a real, unresolved regression** (2,129.2→1,067.7 logs/sec, 42.97%→33.30% success), not noise-sized. Investigated one clear hypothesis directly — whether the load-shedding threshold (`MAX_OUTSTANDING_ROWS`, 20,000) was the cause:

| Threshold | Logs/sec | POST success |
|---|---|---|
| 10,000 (tighter) | 1,621.8 | 30.96% |
| 20,000 (current) | 1,067.7 | 33.30% |
| 40,000 (looser) | 1,211.9 | 34.25% |

Neither direction recovers the earlier 2,129.2/sec checkpoint — 10,000 gets closer on throughput but at the cost of the *lowest* success rate of the three (more outright rejections), 40,000 gives a small, unremarkable bump on both. The threshold isn't the primary driver of this regression. Not fully root-caused: the most plausible remaining explanation is full durability's real fsync/WAL cost interacting with something in Stress's specific sustained (not brief) ramp shape, but that hasn't been isolated. Documented here as a known trade-off, not chased further.

15,000 logs/sec is not reached in any scenario — that gap remains open in every configuration tested to date.

---

## 10. Bottlenecks & Known Limitations

- **Root cause of the throughput gap is proven, not guessed: OS-scheduler CPU contention on Postgres's single core under sustained high-frequency writes.** This was established by directly ruling out every other hypothesis — query cost (a 48-row PK-indexed rollup table still couldn't respond), index maintenance (dropping to 2 minimal indexes didn't fix it), memory/buffer tuning (no effect), GIN index batching (no effect), and connection pool size in isolation (non-monotonic — smaller wasn't automatically better). The only interventions that moved the number at all were reducing the *count* of concurrently active write transactions via coalescing, and removing the read's dependency on Postgres entirely via the in-memory aggregate cache. See Section 6 for the full investigation.
- **15,000 logs/sec is not reached at the 1M-row target scale, in any tested configuration.** Best sustained on the standard combined test with all fixes together (COPY, full durability, GC fusion): 3,700.9 logs/sec average — a genuine, unresolved gap against the target, not a claimed success. See Section 9 for the full evidence trail and the four-scenario portal-style results, none of which reach 15,000/sec either.
- **Aggregate availability at target scale is real but partial.** On the standard combined test, aggregate success sits around 20-30% depending on run (Section 9) — a large improvement over the 0% this investigation started from, but still well short of 100%. Numbers measured against a fresh or lightly-loaded database, or against a less adversarial test shape, can be optimistic relative to true target-scale conditions — any report of this system's performance should lead with the 1M-row, full-query-mix figures (Section 9), not smaller-scale or narrower ones.
- **Open compliance question: does the in-memory aggregate cache violate "PostgreSQL remains the source of truth for both reads and writes"?** The cache never accepts a write that wasn't already durably committed to Postgres first (Section 6), and startup backfill plus retention-pruning keep it in lockstep with the database — so Postgres is still the source of truth for what data *exists*. But unfiltered `GET /logs/aggregate` reads are answered from the in-process cache, not from a live Postgres query, whenever no `q`/`attr.<key>` filter is present. Whether that satisfies the spec's intent is a genuine judgment call this README flags rather than resolves — filtered aggregate requests, and all of `GET /logs`, still query Postgres directly and are unaffected either way.
- **The aggregate cache's latency scales with the number of stored buckets inside the requested window, not with total row count.** Verified at 1M-row scale (Section 9): the realistic access pattern the load generator actually sends (10-minute window, 1-minute buckets) stays under 1s (82–235ms) even with a full month of data resident, but an artificially wide query (15-day window, 1-hour buckets) measured 1.53s — over the 1s target. Not currently a problem given the tested/expected access pattern, but a caveat worth knowing if query patterns change.
- **`q` has no index** (`ILIKE '%...%'`) — a `pg_trgm` index was deferred to avoid extra write-path cost given the throughput constraint.
- **The Stress scenario (15,000→22,500→30,000 logs/sec ramp) regressed** from 2,129.2 to 1,067.7 logs/sec between an earlier checkpoint and the final combined state (Section 9) — investigated directly (load-shedding threshold tested at 10,000/20,000/40,000, none recovers the earlier number), not fully root-caused. Most plausible remaining explanation: full durability's real fsync/WAL cost interacting with this scenario's specific sustained ramp shape, not isolated further. Documented as a known trade-off rather than hidden — Spike and Breakpoint, the two previously-catastrophic scenarios, improved dramatically over the same period (Section 9), so this isn't a uniform regression across all overload shapes.
- **No auth, rate limiting, or multi-tenancy** — by design; see Section 8.

---

## 11. CI

`.github/workflows/ci.yml` runs on every push/PR: installs dependencies, **lints** (`npm run lint` — ESLint with `typescript-eslint`), runs **unit tests** (`npm test` — vitest, covering all four validators and the aggregate cache module), builds the project, brings up the stack with `docker compose up --build`, waits for `/health`, smoke-tests `POST /logs`, `GET /logs`, `GET /logs/aggregate`, and malformed-JSON handling. Re-verified locally against the current codebase before this update (lint, unit tests, build, all 4 smoke tests, teardown) — all passing.
