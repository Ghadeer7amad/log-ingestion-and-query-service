CREATE TABLE "logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"level" varchar(10) NOT NULL,
	"service" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_logs_time_service_level" ON "logs" USING btree ("timestamp","service","level");--> statement-breakpoint
CREATE INDEX "idx_logs_attributes_gin" ON "logs" USING gin ("attributes");