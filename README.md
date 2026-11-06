# KoboMarket

A multi-vendor marketplace backend with wallets and escrow. Buyers pay into escrow; money is released to the vendor (minus platform commission) only after delivery is confirmed or a timeout passes.

**Stack:** Node.js, Express, MongoDB (user side), PostgreSQL (money side).

> Status: Day 4 of 14 complete (foundation, PostgreSQL ledger schema, authentication, RBAC, vendors, wallet provisioning). This README grows with each module.

## Quick start

```bash
cp .env.example .env        # then set JWT_ACCESS_SECRET to a random 32+ character value
docker-compose up --build   # starts API + MongoDB + PostgreSQL, runs migrations
npm run seed                # (seed data arrives on Day 13)
```

- API: http://localhost:3000/api/v1/health
- Swagger docs: http://localhost:3000/api-docs

### Running without Docker for the API

```bash
docker-compose up -d mongo postgres
# in .env use localhost instead of the service names:
#   MONGO_URI=mongodb://localhost:27017/kobomarket
#   DATABASE_URL=postgres://kobo:kobo_password@localhost:5432/kobomarket
npm install
npm run migrate
npm run dev
```

## Scripts

| Script | What it does |
|---|---|
| `npm start` | Start the API |
| `npm run dev` | Start with nodemon |
| `npm run migrate` | Run PostgreSQL migrations (Knex) |
| `npm run migrate:rollback` | Roll back the last migration batch |
| `npm run seed` | Seed admin, vendors, products, buyers (Day 13) |
| `npm run create-admin -- <email> <password>` | Create (or promote) a verified admin and its wallet. Needed to approve vendors until the seed exists. In Docker: `docker-compose exec api npm run create-admin -- admin@kobomarket.test 'Str0ngPassw0rd'` |
| `npm run audit:ledger` | Verify the money invariant, prints PASS/FAIL (Day 5) |
| `npm test` | Jest + Supertest against real MongoDB and PostgreSQL (`docker-compose up -d mongo postgres`). It rebuilds its own `kobomarket_test` databases each run |
| `npm run test:memory` | Same suite, but the MongoDB repositories are replaced by in-memory fakes. For machines with no MongoDB; PostgreSQL is still required |

## Project structure

```
src/
  config/        env validation (Zod), Mongo + Postgres connections
  db/
    migrations/  PostgreSQL schema (Knex). No manual table creation.
    seeds/       Seed scripts
  middlewares/   requestId, validate (Zod), central errorHandler
  modules/       One folder per module: routes -> controllers -> services -> repositories
    auth users vendors products cart wallet orders disputes payouts notifications admin
  routes/        Router mounting + health checks
  jobs/          Background jobs (auto-complete, payouts, outbox)
  docs/          Swagger/OpenAPI definition
  utils/         logger (pino), AppError, money helpers, asyncHandler
scripts/         audit-ledger.js
tests/           Jest + Supertest
```

## Architecture rules

- Layered: routes -> controllers -> services -> repositories. Business logic lives in services only.
- Every request body/query is validated with Zod.
- Every error uses one shape: `{ "success": false, "error": { "code", "message", "details" } }`.
- Structured pino logs carry a request ID; passwords, tokens and auth headers are redacted.
- All money is an integer number of kobo (N1 = 100 kobo). Commission uses integer basis points (500 = 5%). No floats anywhere.
- Business settings (commission, escrow timeout, payout minimum) come from environment config, not hard-coded values.

## PostgreSQL ledger schema (so far)

Money lives only in PostgreSQL, as integer kobo (`bigint`). The database itself refuses bad data, so a bug in application code cannot corrupt the ledger.

```mermaid
erDiagram
  accounts ||--o{ ledger_entries : "has"
  transactions ||--|{ ledger_entries : "made of"
  transactions ||--o| transactions : "reverses"
  accounts {
    uuid id PK
    text owner_type "USER or SYSTEM"
    text owner_id "Mongo ObjectId or system code"
    char3 currency
    bigint balance_kobo "cache, maintained by trigger"
    text status "ACTIVE FROZEN CLOSED"
  }
  transactions {
    uuid id PK
    text reference UK
    text type
    text status "PENDING POSTED FAILED REVERSED"
    text idempotency_key UK
    uuid reverses_transaction_id FK
    jsonb metadata
  }
  ledger_entries {
    bigint id PK
    uuid transaction_id FK
    uuid account_id FK
    text direction "debit or credit"
    bigint amount_kobo "CHECK > 0"
  }
```

**Sign convention:** for every account, `balance_kobo = SUM(credits) - SUM(debits)`.

