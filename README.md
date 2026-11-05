# KoboMarket

A multi-vendor marketplace backend with wallets and escrow. Buyers pay into escrow; money is released to the vendor (minus platform commission) only after delivery is confirmed or a timeout passes.

**Stack:** Node.js, Express, MongoDB (user side), PostgreSQL (money side).

> Status: Day 2 of 14 complete (foundation + PostgreSQL ledger schema). This README grows with each module.

## Quick start

```bash
cp .env.example .env        # then set real JWT secrets (32+ chars each)
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
| `npm test` | Jest + Supertest. Needs PostgreSQL running (`docker-compose up -d postgres`); it creates and rebuilds its own `kobomarket_test` database each run |

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

## Sections still to be written (as modules land)

- Why two databases, and the sync problems faced
- Cross-database consistency approach (compensation vs outbox)
- Concurrency and idempotency handling
- Architecture diagram, PostgreSQL ERD, MongoDB collections
- Known limitations
