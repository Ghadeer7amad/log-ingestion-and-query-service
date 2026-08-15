CREATE TABLE "logs_rollup_minute" (
	"bucket_start" timestamp with time zone NOT NULL,
	"service" varchar(255) NOT NULL,
	"level" varchar(10) NOT NULL,
	"count" bigint NOT NULL,
	CONSTRAINT "logs_rollup_minute_bucket_start_service_level_pk" PRIMARY KEY("bucket_start","service","level")
);