**System accounts** (created by migration): `PLATFORM_ESCROW`, `PLATFORM_REVENUE`, `PLATFORM_PAYOUT_CLEARING`, plus `PLATFORM_EXTERNAL`, which stands for the outside world (Paystack and the bank). Funding a wallet debits `PLATFORM_EXTERNAL`, so it goes negative by exactly *total funded - total paid out*. That is what makes every balance in the system sum to zero, and why `wallets + escrow + revenue + clearing = funded - paid out`.

**What the database enforces (not the application):**

| Rule | Mechanism |
|---|---|
| `amount_kobo > 0`, direction is `debit`/`credit` | `CHECK` on `ledger_entries` |
| User wallets and all system accounts except `PLATFORM_EXTERNAL` never go negative | `CHECK (balance_kobo >= 0 OR ...)` on `accounts` |
| Ledger rows are never updated, deleted or truncated | `BEFORE UPDATE/DELETE/TRUNCATE` triggers raise `LEDGER_APPEND_ONLY` |
| Every transaction has 2+ entries, one currency, a POSTED header, and credits = debits | Deferred constraint trigger, checked at `COMMIT` |
| Cached balance always equals the ledger sum | `AFTER INSERT` trigger on `ledger_entries` updates `accounts`; direct edits to `balance_kobo` are rejected |
| Unique `reference` and `idempotency_key`; foreign keys everywhere | `UNIQUE` / `FOREIGN KEY` |
| Transactions and accounts are never deleted; identifying fields are immutable; status follows PENDING -> POSTED/FAILED, POSTED -> REVERSED | Guard triggers |

Mistakes are fixed by a new `REVERSAL` transaction, never by editing a row. The `account_reconciliation` view compares each cached balance with its ledger sum and must never show a mismatch.

Note: a database superuser can disable triggers. The application connects as an ordinary role in production deployments; the demo `docker-compose` uses the superuser for simplicity (listed under known limitations).

## Authentication (Module A)

Users live in MongoDB. Endpoints: `register`, `verify-email`, `resend-verification`, `login`, `refresh`, `logout`, `forgot-password`, `reset-password`, plus `GET/PATCH /users/me`. Full details at `/api-docs`.

| Concern | Design |
|---|---|
| Passwords | bcrypt (cost from `BCRYPT_ROUNDS`, default 12). 8-72 bytes, at least one letter and one number. The hash is `select:false` and never returned. |
| Email verification | Random 256-bit token, stored as a SHA-256 hash, valid for `EMAIL_VERIFICATION_TTL_HOURS`, single use. Login returns `403 EMAIL_NOT_VERIFIED` until verified. |
| Access token | JWT, 15 minutes, carries only `sub` and `tv` (token version). Roles and frozen status are read from the database on every request, so they are never stale. |
| Refresh token | Opaque random string, 7 days, stored only as a SHA-256 hash. **Rotated on every use**: the old one is consumed by one atomic `findOneAndUpdate`, so it works exactly once, even under concurrent requests. |
| Reuse detection | Presenting an already-used refresh token bumps the user's `tokenVersion` (every access token dies at once) and revokes every refresh token: all sessions are logged out. |
| Logout | Revokes that session's refresh-token family (the token and everything rotated from it). Other devices stay signed in. |
| Password reset | One-time token, `PASSWORD_RESET_TTL_MINUTES`. Resetting also bumps `tokenVersion` and revokes all refresh tokens. Forgot-password and resend-verification give the same reply whether or not the account exists. |
| Login throttling | 5 failed attempts per 15 minutes per **email + IP** (hashed key), then `429` with `Retry-After`, even for the correct password. Counted with atomic MongoDB updates; success resets it. |
| Mass assignment | Request schemas are `.strict()`: sending `roles`, `status` or `email` to a profile or register endpoint is rejected with 422. |

**Email.** `MAIL_TRANSPORT=console` (default) prints emails, including the verification and reset tokens, to the API's stdout; the brief allows this. It writes straight to stdout, not through the structured logger, so tokens never appear in log lines. Set `MAIL_TRANSPORT=smtp` with `SMTP_*` (for example Mailtrap) for real delivery. With Docker: `docker-compose logs -f api`.

**A race worth knowing about.** If two requests replay the same refresh token at the same instant, the replay's "log out everywhere" sweep could run *before* the winner has stored its new token, leaving one live session. `bumpTokenVersion` therefore runs before the revoke sweep, and `refresh()` re-checks the token version after storing its new token and undoes itself if it changed. A deterministic test holds the winner's write open, fires the replay in that window, and asserts no live token remains. Removing the guard makes that test fail.

