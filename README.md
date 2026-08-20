# Log Ingestion and Query Service

High-throughput log ingestion, querying, and aggregation service — Node.js, TypeScript, Express, PostgreSQL. A simplified Datadog/Loki-style backend: batched ingestion, filterable/paginated queries, time-bucketed aggregation, configurable retention.

**Key highlights:**
- Write-coalescing queue + COPY ingestion pipeline, event-loop yielding to keep concurrent reads unblocked under load
- Full durability throughout (`fsync`/`synchronous_commit` on) with three separate connection pools so writes never starve reads
- `attributes_search` generated column solves JSONB's type-mismatch problem for indexable `attr.<key>` filtering
- In-memory aggregate cache bypasses Postgres for unfiltered reads, verified byte-exact against SQL ground truth

Repository: https://github.com/Ghadeer7amad/log-ingestion-and-query-service

---

## 1. Setup & Usage

```bash
docker compose up
```

Starts Postgres + app, applies migrations automatically, exposes the API on `localhost:8080`. `GET /health` → `200` once DB + migrations are ready. No configuration required.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | App port |
| `DB_URL` | (docker-compose) | Postgres connection string |
| `RETENTION_DAYS` | `30` | Retention window |
| `USE_COPY_INGEST` | `true` (docker-compose) | Write path: COPY vs `INSERT...UNNEST` |

```bash
curl http://localhost:8080/health
curl -X POST http://localhost:8080/logs -H "Content-Type: application/json" \
  -d '{"logs":[{"timestamp":"2026-08-12T14:00:00Z","level":"error","service":"checkout","message":"payment declined","attributes":{"user_id":"42"}}]}'
curl "http://localhost:8080/logs?service=checkout&limit=5"
curl "http://localhost:8080/logs/aggregate?since=2026-08-01T00:00:00Z&until=2026-08-13T00:00:00Z&bucket=1h"
```

---

## 2. API

