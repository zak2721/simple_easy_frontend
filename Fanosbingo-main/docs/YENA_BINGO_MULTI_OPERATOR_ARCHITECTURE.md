# YENA Bingo → White-Label Multi-Operator Platform — Architecture & Implementation Plan

Status: **design, not yet implemented.** Based on a read of the current
codebase (`backend/prisma/schema.prisma`, 15 migrations, ~6.9k lines across
the NestJS services, and the React admin in `src/admin/`).

---

## 0. Decisions (confirmed by the Platform Owner)

| # | Decision | Answer | Consequence for the design |
|---|---|---|---|
| D1 | Shared or separate player wallets? | **Separate per operator.** | One player account per (operator, Telegram user). Money deposited with Operator A can never be withdrawn through Operator B. |
| D2 | How do players reach an operator? | **Each operator has its own Telegram bot and its own Mini App, which the operator manages.** | The operator creates the bot in @BotFather and points its Mini App at `https://yena-bingo.com/o/<slug>`. The operator enters the bot token in their admin panel; it is stored encrypted and used to verify that operator's `initData` and to receive its webhook. The platform bot remains only for the default operator (`yena`). |
| D3 | Platform commission? | **Not tracked in the system.** It is agreed manually outside the platform. | No commission column, no commission ledger entry type, no change to the 80/20 payout math. |
| D4 | Game mode | Operators choose **continuous** (current auto-loop) or **scheduled** (operator-created games). | The current engine only auto-creates games. Your spec asks for create/schedule/cancel. |

---

## 1. Architecture Review — what exists today

### Strengths to keep (do not rewrite these)

- **Immutable money trail.** `wallet_ledger` and `audit_logs` have a
  `BEFORE UPDATE OR DELETE` trigger (`prevent_ledger_mutation`, migration
  `20260919032018`). Tampering is impossible even from `psql`. Your
  "immutable audit logs" requirement is **already met at the DB level**.
- **Correct concurrency on the money path.** `CardsService.selectCartela`
  row-locks the game with `SELECT … FOR UPDATE` and then the wallet, and
  treats the unique constraint as the final backstop. `cancelAndRefund`
  re-checks state inside the lock.
- **Server-authoritative game.** CSPRNG draws, backend-enforced cartela
  limits, and the 80/20 split computed server-side.
- **Session-checked admin JWTs.** Every admin request re-reads
  `admin_sessions`, so suspension takes effect immediately.
- **Extensible permission catalog.** `Permission` + `AdminPermission` with an
  `enabled` flag; the Super Admin bypasses via `'*'`.
- **Append-only financial alerts**, deduplicated per entity.

### What blocks multi-operator (the seven singletons)

| # | Singleton | Where | Consequence |
|---|---|---|---|
| S1 | **One global active game** | `GamesService.ensureWaitingGame/getActiveGame` and all three cron ticks use `game.findFirst({status})` with no scope. `AdminService` line 48 does the same. | A second operator's game would be picked up (or ignored) at random by the engine. |
| S2 | **Two hard-coded rooms** | `enum RoomType { etb5, etb10 }`, `CardsService` lines 34–35, `cards.dto.ts` `@IsIn(['etb5','etb10'])`, and 15 frontend files | Operator A cannot sell 20-Birr cartelas and Operator C cannot sell 100-Birr cartelas. |
| S3 | **Global settings** | `settings` key/value table and `SettingsService.DEFAULTS` | Prices, Telebirr account, contact details, and bonus rules are shared by everyone. |
| S4 | **Global player identity** | `telegram_users.telegram_user_id @unique`, with the wallet columns on that row | There is no way to hold separate per-operator balances (see D1). |
| S5 | **One bot token** | `TelegramService.botToken` reads `TELEGRAM_BOT_TOKEN` from the environment | `initData` verification and webhooks cannot tell operators apart. |
| S6 | **Flat admin model** | `AdminRole { SUPER_ADMIN, ADMIN }` with no `operator_id` | There is no concept of an admin who can only see their own operator's data. |
| S7 | **Global content** | `themes`, `game_rules`, `financial_alerts`, leaderboard | Branding and content leak across brands. |

### Security gaps against your spec

| Requirement | Current state |
|---|---|
| Argon2 hashing | **bcrypt** (cost 12). Migrate transparently on the next login. |
| Refresh-token rotation | Players: rotation exists but has **no reuse detection**. Admins: **no refresh token** (2 h access token + 12 h session). |
| Account lockout | **Missing.** Failed logins are audited but never throttle the account. |
| Login history and device tracking | Partial: `admin_sessions` stores IP and user agent. There is no history view and no device identity. |
| Rate limiting | `@nestjs/throttler` is global. It needs tighter per-route limits on auth. |
| Security alerts | Only financial alerts exist. |
| Support tickets | **Do not exist.** The contact center is settings-only. |

### Migration trap you must avoid

`wallet_ledger` and `audit_logs` **reject every UPDATE**. A naive migration
of the form "add `operator_id`, then `UPDATE … SET operator_id = <default>`"
**will fail** against the trigger. The fix is in §3: add the column with a
constant `DEFAULT`, which Postgres 11+ applies as a metadata-only change with
no row updates and no trigger fired, and then drop the default.

---

## 2. Database Changes

Conventions follow the existing schema: snake_case tables, UUID PKs,
`Restrict` on anything that touches money, and `Decimal(14,2)` for amounts.

### 2.1 New core tables

```prisma
enum OperatorStatus { active  suspended  disabled }
enum GameMode       { continuous  scheduled }

model Operator {
  id     String         @id @default(uuid())
  slug   String         @unique            // URL + deep-link key, e.g. "abebe-bingo"
  name   String                            // current approved display name
  status OperatorStatus @default(active)

  ownerAdminId  String?  @map("owner_admin_id")      // transferable (spec: "Transfer Operator Ownership")
  gameMode      GameMode @default(continuous) @map("game_mode")

  // Operator's own bot (D2). Required before a non-default operator can go live;
  // null only for the default operator, which uses the platform bot from env.
  // Token encrypted at rest with PLATFORM_ENCRYPTION_KEY (AES-256-GCM).
  botUsername        String? @map("bot_username")
  botTokenEncrypted  String? @map("bot_token_encrypted")
  webhookSecret      String? @map("webhook_secret")

  suspendedReason String?   @map("suspended_reason")
  suspendedAt     DateTime? @map("suspended_at")
  createdByAdminId String?  @map("created_by_admin_id")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@index([status])
  @@map("operators")
}

/// Operator-level override of platform settings. Lookup order:
/// operator_settings -> settings (platform) -> SettingsService.DEFAULTS.
model OperatorSetting {
  operatorId String   @map("operator_id")
  key        String
  value      String
  updatedAt  DateTime @updatedAt @map("updated_at")
  updatedByAdminId String? @map("updated_by_admin_id")
  @@id([operatorId, key])
  @@map("operator_settings")
}

/// Ceilings the Super Admin imposes (spec: "Limit Operator Features").
/// Enforced in the service layer before any operator write or approval.
model OperatorLimit {
  operatorId String @map("operator_id")
  key        String            // e.g. MAX_ROOMS, MAX_CARTELAS_TOTAL, MAX_CARTELA_PRICE,
                               // MIN_WINNER_PERCENTAGE, MAX_STAFF, FEATURE_REFERRALS_ENABLED
  value      String
  @@id([operatorId, key])
  @@map("operator_limits")
}

model OperatorBranding {
  operatorId     String  @id @map("operator_id")
  displayName    String  @map("display_name")
  logoUrl        String? @map("logo_url")
  themeId        String? @map("theme_id")       // FK -> themes
  welcomeMessage String? @map("welcome_message")
  bannerUrls     String[] @default([]) @map("banner_urls")
  updatedAt DateTime @updatedAt @map("updated_at")
  @@map("operator_branding")
}

/// Replaces the hard-coded etb5/etb10 rooms (S2).
model OperatorRoom {
  id         String  @id @default(uuid())
  operatorId String  @map("operator_id")
  code       String                     // "etb5", "etb10", "vip100" — stable key, unique per operator
  name       String
  price      Decimal @db.Decimal(14, 2)
  capacity   Int                        // number of cartela slots
  maxPerPlayer Int?  @map("max_per_player")   // null -> operator MAX_CARTELAS_PER_PLAYER
  isActive   Boolean @default(true) @map("is_active")
  sortOrder  Int     @default(0) @map("sort_order")
  createdAt  DateTime @default(now()) @map("created_at")
  updatedAt  DateTime @updatedAt @map("updated_at")
  @@unique([operatorId, code])
  @@map("operator_rooms")
}

/// One row per sellable cartela number. Enables per-number activate/deactivate
/// and inventory reporting. Grids are still generated fresh per purchase with
/// crypto.randomInt: a "cartela" is a numbered slot, not a pre-printed grid.
/// This preserves the fairness decision in PRODUCTION_MIGRATION_REPORT.md.
model CartelaSlot {
  id            String  @id @default(uuid())
  operatorId    String  @map("operator_id")
  roomId        String  @map("room_id")
  cartelaNumber Int     @map("cartela_number")
  isActive      Boolean @default(true) @map("is_active")
  deactivatedReason String? @map("deactivated_reason")
  @@unique([roomId, cartelaNumber])
  @@index([operatorId])
  @@map("cartela_slots")
}
```

### 2.2 Approval workflow, notifications, support, security

