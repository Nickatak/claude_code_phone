ALTER TABLE "messages" ALTER COLUMN "content" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_events" ALTER COLUMN "message_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "status" text DEFAULT 'running' NOT NULL;