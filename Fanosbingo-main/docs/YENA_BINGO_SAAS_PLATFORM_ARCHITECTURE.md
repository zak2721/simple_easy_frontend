# YENA Bingo → Commercial SaaS White-Label Platform — Architecture & Implementation Plan

Status: **design, not yet implemented.** Continues the numbering and evidence-based style of `YENA_BINGO_MULTI_OPERATOR_ARCHITECTURE.md` (Phases 0-7, all shipped). Based on a direct read of the current codebase, not assumption — every "already exists" claim below cites the file that proves it.

---

## 0. The central finding: this is 80% already built

The business ask — "create customer accounts, each customer gets an admin URL/username/password, customizes their own bingo business, Super Admin sees and controls everything, sensitive changes need approval, tenants are isolated" — **is a description of the multi-operator platform that already exists**, in SaaS vocabulary instead of multi-tenant vocabulary. Mapping the request's terms onto what's already shipped:

| Request's term | Already exists as |
|---|---|
| "Customer" | `Operator` (`schema.prisma`) |
| "Customer account / login" | `AdminUser` with `role: OPERATOR_OWNER`, `operatorId` set |
| "Customer sees only their own operation" | Application-level `operatorId` scoping + Postgres RLS (`backend/prisma/migrations/20260926090000_row_level_security`) |
| "Customer branding control" (name, logo, theme, colors, welcome message) | `OperatorBranding` + `PUT /api/operator/branding` (`operator-config.controller.ts`) |
| "Customer game control" (create/schedule games, cartelas, prices, patterns) | `OperatorRoom`, `CartelaSlot`, `GamesService.scheduleGame/updateGame`, `OPERATOR_APPROVAL_REQUIRED_SETTINGS` |
| "Customer contact center" | `contact-center/` module — phone/Telegram/email/support hours already in the lobby response (`contact: {telegram, phone, whatsapp, email, support_hours}`) |
| "Customer staff management" | `operator-management/staff.service.ts` — `OPERATOR_STAFF` role, permission delegation, presets |
| "Super Admin sees everything" | `PlatformOperatorsController`, `?operatorId=` filters on every admin list endpoint, `AuditService.list()` |
| "Approval system for sensitive changes" | `ApprovalRequest` model + `approval-policy.ts` registry + `ApprovalsService` (idempotent claim-then-apply) |
| "Suspend/reactivate/delete/reset password" | `Operator.status: active\|suspended\|disabled`, `resetOwnerPassword`, `transferOwnership` (`operator-management.service.ts`) |
| "Audit logging, immutable" | `audit_logs` table with a DB trigger blocking UPDATE/DELETE (`20260919032018_ledger_immutability`) |
| "Multi-tenant security" | Verified in `PRODUCTION_READINESS_AUDIT.md` Phase 4 — no active tenant-isolation bug found across the audited surface |

**What's genuinely missing** — the actual net-new work in this document — is narrower than the request implies:

1. **Subscription/plan system** — no concept of a named plan bundling limits; `OperatorLimit` exists but each key is set independently, not as a plan.
2. **Structured customer onboarding** — `create()` requires the Super Admin to invent the owner's password by hand (`operator-management.service.ts:80`); there's no auto-generated temporary password, no forced-password-change-on-first-login flag, no captured business contact fields (phone/email) on the customer record.
3. **Content pages** — About Page, Terms & Conditions, Game Instructions, Responsible Gaming Rules don't exist as content types. (FAQ and Game Rules do, as their own models — Terms/About/Responsible-Gaming need the same treatment.)
4. **Marketing Manager staff preset** — the other four presets (Deposit/Withdrawal/Support/Game Manager) exist; this one doesn't.
5. **"Delete customer" semantics** need to be explicitly reframed for a paying-customer context (see §4 and §7) — the codebase already deliberately never hard-deletes an operator (`operator-management.service.ts:24-26`: "every money row references them with ON DELETE RESTRICT"), which is correct and must not change, but the SaaS UI needs to communicate this clearly since a customer who's been *sold access* will reasonably ask "if I cancel, is my data really gone?"

Everything else below extends existing infrastructure. No table, service, or guard described in the multi-operator doc is rebuilt.

---

## 1. SaaS Architecture Design

