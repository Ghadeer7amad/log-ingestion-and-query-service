import { pgTable, bigserial, timestamp, varchar, text, jsonb, index } from "drizzle-orm/pg-core";

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
}, (table) => [
  index('idx_logs_time_service_level').on(table.timestamp, table.service, table.level),
  index('idx_logs_attributes_gin').using('gin', table.attributes),
]);

export type Log = typeof logs.$inferSelect;
export type NewLog = typeof logs.$inferInsert;