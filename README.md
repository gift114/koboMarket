# KoboMarket

A multi-vendor marketplace backend with wallets and escrow. Buyers pay into escrow; money is released to the vendor (minus platform commission) only after delivery is confirmed or a timeout passes.

**Stack:** Node.js, Express, MongoDB (user side), PostgreSQL (money side).

> Status: Day 1 of 14 complete (foundation). This README grows with each module.

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
| `npm test` | Jest + Supertest |

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

## Sections still to be written (as modules land)

- Why two databases, and the sync problems faced
- Cross-database consistency approach (compensation vs outbox)
- Concurrency and idempotency handling
- Architecture diagram, PostgreSQL ERD, MongoDB collections
- Known limitations