No new architectural layer. The commercialization work is:
- A new `SubscriptionPlan` model + one FK on `Operator` (§2).
- Extending the existing `OperatorManagementService.create()` onboarding flow (§4).
- A new `OperatorContentPage` model, following the exact pattern `FaqEntry`/`GameRule` already use (§2).
- New entries in the existing `approval-policy.ts` registry (§6) — zero new approval *mechanism*.
- A new staff preset definition (§3) — zero new permission *mechanism*.

The request's phrase "customers receive an Admin Panel URL, Username, Password" maps exactly onto the existing per-operator deep-link pattern already used for the Mini App (`https://yena-bingo.com/o/<slug>`, `docs/YENA_BINGO_MULTI_OPERATOR_ARCHITECTURE.md` §4) — the admin panel is already served from the same origin (`/admin`) and already resolves the logged-in admin's own operator from their JWT, so **no per-customer admin subdomain or separate deployment is needed**. "Admin URL" for a customer is simply `https://<your-domain>/admin` plus their username/password — one login page, tenant resolved server-side from the account, not the URL. This is simpler than a typical multi-tenant SaaS precisely because the isolation already lives in the data layer, not the routing layer.

---

## 2. Multi-Tenant Database Design (additive only)

```prisma
enum SubscriptionStatus { trialing active past_due cancelled }

/// A named, sellable bundle of OperatorLimit values + feature flags. Plans
/// are rows, not hardcoded enum values, so the Super Admin can add a plan
/// (or change Starter's limits) without a deployment.
model SubscriptionPlan {
  id          String   @id @default(uuid())
  key         String   @unique          // "starter" | "professional" | "enterprise" | custom
  name        String                    // display name shown to the Super Admin and (read-only) the customer
  monthlyPriceMinor Int?  @map("monthly_price_minor")  // informational only — billing/invoicing is out of scope, see §5
  currency    String?  @default("ETB")
  limits      Json                      // e.g. {"MAX_STAFF": 5, "MAX_ROOMS": 2, "MAX_TOTAL_CARTELAS": 1000, "MAX_GAMES_PER_DAY": 50}
  features    String[] @default([])     // feature flags this plan unlocks, e.g. "REFERRALS", "CUSTOM_DOMAIN", "API_ACCESS"
  isActive    Boolean  @default(true) @map("is_active")   // retired plans stay for existing subscribers, hidden from new signups
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  operators   Operator[]
  @@map("subscription_plans")
}
```

```prisma
// Additive columns on the EXISTING Operator model — no rename, no removal.
model Operator {
  // ...existing fields unchanged...
  subscriptionPlanId     String?             @map("subscription_plan_id")
  subscriptionPlan       SubscriptionPlan?   @relation(fields: [subscriptionPlanId], references: [id], onDelete: Restrict)
  subscriptionStatus     SubscriptionStatus  @default(trialing) @map("subscription_status")
  subscriptionStartedAt  DateTime?           @map("subscription_started_at")
  subscriptionExpiresAt  DateTime?           @map("subscription_expires_at")
  // Business/owner contact fields the onboarding form collects (request's
  // "Phone Number", "Email") but that don't belong on AdminUser (an operator
  // can change owners via transferOwnership without losing its own business contact record).
  businessPhone          String?             @map("business_phone")
  businessEmail          String?             @map("business_email")
}
```

```prisma
enum ContentPageType { ABOUT TERMS_AND_CONDITIONS RESPONSIBLE_GAMING GAME_INSTRUCTIONS }

/// Long-form branded content — same shape as FaqEntry/GameRule (dedicated
/// table, not an OperatorSetting string value, because these are prose, not
/// config). One row per (operator, page type); platform can seed a default
/// (operatorId null) that a new operator starts from, same convention FaqEntry
/// already uses for "operatorId null = platform-wide".
model OperatorContentPage {
  id            String          @id @default(uuid())
  operatorId    String?         @map("operator_id")
  pageType      ContentPageType @map("page_type")
  title         String
  bodyMarkdown  String          @map("body_markdown")
  updatedAt     DateTime        @updatedAt @map("updated_at")
  updatedByAdminId String?      @map("updated_by_admin_id")
  @@unique([operatorId, pageType])
  @@map("operator_content_pages")
}
```

**Row-Level Security**: `operator_content_pages` gets the identical `tenant_isolation` policy shape already applied to every other operator-scoped table in the RLS migration — same `USING`/`WITH CHECK` clause as `operator_settings` (nullable-operator variant, since a platform-wide default page has `operator_id IS NULL`). `subscription_plans` is **not** RLS-scoped — it's a platform-owned catalog, like `themes`, readable by every operator but writable only by the platform (same pattern as the existing shared theme catalog).