## Roles and RBAC

A user has a list of roles (`buyer`, `vendor`, `admin`), so one person can be both buyer and vendor. Roles are enforced in exactly one place, the `authorize(...roles)` middleware (any listed role is enough):

```js
router.post('/products', authenticate, authorize('vendor'), controller.create);
router.use(authenticate, authorize('admin'));          // a whole router, e.g. /admin
```

Controllers and services contain no `if (user.role === ...)` checks. `authenticate` loads the user on every request, so roles are never stale: a newly approved vendor has access immediately with their existing token, and a revoked role stops working immediately. A missing token is `401`; a valid token without the role is `403 INSUFFICIENT_ROLE`.

## Vendors (Module B, part 1)

`POST /vendors/apply` (any logged-in user) creates a `pending` application with store name, description and bank details. An admin then decides: `PATCH /admin/vendors/:id/approve` or `.../reject` (a reason is required). I added `reject`, `GET /admin/vendors` and `GET /vendors/me` to the endpoints in the brief, because pending applications otherwise cannot be found, rejected, or checked by the applicant.

- Status moves `pending -> approved | rejected`, and `rejected -> pending` when the applicant fixes the application and re-applies. Each move is one atomic MongoDB update that only applies if the application is still in the expected state, so an approve and a reject racing each other cannot both win.
- Approval flips the status and then adds the `vendor` role (idempotent `$addToSet`). If the role step fails, the status is rolled back to `pending`; approving an already-approved vendor re-applies the role, which repairs a half-finished approval.
- Store names are unique case-insensitively (a lower-cased key with a unique index). One application per user.
- Bank account numbers are stored for payouts but **never returned in full**: the API shows `******6789`. The public store page (`GET /vendors/:id`, approved vendors only, no login) shows just the name and description.

## Cross-database consistency (part 1 of 2): user in MongoDB, wallet in PostgreSQL

MongoDB and PostgreSQL cannot share a transaction, so "the user was saved but their wallet was not" has to be handled explicitly. **Chosen approach: an outbox-style record plus an idempotent retrying job** (not compensation that deletes the user).

1. The user document is created with `walletStatus: "pending"`. That field is the durable record that a wallet still has to be created.
2. Immediately, the signup request tries the fast path: create the PostgreSQL account, then mark the user `ready`.
3. If anything fails, signup still succeeds and the user simply stays `pending`. A background job (`WALLET_PROVISION_CRON`, every 30 seconds) retries every pending user with exponential backoff (5s, 10s, 20s ... capped at 15 minutes).

Why this and not compensation: deleting a freshly registered user because a different database blipped is worse for the user than waiting a few seconds for a wallet, and it can itself fail. Retrying forward always converges.

Why it is safe to retry at any point:
- The account insert is `INSERT ... ON CONFLICT DO NOTHING` on `UNIQUE (owner_type, owner_id, currency)`, so there can never be two wallets for one user, even with concurrent calls.
- The job *claims* users with one atomic update that pushes their next-attempt time forward (a lease), so two job runs or two API instances never work on the same user, and a crashed worker's lease just expires.
- New users get a short grace period so the job does not race the signup request that is creating the wallet.

The failure cases are tested by injecting faults: PostgreSQL down at signup, wallet created but the `ready` flag lost, even the failure bookkeeping failing, ten concurrent provisioning calls, and concurrent job claims.

A note on wording: when planning this I described it as writing "a create-wallet row in PostgreSQL in the same transaction". That cannot work for this direction, because the MongoDB write comes first and cannot join a PostgreSQL transaction. The pending flag on the MongoDB user is the outbox entry instead. The other direction (money escrowed in PostgreSQL, then the MongoDB stock decrement fails) is handled with compensation at checkout (Day 9).

Not yet built: the wallet endpoints themselves (Day 5), which will also call the same idempotent provisioning if they ever meet a user whose wallet is still pending.

## Known limitations (so far)

- Vendor bank account numbers are stored in plain text in MongoDB (masked in every API response). Encrypting them at rest would be the next step.
- Background jobs run inside the API process. That is fine for one instance; claims and leases already make it safe for several, but a separate worker process (or BullMQ) would be cleaner at scale.
- A database superuser can disable the ledger triggers, and the demo `docker-compose` connects as one.

## Sections still to be written (as modules land)

- Why two databases, and the sync problems faced
- Cross-database consistency approach (compensation vs outbox)
- Concurrency and idempotency handling
- Architecture diagram, PostgreSQL ERD, MongoDB collections
- Known limitations
