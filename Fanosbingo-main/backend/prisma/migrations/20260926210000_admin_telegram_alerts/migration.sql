-- Phase 5: push warning/critical notifications to an admin's own Telegram
-- chat, on top of the in-app feed. Nullable, plain metadata-only ALTER.
ALTER TABLE "admins" ADD COLUMN "telegram_alert_chat_id" TEXT;