**Migration ordering** (extends §3 "Migration Strategy" pattern from the multi-operator doc — additive columns get a constant default, mutable tables get a normal migration, nothing here touches an immutable table):
1. `subscription_plans` table + seed three rows (Starter/Professional/Enterprise) with sane default limits.
2. `operator.subscription_plan_id` (nullable FK, `DEFAULT NULL`) + `subscription_status` (`DEFAULT 'trialing'`) + `business_phone`/`business_email` (nullable) — pure additive columns, zero risk, matches the exact "M3/M4 constant-default" technique already used for `operator_id` backfills.
3. `admins.must_change_password` (`BOOLEAN DEFAULT false`) — see §4.
4. `operator_content_pages` table + RLS policy, in the same migration style as `20260926090000_row_level_security`.
5. Backfill: assign every existing operator (including the default `yena` operator) to a permissive "Legacy/Unlimited" plan row so nothing currently running hits a new ceiling on deploy day — this is the same "existing data becomes the default, nothing changes until acted on" principle the original multi-operator migration used.

---

## 3. Permission System Design (one new preset, zero new mechanism)

The existing model (`common/rbac.constants.ts`) is flat, direct-assignment, with scope-checked keys (`operator` vs `platform`) — already exactly what's needed. Add one staff preset, matching the existing four (Deposit Manager, Withdrawal Manager, Support Agent, Game Manager — documented in the multi-operator doc §6, implemented as plain `AdminPermission` row bundles a staff.service.ts caller assigns, not a new stored "role"):

| Preset | Permissions |
|---|---|
| **Marketing Manager** (new) | `VIEW_REFERRALS, VIEW_REFERRAL_REPORTS, VIEW_REPORTS, EXPORT_REPORTS` |

Kept deliberately read/analytics-scoped: `MANAGE_BONUS_SETTINGS` is `platform`-scope only (rbac.constants.ts) — bonus/referral *rule changes* already require Super Admin approval per the business's own existing spec, so a Marketing Manager analyzes campaign performance but doesn't unilaterally change payout economics. If a customer wants their Marketing Manager to *propose* bonus/referral rule changes (not apply them), that's already possible today with zero new permission: `MANAGE_SETTINGS` (operator-scope) routes through `OPERATOR_APPROVAL_REQUIRED_SETTINGS` automatically for any operator-bound admin, staff included — the approval gate is enforced centrally, not per-role, per `common/rbac.constants.ts`'s existing design. `staff.service.ts`'s existing delegation rule (`assertGrantable`, "an actor can only grant permissions it holds itself") applies unchanged — no new escalation path is opened.

---

## 4. Customer Management System (the main new backend work)

### 4.1 Onboarding flow — extends `OperatorManagementService.create()`

Current: `create(actingAdminId, dto)` requires `dto.owner.password` supplied by the Super Admin (`operator-management.service.ts:80`). New:

1. **`CreateOperatorDto` gains**: `businessPhone`, `businessEmail`, `subscriptionPlanId` (optional; defaults to a "Trial" plan if omitted).
2. **Password generation**: if `dto.owner.password` is omitted, generate one server-side — reuse the exact pattern already proven for `ADMIN_KEY`/webhook secrets elsewhere in this codebase (`crypto.randomBytes`, not `Math.random`), e.g. a 12-character mixed-case+digit string.
3. **`admins.must_change_password`** (new column, §2): set `true` on the generated owner account. `JwtAdminStrategy` already re-reads the admin row on every request (`jwt-admin.strategy.ts:42-66`) — extend that same check to short-circuit every route except `POST /auth/admin/change-password` when the flag is set, forcing the first login straight into a password change. This is additive to an already-existing per-request re-validation, not a new enforcement layer.
4. **One-time credential response**: `create()`'s response includes the plaintext temporary password **exactly once**, in the API response body, never persisted or logged — the same "shown once, never stored" discipline this codebase already uses for the `ADMIN_KEY` bootstrap flow and 2FA setup secrets. The Super Admin copies it into whatever out-of-band channel they use (email/SMS/manual handoff) — this document does not scope building an email-sending onboarding flow (email notifications are separately flagged as unfinished business in `PRODUCTION_READINESS_AUDIT.md`); the response payload is the deliverable, delivery is manual until that lands.
5. **Admin URL**: computed, not stored — `https://<DOMAIN>/admin` (the same `DOMAIN` env var already used for `YENA_BINGO_APP_URL`/CORS in `docker-compose.prod.yml`). Returned alongside the credentials for convenience.

