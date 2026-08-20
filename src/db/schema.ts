import { pgTable, bigserial, timestamp, varchar, text, jsonb, index } from "drizzle-orm/pg-core";
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
