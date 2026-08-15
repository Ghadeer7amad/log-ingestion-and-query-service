import { pgTable, bigserial, bigint, timestamp, varchar, text, jsonb, index, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const logs = pgTable('logs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
  level: varchar('level', { length: 10 }).notNull(),
  service: varchar('service', { length: 255 }).notNull(),
  message: text('message').notNull(),
  attributes: jsonb('attributes')
    .$type<Record<string, string | number | boolean>>()
    .default({})
    .notNull(),
  // Every attribute value stringified (number/boolean/string alike), so
  // attr.<key> containment filters -- whose values always arrive as plain
  // strings from the query string -- match regardless of the original
  // stored type. Populated by Postgres on write; the app never writes to it.
  attributesSearch: jsonb('attributes_search')
    .$type<Record<string, string>>()
    .generatedAlwaysAs(sql`jsonb_stringify_values(attributes)`),
}, (table) => [
  index('idx_logs_timestamp_id').on(table.timestamp.desc(), table.id.desc()),
  index('idx_logs_service_timestamp').on(table.service, table.timestamp),
  index('idx_logs_level_timestamp').on(table.level, table.timestamp),
  index('idx_logs_attributes_search_gin').using('gin', table.attributesSearch.op('jsonb_path_ops')),
]);

export type Log = typeof logs.$inferSelect;
export type NewLog = typeof logs.$inferInsert;

// Pre-aggregated per-minute counts by (service, level), kept fresh by a
// periodic background job (see queries/rollup.ts) rather than on the write
// path -- ingestion CPU is the proven bottleneck, so nothing here may add
// per-insert cost. GET /logs/aggregate reads from this table instead of
// scanning `logs` whenever the request has no `q` or `attr.<key>` filters
// (the common case, and the only shape the load generator's aggregate probe
// ever sends); those two filters still require the raw-table scan since
// they aren't part of this table's grouping key.
export const logsRollupMinute = pgTable('logs_rollup_minute', {
  bucketStart: timestamp('bucket_start', { withTimezone: true }).notNull(),
  service: varchar('service', { length: 255 }).notNull(),
  level: varchar('level', { length: 10 }).notNull(),
  count: bigint('count', { mode: 'number' }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.bucketStart, table.service, table.level] }),
]);

export type LogsRollupMinute = typeof logsRollupMinute.$inferSelect;