### 4.2 Customer's own view — already correctly scoped

No change needed: `OperatorSelfController`/`OperatorConfigController` already resolve everything from the authenticated admin's own `operatorId` (verified in `PRODUCTION_READINESS_AUDIT.md` Phase 4 — "operator-self routes never accept operatorId from the client"). A customer logging in today already cannot see other operators, platform settings, or system configuration — this requirement is **done**, not designed.

### 4.3 Super Admin's view — mostly already exists, one gap

`PlatformOperatorsController.list()` already returns every operator with player/admin counts and room config (`operator-management.service.ts:40-53`). What's missing for a true "nothing hidden" SaaS console: a **cross-operator drill-down view** that shows a chosen operator's deposits/withdrawals/support tickets/staff in one screen without switching into impersonation first. This is a read-only aggregation, not a new isolation mechanism — every underlying list endpoint already accepts `?operatorId=` for a platform admin (per the multi-operator doc §4 "Every existing admin list endpoint accepts `?operatorId=`"). The gap is a frontend convenience view, not a backend capability gap.

---

## 5. Subscription System

**Deliberately scoped to plan *limits*, not billing.** Payment collection, invoicing, and dunning are a distinct product (Stripe/local payment gateway integration) and are explicitly out of scope here — conflating them would violate "extend the current system," since this codebase has no payment-processing infrastructure to extend. What's built:

- `SubscriptionPlan` rows (§2) define `limits: Json` matching `LimitsService.LIMIT_DEFAULTS` keys (`MAX_ROOMS`, `MAX_TOTAL_CARTELAS`, `MAX_CARTELA_PRICE`, `MAX_STAFF`) **plus two new limit keys** the current `LimitsService` doesn't have yet: `MAX_GAMES_PER_DAY` and `MAX_ACTIVE_PLAYERS` (add to `LIMIT_DEFAULTS`, same file, same enforcement pattern — `LimitsService.get()` already merges operator-specific overrides onto defaults, no new mechanism).
- **Applying a plan** = calling the *existing* `LimitsService.set()` with that plan's `limits` bundle when a Super Admin assigns/changes an operator's plan — the subscription system is a named shortcut for "set several limits at once," not a parallel enforcement path. Enforcement stays exactly where it already is (each service that checks a limit — room creation, staff creation, cartela inventory — already reads from `LimitsService.get()`).
- **Feature flags** (`SubscriptionPlan.features`, e.g. `"REFERRALS"`, `"CUSTOM_DOMAIN"`): checked the same way `OPERATOR_APPROVAL_REQUIRED_SETTINGS` is checked today — a small guard/helper (`hasFeature(operatorId, key)`) consulted at the point of use (e.g. hide/reject referral-related endpoints if the operator's plan lacks `"REFERRALS"`). Additive checks in existing service methods, not new modules.
- **Expiry**: `subscriptionExpiresAt` checked by the same per-request admin-session revalidation already in `JwtAdminStrategy` (which already checks operator suspension on every request) — an expired subscription behaves exactly like today's "operator suspended" state (locks out that operator's admins), reusing the existing suspension mechanism rather than inventing a second lockout path.

---

## 6. Approval Workflow Design (registry additions only)

`approval-policy.ts` is already a typed map from change-type to `{requiresApproval, notifySuperAdmin}`. Add:

```ts
export const APPROVAL_POLICY = {
  // ...existing entries unchanged...
  CONTENT_PAGE_TERMS:              { requiresApproval: true },   // legal/compliance-sensitive
  CONTENT_PAGE_RESPONSIBLE_GAMING: { requiresApproval: true },   // regulatory-sensitive
  CONTENT_PAGE_ABOUT:              { requiresApproval: false },  // marketing copy, low risk
  CONTENT_PAGE_GAME_INSTRUCTIONS:  { requiresApproval: false, notifySuperAdmin: true },
} as const;
```

The lifecycle (`operator submits → ApprovalRequest(pending) → audit → notify Super Admin → approve/reject → apply via the same handler a direct change would use`) is untouched — `ApprovalsService.approve()`'s existing atomic claim-then-apply (`updateMany` scoped to `status:'pending'`, verified race-safe in `PRODUCTION_READINESS_AUDIT.md`) needs exactly one new `apply handler` function per content-page type, following the identical shape every existing handler already uses (`approvals/handlers/*.ts`). No change to the approval engine itself.

