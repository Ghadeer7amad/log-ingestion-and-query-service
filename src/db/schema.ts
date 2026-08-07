import { pgTable, uuid, timestamp, varchar,  text, jsonb, index } from "drizzle-orm/pg-core";

export const logs = pgTable('logs', {

    id: uuid('id').defaultRandom().primaryKey(),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
    level: varchar('level', { length: 10 }).notNull(),
    service: varchar('service', {length: 255 }).notNull(),
    message: text('message').notNull(),
    attributes: jsonb('attributes')
    .$type<Record<string, string | number | boolean>>()
    .default({})
    .notNull(),
 }, (table) => [

        index('idx_logs_timestamp').on(table.timestamp),
        index('idx_logs_level').on(table.level),
        index('idx_logs_service').on(table.service),
        index('idx_logs_attributes_gin').using('gin', table.attributes),
    
]);

export type Log = typeof logs.$inferSelect;
export type NewLog = typeof logs.$inferInsert;