```prisma
enum ApprovalStatus { pending  approved  rejected  cancelled  superseded }

model ApprovalRequest {
  id          String @id @default(uuid())
  operatorId  String @map("operator_id")
  type        String          // BRANDING_NAME, BRANDING_LOGO, BRANDING_THEME, INVENTORY_INCREASE,
                              // RULE_CHANGE, WITHDRAWAL_RULES, BONUS_RULES, REFERRAL_RULES
  targetEntityType String? @map("target_entity_type")
  targetEntityId   String? @map("target_entity_id")
  currentValue Json?  @map("current_value")   // snapshot when submitted
  proposedValue Json  @map("proposed_value")
  status      ApprovalStatus @default(pending)
  submittedByAdminId String   @map("submitted_by_admin_id")
  submittedAt DateTime @default(now()) @map("submitted_at")
  reviewedByAdminId  String?  @map("reviewed_by_admin_id")
  reviewedAt  DateTime? @map("reviewed_at")
  reviewNote  String?   @map("review_note")
  appliedAt   DateTime? @map("applied_at")
  @@index([status, submittedAt])
  @@index([operatorId, status])
  @@map("approval_requests")
}

model Notification {
  id         String   @id @default(uuid())
  audience   String             // "super_admin" | "operator"
  operatorId String?  @map("operator_id")
  type       String             // BRANDING_CHANGED, PRICING_CHANGED, GAME_CREATED, LARGE_WITHDRAWAL,
                                // SUSPICIOUS_LOGIN, STAFF_CREATED, APPROVAL_PENDING, ...
  severity   String   @default("info")
  title      String
  body       String?
  relatedEntityType String? @map("related_entity_type")
  relatedEntityId   String? @map("related_entity_id")
  createdAt  DateTime @default(now()) @map("created_at")
  readAt     DateTime? @map("read_at")
  readByAdminId String? @map("read_by_admin_id")
  @@index([audience, readAt, createdAt])
  @@index([operatorId, readAt])
  @@map("notifications")
}

model SupportTicket {
  id         String @id @default(uuid())
  operatorId String @map("operator_id")
  telegramUserId String @map("telegram_user_id")
  subject    String
  status     String @default("open")      // open | pending | resolved | closed
  priority   String @default("normal")
  assignedAdminId String? @map("assigned_admin_id")
  createdAt  DateTime @default(now()) @map("created_at")
  updatedAt  DateTime @updatedAt @map("updated_at")
  messages   SupportTicketMessage[]
  @@index([operatorId, status])
  @@map("support_tickets")
}

model SupportTicketMessage {
  id        String @id @default(uuid())
  ticketId  String @map("ticket_id")
  ticket    SupportTicket @relation(fields: [ticketId], references: [id], onDelete: Restrict)
  authorType String @map("author_type")  // "player" | "admin"
  authorId  String @map("author_id")
  body      String
  createdAt DateTime @default(now()) @map("created_at")
  @@index([ticketId, createdAt])
  @@map("support_ticket_messages")
}

model FaqEntry {
  id String @id @default(uuid())
  operatorId String? @map("operator_id")   // null = platform-wide FAQ
  question String
  answer   String
  sortOrder Int @default(0) @map("sort_order")
  isActive Boolean @default(true) @map("is_active")
  @@index([operatorId, isActive, sortOrder])
  @@map("faq_entries")
}

model LoginHistory {                         // append-only (add to the immutability trigger)
  id         String   @id @default(uuid())
  principalType String @map("principal_type")   // "admin" | "player"
  principalId   String? @map("principal_id")
  operatorId    String? @map("operator_id")
  attemptedUsername String? @map("attempted_username")
  success    Boolean
  failureReason String? @map("failure_reason")
  ipAddress  String?  @map("ip_address")
  userAgent  String?  @map("user_agent")
  deviceId   String?  @map("device_id")          // client-generated stable ID (localStorage)
  createdAt  DateTime @default(now()) @map("created_at")
  @@index([principalType, principalId, createdAt])
  @@index([ipAddress, createdAt])
  @@map("login_history")
}

model AdminRefreshToken {
  id        String   @id @default(uuid())
  adminId   String   @map("admin_id")
  familyId  String   @map("family_id")      // reuse of a revoked token revokes the whole family
  tokenHash String   @map("token_hash")
  sessionId String   @map("session_id")
  createdAt DateTime @default(now()) @map("created_at")
  expiresAt DateTime @map("expires_at")
  revokedAt DateTime? @map("revoked_at")
  replacedById String? @map("replaced_by_id")
  @@index([tokenHash])
  @@index([familyId])
  @@map("admin_refresh_tokens")
}

/// Nightly rollup that keeps reports fast without scanning wallet_ledger.
model OperatorDailyStat {
  operatorId String   @map("operator_id")
  day        DateTime @db.Date
  cartelasSold   Int     @default(0) @map("cartelas_sold")
  salesAmount    Decimal @default(0) @map("sales_amount") @db.Decimal(14, 2)
  prizesPaid     Decimal @default(0) @map("prizes_paid") @db.Decimal(14, 2)
  houseRevenue   Decimal @default(0) @map("house_revenue") @db.Decimal(14, 2)
  depositsAmount Decimal @default(0) @map("deposits_amount") @db.Decimal(14, 2)
  withdrawalsAmount Decimal @default(0) @map("withdrawals_amount") @db.Decimal(14, 2)
  bonusCost      Decimal @default(0) @map("bonus_cost") @db.Decimal(14, 2)
  referralCost   Decimal @default(0) @map("referral_cost") @db.Decimal(14, 2)
  gamesPlayed    Int     @default(0) @map("games_played")
  activePlayers  Int     @default(0) @map("active_players")
  @@id([operatorId, day])
  @@map("operator_daily_stats")
}
```

### 2.3 Changes to existing tables (all additive)

| Table | Change |
|---|---|
| `admins` | `+ operator_id` (nullable, where null means a platform-level admin), `+ failed_login_count`, `+ locked_until`, `+ password_changed_at`, `+ must_change_password`. Extend `AdminRole`: `SUPER_ADMIN`, `ADMIN` (kept, means *platform admin*), `+ OPERATOR_OWNER`, `+ OPERATOR_STAFF`. |
| `admin_sessions` | `+ impersonator_admin_id`, `+ device_id`, `+ last_seen_at` |
| `permissions` | `+ scope` (`platform` or `operator`) |
| `telegram_users` | `+ operator_id NOT NULL`. Replace `@unique(telegram_user_id)` with `@@unique([operator_id, telegram_user_id])` (D1). |
| `games` | `+ operator_id NOT NULL`, `+ created_by_admin_id`, `+ scheduled` (bool), `+ winning_patterns text[]` (default all five), `+ cancelled_reason`. The status enum gains `cancelled`. |
| `game_cartelas` | `+ room_id` (FK `operator_rooms`), `+ operator_id`. `room_type` becomes nullable (legacy). `+ @@unique([game_id, room_id, cartela_number])`. The old unique stays and still covers legacy rows. |
| `wallet_ledger` | `+ operator_id` |
| `manual_deposits`, `withdrawal_requests`, `bonus_grants`, `referrals` | `+ operator_id` (denormalized from the user for index-only operator filters) |
| `audit_logs` | `+ operator_id`, `+ actor_role`, `+ impersonator_admin_id`, `+ user_agent`, `+ device_id` |
| `themes`, `game_rules`, `financial_alerts` | `+ operator_id` (nullable, where null means the platform library) |

### 2.4 Database-level invariants (raw SQL in migrations, same pattern as `uniq_single_super_admin`)

```sql
-- S1 fix enforced by the DB: at most one live game per operator.
CREATE UNIQUE INDEX uniq_live_game_per_operator
  ON games (operator_id) WHERE status IN ('waiting', 'playing');

-- Operator-scoped admins must have an operator; platform admins must not.
ALTER TABLE admins ADD CONSTRAINT admins_operator_scope_chk CHECK (
  (role IN ('SUPER_ADMIN','ADMIN') AND operator_id IS NULL) OR
  (role IN ('OPERATOR_OWNER','OPERATOR_STAFF') AND operator_id IS NOT NULL));

-- Prices and capacities can never be nonsense, even through a bug.
ALTER TABLE operator_rooms ADD CONSTRAINT operator_rooms_sane_chk
  CHECK (price > 0 AND capacity BETWEEN 1 AND 10000);

-- A cartela's operator must match its game's operator (checked by trigger: no cross-tenant rows).
-- login_history and approval_requests history: add to prevent_ledger_mutation
-- (login_history fully; approval_requests blocks DELETE only).
```

---

## 3. Migration Strategy

**Principle: after migration, the platform behaves exactly as it does today.**
All existing data becomes the **default operator** (`slug = 'yena'`, fixed
UUID). With only that operator present, every scoped query returns what the
unscoped one returned before. Multi-operator behavior only starts when you
create the second operator, so no feature flag is needed.

Migrations are ordered, each separately deployable and reversible up to the
point where new data is written:

| Step | Migration | Notes |
|---|---|---|
| M1 | Create `operators`. Insert the default operator with a fixed UUID. | |
| M2 | Create new tables (§2.1–2.2). | Pure additions, zero risk. |
| M3 | Add `operator_id` to **immutable tables** (`wallet_ledger`, `audit_logs`) as `ADD COLUMN operator_id uuid DEFAULT '<default-uuid>'`, then `ALTER COLUMN … DROP DEFAULT`. | **Must use a constant DEFAULT.** PG11+ stores it as metadata: no row rewrite, no UPDATE, no trigger fired. A backfill `UPDATE` would be rejected by `prevent_ledger_mutation`. Leave the column nullable on these two tables: system rows can be platform-level. |
| M4 | Add `operator_id` to mutable tables with the same DEFAULT trick, then `SET NOT NULL`, drop the default, and add FKs + indexes. | Use `CREATE INDEX CONCURRENTLY` in a separate non-transactional migration if the tables are large. |
| M5 | Create `operator_rooms` rows `etb5` and `etb10` for the default operator from current settings (`ETB5_ROOM_PRICE` etc.). Generate `cartela_slots` (400 + 200 rows). Backfill `game_cartelas.room_id` from `room_type`. | `game_cartelas` is mutable, so the UPDATE is fine. |
| M6 | Copy branding-relevant `settings` rows into `operator_settings` for the default operator. | Keep the `settings` rows as platform defaults. |
| M7 | Swap the `telegram_users` unique: create `(operator_id, telegram_user_id)` unique, then drop the old single-column unique. | Done in one migration. The code change that resolves users by `(operatorId, tgId)` must ship in the **same release**. |
| M8 | Add the §2.4 constraints/indexes and extend the immutability trigger to `login_history`. | Create `uniq_live_game_per_operator` **after** verifying that today at most one live game exists (it does: S1). |
| M9 | Argon2: no schema change. Hashes are upgraded on each admin's next successful login. | |

**Before running M1–M8 in production:** take a `pg_dump` (see
`YENA_BINGO_BACKUP_AND_RESTORE.md`), rehearse on a restored copy of the
production DB, and run the verification queries. Row counts, the ledger sum
per user equal to the wallet columns, and exactly one operator must all match
before and after.

> Test-DB warning: never point the test suite at a database you care about.
> Use a throwaway Postgres container for migration rehearsals.

---

## 4. API Changes

Existing routes keep their paths and response shapes, with the default
operator implied where there's no context. New routes:

### Tenant resolution (players)

- `POST /api/auth/telegram` gains an optional `operatorSlug` (taken from the
  Mini App URL `/o/<slug>`; omitted means the default operator). The backend
  resolves the operator and verifies `initData` with **that operator's own**
  bot token. There is no fallback to another bot, because a signature valid
  for a different bot must not log a player into this operator. It then
  issues a JWT containing `op: <operatorId>`. Every player route
  then scopes by `req.user.operatorId`. The client never gets to choose
  after login.
- `GET /api/public/operators/:slug/branding` is unauthenticated: name, logo,
  theme, and banners for the splash screen before login.
- `POST /api/telegram/webhook/:operatorSlug` is a per-operator webhook, each
  with its own secret. The existing `/api/telegram/webhook` stays for the
  platform bot.

### Operator admin (`/api/operator/*`, scoped automatically to `admin.operatorId`)