---

## 7. Security Design

Builds directly on `PRODUCTION_READINESS_AUDIT.md`'s findings rather than re-deriving them:

- **Tenant isolation**: already verified sound at the application layer across the audited surface (Phase 4 of the audit). One item from that audit becomes **higher priority once this is a paying-customer product**: the audit found RLS enforcement (`set_config('app.operator_id', ...)`) only covers ~21 files' worth of `$transaction`-wrapped writes, with 258 direct Prisma calls across 32 files relying on app-level filtering alone. That was an acceptable residual risk for a single-owner platform; it becomes a **contractual-grade guarantee** once Customer A's data must be provably inaccessible to Customer B by architecture, not just by code review. Recommend closing this gap (Prisma middleware/extension activating RLS on every query, not just wrapped writes) **before** onboarding the first paying, non-affiliated customer — this is the single highest-leverage security fix for the SaaS pivot specifically.
- **"Delete customer" must never be literal deletion.** Every money-adjacent table has `ON DELETE RESTRICT` back to `Operator` by design (`operator-management.service.ts:24-26`) — this is correct and must not be weakened to make a "Delete" button work. Implement "Delete" in the Super Admin UI as `status = disabled` (already the exact mechanism `suspend` uses one level down) plus a distinct, irreversible-sounding confirmation flow so a paying customer's expectations are set correctly: deactivation is permanent-in-effect (no login, ever, without a new account), but underlying records (their players' wallet history, deposits, audit trail) are retained per the same "never destroy financial history" invariant that protects the platform owner too (a disputed deposit six months after a customer cancels still needs its audit trail intact).
- **Temporary password delivery**: the one-time API response (§4.1) must never be logged — cross-reference `backend/src/common/logger/logger.module.ts`'s existing redact list (`req.body.password`, `req.body.adminKey`, etc.) and add the new `create()` response's password field to whatever the equivalent response-redaction covers, since this is a new place a plaintext credential briefly exists in a response body.
- **Cross-customer support boundary**: if platform-owner support staff ever need to act *as* a customer to debug an issue, that's exactly what impersonation already does (`admin-management.service.ts`) — no new "support access" mechanism should be built; route it through the existing, audited impersonation path so it inherits the existing 30-minute cap, audit trail, and permission boundaries.

---

## 8. Migration Plan

Follows the exact discipline the multi-operator doc's §3 established (rehearse on a restored copy before real apply, constant-DEFAULT trick for any column touching a table with volume, nothing changes until acted on):

