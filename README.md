# KoboMarket

A multi-vendor marketplace backend with wallets and escrow. Buyers pay into escrow; money is released to the vendor (minus platform commission) only after delivery is confirmed or a timeout passes.

**Stack:** Node.js, Express, MongoDB (user side), PostgreSQL (money side).

> Status: Day 3 of 14 complete (foundation, PostgreSQL ledger schema, authentication). This README grows with each module.

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

Not yet built: role checks (RBAC middleware) arrive with the vendor module; the PostgreSQL wallet that must be created for every new user is part of the cross-database consistency work (Day 4).

## Sections still to be written (as modules land)

- Why two databases, and the sync problems faced
- Cross-database consistency approach (compensation vs outbox)
- Concurrency and idempotency handling
- Architecture diagram, PostgreSQL ERD, MongoDB collections
- Known limitations
