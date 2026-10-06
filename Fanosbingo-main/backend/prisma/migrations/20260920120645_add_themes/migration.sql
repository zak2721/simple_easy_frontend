-- AlterTable
ALTER TABLE "telegram_users" ADD COLUMN     "selected_theme_id" TEXT;

-- CreateTable
CREATE TABLE "themes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "primary_color" TEXT NOT NULL,
    "secondary_color" TEXT NOT NULL,
    "background_color" TEXT NOT NULL,
    "text_color" TEXT NOT NULL,
    "surface_color" TEXT NOT NULL,
    "surface_alt_color" TEXT NOT NULL,
    "muted_text_color" TEXT NOT NULL,
    "accent_color" TEXT NOT NULL,
    "button_background_color" TEXT,
    "button_text_color" TEXT,
    "logo_url" TEXT,
    "banner_url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "scheduled_start_at" TIMESTAMP(3),
    "scheduled_end_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "themes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "themes_slug_key" ON "themes"("slug");

-- CreateIndex
CREATE INDEX "themes_is_active_idx" ON "themes"("is_active");

-- AddForeignKey
ALTER TABLE "telegram_users" ADD CONSTRAINT "telegram_users_selected_theme_id_fkey" FOREIGN KEY ("selected_theme_id") REFERENCES "themes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