| Step | Migration | Risk |
|---|---|---|
| S1 | `subscription_plans` table + seed Starter/Professional/Enterprise + a permissive "Legacy" plan | None — pure addition |
| S2 | `operator.subscription_plan_id/status/started_at/expires_at`, `operator.business_phone/business_email` — nullable, `DEFAULT NULL`/`'trialing'` | None — additive columns |
| S3 | Backfill every existing operator to the "Legacy" plan (unlimited-equivalent values matching whatever `LimitsService.LIMIT_DEFAULTS` already is) | None — existing behavior unchanged by construction |
| S4 | `admins.must_change_password BOOLEAN DEFAULT false` | None — only ever set `true` by the new onboarding path |
| S5 | `operator_content_pages` table + RLS policy (same shape as the RLS migration's nullable-operator variant, e.g. `admins`/`audit_logs`) | Low — new table, no existing data affected |
| S6 | Add `MAX_GAMES_PER_DAY`, `MAX_ACTIVE_PLAYERS` to `LimitsService.LIMIT_DEFAULTS` | None — `LimitsService.get()` already merges defaults; no migration needed, code-only |

**Rehearsal**: same scratch-database-copy procedure already used for this session's RLS activation — `CREATE DATABASE ... TEMPLATE <source>`, run S1-S5, verify row counts unchanged on every existing table, verify every existing operator resolves a non-null plan after S3, verify the app boots and a smoke-test login/purchase still works, before touching the real database.

---

## 9. File-by-File Implementation Plan

Phased so each ships independently, matching the existing Phase 0-7 convention:

### Phase 8a: subscription foundation (no behavior change)
| File | Change |
|---|---|
| `backend/prisma/schema.prisma` | `SubscriptionPlan` model, `Operator` columns (§2) |
| `backend/prisma/migrations/2026..._subscription_plans/` | S1-S3 |
| `backend/prisma/seed.ts` | Seed the three named plans + "Legacy" plan |
| `backend/src/subscriptions/subscriptions.service.ts` (new) | `list()`, `get(operatorId)`, `assign(actingAdminId, operatorId, planId)` — `assign` calls the existing `LimitsService.set()` with the plan's bundle, and writes an audit entry |
| `backend/src/operator-management/limits.service.ts` | Add `MAX_GAMES_PER_DAY`, `MAX_ACTIVE_PLAYERS` to `LIMIT_DEFAULTS` |

### Phase 8b: structured onboarding
| File | Change |
|---|---|
| `backend/src/operator-management/dto/operator-management.dto.ts` | `CreateOperatorDto`: add `businessPhone`, `businessEmail`, `subscriptionPlanId?`, make `owner.password` optional |
| `backend/src/operator-management/operator-management.service.ts` | `create()`: generate a temp password when omitted (crypto-random), set `mustChangePassword: true`, return `{adminUrl, username, temporaryPassword}` once in the response |
| `backend/prisma/migrations/2026..._must_change_password/` | S4 |
| `backend/src/auth/strategies/jwt-admin.strategy.ts` | Short-circuit to a "must change password" state when the flag is set (mirrors the existing suspended/locked checks already in this file) |
| `backend/src/auth/auth.controller.ts` | New `POST /auth/admin/change-password` (first-login path) if it doesn't already cover this — verify against existing password-change endpoints first, extend rather than duplicate |
| `backend/src/common/logger/logger.module.ts` | Extend the redact list for the new one-time credential response |

### Phase 8c: content pages
| File | Change |
|---|---|
| `backend/prisma/schema.prisma` | `OperatorContentPage` model + enum |
| `backend/prisma/migrations/2026..._operator_content_pages/` | S5, same RLS policy shape as existing nullable-operator tables |
| `backend/src/content-pages/content-pages.service.ts` (new) | Mirrors `support/faq.service.ts`'s exact shape (get/upsert per operator, fallback to platform-wide default when `operatorId` row absent) |
| `backend/src/operator-management/approval-policy.ts` | Add the four `CONTENT_PAGE_*` entries (§6) |
| `backend/src/operator-management/approvals/handlers/` | Two new apply handlers (Terms, Responsible Gaming) — direct-apply for About/Instructions needs no handler, just a normal service call |
| `src/admin/views/` (frontend) | New tab under Branding/Content for editing the four page types, reusing whatever rich-text/markdown input component the existing FAQ/Game Rules editor already uses |

### Phase 8d: staff preset + Super Admin drill-down UI
| File | Change |
|---|---|
| Wherever the existing 4 presets are defined (frontend staff-creation UI, per the multi-operator doc §6 "convenience only") | Add the Marketing Manager preset (§3) |
| `src/admin/views/PlatformOperators.tsx` (or equivalent) | Cross-operator drill-down view (§4.3) — read-only, calls existing `?operatorId=`-filtered endpoints, no new backend route required unless a genuinely new aggregate view is wanted |

---

## 10. Production Deployment Strategy

No change to the deployment shape described in `DEPLOYMENT.md` — same Docker Compose stack, same Caddy/HTTPS, same `app_runtime`/RLS wiring completed this session. Specific to this feature set:

1. **Deploy Phase 8a-8d in order**, each independently — consistent with how Phases 1-7 shipped incrementally to the live single-tenant-turned-multi-tenant platform without a big-bang cutover.
2. **Before onboarding the first external paying customer** (not before merging this code): close the RLS-coverage gap flagged in §7. Selling access changes the risk calculus enough that this should gate go-to-market, even though it didn't block the internal multi-operator launch.
3. **Backfill verification**: after S3, run a query confirming every operator (including the default `yena` operator) has a non-null `subscriptionPlanId` before deploying any code that assumes one exists — same discipline as the RLS rehearsal's "verify before trusting" checklist.
4. **Rollback plan**: every migration in §8 is additive (new tables/nullable columns) except none actually mutate or drop existing columns — a rollback is "stop using the new columns," not a schema reversal; if S1-S6 need to be undone, they can be dropped in reverse order with zero impact on existing operator/game/wallet data, mirroring the "changes the system's behavior only once acted on" principle used throughout this codebase's migration history.
5. **No new infrastructure**: no new database, no new service, no new container. This runs inside the existing `backend` container against the existing Postgres instance.
