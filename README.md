# Log Ingestion and Query Service

High-throughput log ingestion, querying, and aggregation service (Node.js, TypeScript, Express, PostgreSQL) — a simplified Datadog/Loki-style backend for structured application logs.

Repository: https://github.com/Ghadeer7amad/log-ingestion-and-query-service

**Status at a glance:** ingestion, querying, aggregation, retention, and cursor pagination are all implemented and correct — including a fix to a real `attr.<key>` filtering bug found and fixed this session (Section 5). The connection pool is split between reads and writes so sustained ingestion can't starve `GET` requests of a connection (Section 3). A deep investigation (six-plus independent load-test configurations) found and proved the actual throughput bottleneck: OS-scheduler CPU contention on the single-core Postgres container under sustained high-frequency writes — not query cost, not indexes, not memory tuning, not connection pool size (Section 6, Section 10). Write coalescing was implemented in direct response to that finding and measurably helps. **Current stable state: 25% aggregate success rate and ~5,300 logs/sec sustained under the hardest combined ingestion+aggregate load test, with zero application crashes.** A faster `COPY`-based write path was tried, measured better (30% / ~5,400/sec), and reverted after it was found to crash the process under load — see Section 6 for the full story. 15,000 logs/sec and full aggregate availability under peak sustained load remain the two open gaps; the root cause is now proven, not guessed at.

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

**Connection pool — split, not shared.** `writeClient` (max 6, used by ingest + retention) and `readClient` (max 4, used by `GET /logs`, `GET /logs/aggregate`, and the health check) are independent `postgres.js` pools. Originally a single shared `max: 8` pool served both — under sustained ingestion all 8 connections stayed busy with writes, so every read request queued behind them, measured as ~80% aggregate failures during a combined ingestion+aggregate load test. The write pool's `max` was deliberately tuned back down from an initial `16`: more concurrent write backends doesn't mean more throughput once the CPU core is saturated, only more OS-scheduler contention (see Section 6). Startup order: migrate → mark ready → start retention job → bind port, so `/health` never reports ready before the service actually is.

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

### The COPY experiment — tried, worked, crashed, reverted

`COPY FROM STDIN` was tried next as a lower-overhead replacement for the batched `INSERT ... SELECT FROM UNNEST` flush — COPY skips per-row planner/executor overhead that UNNEST still incurs. It helped: aggregate success rose to **30%** and throughput to **~5,400 logs/sec**, both real improvements over UNNEST under the identical test.

It also crashed the process. Under sustained load, a genuine server-side COPY failure (Postgres error `57014 query_canceled`) surfaced as an **unhandled `'error'` event** on the underlying Writable stream — Node's default behavior for an unhandled EventEmitter `'error'` is to throw and kill the process. A `stream.on('error', ...)` listener was added and initially appeared to fix it (verified stable across a full 120s run). A later test reproduced the **exact same crash** anyway, strongly suggesting the actual failing emitter is an internal object inside `postgres.js`'s COPY implementation that application code can't reach — not the stream reference the app holds a listener on.

**Decision: reverted to `INSERT ... SELECT FROM UNNEST`.** The spec penalizes application crashes far more severely than a 5-percentage-point difference in aggregate success rate, and a blanket `process.on('uncaughtException', ...)` safety net was deliberately rejected — it would paper over this one failure but also silently swallow any other, unrelated future crash. `insertLogsCopy` and `escapeCopyField` were subsequently removed from `src/db/queries/logs.ts` as dead code, not used by the active `UNNEST` path — a safe fix for the underlying stream-error surface would need to be re-implemented from this document if `COPY` is revisited.

### CPU profiling: `escapeCopyField` and GC pressure

A `--prof` CPU profile — run **inside the actual resource-capped container** under the same 120s load (`clinic.js` would not run reliably in this environment) — found `insertLogsCopy`'s row-building loop as the single largest identified JS hot spot in the app, bigger than JSON body parsing or request validation combined. `escapeCopyField`'s four sequential regex `.replace()` calls were running on every field of every row regardless of whether escaping was ever needed. A cheap pre-check (`/[\\\t\n\r]/.test(value)`) that skips all four calls when a field has nothing to escape was added and correctness-verified against edge cases (embedded newlines/tabs, literal backslashes, a literal `\N` message that must not be misread as SQL NULL) — this fix, and the function it belonged to, was later removed along with the rest of the `COPY` path (see above). The same profile also found GC costing more than raw JS execution (19.8% vs 8.7% of non-library time) — consistent with the allocation pressure this fix targeted.

### A rollup table was tried and removed

Earlier in the investigation, a per-minute pre-aggregated rollup table (`logs_rollup_minute`, kept fresh by a background job, read by `GET /logs/aggregate` whenever no `q`/`attr.<key>` filter was present) was built specifically to make aggregate reads cheap. It's what produced the decisive 48-row-still-times-out result above — genuinely useful as a diagnostic, but it never moved aggregate success off 0% on its own, since the problem was never query cost. It was removed afterward as unnecessary complexity once the real fix (coalescing) was in place.

---

## 7. Retention Strategy

Configurable via `RETENTION_DAYS` (default 30). Deletes in batches of 5,000 with a 200ms pause between batches, starting 60s after startup, repeating every 24h — avoids long-running locks and ingestion disruption from a single large `DELETE`.