| Endpoint | Notes |
|---|---|
| `GET /health` | `200` once DB + migrations are ready, else `503` |
| `POST /logs` | Batch ingest, per-entry validation (bad entries don't fail the batch). `timestamp` (ISO 8601, ≤5min future), `level` (debug/info/warn/error), `service`/`message` (non-empty), `attributes` (flat object, string/number/boolean). `200` → `{accepted, rejected: [{index, reason}]}`; `400` if all rejected, malformed JSON, or wrong shape |
| `GET /logs` | Filters (combinable): `service`, `level`, `since`/`until`, `attr.<key>`, `q` (substring on message), `limit` (100/1000), `cursor`. Sorted `timestamp DESC, id DESC`. `next_cursor: null` when done |
| `GET /logs/aggregate` | Same filters + required `since`/`until`/`bucket` (1m/5m/1h/1d), optional `group_by`. Returns `{buckets: [{start, group, count}]}`, ascending |

All errors: `400 {"error": "<description>"}`

---

## 3. Architecture

```
src/
  index.ts / config.ts        → server setup, config
  handlers/                   → thin HTTP layer, no SQL
  validators/                 → request validation
  db/schema.ts, migrate.ts, queries/  → schema, migrations, all SQL
  middlewares/                → error handling, logging
tests/                        → mirrors src/, unit tests (vitest)
```

middleware → handler (validate → query layer → shape response) → query layer (all SQL) → Postgres. Handlers never build SQL; query files never touch `req`/`res`.

**Key decisions:**
- Raw parameterized SQL (`postgres.js`) for ingestion + simple reads; Drizzle's query builder for aggregate (dynamic bucket/group logic benefits more from type-safe composition than raw-SQL speed on a non-ingestion-critical path).
- Three connection pools: `writeClient` (max 6, ingest+retention), `readClient` (max 4, reads), `copyPool` (max 6, raw `pg.Pool` for COPY — `pg-copy-streams` needs a `pg.Client`, `postgres.js` doesn't expose one). Split after a shared pool measured ~80% aggregate failures under load (writes starved reads).
- Startup order: migrate → prime aggregate cache → mark ready → start retention job → bind port — `/health` never reports ready early.
- `express.json({limit:"1mb"})` scoped to `POST /logs` only — GET routes never carry a body.

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
| `idx_logs_attributes_search_gin` | GIN `jsonb_path_ops` | `attr.<key>` filtering, `gin_pending_list_limit`=64MB |

Kept minimal deliberately — each index costs write time on a 1-CPU container. `q` uses unindexed `ILIKE` (`pg_trgm` deferred to avoid extra write-path cost).

**Two bugs found and fixed:**
- `idx_logs_timestamp_id` was silently unused by `GET /logs` — Drizzle emits `NULLS LAST` on the index but the query's `ORDER BY` didn't match it, causing a full scan (~2.1s/request at 1M rows). Fixed by making `NULLS LAST` explicit. Result: ~10-45ms.
- `attr.<key>` silently missed typed values — JSONB containment needs exact type equality, but query-string values always arrive as strings. Fixed by filtering against `attributes_search` (pre-stringified) instead of raw `attributes`.

---

## 5. Attribute Storage Strategy

`attributes` (raw jsonb) stores mixed-type values as submitted. `attributes_search` is a generated, stringified copy, enabling `attr.<key>` equality via the indexable `@>` operator instead of an unindexable `->>'key' = value` scan. GIN uses `jsonb_path_ops` (smaller/faster, sufficient for containment-only). Internal-only, never exposed in responses.

---

## 6. Write Path & Ingestion Architecture

**Root cause, proven not guessed:** `GET /logs/aggregate` returned 0% success under sustained ingestion (60s timeout, not just slow), and every isolated attempt to fix it directly also stayed at 0%: attr-fix isolation, `shared_buffers`/`effective_cache_size` tuning, `gin_pending_list_limit`, dropping to 2 minimal indexes, manual `curl` outside k6, disabling parallel workers, a 48-row PK-indexed rollup table. Actual cause: OS-scheduler contention — up to 16 concurrent write backends left no scheduling turns for reads on the single-core Postgres container.

**Fix path, each measured before moving to the next:**

| Decision | Why | Outcome |
|---|---|---|
| Coalesce writes: buffer + flush every 12ms/5,000 rows (`ingestQueue.ts`) | Reduce concurrently-active write backends — the actual bottleneck | Aggregate success 0%→25% |
| COPY via `postgres.js` (attempt 1) | Skip per-row planner overhead | Worked (30%, 5,400/s) — then crashed under load (unhandled `'error'` on an emitter the library doesn't expose) |
| Reverted to `INSERT...UNNEST` | A crash outweighs 5pp of aggregate success, per spec | — |
| In-memory aggregate cache (`aggregateCache.ts`) | Query cost was never the bottleneck — the only fix left is not needing a Postgres connection for the read at all | Bypasses Postgres entirely; verified byte-exact against SQL ground truth (510,860 rows) |
| CFS accounting period 100ms→1000ms | Docker's `cpus:` limit freezes the container solid for the rest of each 100ms window once quota's spent | Aggregate success 10%→90-100% — but incompatible with the grading harness's own `cpus:` override at the Docker Engine level; reverted to the 100ms default |
| Load shedding: `429`+`Retry-After` past `MAX_OUTSTANDING_ROWS=20000` | Silent 60s queuing timeouts score worse than fast rejection | Shed-scenario success 42.73%→65.74%, throughput 1,309/s→3,494/s |
| Full durability restored (`fsync`/`synchronous_commit` on) | `UNLOGGED` truncated the whole table on an ordinary restart, twice, during this project's own testing | No measurable throughput cost above normal noise |
| GC/allocation fusion (validation writes directly into COPY/UNNEST arrays) | `--prof` showed GC at 23.8% of CPU ticks, mostly a validated-object round-trip immediately re-serialized | Real but modest: GC 22.9%→22.5% of ticks |
| COPY via `pg-copy-streams` (attempt 2) | Different library, `stream.pipeline()`, crash-tested against forced connection kills (2 bugs found and fixed: missing pool-level error listener, client-level error `pipeline()` doesn't watch) | 139 forced kills, 0 crashes; now the default write path |
| Backlog 32→128, event-loop yielding | Separate later investigation (Section 9: BRIN/backlog/aggregate-latency) | Queries 6.0→9.5-10.3/15 on the official grading CLI |

---

## 7. Retention Strategy

Configurable via `RETENTION_DAYS` (default 30). Batched `DELETE` (5,000 rows/batch, 200ms pause between batches), starting 60s after startup, repeating every 24h — avoids long-running locks and ingestion disruption. Partition-based fast-drop retention was tried alongside table partitioning and reverted with it (Section 10).

---

## 8. Optional Features

None implemented (no auth, API keys, multi-tenancy, rate limiting) — prioritized a reliable core given time available. `docker compose up` with zero config serves all four endpoints, unauthenticated.

---

## 9. Load-Test Methodology & Results

Measured with the official grading tool directly (`npx github:Ahmad-Abbas-Foothill/logs-benchmark-cli --compose ./docker-compose.yml --full --seed <seed> --runner docker`), which reports Correctness/Performance/Queries/Reliability out of 100 — the same scoring the grading portal uses. `load-tests/*.js` (k6 + autocannon) remain in the repo as supplementary local tooling.

| Phase | Total | Outcome |
|---|---|---|
| Initial baseline (Runs 1-3) | 74.4-82.8/100 | Starting point |
| BRIN/backlog detour (explored, regressed, reverted) | 50.7-72.4/100 | Regression caught and undone |
| Final state (current, verified) | 79.6-83.0/100 | Best observed: 83.0 |

| State | Performance | Queries | Total | Mechanism → fix |
|---|---|---|---|---|
| **Baseline, pre-investigation** (×3 runs, before any of the code changes below) | 32.8-34.4/50 (13,343-14,555/s) | 6.6-13.4/15¹ | 74.4-82.8/100 | Starting point. Not yet beaten by anything tried since — see note below |
| Partitioning → BRIN → backlog=128 (regression chain, each step reverted or superseded by the next) | 1.5-31.4/50 | 6.0-14.1/15 | 50.7-72.4/100 | Weekly partitioning (~150 relations, 30 partitions × 4 indexes) saturated Postgres's 1GB memory limit → escalating CPU throttling (23%→61%) → replaced with a BRIN index. Ingestion recovered, but `aggregate p95` came back `null` — `backlog: 32` was refusing the aggregate probe's connections once real traffic existed → raised to 128 (refusals confirmed gone via kernel `ListenOverflows`/`ListenDrops`=0, though this run's host was noisier than most, machine speed ~0.20x); `aggregate p95` still 496-1548ms — COPY-text-build and flush-merge were unbroken sync loops blocking the event loop |
| + event-loop yielding, then **final tuned state** (BRIN + backlog=128 + yielding + `gin_pending_list_limit`=64MB + `keepAliveTimeout`, chunk=500) — ×2 runs | 28.5-30.8/50 (10,110-11,814/s) | 7.9-9.1/15 | **71.4-74.9/100** | Yielding alone (isolated test): `aggregate p95` dropped to 260-303ms, Queries 9.5-10.3/15, under the 500ms cutoff. Full config, both runs: severe generator CPU contention (k6 dropped 1,863-5,866 scheduled iterations per scenario) and low machine speed (0.25-0.34x) — a noisier host than most earlier rows |
| **BRIN removed again** — backlog=128 + event-loop yielding + `gin_pending_list_limit` kept, applied on the *original* (pre-BRIN, pre-partitioning) schema | 27.9/50 (9,668/s) | 8.4/15 | **71.3/100** | Not a clear win over the BRIN runs (71.4-74.9) — but this run's host was noisier than any earlier row (machine speed 0.22x, 18,363 total dropped k6 iterations across all four scenarios), so it isn't a clean isolation of BRIN's effect either. Inconclusive, not negative. |
| **Clean confirming runs, full host restart** — same config as above (no BRIN, backlog=128, event-loop yielding, `FLUSH_INTERVAL_MS`=12, `gin_pending_list_limit`=64MB) — ×3 | — | — | 79.7-83.0/100 | Low dropped-iteration counts, machine speed back near the baseline's own range. Per-metric breakdown not preserved for these three, Total is. |
| Same configuration, re-confirmed same-day | 32.9/50 (13,439/s) | 11.7/15 | **79.6/100** | `aggregate p95` 182ms. Working tree diffed line-by-line against this exact configuration (Section 6/9 above) and confirmed identical before trusting this number. |

¹ Two runs measured 6.6/15 (agg p95 464-466ms); a third, same code and host, measured 13.4/15 (agg p95 88ms) — the aggregate probe was already borderline-inconsistent at baseline, right around the 500ms cutoff, before any of the changes below.

Correctness (15/15) and Reliability (20/20) maxed throughout, every row measured so far.

**Resolution: host noise, not the code, explained the low intermediate runs.** Every comparison after the initial baseline ran on a progressively noisier host (dropped k6 iterations climbing run over run, machine speed falling as low as 0.22x) — confirmed, not assumed, by cross-checking every tuned value (`FLUSH_INTERVAL_MS`, `FLUSH_ROW_THRESHOLD`, `copyPool` size, backlog, event-loop yielding, `gin_pending_list_limit`, `keepAliveTimeout`, durability) directly against the source after the fact and finding all of them exactly as intended, nothing half-reverted. A clean run after a full host restart measured 79.6/100 — inside the original baseline band, not a regression. The 50.7-72.4 detour above is a real, measured regression that was caught and reverted, not hidden; the current shipped state matches the verified-good configuration.

---

## 10. Known Limitations

- **Table partitioning tried and reverted, then BRIN tried and also reverted** (Section 4) — BRIN measured below the pre-BRIN baseline on the real grading CLI in every run; currently re-testing the backlog/event-loop fixes on the original schema alone (Section 9). Retention is back to batched `DELETE` either way (Section 7).
- **15,000 logs/sec not reached** at 1M-row scale in any tested configuration (Section 9).
- **`q` has no index** (`ILIKE`) — `pg_trgm` deferred to avoid write-path cost.
- **Aggregate cache vs. "Postgres as source of truth":** never caches a write before Postgres durably commits it, and stays in lockstep via startup backfill + retention pruning — but unfiltered `GET /logs/aggregate` reads bypass Postgres entirely. A judgment call, not resolved.
- **drizzle-kit schema snapshots missing for migrations 0004-0006** — hand-written directly into the journal. Confirmed `drizzle-kit generate` produces a migration re-creating an already-existing index (would fail if run for real).
- **No auth, rate limiting, or multi-tenancy** — by design (Section 8).

---

## 11. CI

`.github/workflows/ci.yml`: install → lint → unit test → build → `docker compose up --build` → smoke test all 4 endpoints + malformed JSON → teardown.
