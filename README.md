# Log Ingestion and Query Service

High-throughput log ingestion, querying, and aggregation service (Node.js, TypeScript, Express, PostgreSQL) — a simplified Datadog/Loki-style backend for structured application logs.

Repository: https://github.com/Ghadeer7amad/log-ingestion-and-query-service

**Status at a glance:** ingestion, querying, aggregation, retention, and cursor pagination are all implemented and correct. Aggregate query latency, data freshness, and query performance during ingestion all meet their targets. The one target not yet consistently met is raw ingestion throughput — best measured so far is ~8,700 logs/sec against a 15,000/sec goal, under the exact 0.5 CPU / 1 CPU resource limits used for grading. This is being actively worked on; see Section 8 for the current numbers and Section 9 for the root-cause analysis. **This README will be updated with the latest throughput figures before final submission.**

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

**Trade-off:** ingestion + simple reads use raw parameterized SQL (`postgres.js`) for bulk `UNNEST` inserts and lower overhead under load; aggregate uses Drizzle's query builder, since its dynamic bucket/group logic benefits more from type-safe composition than raw-SQL speed on a path that isn't ingestion-critical. Single shared connection pool (`max: 8`) for reads and writes — see Limitations. Startup order: migrate → mark ready → start retention job → bind port, so `/health` never reports ready before the service actually is.

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

Kept to 4 indexes deliberately — each adds write cost on a 1-CPU container. `q` uses unindexed `ILIKE` (see Limitations).

---

## 5. Attribute Storage Strategy

`attributes` (raw jsonb) stores mixed-type values as submitted. `attributes_search` is a generated, stringified copy (`GENERATED ALWAYS AS ... STORED`), enabling `attr.<key>` equality — required to be compared as strings — via the indexable `@>` operator instead of an unindexable `->>'key' = value` scan. GIN index uses `jsonb_path_ops` (smaller/faster than default, sufficient since only containment is needed). Internal-only — never exposed in responses (SELECTs list columns explicitly).

---

## 6. Retention Strategy

Configurable via `RETENTION_DAYS` (default 30). Deletes in batches of 5,000 with a 200ms pause between batches, starting 60s after startup, repeating every 24h — avoids long-running locks and ingestion disruption from a single large `DELETE`.

---

## 7. Optional Features

**None implemented** (no auth, API keys, multi-tenancy, rate limiting) — prioritized a reliable core given time available. `docker compose up` with zero config serves all four endpoints, unauthenticated.

---

## 8. Load-Test Methodology & Results

**Tools:** [k6](https://k6.io) (primary — `load-test.js`, `seed-data.js`) and [autocannon](https://github.com/mcollina/autocannon) (secondary — `autocannon-get.js`, `autocannon-test.js`), both included in the repo. **Environment:** exact grading limits (Postgres 1 CPU/1GB, App 0.5 CPU/256MB), confirmed active via `docker stats`.

| Batch size | Rate | logs/sec | Notes |
|---|---|---|---|
| 50 | 300/s | ~5,150 | high latency, drops |
| 500 | 30/s | ~8,150 | stable |
| 1000 | 15/s | ~7,620 | stable |
| **700** | **21/s** | **~8,705** | best so far, no drops |
| 50 | 50/s (60s) | ~2,500 | p95 88ms, 0 drops |

> **Note:** 15,000 logs/sec is not yet consistently reached. Further optimization is in progress (see Section 9); this table will be updated with final numbers before submission.

**Optimizations applied so far (by impact):** `NODE_ENV=production` (~halved latency) → bulk `UNNEST` insert, chunked at 1,000 → Postgres tuning (`synchronous_commit=off` etc.) → fewer write-path indexes (5→4) → batch-size tuning (peak at 500–700).

**Aggregate latency** (~945,700 rows, 4 runs): p97.5 397–508ms, avg ~320–340ms — consistently under the 1s p95 target.

**During ingestion** (2,500 logs/sec sustained): aggregate requests returned in 47–137ms — no degradation.

**Freshness:** new logs queryable within 2s (target: 20s).

**Resources:** App 39–55MiB / 15–50% CPU. Postgres 130–460MiB / 80–105% CPU under load.

---

## 9. Bottlenecks & Known Limitations

- **Postgres CPU is the real bottleneck**, not the app (confirmed via cgroup throttling stats + consistent 100%+ Postgres CPU under load, while the app stayed within its 0.5 CPU limit). As a result, **15,000 logs/sec is not yet reliably sustained** — best measured: ~8,700/sec. Query plan, connection pool size, and the GIN index were each individually ruled out as the primary cause; the remaining cost appears inherent to running enough concurrent transactions within a single Postgres core. Actively being worked on.
- **Cursor pagination was broken until fixed:** `postgres.js` returns `bigint` ids as strings; the validator required a JSON number, rejecting every paginated request with 400. Fixed by coercing `id` to a number before serializing the cursor.
- **`q` has no index** (`ILIKE '%...%'`) — a `pg_trgm` index was deferred to avoid extra write-path cost given the throughput constraint.
- **Single connection pool for reads and writes** — a dedicated read pool was considered but not adopted; open trade-off under heavy sustained ingestion.
- **No auth, rate limiting, or multi-tenancy** — by design.

---

## 10. CI

`.github/workflows/ci.yml` runs on every push/PR: builds the project, brings up the stack with `docker compose up --build`, waits for `/health`, smoke-tests `POST /logs`, `GET /logs`, `GET /logs/aggregate`, and malformed-JSON handling.