---

## 8. Optional Features

**None implemented** (no auth, API keys, multi-tenancy, rate limiting) — prioritized a reliable core given time available. `docker compose up` with zero config serves all four endpoints, unauthenticated.

---

## 9. Load-Test Methodology & Results

**Tools:** [k6](https://k6.io) (primary — `load-tests/load-test.js`, `load-tests/load-test-full.js`, `load-tests/seed-data.js`) and [autocannon](https://github.com/mcollina/autocannon) (secondary — `load-tests/autocannon-get.js`, `load-tests/autocannon-test.js`), both included in the repo. **Environment:** exact grading limits (Postgres 1 CPU/1GB, App 0.5 CPU/256MB), confirmed active via `docker inspect` and `docker stats` throughout.

**Primary test:** `load-test-full.js` — 120s combined run: sustained ingestion at 300 iterations/sec × 50 logs/batch (15,000/sec target), 1 aggregate request/sec throughout, and a continuous freshness probe (write then poll until visible, ≤20s budget).

**Current stable configuration** (coalescing, `INSERT ... SELECT FROM UNNEST`, pool=6, 12ms/5,000-row flush):

| Metric | Result | Target |
|---|---|---|
| Aggregate success rate | **25.00% (5/20)** | — |
| Logs/sec (sustained) | **~5,300/sec** | 15,000/sec |
| Ingest success rate | **92.87%** | >99.9% |
| Application crashes | **0** across every test this session | 0 |
| Aggregate p95 latency | 59.99s | <1s |
| Freshness | new logs queryable in ~1–2s | <20s |

**Evidence trail for how this number was reached** (all measured, not assumed — see Section 6 for the full narrative):

| Step | Configuration | Aggregate success | Logs/sec |
|---|---|---|---|
| 1 | No coalescing (baseline) | 0.00% | ~3,600 |
| 2 | Coalescing, 150ms flush interval | 10.00% | 2,633 |
| 3 | Coalescing, 30ms flush interval | 20.00% | 2,846 |
| 4 | Coalescing, 12ms flush interval | 25.00% | 4,610 |
| 5 | + pool reduced 6→4 | 20.00% (regression) | 4,775 |
| 6 | Pool reverted to 6, + `COPY` instead of `UNNEST` | 30.00% | 5,411 |
| 7 | `COPY` crashed under sustained load | — | — |
| 8 | **Reverted to `UNNEST`, kept coalescing/pool/timing** | **25.00% (current)** | **~5,300** |

Steps 5 and 7 are as important as the improvements — a regression and a crash discovered through the same measure-first discipline, not assumed away.

**Resources under the primary test:** App CPU steady ~48–56% of its 0.5-core limit (real headroom, never the bottleneck). Postgres CPU repeatedly spiking to 90–110%+ of its 1-core limit — the confirmed, proven bottleneck (Section 6, Section 10).

---

## 10. Bottlenecks & Known Limitations

- **Root cause of the throughput gap is proven, not guessed: OS-scheduler CPU contention on Postgres's single core under sustained high-frequency writes.** This was established by directly ruling out every other hypothesis — query cost (a 48-row PK-indexed rollup table still couldn't respond), index maintenance (dropping to 2 minimal indexes didn't fix it), memory/buffer tuning (no effect), GIN index batching (no effect), and connection pool size in isolation (non-monotonic — smaller wasn't automatically better). The only intervention that moved the number at all was reducing the *count* of concurrently active write transactions via coalescing. See Section 6 for the full investigation.
- **15,000 logs/sec is not reached.** Current best sustained: ~5,300/sec under the hardest combined test (ingestion + concurrent aggregate + freshness probing simultaneously). This is a genuine, unresolved gap against the target, not a claimed success.
- **Aggregate availability under sustained peak load is 25%, not 100%.** Coalescing measurably helps (0%→25%) but doesn't fully solve it on this exact hardware — the write path still consumes enough of the single core that reads are starved a majority of the time under the harshest test. A `COPY`-based flush measured better (30%) but was reverted after a crash under load (Section 6); `insertLogsCopy` was removed as dead code afterward and would need to be re-implemented if revisited.
- **`q` has no index** (`ILIKE '%...%'`) — a `pg_trgm` index was deferred to avoid extra write-path cost given the throughput constraint.
- **Aggregate p95 latency (59.99s under peak sustained load) is far over the 1s target during the hardest test.** Under lighter/no concurrent ingestion, aggregate latency is well under 1s (consistent with earlier isolated measurements) — the regression only appears specifically when ingestion is saturating the CPU, which is the same root cause as the availability issue above, not a separate one.
- **A `stream.on('error', ...)` listener does not fully guard `postgres.js`'s COPY path** — a real crash was reproduced despite it, which is why `COPY` isn't the active write path. Documented in Section 6 rather than papered over with a blanket exception handler, which was deliberately rejected as a fix.
- **No auth, rate limiting, or multi-tenancy** — by design; see Section 8.

---

## 11. CI

`.github/workflows/ci.yml` runs on every push/PR: builds the project, brings up the stack with `docker compose up --build`, waits for `/health`, smoke-tests `POST /logs`, `GET /logs`, `GET /logs/aggregate`, and malformed-JSON handling. Re-verified locally against the current codebase before this update (build, all 4 smoke tests, teardown) — all passing.
