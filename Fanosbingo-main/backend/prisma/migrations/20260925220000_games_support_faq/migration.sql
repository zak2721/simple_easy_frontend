-- Multi-operator Phase 4b: operator-scheduled games + winning patterns, support tickets, FAQ.

CREATE TYPE "TicketStatus" AS ENUM ('open', 'pending', 'resolved', 'closed');
ALTER TYPE "GameStatus" ADD VALUE 'scheduled';
ALTER TABLE "games" ADD COLUMN     "cancelled_at" TIMESTAMP(3),
ADD COLUMN     "cancelled_reason" TEXT,
ADD COLUMN     "created_by_admin_id" TEXT,
ADD COLUMN     "sales_open_at" TIMESTAMP(3),
ADD COLUMN     "winning_patterns" TEXT[] DEFAULT ARRAY['row', 'column', 'diagonal', 'corners']::TEXT[];
CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "telegram_user_id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'open',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "assigned_admin_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "support_ticket_messages" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "author_type" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_ticket_messages_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "faq_entries" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "faq_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "support_tickets_operator_id_status_last_message_at_idx" ON "support_tickets"("operator_id", "status", "last_message_at");
CREATE INDEX "support_tickets_telegram_user_id_created_at_idx" ON "support_tickets"("telegram_user_id", "created_at");
CREATE INDEX "support_ticket_messages_ticket_id_created_at_idx" ON "support_ticket_messages"("ticket_id", "created_at");
CREATE INDEX "faq_entries_operator_id_is_active_sort_order_idx" ON "faq_entries"("operator_id", "is_active", "sort_order");
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_telegram_user_id_fkey" FOREIGN KEY ("telegram_user_id") REFERENCES "telegram_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "faq_entries" ADD CONSTRAINT "faq_entries_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A game's winning patterns: non-empty, and only patterns the engine knows (BingoService / checkWin).
ALTER TABLE "games" ADD CONSTRAINT "games_winning_patterns_chk" CHECK (
  cardinality("winning_patterns") >= 1
  AND "winning_patterns" <@ ARRAY['row', 'column', 'diagonal', 'corners', 'full_house']::TEXT[]
);

ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_priority_chk" CHECK ("priority" IN ('low', 'normal', 'high', 'urgent'));

-- A ticket belongs to its player's own operator (same backstop as deposits/withdrawals).
CREATE TRIGGER support_tickets_operator_matches_player
  BEFORE INSERT OR UPDATE OF operator_id, telegram_user_id ON support_tickets
  FOR EACH ROW EXECUTE FUNCTION assert_operator_matches_player();

-- The conversation is a record of what was said: messages are append-only.
CREATE TRIGGER support_ticket_messages_immutable
  BEFORE UPDATE OR DELETE ON support_ticket_messages
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
