DROP INDEX "idx_logs_timestamp";--> statement-breakpoint
DROP INDEX "idx_logs_level";--> statement-breakpoint
DROP INDEX "idx_logs_service";--> statement-breakpoint
ALTER TABLE "logs" ALTER COLUMN "id" SET DATA TYPE bigserial;--> statement-breakpoint
ALTER TABLE "logs" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
CREATE INDEX "idx_logs_time_service_level" ON "logs" USING btree ("timestamp","service","level");