CREATE TABLE "logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"level" varchar(10) NOT NULL,
	"service" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_logs_timestamp" ON "logs" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_logs_level" ON "logs" USING btree ("level");--> statement-breakpoint
CREATE INDEX "idx_logs_service" ON "logs" USING btree ("service");--> statement-breakpoint
CREATE INDEX "idx_logs_attributes_gin" ON "logs" USING gin ("attributes");