| Area | Routes |
|---|---|
| Telegram bot (D2) | `GET /operator/bot` (username + status only; the token is never returned), `PUT /operator/bot` (operator pastes its @BotFather token; the backend validates it with `getMe`, stores it encrypted, registers the webhook with a fresh secret, and sets the bot's menu button to `https://yena-bingo.com/o/<slug>`). Changing the token notifies the Super Admin. |
| Branding | `GET/PUT /operator/branding` (non-approval fields apply at once; approval fields create an `ApprovalRequest`), `POST /operator/branding/logo` |
| Rooms and inventory | `GET/POST /operator/rooms`, `PATCH /operator/rooms/:id` (price change applies to **future games only**), `GET /operator/rooms/:id/slots`, `PATCH /operator/slots/:id` (activate/deactivate), `POST /operator/rooms/:id/capacity-requests` |
| Games | `GET/POST /operator/games`, `PATCH /operator/games/:id` (only while `waiting` with zero sales), `POST /operator/games/:id/cancel` (refunds everyone) |
| Rules and settings | `GET/PUT /operator/settings/:key` (the registry decides direct vs approval), `CRUD /operator/game-rules`, `CRUD /operator/faq` |
| Players | `GET /operator/players`, `POST /operator/players/:id/suspend`, `POST /operator/players/:id/reactivate` |
| Money | `GET /operator/deposits`, `…/approve`, `…/reject`, `GET /operator/withdrawals`, `…/approve`, `…/pay`, `…/reject` (existing logic, scoped) |
| Support | `GET /operator/tickets`, `POST /operator/tickets/:id/messages`, `PATCH /operator/tickets/:id` |
| Staff | `GET/POST /operator/staff`, `PATCH /operator/staff/:id/permissions`, `POST /operator/staff/:id/suspend`, `POST /operator/staff/:id/reset-password` |
| Approvals | `GET /operator/approvals` (own requests), `POST /operator/approvals/:id/cancel` |
| Reports | `GET /operator/reports?period=day\|week\|month\|year&from=&to=` and `/export.csv` |
| Notifications | `GET /operator/notifications`, `POST …/:id/read` |

### Super Admin (`/api/platform/*`, SUPER_ADMIN only, plus platform ADMINs holding the matching permission)

| Area | Routes |
|---|---|
| Operators | `GET/POST /platform/operators`, `PATCH /platform/operators/:id`, `POST …/:id/suspend`, `…/reactivate`, `…/disable`, `…/transfer-ownership`, `PUT …/:id/limits`, `PUT …/:id/bot` (token stored encrypted, webhook registered) |
| Operator accounts | `POST …/:id/reset-owner-password`, `PATCH /platform/admins/:id/permissions` |
| Impersonation | `POST /platform/operators/:id/impersonate` (returns a short-lived session marked with `impersonator_admin_id`; requires a reason; audited on start and end), `POST /platform/impersonation/end` |
| Approvals | `GET /platform/approvals?status=pending`, `POST …/:id/approve`, `POST …/:id/reject` |
| Inventory | `POST /platform/rooms/:id/capacity` (increase/decrease), `POST /platform/inventory/reassign` |
| Monitoring | Every existing admin list endpoint accepts `?operatorId=`. Omitting it returns all operators, with operator name included in each row. |
| Reports | `GET /platform/reports?groupBy=operator&period=…` |
| Audit | `GET /platform/audit?operatorId=&actorId=&action=&from=&to=` |
| Notifications | `GET /platform/notifications` |

Deleting an operator is **soft only** (`status = disabled`). Hard delete is
impossible by design: every money row has an `ON DELETE RESTRICT` FK to it,
matching the schema's "never destroy financial history" rule.

---

## 5. Security Enhancements

| Item | Design |
|---|---|
| **Argon2id** | `argon2` package, `m=19456 KiB, t=2, p=1` (OWASP baseline). On login: if the stored hash starts with `$2`, verify with bcrypt, then **rehash to argon2id** and save. The `bcryptjs` dependency can be removed after every admin has logged in once, or after a forced reset. |
| **Admin refresh rotation** | Access token 15 min (down from 2 h). Refresh token in an **httpOnly, Secure, SameSite=Strict cookie**, 12 h absolute / 1 h idle. Each refresh revokes the old token and issues a new one in the same `familyId`. **Reuse of an already-rotated token revokes the entire family and session**, and raises a `SUSPICIOUS_TOKEN_REUSE` notification. |
| **Player refresh** | Add the same reuse detection to `refreshPlayerToken` (`familyId` column on `player_refresh_tokens`). |
| **Account lockout** | 5 consecutive failures → locked 15 min; 10 → 1 h; 20 → locked until an admin unlocks it. Counter resets on success. Responses stay a generic "Invalid credentials", so lockout isn't an enumeration oracle. |
| **Login history and devices** | Every attempt goes to `login_history`. The admin UI sends an `X-Device-Id` (random UUID in localStorage). A login from a new device or country for the SUPER_ADMIN or an OPERATOR_OWNER triggers a notification. |
| **Rate limiting** | Keep the global throttler. Add `@Throttle` on `/auth/admin/login` (5/min per IP + username), `/auth/telegram` (30/min per IP), approvals, and uploads. Because of `trust proxy = 1` (already set), limits key on the real client IP behind Apache. |
| **Permission middleware** | See §6. Three guards in order: `JwtAdminGuard` → `OperatorScopeGuard` → `PermissionsGuard`. |
| **Tenant isolation** | App layer: `OperatorScopeGuard` plus a `scoped(admin)` helper that injects `operatorId` into every Prisma `where`. There is **no manual `operatorId` in controllers**; it always comes from the token. Defense in depth (Phase 7): Postgres **Row-Level Security** on tenant tables using `SET LOCAL app.operator_id` inside each request's transaction. Correction (Phase 7 Part 2, see below): RLS only activates for the `$transaction`-wrapped writes that call `setTenantOnTx`/`tenantSetConfigOp` — a forgotten `where` on a bare read is **not** caught by RLS as this design shipped; the app layer above remains the actual guarantee for those. |
| **Secrets** | Operator bot tokens encrypted with AES-256-GCM (`PLATFORM_ENCRYPTION_KEY`, 32 bytes, env only). They are never returned by any API after being saved (write-only field). |
| **Impersonation** | JWT carries an `imp` claim, and every audit row records both identities. It cannot be nested, expires after 30 min, and a banner shows in the admin UI. Impersonated sessions **cannot change passwords, transfer ownership, or approve their own requests**. |
| **2FA (recommended)** | TOTP for SUPER_ADMIN and OPERATOR_OWNER. This is not in your spec, but these accounts move money and the Super Admin account can do everything. |
| **Security alerts** | Notifications for: lockout triggered, token reuse, new-device login, impersonation start, bulk player suspensions, and withdrawal approval over a threshold. |

---

## 6. Permission System Design

The existing flat model is extended, not replaced.

```
SUPER_ADMIN (exactly one; unchanged)       -> '*' everywhere, all operators
ADMIN       (platform staff; existing)     -> platform-scope permissions, all operators (read) + granted actions
OPERATOR_OWNER  (one per operator)          -> every operator-scope permission, own operator only
OPERATOR_STAFF  (created by the owner)      -> subset of operator-scope permissions, own operator only
```

**Scope rule.** `Permission.scope = 'operator'` permissions only ever apply
to `admin.operatorId`. `platform` permissions (`MANAGE_OPERATORS`,
`APPROVE_OPERATOR_CHANGES`, `VIEW_ALL_OPERATORS`, `IMPERSONATE_OPERATOR`,
`MANAGE_OPERATOR_LIMITS`, `VIEW_PLATFORM_REPORTS`) can never be granted to
operator-scoped roles. This is enforced in `AdminManagementService`, not
just the UI.

**Delegation rule.** An OPERATOR_OWNER can grant a staff member only
permissions that are both operator-scoped **and** enabled for the operator in
`operator_limits` (for example, the Super Admin can switch off
`FEATURE_REFERRALS_ENABLED` for one operator).

**Staff presets** (convenience only; stored as plain `AdminPermission` rows,
so the flat model is kept):

| Preset | Permissions |
|---|---|
| Deposit Manager | `VIEW_USERS, VIEW_DEPOSITS, APPROVE_DEPOSITS, REJECT_DEPOSITS` |
| Withdrawal Manager | `VIEW_USERS, VIEW_WITHDRAWALS, APPROVE_WITHDRAWALS, REJECT_WITHDRAWALS` |
| Support Agent | `VIEW_USERS, VIEW_SUPPORT_TICKETS, MANAGE_SUPPORT_TICKETS, VIEW_CONTACT_CENTER` |
| Game Manager | `VIEW_GAMES, CREATE_GAMES, UPDATE_GAMES, CANCEL_GAMES, VIEW_BINGO_CARDS, VIEW_GAME_RULES` |

New permission keys to add to `rbac.constants.ts`: `MANAGE_BRANDING`,
`MANAGE_ROOMS`, `MANAGE_INVENTORY`, `CANCEL_GAMES`, `MANAGE_STAFF`,
`VIEW_SUPPORT_TICKETS`, `MANAGE_SUPPORT_TICKETS`, `MANAGE_FAQ`,
`SUSPEND_PLAYERS`, `VIEW_OPERATOR_REPORTS`, `SUBMIT_APPROVALS`, plus the
platform keys above.

**Request context** (`RequestAdmin` in `current-user.decorator.ts`) gains
`operatorId: string | null`, `role`, and
`impersonatorAdminId: string | null`. A Super Admin with no impersonation
can read any operator by passing `?operatorId=`, but **operator-scoped write
routes require impersonation**, so every operator change they make is
attributed properly.

---

## 7. Cartela Inventory Design

Mapping your terms to the model:

| Spec | Model |
|---|---|
| "Operator A: 600 cartelas at 20 Birr" | One or more `operator_rooms`, e.g. `{code: 'main', price: 20, capacity: 600}` with 600 `cartela_slots`. An operator can also split it, for example 400 at 20 and 200 at 50. |
| Activate/deactivate cartelas | `cartela_slots.is_active`. The selection screen hides inactive numbers, and `selectCartela` rejects them inside the transaction. |
| Sales limits | `operator_rooms.max_per_player`, operator `MAX_CARTELAS_PER_PLAYER` (global across that operator's rooms, as today), and a Super Admin ceiling via `operator_limits`. |
| Sold / available / reserved / winning | Per game: from `game_cartelas` (sold = rows, reserved = rows with `confirmed_at IS NULL`, winning = `winning_pattern IS NOT NULL`, available = active slots minus sold). |
| Revenue per cartela | `SUM(entry_price)` over `game_cartelas` grouped by `(room_id, cartela_number)` for all-time/per-period views, served from a nightly rollup `cartela_slot_stats` if it gets slow. |
| Super Admin increase/decrease/reassign | Increase creates slots `capacity+1..new`. Decrease only removes the **highest-numbered slots that have no live-game sale** (and never below any number sold in a live game). Reassign is a decrease on one room plus an increase on another in **one transaction**, with one audit entry referencing both. |

**Rules that protect players:**

1. Price and capacity changes apply to the **next** game. A `waiting` game
   with sales keeps its price, because `game_cartelas.entry_price` is
   already captured per sale and payouts use that value.
2. Operator inventory **increases require approval**. Decreases and
   deactivations apply immediately but cannot touch a number sold in the
   live game.
3. `selectCartela` changes from `room: 'etb5' | 'etb10'` to a `roomId`. The
   capacity and price lookup reads the room row **inside the same
   transaction** after the game lock, so a concurrent price change can't
   produce a sale at a stale price.

**Engine changes** (fixing S1):

- `GamesService.callNumbersTick` loops over `operators WHERE status='active'`
  and runs the three ticks per operator. Each operator's tick is wrapped in
  `pg_try_advisory_xact_lock(hash(operatorId))`, so a slow operator can't
  stall the others. It is also safe if you ever run two backend instances
  (today the cron would double-fire).
- In `scheduled` mode, `ensureWaitingGame` doesn't auto-create. Operators
  create games with `startsAt`, and the tick only transitions them.
- `BingoService.checkAutoWinAfterDraw(gameId)` and `finalizeGame` take an
  explicit game ID. They must never look up "the" active game again.
- `game.winning_patterns` locks at the first cartela sale. Win validation
  checks only the enabled patterns.

---

## 8. Approval Workflow Design

**Registry, not scattered ifs.** A single `APPROVAL_POLICY` map in
`approvals/approval-policy.ts` decides per change type:

```ts
export const APPROVAL_POLICY = {
  BRANDING_NAME:       { requiresApproval: true },
  BRANDING_LOGO:       { requiresApproval: true },
  BRANDING_THEME:      { requiresApproval: true },
  BRANDING_WELCOME:    { requiresApproval: false },
  CONTACT_INFO:        { requiresApproval: false },
  ROOM_PRICE:          { requiresApproval: false, notifySuperAdmin: true }, // spec: notify on pricing change
  INVENTORY_INCREASE:  { requiresApproval: true },
  INVENTORY_DECREASE:  { requiresApproval: false, notifySuperAdmin: true },
  RULE_CHANGE_MAJOR:   { requiresApproval: true },   // winning patterns, winner %, max cartelas
  WITHDRAWAL_RULES:    { requiresApproval: true },
  BONUS_RULES:         { requiresApproval: true },
  REFERRAL_RULES:      { requiresApproval: true },
} as const;
```

The Super Admin can edit this policy per operator later (store overrides in
`operator_limits`).

**Lifecycle:**

```
operator submits -> validate against operator_limits -> ApprovalRequest(pending)
                 -> audit APPROVAL_SUBMITTED -> notify super_admin
                 (a new request of the same type+target supersedes the older pending one)

super admin approve -> in ONE transaction:
                       re-validate (limits may have changed) -> check currentValue still matches the live value
                       (stale -> reject with "changed since submission") -> apply via handler[type]
                       -> status=approved, appliedAt -> audit APPROVAL_APPROVED + the applied change
                       -> notify operator
super admin reject  -> status=rejected, reviewNote required -> audit -> notify operator
```

Each `type` has one **apply handler** (`approvals/handlers/*.ts`) that calls
the same service method used for direct changes, so there's a single write
path per setting. Approval requests are never deleted: the trigger blocks
DELETE, and status transitions are forward-only (checked in the service).

---

## 9. File-by-File Implementation Plan

Phased so each phase ships to production on its own without regressing the
live single-operator platform.

### Phase 0: safety net (before touching anything)

| File | Change |
|---|---|
| `backend/test/**` | Integration tests for today's behavior: cartela purchase, cancel/refund, finalize/payout, deposit approve, withdrawal pay. These are the regression net for Phases 1–2. |
| `docker-compose.test.yml` (new) | Throwaway Postgres for tests, **never** the dev DB. |
| Ops | VPS upgrade (see §10) plus a verified backup/restore drill. |

### Phase 1: schema foundation (no behavior change)

**Status: done** — migration `20260925120000_operators_foundation`. As built,
it differs from the table below in these ways:

- One migration instead of M1–M8. It creates the `operators` table (with the
  default operator `yena`) plus operator settings, limits, branding, rooms,
  and cartela slots. It adds `operator_id` to the 13 existing tables, creates
  the `etb5`/`etb10` rooms and their 600 slots from the current settings, and
  links every existing `game_cartelas` row to its room.
- The approval, notification, support, FAQ, login-history, refresh-token, and
  daily-stats tables are **deferred to the phase that uses them**, so no
  unused tables ship.
- The `operator_id` columns **keep their DEFAULT** (the default operator) for
  now, so the unchanged code still writes valid rows. Phase 2 removes the
  defaults once every write path passes the operator explicitly.
- `operator_settings` is **not** back-filled. Lookups fall through to the
  platform `settings` table, which gives the same values with no duplicate
  source of truth.
- `uniq_live_game_per_operator` and the `telegram_users` unique swap (M7) move
  to Phase 2, where the engine and login code change with them.
- **Known Phase 1 gap:** room price/capacity is still read from `settings`.
  If you change ETB5/ETB10 prices in the admin panel before Phase 2 ships,
  `operator_rooms` goes stale. Phase 2 makes `operator_rooms` the source.
- Verified by: a rehearsal on a restored copy (row counts per table
  unchanged, ledger UPDATE still rejected, new rows get the default
  operator), 114/114 backend tests, a clean `tsc`, and a live
  purchase + release smoke test.

| File | Change |
|---|---|
| `backend/prisma/schema.prisma` | §2 models and columns |
| `backend/prisma/migrations/2026…_operators_foundation/` | M1–M2 |
| `…_operator_id_immutable_tables/` | M3 (constant-DEFAULT trick) |
| `…_operator_id_scoped_tables/` | M4 |
| `…_rooms_and_slots_backfill/` | M5 |
| `…_operator_settings_backfill/` | M6 |
| `…_tenant_constraints/` | M8 |
| `backend/prisma/seed.ts` | Default operator, new permission keys with `scope`, staff presets |
| `backend/src/common/operator.constants.ts` (new) | `DEFAULT_OPERATOR_ID` |

### Phase 2: tenant context and scoping (fixes S1, S3, S4, S7)

**Status: Phase 2a done** — migration `20260925140000_operator_isolation`
plus the code changes below. As built:

- **Player side is fully isolated.** The player's operator comes from their
  own account row on every request, never from client input.
  - Login verifies `initData` against the entered operator's own bot
    (no fallback).
  - The same Telegram user gets a separate account and wallet per operator.
  - Purchases resolve the room from the game's own operator inside the game
    lock, and respect deactivated numbers and per-room limits.
  - Deposits, withdrawals, bonuses, referrals, the leaderboard, game rules,
    contact info, and the Telebirr account are all per-operator.
- **Settings:** the default operator keeps reading the legacy `settings`
  table. Other operators read only `operator_settings` and then the
  built-in defaults, so they never inherit yena's Telebirr account.
  - The legacy `ETB5_*`/`ETB10_*` keys write through to `operator_rooms`,
    which closes the Phase 1 gap.
- **Engine:** one loop per active operator. Each operator's tick is guarded
  against overlapping itself, and a failure is isolated to that operator.
  `uniq_live_game_per_operator` enforces one live game per operator.
- **Bots:** a per-operator webhook at `/telegram/webhook/<slug>` with its own
  secret. Each operator's bot answers from that operator's data. Winner,
  deposit, and withdrawal notices go out from the right bot, after the
  database commit.
- **Database backstops:**
  - Column defaults are dropped, so a write missing its operator fails.
  - `wallet_ledger.operator_id` is NOT NULL.
  - Triggers reject any ledger, deposit, withdrawal, bonus, cartela, or
    referral row whose operator doesn't match its player, game, or room.
- **Admin:** `common/tenant/operator-scope.ts` provides `readScope` and
  `writeTarget`.
  - Platform admins can filter with `?operatorId=`. Writes and
    Telegram-ID lookups default to the default operator, so the current
    admin panel is unchanged.
  - Operator-bound admins (Phase 3) are pinned to their own operator,
    including inside the deposit and withdrawal review `WHERE` clauses.
- **Verified by:**
  - A rehearsal on a restored copy of the database.
  - 123/123 backend tests (9 new isolation tests) and a clean backend `tsc`.
  - A live two-operator smoke test with 25 checks: separate
    accounts/wallets/games/prices/Telebirr/contact, cross-operator purchase
    refused, deactivated number refused, and operator suspension locking
    out only its own players.

**Status: Phase 2b done** — migration `20260925160000_game_rules_per_operator`.

- **Finance:** dashboard, settlements, reconciliation, reports, and unpaid
  withdrawals are filtered by `readScope`.
  - A platform admin's unfiltered financial report adds `by_operator`
    (deposits, paid withdrawals, house revenue, winnings, refunds, bonus
    cost per operator) from one grouped ledger query.
  - The CSV export has a total row plus one row per operator.
- **Alerts:** each alert is stamped with its operator. Listing and
  acknowledging respect the filter.
- **Audit log:** list and export are filtered.
- **Referral reports:** list, summary, and export are filtered.
- **Game rules:** each rule belongs to one operator (existing rules were
  assigned to the default operator). Admin create/update/delete/reorder
  match on (id, operator).
- **Themes:** stay a shared catalog. Editing is platform-only
  (`PlatformAdminGuard`) until operator branding in Phase 4.
- **Per-player admin routes by internal id** (ledger view/export):
  `assertPlayerInScope` rejects another operator's player.
- **Bug fixed:** a player's referral link (`/referrals/me`) was built from
  the platform bot and base URL. Other operators' players would have
  invited friends into yena, and the referral would have been silently
  dropped as cross-operator. It now uses the player's own operator's bot
  and `/o/<slug>` URL.
- **Bug fixed:** `toCsv` took its columns from the first row only, silently
  dropping columns from differently-shaped rows. It now uses the union of
  all rows' keys.
- **Verified by:**
  - 136/136 backend tests: new tests for the scope helpers,
    `PlatformAdminGuard`, and game-rule ownership.
  - A live admin smoke test with 17 checks, run as a platform admin and as
    an admin bound to the test operator. The operator-bound admin sees only
    its own players, reports, liability, reconciliation, settings, and audit
    rows. It is refused another operator's data (403/404) and the shared
    theme catalog.

**Frontend limitation until Phase 6:** the Mini App screens still render the
fixed `etb5`/`etb10` rooms. An operator whose rooms use other codes has a
working backend (lobby `room_list`, purchase by any code), but its players
won't see those rooms until the screens render `room_list` dynamically.

**Pre-existing issue found (not changed):** `CardsService.releaseCartela`
and every game refund credit the full price back to `deposited_balance`,
even when the cartela was paid from bonus. A released bonus-funded cartela
therefore turns bonus money into deposit money and escapes the wagering
requirement. This needs a decision on the intended refund rule.

| File | Change |
|---|---|
| `src/common/decorators/current-user.decorator.ts` | `RequestAdmin`/`RequestPlayer` gain `operatorId`, `role`, `impersonatorAdminId` |
| `src/common/guards/operator-scope.guard.ts` (new) | Rejects operator routes when there's no operator context; blocks writes by a non-impersonating SUPER_ADMIN |
| `src/common/tenant/scoped.ts` (new) | `scoped(ctx)` helper returning `{ operatorId }` |
| `src/auth/strategies/jwt-player.strategy.ts` | Read the `op` claim and verify the user belongs to that operator |
| `src/auth/strategies/jwt-admin.strategy.ts` | Load `operatorId`; reject if the operator is suspended |
| `src/settings/settings.service.ts` | `get(key, operatorId)`: operator, then platform, then DEFAULTS. `getGameConfig(operatorId)` returns `rooms[]` instead of the etb5/etb10 fields (keep those fields in responses for the old frontend, derived from the rooms with code etb5/etb10). |
| `src/games/games.service.ts` | Every `findFirst` scoped by `operatorId`; per-operator tick loop with advisory lock; scheduled mode |
| `src/bingo/bingo.service.ts` | `checkAutoWinAfterDraw(gameId)`, `finalizeGame(gameId)`, winning-pattern filter |
| `src/cards/cards.service.ts` + `dto/cards.dto.ts` | `roomId` (also accept legacy `room` code, resolved to the room), slot `is_active` check, in-transaction price read |
| `src/auth/auth.service.ts` | `telegramLogin` resolves the operator and upserts by `(operatorId, tgId)`; the `op` claim goes in the JWT |
| `src/telegram/telegram.service.ts` | `verifyInitData(initData, operator)` using the operator's decrypted token; `sendMessage(operatorId, …)` |
| `src/telegram/telegram-bot.controller.ts` | `/webhook/:operatorSlug` route with a per-operator secret |
| `src/wallet/wallet.service.ts` | `writeEntry` stamps `operatorId` from the user row (never from input) |
| `src/deposits/*`, `src/withdrawals/*`, `src/bonus/*`, `src/referrals/*`, `src/users/*`, `src/leaderboard/*`, `src/game-rules/*`, `src/theme/*`, `src/contact-center/*`, `src/admin/*.ts` | Scope every query; stamp `operatorId` on writes. `AdminService` line 48 in particular. |
| `src/audit/audit.service.ts` | `log()` takes the request context and records `operatorId`, `actorRole`, `impersonatorAdminId`, `userAgent`, `deviceId` |

### Phase 3: identity and security

**Status: done** — migrations `20260925180000_operator_admin_roles` and
`20260925180100_admin_security`, plus the new module
`src/operator-management/`. As built:

- **Roles:** `OPERATOR_OWNER` and `OPERATOR_STAFF` added.
  - `admins_operator_scope_chk`: platform roles have no operator; operator
    roles must have one.
  - `uniq_operator_owner`: exactly one owner per operator.
- **Permission scopes** (`rbac.constants.ts` is the source of truth; the seed
  writes `permissions.scope`): 28 operator-scoped, 10 platform-only.
  - An owner implicitly holds every operator permission.
  - Staff permissions are filtered to operator scope on every request, so a
    platform permission can never reach an operator account even if it is
    stored against one.
  - New keys: `MANAGE_OPERATORS` (platform), `MANAGE_STAFF` and
    `VIEW_LOGIN_HISTORY` (operator).
- **Approval stand-in:** until the Phase 4 approval workflow exists, operator
  accounts are refused (403) on the settings the spec says need Super Admin
  approval (`OPERATOR_APPROVAL_REQUIRED_SETTINGS`: name, cartela quantities,
  and withdrawal/bonus/referral rules). `MANAGE_BONUS_SETTINGS` is
  platform-scoped for the same reason.
- **Operator lifecycle** (`/platform/operators`, needs `MANAGE_OPERATORS`):
  - Create an operator with its owner, rooms, and slots in one transaction.
  - List; suspend, disable, or reactivate (revokes every session of the
    operator's admins immediately; the default operator can't be suspended).
  - Reset the owner's password; transfer ownership to a staff member (the old
    owner becomes staff); configure the operator's bot. Operators are never
    hard-deleted.
- **Operator self-service** (`/operator/*`):
  - The owner connects its bot. The token is validated with Telegram
    `getMe`, rejected if another operator already uses it, stored AES-GCM
    encrypted, and never returned. A fresh webhook secret is generated, the
    webhook registered, and the bot's menu button set to `/o/<slug>`.
  - Staff management needs `MANAGE_STAFF`. Delegation rule: an actor can only
    grant operator-scoped permissions it holds itself. Nobody acts on their
    own account, staff can't touch the owner, and a staff account that has
    ever signed in is disabled rather than deleted, so its history stays
    attributable.
- **Passwords:** argon2id (OWASP parameters) via `PasswordService`. Legacy
  bcrypt hashes are verified and upgraded to argon2id on the next successful
  login. An unknown username still runs a verification against a dummy hash,
  so response timing doesn't reveal which usernames exist.
- **Lockout:** 5 consecutive failures lock the account for 15 min, 10 for
  1 h, and 20 until an administrator unlocks it
  (`POST /admin-management/admins/:id/unlock`, or a password reset).
  - A locked account never reaches password verification.
  - The lock is also enforced per request, not just at login.
  - A lock is audited as `ADMIN_ACCOUNT_LOCKED`.
- **Login history:** a new `login_history` table records every admin and
  player attempt with its reason, IP, user agent, and device id. It is
  append-only (the immutability trigger) and viewable at
  `/admin/login-history`, scoped to the admin's operator.
- **Admin sessions:**
  - The access token now lasts 15 min (was 2 h).
  - The refresh token lives only in an httpOnly, SameSite=Strict cookie
    scoped to `/api/auth/admin`, and is never in a JSON body.
  - Refresh tokens are claimed atomically (two concurrent refreshes can't
    both succeed) and last 1 h idle, never past the 12 h session.
  - Replaying an already-rotated token revokes the whole session, with an
    audit entry and a login-history entry.
  - The frontend's single-flight 401 → refresh → retry interceptor sends
    `X-Device-Id`.
- **Player sessions:** refresh tokens now form a rotation family. Reuse
  revokes the whole family (the player re-signs in silently through
  Telegram), with the same atomic claim.
- **Verified by:**
  - 165/165 backend tests: new suites for argon2 and legacy bcrypt, the
    lockout ladder, the login flow (dummy-hash timing, lock before verify,
    suspended operator), refresh rotation, reuse, and the concurrent claim,
    player family revoke, role→permission computation, and staff delegation.
  - A live 42-check end-to-end test on the dev DB covering everything above,
    including the legacy-hash upgrade, the cookie flags, operator
    creation/transfer/suspension, and lockout.
- **Not yet built:** impersonation (Phase 5), security notifications (Phase 4
  notifications table), and 2FA (recommended, not in spec).
- **Not browser-tested:** the admin panel UI. The refresh interceptor is
  type-checked and the backend endpoints are tested live, but I have no
  browser here, so do one manual admin sign-in and wait 15+ minutes on the
  panel.

| File | Change |
|---|---|
| `src/auth/password.service.ts` (new) | argon2id hash/verify, bcrypt fallback, `needsRehash()` |
| `src/auth/auth.service.ts` | Lockout, login history, rehash-on-login, refresh-family rotation, reuse detection |
| `src/auth/auth.controller.ts` | `POST /auth/admin/refresh` (cookie), `POST /auth/admin/logout-all`, per-route `@Throttle` |
| `src/security/security-alerts.service.ts` (new) | New-device, lockout, token-reuse, and impersonation alerts go to `NotificationsService` |
| `src/common/crypto/secret-box.ts` (new) | AES-256-GCM helpers for bot tokens |
| `package.json` | `+ argon2`, `+ cookie-parser` |

### Phase 4: operator capabilities

**Status: Phase 4a done** — migration `20260925200000_approvals_notifications`.
As built:

- **Approval workflow** (`approvals.service.ts`, catalog in
  `approval-policy.ts`). Types: `BRANDING_NAME`, `BRANDING_LOGO`,
  `BRANDING_THEME`, `ROOM_CREATE`, `ROOM_CAPACITY_INCREASE`, `SETTING_CHANGE`
  (the withdrawal / bonus / referral rule keys).
  - Submitting stores the live value as a snapshot, supersedes any older
    pending request for the same target, and notifies the Super Admin.
  - Approving claims the request, so two reviewers can't both apply it. It is
    refused as stale if the live value changed since submission. It applies
    through the same service method a direct change uses; if that fails
    (e.g. a limit), the claim is released and the request stays pending.
    The operator is notified of the decision.
  - Reject needs a reason. The operator can cancel its own pending requests.
  - Database: `uniq_pending_approval` (one pending per operator/type/target),
    and `protect_approval_history` (no DELETE, decided rows frozen, proposal
    content immutable).
  - The Phase 3 403 stand-in is gone: an operator changing a rule setting
    through `/admin/settings/:key` now creates a request. The name and
    capacity keys point the operator to Branding / Rooms instead.
- **Notifications** (`notifications/`): a stored feed at
  `/admin/notifications` (list, mark read, read all). Platform admins get
  the platform feed (optionally filtered by operator); operator accounts get
  only their own. Events: approval pending/approved/rejected, price change,
  inventory decrease, branding change, staff created, bot connected, admin
  account locked, refresh-token reuse (critical), and large withdrawal
  (platform and operator).
- **Rooms and inventory** (`rooms.service.ts`):
  - The inventory report per room shows capacity, deactivated numbers,
    live-game sold/available, and all-time sold/revenue/winning.
  - Price, name, per-player cap, and on/off apply immediately; a price change
    notifies the Super Admin and takes effect from the next purchase.
  - Capacity decrease applies immediately but is refused below a number sold
    in the live game. Increases and new rooms go to approval for operators.
  - A cartela number sold in the live game can't be deactivated. The last
    active room can't be switched off.
  - The Super Admin can change any of this directly and reassign capacity
    between rooms or operators (`/platform/inventory/reassign`).
  - The default operator's etb5/etb10 changes are mirrored into the legacy
    settings keys.
- **Operator limits** (`limits.service.ts`, `operator_limits`):
  `MAX_ROOMS`, `MAX_TOTAL_CARTELAS`, `MIN_/MAX_CARTELA_PRICE`, and
  `MAX_STAFF`, with defaults. Set by the Super Admin, enforced on every room
  change and staff creation, and re-checked at approval time.
- **Branding** (`branding.service.ts`):
  - Name, logo, and theme go to approval; the welcome message and up to 5
    banners apply immediately (and notify the Super Admin).
  - Logos and banners are uploaded to public storage.
  - The Super Admin can override every field directly.
  - `GET /public/branding?operator=<slug>` gives the Mini App's pre-login
    splash.
  - The theme service now applies the operator's theme, logo, and first
    banner (unless the player picked a theme). The Mini App already renders
    `theme.logoUrl/bannerUrl`, so branding shows with no frontend change.
- **New permissions:** `MANAGE_ROOMS` and `MANAGE_BRANDING` (operator),
  `APPROVE_OPERATOR_CHANGES` (platform).
- **Verified by:**
  - 185/185 backend tests, including new approval-engine and room-invariant
    suites.
  - A live 30-check end-to-end test: direct vs approval-routed changes,
    supersede, stale refusal (capacity reduced after an increase request),
    approve/reject effects, frozen history, both notification feeds and their
    isolation, the price ceiling, public branding, and the player lobby
    reflecting the new price, the new room, and a deactivated number.

**Status: Phase 4b done** — migration `20260925220000_games_support_faq`.
As built:

- **Game modes.** Every operator is `continuous` (today's auto-loop,
  unchanged — the default operator stays on this) or `scheduled` (the
  operator creates each game; the engine never invents one). The Super
  Admin switches an operator between modes
  (`POST /platform/operators/:id/game-mode`); switching to continuous is
  refused while scheduled games are still pending, so none are silently
  abandoned.
- **Scheduled games** (`GamesService` additions, `games-admin.controller.ts`):
  - `POST /operator/games` creates a `scheduled` game: a start time (≥2
    minutes out, ≤60 days), when sales open (default 10 minutes before
    start), and its winning patterns. Games must be ≥10 minutes apart.
  - A new engine tick (`tickPromoteScheduled`, first in every 4s cycle)
    opens sales (`scheduled → waiting`) once `salesOpenAt` arrives and
    nothing else is live for that operator. A game whose start time
    effectively passed while an earlier game was still running, or that's
    too close to start to give players a real sales window, is cancelled as
    "missed" with a full refund rather than started with no time to sell.
  - `PATCH /operator/games/:id` can move the start time or change the
    patterns while the game is still `scheduled`, or — patterns only — while
    it's `waiting` with zero cartelas sold. The first sale locks the
    patterns, checked under the same row lock the purchase itself uses.
  - `POST /operator/games/:id/cancel` cancels a scheduled or waiting game
    and force-refunds every cartela sold, even below the normal 2-player
    floor (that floor is for the engine's automatic cancellation, not an
    operator's deliberate one). The Super Admin has the equivalent routes
    for any operator.
  - The lobby response for scheduled mode with nothing on sale returns
    `game: null` and a `next_game` (id, start time, sales-open time,
    patterns) instead of inventing one.
- **Configurable winning patterns** (`bingo-card-generator.ts`): `checkWin`
  now takes the set of patterns a game allows (row, column, diagonal,
  corners, full house — full house newly added). A claim on a pattern the
  game doesn't allow is a false claim, same consequence as claiming with no
  pattern at all. `games.winning_patterns` (`TEXT[]`, DB-checked non-empty
  and drawn only from that fixed set) is read at claim time. Continuous-mode
  games take the operator's `WINNING_PATTERNS` setting (validated the same
  way as everything else routed through `SettingsService.set`, and, for
  operator accounts, through the existing approval workflow as a
  `SETTING_CHANGE` — no new approval type needed). Every pre-existing game
  keeps the original four patterns.
- **Support tickets** (`support/`, tables `support_tickets` +
  `support_ticket_messages`, both scoped to the player's own operator by the
  same DB trigger deposits/withdrawals use):
  - Players open tickets and reply from the Mini App
    (`/support/tickets/*`). Replying on a resolved/closed ticket is refused
    — open a new one instead.
  - Operator staff/owner read and reply from `/operator/tickets/*` (needs
    `VIEW_SUPPORT_TICKETS` / `MANAGE_SUPPORT_TICKETS`, both operator-scoped);
    an admin reply moves `open → pending`, a player reply moves
    `pending → open`. Assignment is restricted to admins of that same
    operator. The platform can read (not reply to) any operator's tickets
    for oversight.
  - Messages are append-only (the immutability trigger) — a conversation is
    a record, not an editable document.
  - Opening a ticket notifies the operator (`SUPPORT_TICKET_OPENED`).
- **FAQ** (`faq_entries`, one operator each — there is no shared/platform
  FAQ): player read at `/faq`; admin create/update/delete/reorder at
  `/admin/faq`, ownership-checked the same way `GameRulesService` already
  was in Phase 2b.
- **Reports:** `financialReport` gains a `yearly` period (Jan 1 to now) and
  an explicit `from`/`to` range that overrides the fixed bucket entirely
  (the CSV export and the JSON route both take it); `period` is still
  echoed back for display even when a custom range is used. `alltime` and
  `daily`/`weekly`/`monthly` are unchanged from Phase 2b.
- **Bug found and fixed during the live test:** `SupportService.listForAdmin`
  and `getForAdmin` returned the player's raw `telegramUserId` (a `BigInt`),
  which Nest's JSON serializer cannot handle — every ticket-list call was a
  500. Fixed by converting to `Number` at the service boundary, the same
  pattern every other admin listing in this codebase already uses for that
  column.
- **Verified by:**
  - 215/215 backend tests: new suites for `SupportService` (operator
    isolation, ticket status transitions, message length limits),
    `FaqService` (ownership), and `FinanceService.financialReport` (yearly
    bucket, custom range, per-operator breakdown presence/absence) — plus
    new cases in the existing game and win-pattern suites (promote/cancel
    scheduled games, cross-operator tick isolation now covers four sub-ticks,
    full-house-only win checking).
  - A live 31-check end-to-end test: a rule-setting change routed through
    approval, an operator switched to scheduled mode, a game scheduled then
    force-promoted past its `salesOpenAt` and picked up by the real 4-second
    engine tick, a player seeing that exact game with its own patterns, a
    pattern change accepted before any sale and refused after one, an
    operator cancellation refunding a sold cartela, a support ticket's full
    open → reply → reply → resolve lifecycle across a player and two
    operator accounts (owner and a newly created support-agent staff
    member) with its messages confirmed immutable, a FAQ entry created and
    read back by a player, and both the new yearly and custom-range reports.
    This run is what caught the `BigInt` serialization bug above.
  - Test accounts and operators created during both the automated and live
    testing were removed/disabled afterward; only the two original admin
    accounts remain active.

**Multi-operator work (Phases 1–4b) is now feature-complete** against the
original request, short of the deliberately deferred pieces below.

### Phase 6 (frontend): done

- **Player Mini App**: generalized from the hardcoded `etb5`/`etb10` pair to
  any number of operator-defined rooms. `lib/types.ts`'s `RoomKey` is now
  `string` (was a two-value union); `HomeScreen.tsx`, `BingoScreen.tsx`,
  `MyCartelasScreen.tsx` and `components/GameRoom.tsx` all render by mapping
  over the backend's `room_list`/`config.rooms` instead of two fixed JSX
  blocks. `GamesService.getGameForPlayer` gained a `room_name` field so
  in-game cartela labels show the operator's real room name instead of a
  translation-key lookup that only knew about two rooms. Verified via
  `tsc --noEmit` (frontend + backend) and a live end-to-end smoke test
  (login → lobby → purchase → getGame → release) confirming `room_list`,
  `config.rooms` and `room_name` all appear correctly at runtime.
- **Admin panel**: new screens for every Phase 1–4b backend capability that
  previously had zero UI:
  - `admin/views/PlatformOperators.tsx` — operator list/create, suspend/
    reactivate/disable, game-mode toggle, owner password reset, ownership
    transfer, platform-side bot configuration, staff view (Super Admin /
    `MANAGE_OPERATORS`).
  - `admin/views/ApprovalsQueue.tsx` — `PlatformApprovalsQueue` (review/
    approve/reject any operator's pending changes) and `OperatorApprovals`
    (an operator's own submitted requests, cancellable while pending).
  - `admin/views/OperatorBot.tsx`, `OperatorRooms.tsx`, `OperatorBranding.tsx`,
    `OperatorStaff.tsx`, `OperatorGames.tsx` — the operator self-service
    console: connect a Telegram bot, manage rooms/inventory (capacity
    increases and new rooms correctly route through the approval flow),
    branding (name/logo/theme via approval; welcome message/banners direct),
    staff CRUD with delegated permission grants, and scheduled-game
    management.
  - `admin/views/SupportTicketsAdmin.tsx`, `AdminFaq.tsx` — ticket
    list/reply/status/assign and FAQ CRUD, shared between operator and
    platform contexts.
  - `admin/components/NotificationsBell.tsx` — polls `/admin/notifications`,
    shows unread count, mark-read/mark-all-read.
  - `AdminApp.tsx` nav is now role-aware: platform-level admins
    (`operatorId === null`) see Operators + Approvals Queue; operator-bound
    admins (owner/staff) see My Bot/Rooms/Branding/Staff/Games/My Approvals;
    both see Support Tickets, FAQ, and the notifications bell.
  - `adminApi.ts` grew ~50 new methods covering every route added in
    Phases 3–4b; `permissionCatalog.ts` mirrors the backend's
    operator-scoped permission list for the staff-creation checkboxes.
  - Verified with a 27-check live end-to-end smoke test against the running
    dev backend: create operator → room/branding changes submitted for
    approval → platform approves one and rejects the other → operator
    receives the notification → staff creation and permission delegation →
    bot-config route reachability → game-mode switch → schedule/list/cancel
    a game → FAQ create/list → full support-ticket lifecycle (player opens,
    agent replies and resolves). All 27 checks passed; test operators were
    disabled (never hard-deleted, by design) and scratch accounts removed
    afterward.
  - **Follow-up, now done**: `AdminService.cartelas()`/`dashboard()`
    (`backend/src/admin/admin.service.ts`) were rewritten to compute rooms
    dynamically from `OperatorRoom` instead of a shape the frontend never
    actually matched (`AdminCartelas.tsx` read `.price`/`.capacity`/`.taken`/
    `.available` off what the backend actually returned as raw per-room
    arrays of sold-cartela rows — a pre-existing mismatch, not caused by this
    phase). `cartelas()` now returns `{ rooms, holders, total_capacity,
    max_per_player, limit_violations }`; `dashboard()` gained a `rooms`
    array (`{code, name, price, capacity, available}`, operator-scoped only —
    omitted when a platform admin views the cross-operator aggregate).
    Fixing this also surfaced and fixed a **second BigInt-serialization bug**
    of the same class as the support-tickets one from Phase 4b: `holders`
    selected `user.telegramUserId` (a Prisma `BigInt`) straight into the
    JSON response, which would have thrown a 500 the first time
    `AdminCartelas.tsx` rendered a room with cartelas actually sold — caught
    before it shipped, by a live smoke test that specifically bought a
    cartela and read it back through `/admin/cartelas`. `AdminCartelas.tsx`
    now renders per-room price/capacity plus a live list of who holds each
    sold cartela; `AdminDashboard.tsx` renders one tile per room with
    available/capacity. Verified with `tsc --noEmit` (both projects) and a
    7-check live smoke test against the running dev backend.

### Phase 7 (Part 1): Postgres Row-Level Security — done, not yet activated

Migration `20260926090000_row_level_security` adds a second, independent
tenant-isolation layer beneath the application-level `operatorId` scoping
(Phases 1-4b) and its consistency triggers. It:

- Creates a new, unprivileged role, `app_runtime` — no password is set by
  the migration (a role with no password rejects every login, so this is
  safe to create in every environment without granting anyone access), and
  it is deliberately **not** the role the backend connects as today.
- Grants `app_runtime` exactly the privileges the application needs on every
  table (explicitly excluding `_prisma_migrations` — migrations run only as
  the superuser/owner, never as the runtime role).
- Enables RLS with a policy on all 23 tables that carry an `operator_id`
  (`admins`, `login_history`, `audit_logs`, `themes`, `financial_alerts` and
  `notifications` also allow `operator_id IS NULL` through, since those hold
  legitimate platform-wide rows with no single owning operator), plus a 24th
  (`support_ticket_messages`, which has no `operator_id` of its own) via a
  subquery against its parent ticket's operator. Every policy is
  unrestricted when the `app.operator_id` session variable is unset or
  empty — intentional, so a platform-level (Super Admin) connection keeps
  seeing every operator once this is switched on — and otherwise confines
  both reads (`USING`) and writes (`WITH CHECK`) to that one operator.
- Column type note the first draft got wrong and the rehearsal step caught:
  every `operator_id` column is Prisma's default `TEXT` mapping, not
  Postgres's native `uuid` type, so the policies compare as text
  (`"operator_id" = current_setting('app.operator_id', true)`) — an earlier
  version cast to `::uuid` and failed every policy with `operator does not
  exist: text = uuid` the moment it was rehearsed on a restored copy of the
  dev database, exactly the kind of mistake this project's
  rehearse-before-real-apply discipline exists to catch before it reaches
  the real database.

**What is NOT active yet, on purpose:** the backend still connects as the
`postgres` superuser (`DATABASE_URL`), and Postgres superusers bypass RLS
unconditionally, with no policy able to override that. So immediately after
this migration, application behavior is provably unchanged — this was
verified live (see below), not assumed. Turning enforcement on needs two
more deliberately-deferred steps, each consequential enough to deserve its
own careful rollout rather than being folded into this migration:
  1. Give `app_runtime` a real password out of band (never in a migration
     file) and switch `DATABASE_URL` to it.
  2. Change how the backend talks to Postgres so every operator-scoped
     request runs `SET LOCAL app.operator_id = '<id>'` inside an explicit
     transaction before its queries (`SET LOCAL` is required, not plain
     `SET` — Prisma's connection pool reuses physical connections across
     unrelated requests, and a plain `SET` would leak one request's operator
     scope into the next request that happens to reuse that connection).
     Doing this for literally every one of the ~85 existing Prisma call
     sites across ~40 services without either a large mechanical refactor or
     a new cross-cutting interception layer (and the regression testing
     either deserves) is real, scoped work of its own — see
     `docs/YENA_BINGO_MULTI_OPERATOR_ARCHITECTURE.md` Phase 7 below for
     what's left.

### Phase 7 (Part 2): RLS activated — status: done, with a documented coverage boundary

Done in a later session (2026-09-26/27), not the same sitting as Part 1, per
Part 1's own note above about giving this its own dedicated pass:

- `app_runtime` was given a real password out of band and `DATABASE_URL`
  switched to it — confirmed live (`SELECT current_user` inside the running
  backend returns `app_runtime`, not `postgres`), rehearsed first on a
  restored copy of the database per this project's standard discipline.
- `backend/src/common/tenant/` (new): an `AsyncLocalStorage`-based tenant
  context, set once per request by a global `TenantContextInterceptor` from
  the already-authenticated admin's/player's own `operatorId` (never client
  input) — not a per-call-site refactor. `setTenantOnTx()`/
  `tenantSetConfigOp()` (`common/tenant/rls.ts`) read it and issue
  `SELECT set_config('app.operator_id', ..., true)` (the function form of
  `SET LOCAL`, safe under Prisma's connection pooling) against a
  `$transaction`.
- **Coverage boundary, decided deliberately, not an oversight (Production
  Readiness Audit finding, re-confirmed by two independent audit passes with
  no active leak found):** `setTenantOnTx`/`tenantSetConfigOp` are only ever
  called from the ~20 service files that wrap a *write* in `$transaction`.
  Every bare (non-transaction) Prisma call elsewhere — the majority of
  *reads* across the codebase — never activates the RLS session variable,
  and every policy treats an unset value as unrestricted. For those calls,
  RLS provides no protection; correctness rests entirely on that service
  method's own `WHERE operatorId = ...` filter, exactly as it did before RLS
  existed. A Prisma Client Extension could intercept every query and close
  this gap universally, but that's a global behavioral change to the ORM
  layer touching all ~258 call sites — given the independently-verified
  correctness of the existing application-level scoping, the lower-risk
  choice (confirmed with the platform owner) was to keep RLS as a
  defense-in-depth backstop for the write paths that already use it, and
  document the real boundary clearly rather than expand it blind. See the
  comment block in `common/tenant/rls.ts` for the same note kept next to the
  code it describes.
- Production wiring (`docker-compose.prod.yml`, `docker-entrypoint.sh`):
  `APP_RUNTIME_PASSWORD` is set on the role automatically at container
  startup, before the app itself starts — so this is active from a fresh
  deploy's first boot, not a manual post-deploy step.

**Verification performed:** `pg_dump` backup of the dev database, restored
into a scratch database, migration rehearsed there first (catching the
`text = uuid` bug above), then applied for real via `prisma migrate deploy`.
With a password set on the *scratch* database's copy of `app_runtime` only
(the real dev database's role has no password and stays inert), a 9-check
verification connected as that role directly and confirmed: with no
`app.operator_id` set, all 21 players across every operator are visible
(platform bypass); scoped to one operator, only that operator's players are
visible (not the other 20); a direct cross-operator id lookup returns zero
rows rather than erroring; an `INSERT` with a mismatched `operator_id` is
rejected (`new row violates row-level security policy`); a matching insert
succeeds; nullable-column platform rows stay visible while scoped;
unsetting the scope restores full visibility; and the indirect
`support_ticket_messages` policy correctly follows its parent ticket. The
scratch database was dropped afterward; the real dev database was
unaffected throughout (nothing but the 24-policy migration itself was
applied to it). The full backend test suite (18 files, 215 tests) and a
live smoke test of the admin dashboard/cartelas endpoints were re-run
afterward and still pass — this migration touches no application code, only
the database, so that was expected, not a coincidence.

### Phase 5 (partial): admin two-factor authentication — done

TOTP (RFC 6238) for admin accounts, implemented directly against Node's
built-in `crypto` rather than adding a dependency (the same approach this
codebase already takes for password hashing and secret encryption):

- `backend/src/common/crypto/totp.ts` — base32 encode/decode, HOTP (RFC
  4226), TOTP, a ±1-step (90s) clock-drift window, and an `otpauth://` URI
  builder for authenticator apps. Verified against all 5 of RFC 6238
  Appendix B's official test vectors (truncated to 6 digits, since 6-digit
  and the RFC's 8-digit vectors are the same value mod 10^6) — proof against
  the spec, not just internal self-consistency. 14 unit tests total,
  including replay-protection and clock-drift edge cases.
- Migration `20260926150000_admin_totp` adds four nullable/defaulted columns
  to `admins` — a plain metadata-only `ALTER TABLE`, rehearsed on a scratch
  copy first per this project's usual discipline (low risk here, but kept
  consistent).
- `AdminUser.totpSecretEncrypted` is AES-256-GCM encrypted with the same
  `PLATFORM_ENCRYPTION_KEY` already used for operator bot tokens — never
  stored or returned in plaintext, and `totpEnabled` only flips true once
  `confirmTotp` proves the admin actually possesses a working code.
- Login becomes two-step for an account with 2FA on: `POST /auth/admin/login`
  returns `{status: 'twofa_required', challengeToken}` (a 5-minute JWT)
  instead of a session; `POST /auth/admin/2fa/login` exchanges that plus a
  live code for the real session. A wrong code counts toward the same
  lockout ladder as a wrong password (`AuthService.recordFailedLoginAndMaybeLock`,
  extracted from the existing wrong-password path so both share it exactly).
  `totpLastUsedCounter` blocks replaying an observed code a second time,
  even within its own still-valid 30s window — verified live, not assumed:
  a code that just succeeded is rejected if replayed immediately, and is
  still rejected against a brand-new login challenge afterward.
- Self-service enroll/disable: `POST /auth/admin/2fa/setup` (returns a
  secret + otpauth URI), `POST /auth/admin/2fa/confirm` (turns it on),
  `POST /auth/admin/2fa/disable` (requires the current password — a higher
  bar for removing a security control than for adding one). Recovery path
  for a lost authenticator: `POST /admin-management/admins/:id/2fa/disable`,
  Super-Admin-only, matching the existing `unlock`/`reset-password` pattern.
- Frontend: `AdminApp.tsx`'s login form now has a second step for the
  6-digit code when challenged; a new **Account Security** screen (visible
  to every admin, no permission gate — it only ever touches the signed-in
  admin's own account) handles enroll/confirm/disable; `AdminManagement.tsx`
  gained a 2FA column and a "Force off 2FA" recovery button per admin.
- Verified with a 16-check live smoke test against the running dev backend:
  enroll → wrong-code rejection → correct-code confirmation → `/me` reflects
  `totpEnabled: true` → next login returns a challenge, not a session →
  wrong code rejected → correct code (from a fresh 30s window, deliberately
  waited for — an immediately-recomputed code would still be inside the
  just-spent window and get replay-rejected, which is correct behavior, not
  a bug) completes the session → immediate replay of that code rejected →
  replay rejected again against a brand-new challenge → the force-disable
  route correctly 403s a non-Super-Admin token → self-disable rejects a
  wrong password → self-disable with the right password turns 2FA off →
  login is single-step again afterward. Full backend suite (19 files, 229
  tests) re-run and passing.
- **Not built** (explicitly out of scope for this pass): backup/recovery
  codes for a lost-authenticator self-recovery without waiting on a Super
  Admin. The Super-Admin force-disable path covers the same real-world need
  today; recovery codes would be a genuine but separate addition.

### Phase 5 (partial): Super Admin impersonation ("view as") — done

Lets a Super Admin act with an operator owner's or staff member's own
permissions for support debugging, without knowing their password:

- Migration `20260926180000_admin_impersonation` adds two nullable columns
  to `admin_sessions` (`impersonated_by_admin_id`, `impersonation_reason`) —
  another plain metadata-only `ALTER TABLE`, rehearsed on a scratch copy
  first.
- `POST /admin-management/admins/:id/impersonate` (Super-Admin-only, reuses
  the same `assertNotSelf`/`assertNotSuperAdmin` guards every other
  admin-management action already enforces) creates a **new** `AdminSession`
  for the target account — same shape as a real login session, just tagged
  with the real actor — and signs it a normal access token. Deliberately
  **no refresh token or cookie**: the session just expires on its own
  30-minute TTL rather than rotating forever, so a forgotten open
  impersonation tab doesn't stay valid indefinitely.
- `JwtAdminStrategy` surfaces `impersonatedByAdminId` on every request's
  `RequestAdmin`, so it costs nothing extra to check anywhere in the app —
  used today to block the impersonated session from changing its own
  security settings (`assertNotImpersonating` guards `2fa/setup`,
  `2fa/confirm`, `2fa/disable`) while leaving every normal operator action
  (rooms, deposits, games, ...) fully usable, which is the actual point of
  the feature — the Super Admin needs to see and act exactly as the operator
  does, not a restricted subset.
- `POST /auth/admin/impersonation/exit` ends it: revokes the session and
  audits `IMPERSONATION_ENDED` against the **real actor's** id, not the
  impersonated account's — same for the `IMPERSONATION_STARTED` bookend.
  Both operator and platform are notified when an impersonation starts or
  ends (transparency: the operator whose account was viewed knows it
  happened).
- Frontend: `PlatformOperators.tsx`'s staff tab gained a "View as" button
  (requires typing a reason, shown to the operator); `AdminApp.tsx` swaps
  the stored token to the impersonation session while remembering the
  original one in memory, shows a persistent orange banner ("Viewing as
  X — Exit") for the duration, and restores the original session on Exit.
- **Known limitation, accepted rather than fixed in this pass**: the
  impersonation token isn't remembered across a hard page refresh (it's
  in-memory only, not persisted) — refreshing mid-impersonation and then
  exiting logs out entirely rather than returning to the Super Admin's own
  session; they sign back in normally. Separately, the browser's existing
  admin-refresh-token cookie (from the Super Admin's own earlier login) is
  untouched by impersonation, so if the impersonation access token expires
  before Exit is clicked (15 minutes), the frontend's silent-refresh
  interceptor will transparently restore the Super Admin's *own* session
  using that cookie rather than erroring — a confusing but not
  security-relevant edge case (it fails safe, back to the legitimate
  actor's own identity, never to someone else's). Properly fixing either
  requires more deliberate session/cookie handling around start/stop and
  was left out to keep this pass's scope to the actual audit/access-control
  guarantees, not every rough UX edge.
- Audit trail fidelity is intentionally bounded: only the two bookend events
  (`IMPERSONATION_STARTED`/`_ENDED`) explicitly record both the real actor
  and the target. Every *other* action taken during the session is audited
  exactly as if the target admin did it themselves (because, as far as the
  rest of the app is concerned, they did — same session, same permissions).
  Reviewing "what happened during impersonation X" today means
  cross-referencing that admin's audit rows against the bookend timestamps,
  not a per-row impersonator stamp. Threading the real actor through every
  audit call site across the codebase would be the RLS-Part-2-style large
  mechanical change this project has been deliberately avoiding rushing —
  a real, scoped follow-up if finer-grained audit fidelity is ever needed.
- Verified with 7 unit tests (mocked Prisma/JWT/audit/notifications:
  happy path, self-impersonation refused, Super-Admin-target refused,
  inactive-target refused, nonexistent-target refused, ending audits the
  real actor not the target, ending a non-impersonated session is refused)
  plus a 12-check live smoke test against the running dev backend. The live
  test fabricated an impersonation session directly (a real `AdminUser` +
  `AdminSession` row with `impersonated_by_admin_id` set, signed with the
  server's actual `JWT_ACCESS_SECRET`) rather than calling the guarded start
  endpoint, since a second `SUPER_ADMIN` cannot exist
  (`uniq_single_super_admin`) and this session has no way to safely
  authenticate as the real one — the fabricated session is byte-for-byte
  what `startImpersonation` itself would have produced, so this is a faithful
  test of everything downstream of that call, and the Super-Admin gate on
  the start endpoint itself was verified separately (403 for a non-Super-Admin
  token). Confirmed live: `/me` shows the target's identity with
  `impersonating: true`; all three 2FA self-service routes correctly 403;
  a normal operator route (room inventory) still works; exit revokes the
  session (the same token 401s immediately after); exiting twice 401s
  rather than silently succeeding; and exiting a normal, non-impersonated
  session is rejected with 400. Full backend suite re-run and passing
  (19 files, 236 tests). Scratch fixtures cleaned up afterward (the scratch
  operator was disabled, not hard-deleted, once it had audit-log rows
  referencing it — the same `ON DELETE RESTRICT` invariant this project has
  relied on since Phase 1).

### Phase 5 (partial): Telegram push alerts — done; email/SMS not built

"Security-notification delivery beyond the in-app feed" turned out not to
need a new external service at all — this platform already runs a Telegram
bot per operator (Phase 1) with a working, best-effort `sendMessage`. Every
`warning`/`critical` notification now pushes to any admin who's opted in, on
top of the in-app row that always gets written:

- `AdminUser.telegramAlertChatId` (nullable, self-service) — an admin pastes
  their own numeric Telegram chat id (from @userinfobot or similar) into a
  new **Telegram push alerts** section on the Account Security screen.
  Null (the default) means in-app only, unchanged from before.
- `NotificationsService.write()` now pushes after every DB write whose
  severity isn't `info`: platform notifications go to every active
  `SUPER_ADMIN`/`ADMIN` who's opted in, via the platform's own (default
  operator's) bot; operator notifications go to that operator's own opted-in
  admins, via *that operator's own bot* — each operator's alerts stay behind
  their own bot, consistent with every other per-operator boundary in this
  system. The push is best-effort and cannot fail the triggering action:
  wrapped in its own `catch`, logged, never rethrown — the exact same
  guarantee `TelegramService.sendMessage` itself already provides one layer
  down.
- `POST /auth/admin/telegram-alerts` (self-service, works even while
  impersonating — this isn't a security-control change, unlike 2FA)
  sets or clears it; `/auth/admin/me` reports the current value so the UI
  can show it's on.
- Verified two ways: 6 unit tests (mocked Prisma + Telegram) covering
  severity gating (`info` never triggers a lookup), platform vs. operator
  recipient scoping and bot selection, HTML-escaping of the title/body
  before sending, no-recipients-means-no-call, and a Telegram failure never
  propagating out of `notifyPlatform`/`notifyOperator`; plus a live check
  against the *real* configured bot token (`TELEGRAM_BOT_TOKEN` in this dev
  environment) with a deliberately bogus chat id — Telegram replied
  `400 Bad Request: chat not found` rather than an auth error, proving the
  token itself is valid and reachable — then a live end-to-end run (set a
  chat id via the real endpoint, trigger a real `ADMIN_ACCOUNT_LOCKED`
  warning through the real 5-failed-logins lockout path, confirm the server
  stayed healthy and responsive throughout the live push attempt). No real
  Telegram chat existed to actually receive the message (this session has
  no way to read a Telegram client), so delivery *into* a real chat was not
  observed directly — everything on this project's side of that boundary
  was.
- **Not built**: email or SMS delivery. Given a working push channel already
  existed for free, and the original request said "push/email" as
  alternatives, not both, this was judged sufficient — email/SMS would need
  a real provider (SMTP relay, SendGrid, Twilio, ...) and credentials this
  session doesn't have, and would be a separate, honestly-scoped addition
  if ever wanted.

**Deferred at the time this section was written, since done (see Phase 7
Part 2 below and `load-tests/` respectively):**
- Phase 7 Part 2 (activating the RLS layer above) — done in a later session;
  see the Phase 7 Part 2 section below for what shipped and its documented
  coverage boundary.
- Full k6 load testing — the `stress-test/` suite predates this backend
  entirely (its README and scripts target Supabase, which this project
  migrated off before Phase 1 of the multi-operator work even started) and
  is kept only for historical reference; `load-tests/yena-bingo-load-test.js`
  replaces it for the current NestJS API and is multi-operator aware. A
  smoke-scale run against local dev has been validated (see its own commit
  history); the actual 100-5000-user capacity runs still need a dedicated
  staging deployment.

### Phase 7 hardening: cross-instance safety for the per-operator game-tick cron — done

"Running two backend instances" had a specific, already-documented gap, not
just an unknown: `GamesService.callNumbersTick()`'s in-process `ticking` Set
only stops one instance's own tick from overlapping itself — a second
replica running the same 4-second cron against the same operator would have
raced it, at minimum doubling the call rate, at worst racing two
finalizations of the same game. This was the one piece of "unverified
beyond a single process" with a concrete, fixable mechanism, so it's the
piece that got fixed and proven, rather than a generic capacity test:

- `GamesService.withOperatorLock()` wraps `tickOperator(operatorId)` in a
  Prisma interactive transaction that first takes
  `pg_try_advisory_xact_lock(hashtext(operatorId))` — a non-blocking
  Postgres session lock scoped to that one transaction, so it's held on a
  single pinned connection for the tick's entire duration and released
  automatically when the transaction ends, with no separate unlock call and
  nothing to leak if the tick throws. A replica that loses the race skips
  that operator for that tick and simply waits for the next one — the same
  "skip, don't queue" semantics the existing in-process guard already used
  for a single instance's own overlapping ticks. `hashtext` folds the
  operator UUID into the 32-bit key the lock function takes; a hash
  collision between two different operators would make one operator's tick
  briefly wait behind another's — never a correctness problem, and
  astronomically unlikely at any realistic operator count.
- This is a genuinely small, low-risk change — one method in one service —
  unlike Phase 7 Part 2's RLS activation, which would need touching how
  every one of ~40 services talks to the database. That difference in
  blast radius is exactly why this got done in the same pass and RLS Part 2
  didn't.
- Verified two ways. Four new unit tests (mocked Prisma): wins the lock and
  runs the tick; loses the lock and never runs it; the lock is keyed per
  operator (winning for one says nothing about another); and
  `callNumbersTick` still fully processes every operator it wins the lock
  for even when another operator in the same tick loses theirs. Full
  backend suite re-run and passing (20 files, 249 tests).
- Then a **live two-instance test**, the real point of this work: a second
  backend process was started on a different port against the exact same
  Postgres/Redis this session's primary dev instance already uses (a static
  copy of `dist/` was used for the second process specifically to avoid two
  concurrent `nest start --watch` compilers racing to write the same `dist/`
  output — an incidental hazard of testing this on one machine, not
  something a real multi-instance deployment would hit). With both
  instances live and both running the 4-second tick cron against the same
  operator, a real game was started with two real players and watched
  directly in the database: **15 calls appeared over 61 seconds — one every
  ~4.07 seconds**, matching the single-instance cron rate almost exactly.
  Had the lock not been working, the expected rate would have been roughly
  double (~1 every 2 seconds, two independent instances each advancing the
  game on their own cron fire). Also confirmed: exactly one live game
  existed for the operator throughout (no duplicate-creation race), and
  neither instance logged an error during the test window.

| File | Change |
|---|---|
| `src/operators/` (new module) | `operators.service.ts` (CRUD, limits, bot setup, ownership transfer), `operator-branding.service.ts`, `operator-rooms.service.ts`, `inventory.service.ts`, `operator-staff.service.ts` |
| `src/approvals/` (new module) | `approval-policy.ts`, `approvals.service.ts`, `handlers/*.ts`, controllers for `/operator/approvals` and `/platform/approvals` |
| `src/notifications/` (new module) | `notifications.service.ts` (write + list + read), optional Telegram push to the Super Admin's chat |
| `src/support/` (new module) | Tickets + messages (player-side `POST /api/support/tickets` in the Mini App) |
| `src/faq/` (new module) | FAQ CRUD |
| `src/reports/` (new module) | Nightly `operator_daily_stats` rollup cron; day/week/month/year queries; CSV export (reuse `common/csv.ts`) |
| `src/admin-management/admin-management.service.ts` | Scope + delegation rules (§6); OPERATOR_OWNER creates staff |
| `src/common/rbac.constants.ts` | New keys with scope metadata |

### Phase 5: Super Admin console (backend)

| File | Change |
|---|---|
| `src/platform/` (new module) | `/platform/*` controllers: operators, impersonation, approvals, cross-operator monitoring, reports, audit search |
| `src/platform/impersonation.service.ts` | Start/end impersonation sessions, restrictions, audit |

### Phase 6: frontend

| File | Change |
|---|---|
| `src/lib/operator.ts` (new) | Resolve the operator slug from `/o/:slug`, `Telegram.WebApp.initDataUnsafe.start_param`, or the default |
| `src/lib/api-client.ts`, `src/lib/session.tsx` | Send `operatorSlug` on login; load branding before the login splash |
| `src/config/brand.ts`, `src/lib/theme.tsx` | Branding from the API instead of constants (the theme system already swaps 8 CSS vars, so no component changes) |
| `src/screens/BingoScreen.tsx`, `HomeScreen.tsx`, `MyCartelasScreen.tsx`, `components/GameRoom.tsx`, `lib/useLobby.ts`, `lib/types.ts` | Render `rooms[]` dynamically instead of the fixed etb5/etb10 pair (the 15 files found by grep) |
| `src/admin/AdminApp.tsx` | Role-aware navigation: Platform console vs Operator console; impersonation banner |
| `src/admin/views/platform/*` (new) | Operators list/detail, limits, approvals queue, cross-operator dashboard, reports, audit search, notifications |
| `src/admin/views/operator/*` (new) | Branding (shows pending approvals), rooms and inventory grid, games scheduler, staff, support tickets, FAQ, reports |
| Existing `src/admin/views/*` | Reused inside the operator console; add an operator column/filter when viewed by the Super Admin |

### Phase 7: hardening

| Item | Change |
|---|---|
| Postgres RLS | Policies on every tenant table; `PrismaService` sets `app.operator_id` per request transaction |
| Load test | Update `stress-test/` k6 scripts (they still post the old payload) for N operators × concurrent players |
| Isolation test suite | For every operator route: operator A's token must get 404/403 on operator B's IDs |

**Rough effort:** about 7–10 weeks for one experienced full-stack developer,
or 4–6 weeks for two. Phases 1–2 are the riskiest (money paths) and should
not be rushed.

---

## 10. Production Deployment Considerations

- **Server size.** The current plan (1 GB RAM / 1 vCPU with cPanel on the
  same box) is already below this app's single-operator requirement.
  Multi-operator adds a game loop per operator plus reporting jobs. Minimum
  for launch with a handful of operators: **4 GB RAM / 2 vCPU**, Postgres
  `shared_buffers ≈ 1 GB`. Move Postgres to its own server or a managed
  instance before roughly 10 active operators.
- **One backend instance until Phase 7.** The crons (number calling,
  cleanup, rollups) run in-process. The per-operator advisory lock added in
  Phase 2 makes a second instance *safe*, but test that before relying on it.
- **Webhooks.** Each operator bot is registered to
  `https://yena-bingo.com/api/telegram/webhook/<slug>` with its own secret
  token. The Apache reverse proxy from the cPanel guide already forwards
  `/api/*`, so no proxy change is needed.
- **Operator URLs.** Path-based (`https://yena-bingo.com/o/<slug>`) works
  with your existing single cPanel domain and SSL certificate. Custom
  per-operator domains (`bingo.operator.com`) would need a vhost + AutoSSL
  per domain in WHM, so defer them.
- **Secrets.** Add `PLATFORM_ENCRYPTION_KEY` to `.env.production` and
  `docker-compose.cpanel.yml`. Losing it makes every stored bot token
  unreadable, so back it up separately from the DB dumps.
- **Release order:** backup → deploy Phase 1 migrations (no behavior change)
  → verify the ledger totals query → deploy the Phase 2 code **in the same
  release as M7** → smoke test with the default operator → only then create
  operator #2 as a test operator with no real money.
- **Monitoring.** Add a per-operator label to the existing Prometheus
  metrics (`gameCronLastSuccessTimestamp{operator}`) so one stuck operator
  loop is visible.
- **Backups.** Keep daily `pg_dump` off-server (existing guide). With
  multiple operators' money in one DB, add point-in-time recovery (WAL
  archiving) before onboarding paying operators.
