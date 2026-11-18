# KoboMarket

A multi-vendor marketplace backend with wallets and escrow. Buyers pay into escrow; money is released to the vendor (minus platform commission) only after delivery is confirmed or a timeout passes.

**Stack:** Node.js, Express, MongoDB (user side), PostgreSQL (money side).

> Status: all 14 days complete. Modules A–J (auth, vendors, products, cart, wallet/ledger, funding, checkout/escrow, fulfilment, disputes, payouts, notifications, admin/reports), seed data, Swagger, a Postman collection and the demo script. Every module has its own section below.

**Contents:** [Quick start](#quick-start) · [Architecture](#architecture) · [Money flow](#where-the-money-goes) · [Database diagrams](#database-diagrams) · [Configuration](#configuration) · [API docs and Postman](#api-docs-and-postman) · [Testing](#testing) · [Design decisions](#design-decisions) · [Known limitations](#known-limitations)

## Quick start

```bash
cp .env.example .env        # then set JWT_ACCESS_SECRET to a random 32+ character value
docker-compose up --build   # starts API + MongoDB + PostgreSQL, runs migrations
docker-compose exec api npm run seed   # demo admin, vendors, products, buyers and orders
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
| `npm run seed` | Seed 1 admin, 3 vendors, 20 products, 5 funded buyers and 4 orders (idempotent; refuses to run in production) |
| `npm run postman` | Regenerate `docs/KoboMarket.postman_collection.json` from the OpenAPI spec |
| `npm run create-admin -- <email> <password>` | Create (or promote) a verified admin and its wallet. Needed to approve vendors until the seed exists. In Docker: `docker-compose exec api npm run create-admin -- admin@kobomarket.test 'Str0ngPassw0rd'` |
| `npm run audit:ledger` | Verify the money invariant, prints PASS/FAIL (Day 5) |
| `npm test` | Jest + Supertest against real MongoDB and PostgreSQL (`docker-compose up -d mongo postgres`). It rebuilds its own `kobomarket_test` databases each run |
| `npm run test:memory` | Same suite, but the MongoDB repositories are replaced by in-memory fakes. For machines with no MongoDB; PostgreSQL is still required |

## Architecture

```mermaid
flowchart TB
  client["Client / Postman / Swagger UI"] -->|HTTPS + JWT| api
  subgraph api["Express API (one process)"]
    direction TB
    mw["Middleware: requestId, Helmet, CORS, rate limit, Zod validate, authenticate, authorize, idempotent"]
    routes["Routes"] --> controllers["Controllers"] --> services["Services (all business rules)"] --> repos["Repositories"]
    mw --> routes
    bus["In-process event bus"]
    jobs["node-cron jobs: auto-complete escrow, payouts, stuck-orders, wallet provisioning"]
  end
  services -->|publish after commit| bus --> listeners["Notification listeners"]
  jobs --> services
  repos --> mongo[("MongoDB<br/>users, vendors, products,<br/>carts, reviews, notifications,<br/>auth tokens")]
  repos --> pg[("PostgreSQL<br/>accounts, transactions, ledger_entries,<br/>orders, sub_orders, order_items,<br/>payments, payouts, disputes, settings,<br/>idempotency_keys, webhook_events")]
  services <-->|charge / verify / transfer| paystack["Paystack (or mock provider)"]
  paystack -->|signed webhook| mw
```

**Why two databases.** MongoDB holds what is document-shaped and changes often (users, vendors, products with variants, carts, reviews, notifications). PostgreSQL holds everything where an error costs money (wallets, the double-entry ledger, orders, escrow, payments, payouts, disputes) because it gives real transactions, foreign keys, CHECK constraints and triggers. The price is that no transaction spans both; the "Cross-database consistency" sections below explain how each crossing is made safe (retrying outbox flag for wallet creation, compensation for checkout).

## Where the money goes

Every movement is one balanced ledger transaction (debits = credits). Nothing is ever edited or deleted; mistakes are fixed by posting a reversal.

```mermaid
flowchart LR
  EXT["PLATFORM_EXTERNAL<br/>(the bank)"] -->|"1 WALLET_FUNDING"| BW["Buyer wallet"]
  BW -->|"2 ORDER_PAYMENT"| ESC["PLATFORM_ESCROW"]
  ESC -->|"3a ESCROW_RELEASE: net"| VW["Vendor wallet"]
  ESC -->|"3b ESCROW_RELEASE: commission"| REV["PLATFORM_REVENUE"]
  ESC -->|"cancel / dispute refund"| BW
  VW -->|"4 PAYOUT_REQUEST"| CLR["PLATFORM_PAYOUT_CLEARING"]
  CLR -->|"5a PAYOUT_SETTLEMENT (success)"| EXT
  CLR -->|"5b PAYOUT_REVERSAL (failed)"| VW
```

Sub-order lifecycle (enforced by a database trigger, not only by code):

```mermaid
stateDiagram-v2
  [*] --> PENDING_PAYMENT
  PENDING_PAYMENT --> PAID
  PENDING_PAYMENT --> CANCELLED
  PAID --> SHIPPED
  PAID --> CANCELLED: buyer cancels, escrow refunded
  SHIPPED --> DELIVERED
  SHIPPED --> COMPLETED: auto-complete after timeout
  SHIPPED --> DISPUTED
  DELIVERED --> COMPLETED: escrow released
  DELIVERED --> DISPUTED
  DISPUTED --> COMPLETED: reject or partial refund
  DISPUTED --> REFUNDED: full refund
  COMPLETED --> [*]
  REFUNDED --> [*]
  CANCELLED --> [*]
```

## Database diagrams

### PostgreSQL (money side)

```mermaid
erDiagram
  accounts ||--o{ ledger_entries : "has entries"
  transactions ||--|{ ledger_entries : "balanced set of"
  transactions ||--o| transactions : "reverses"
  orders ||--|{ sub_orders : "one per vendor"
  sub_orders ||--|{ order_items : contains
  sub_orders ||--o| disputes : "at most one"
  orders }o--|| transactions : "payment_transaction_id"
  payments }o--o| transactions : "ledger_transaction_id"
  payouts }o--o| transactions : "request / settlement / reversal"
  disputes }o--o| transactions : "resolution_transaction_id"
  accounts {
    uuid id PK
    text owner_type "USER or SYSTEM"
    text owner_id "mongo user id or system name"
    bigint balance_kobo "cached, trigger-maintained"
    text status
  }
  transactions {
    uuid id PK
    text type
    text status
    text idempotency_key UK
    uuid reverses_transaction_id FK
    jsonb metadata
  }
  ledger_entries {
    uuid id PK
    uuid transaction_id FK
    uuid account_id FK
    text direction "DEBIT or CREDIT"
    bigint amount_kobo
  }
  orders {
    uuid id PK
    text buyer_id "mongo user id"
    text idempotency_key "UK with buyer_id"
    text status
    bigint total_kobo
    uuid payment_transaction_id FK
    text stock_status
  }
  sub_orders {
    uuid id PK
    uuid order_id FK
    text vendor_user_id
    text status
    bigint subtotal_kobo
    int commission_rate_bps "snapshot at checkout"
    bigint escrow_held_kobo
  }
  order_items {
    uuid id PK
    uuid sub_order_id FK
    text product_id "mongo id"
    int quantity
    bigint unit_price_kobo "snapshot"
  }
  payments {
    uuid id PK
    text reference UK
    text provider
    bigint amount_kobo
    text status
    uuid ledger_transaction_id FK "unique"
  }
  payouts {
    uuid id PK
    text user_id
    bigint amount_kobo
    text status "PENDING SUCCESS FAILED"
    uuid request_transaction_id FK
    uuid settlement_transaction_id FK
    uuid reversal_transaction_id FK
  }
  disputes {
    uuid id PK
    uuid sub_order_id FK "unique"
    text status
    text resolution
    bigint refund_kobo
    text resolved_by "admin id"
    uuid resolution_transaction_id FK
  }
  platform_settings {
    text key PK
    jsonb value
  }
  platform_setting_changes {
    uuid id PK
    text key
    jsonb old_value
    jsonb new_value
    text changed_by
  }
  webhook_events {
    uuid id PK
    text provider
    text event_key "unique per provider"
  }
  idempotency_keys {
    uuid id PK
    text user_id
    text key
    text request_hash
    int response_status
  }
```

### MongoDB (user side)

```mermaid
erDiagram
  User ||--o| Vendor : "applies as"
  Vendor ||--o{ Product : sells
  User ||--o| Cart : owns
  Product ||--o{ Review : "reviewed in"
  User ||--o{ Review : writes
  User ||--o{ Notification : receives
  User ||--o{ RefreshToken : "sessions"
  Product ||--|{ Variant : "embeds"
  Cart ||--|{ CartItem : "embeds"
  User {
    string email UK
    string fullName
    array roles "buyer vendor admin"
    string status "active or frozen"
    string walletStatus
  }
  Vendor {
    ObjectId userId UK
    string storeName UK
    object bankDetails
    string status "pending approved rejected"
  }
  Product {
    ObjectId vendorId
    string slug UK
    int priceKobo "lowest variant"
    int stock
    int ratingCount
    date deletedAt "soft delete"
  }
  Variant {
    string sku
    int priceKobo
    int stock
  }
  Cart {
    ObjectId userId UK
    int rev "optimistic concurrency"
  }
  CartItem {
    ObjectId productId
    int quantity
    int priceKobo "snapshot for warnings"
  }
  Review {
    ObjectId productId
    ObjectId buyerId "unique pair"
    int rating
  }
  Notification {
    ObjectId userId
    string type
    string dedupeKey "unique with userId"
    date readAt
  }
  RefreshToken {
    ObjectId userId
    string tokenHash
    date expiresAt
  }
```

The two sides refer to each other by id only (`owner_id`, `buyer_id`, `product_id` in PostgreSQL hold MongoDB ObjectIds as text). Order items store a snapshot of name and price, so history survives product edits.

Diagram sources live in `docs/diagrams/*.mmd`.

## Configuration

Copy `.env.example` to `.env`. Nothing secret is committed. The important variables (all validated at start-up with Zod; the API refuses to boot on a bad value):

| Variable | Meaning |
|---|---|
| `MONGO_URI`, `DATABASE_URL` | The two databases. `TEST_DATABASE_URL` is rebuilt on every test run |
| `JWT_ACCESS_SECRET` | 32+ random characters; signs 15-minute access tokens |
| `PAYMENT_PROVIDER` | `paystack` (default; requires `PAYSTACK_SECRET_KEY`) or `mock` (only when explicitly selected for development/tests) |
| `COMMISSION_RATE_BPS` | Default platform commission, basis points (500 = 5%). Admin can change it at runtime; each sub-order keeps the rate it was created with |
| `ESCROW_AUTO_COMPLETE_HOURS` | Hours after shipping before escrow auto-releases (not for disputed orders) |
| `PAYOUT_MINIMUM_KOBO` | Smallest payout, 100000 = N1,000 |
| `*_CRON` | Schedules of the background jobs (auto-complete, payouts, stuck-order recovery, wallet provisioning) |
| `MAIL_TRANSPORT` | `smtp` sends through `SMTP_*` (or `EMAIL_*`) when a host is configured; otherwise `console` prints verification emails to the API log |
| `SEED_PASSWORD` | Password for seeded accounts; random and printed once if empty |

## API docs and Postman

- **Swagger UI:** http://localhost:3000/api-docs (every endpoint, including the dev-only mock payment endpoint, with request shapes and error codes). A test fails if a route exists in the code but not in the docs.
- **Postman:** import `docs/KoboMarket.postman_collection.json`. It is generated from the OpenAPI spec (`npm run postman`) and a test keeps it in sync. Variables: `baseUrl`, `email`, `password`, `token`. Run **Auth -> login** first; its script stores `{token}` and `{refreshToken}` for every other request. Money requests carry `Idempotency-Key: {$guid}`; to see a replay, copy the value into a second send.
- **Demo walkthrough:** `docs/DEMO_SCRIPT.md` (shot list for the demo video).

## Testing

`npm test` runs Jest + Supertest against real MongoDB and PostgreSQL. `npm run test:memory` swaps only the MongoDB repositories for in-memory fakes (PostgreSQL stays real), for machines without MongoDB. After the run, the ledger audit executes automatically and the run fails if any money invariant is broken.

Coverage highlights: double-entry invariants and append-only triggers; concurrent checkout, double confirm-delivery, double webhook, two simultaneous payouts; the order state machine; dispute resolutions; payout failure and crash recovery; idempotency replay and conflict; role and ownership checks; a full lifecycle test (fund, buy, ship, confirm, commission, payout, notifications, audit).

## Design decisions

- **Idempotency everywhere money moves.** An `Idempotency-Key` header is required on funding, checkout and payouts. Same key and same request replays the stored response; same key and a different request is 409. Below that, ledger keys and unique indexes protect against a duplicate even if the middleware is bypassed.
- **Concurrency by locking in a fixed order.** Ledger accounts are locked sorted by id; fulfilment locks the order, then the sub-order, and re-reads status. Payout claims use `FOR UPDATE SKIP LOCKED` and a lease.
- **Defence in depth.** Rules are checked in services and again by the database (CHECKs, triggers, unique indexes), so a bug cannot silently corrupt money.
- **Verify before sending money.** The payout job asks the provider whether a transfer with this reference already exists before it sends one; an unknown outcome stays PENDING and is retried instead of guessed.
- **Events after commit.** Notifications are published only after the business transaction commits and can never fail a request.

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

**Email.** `MAIL_TRANSPORT=console` prints emails, including verification and reset tokens, to the API's stdout. For real delivery, configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASS` (or the equivalent `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USER`, and `EMAIL_PASSWORD`) and set `MAIL_TRANSPORT=smtp`. When a host is configured and `MAIL_TRANSPORT` is omitted, SMTP is selected automatically. If `MAIL_FROM` is empty, the authenticated SMTP user is used as the sender. With Docker: `docker-compose logs -f api`.

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

`GET /wallet` calls the same idempotent provisioning if it ever meets a user whose wallet is still pending, so a user is never stuck waiting for the retry job.

## Ledger service (Module D)

`src/modules/wallet/ledger.service.js` is the only code allowed to write ledger rows. Funding, escrow, refunds and payouts all call `postTransaction`, `transfer` or `reverseTransaction`.

| Rule | How it is enforced |
| --- | --- |
| Debits = credits | Checked in the service **and** by a deferred database trigger at COMMIT |
| Integer kobo, amount > 0 | `assertKobo` plus a `CHECK` on `ledger_entries` |
| No overdraft | Accounts are locked, then the new balance is checked; a `CHECK (balance_kobo >= 0)` is the last line of defence (only `PLATFORM_EXTERNAL` may go negative) |
| No deadlocks | Every posting locks its accounts with `SELECT ... FOR UPDATE` **sorted by id** |
| No double spend | The lock is taken *before* the balance is read, so concurrent spends queue up |
| Idempotency | `idempotencyKey` is UNIQUE. Same key and same entries returns the original result (`replayed: true`); same key with different entries is `409 IDEMPOTENCY_KEY_REUSED` |
| Atomic | One PostgreSQL transaction. Pass `trx` to make a posting part of a bigger one (order + escrow) |
| Frozen / closed accounts | Refuse every posting (`ACCOUNT_NOT_ACTIVE`) |
| Never edit history | Rows are append-only (triggers). A mistake is fixed with `reverseTransaction`, which posts a NEW transaction with every direction flipped |
| Reverse once only | Status must be POSTED, a reversal cannot be reversed, and a unique index on `reverses_transaction_id` stops two racing reversals paying twice |

Wallet endpoints (always the caller's **own** wallet, there is no id in the URL):

- `GET /api/v1/wallet`: balance in integer kobo (plus a display string).
- `GET /api/v1/wallet/transactions?limit&cursor&type&direction`: ledger history, newest first, each row with `balanceAfterKobo`. The running balance is a SQL window function over the whole history, so filters never distort it. Cursor pagination, not offsets.

## Wallet funding (Module E) and the Idempotency-Key middleware

Flow: `POST /wallet/fund {amountKobo}` records a PENDING payment, asks the provider for a checkout URL and returns it. **No money moves.** The wallet is credited only when the provider's `charge.success` webhook arrives and we have re-verified it.

`PAYMENT_PROVIDER=paystack` (default; requires `PAYSTACK_SECRET_KEY`) or `mock` (explicit development/test opt-in). A Paystack `sk_test_...` key uses the Paystack sandbox: test payments can credit the app's wallet ledger, but do not move real money. Use a Paystack `sk_live_...` key to accept real charges. The mock behaves like Paystack: signed webhooks (HMAC SHA512), a verify endpoint that reports the real state, and **duplicate webhook deliveries** (`POST /api/v1/dev/mock-payments/:reference/pay {"duplicates": 3}` plays the customer paying, then sends the webhook 1 + 3 times; this route exists only for the mock provider outside production). The Paystack client is tested against a local stand-in for their API (request shape, integer kobo, error mapping); it has not been run against live Paystack from this environment.

The webhook (`POST /webhooks/paystack`):

1. **Signature.** The route receives the raw bytes (`express.raw`, registered before `express.json`), computes HMAC SHA512 with the secret key and compares in constant time with `x-paystack-signature`. Missing or wrong is `401` and nothing else happens.
2. **Dedupe.** Each event is stored once (`webhook_events`, UNIQUE provider + event key). An event already processed is acknowledged and ignored.
3. **Re-verify.** The body is not trusted. We call the provider's verify endpoint and compare status, currency and amount with what *we* recorded. Amount mismatch: not credited, payment marked FAILED (`AMOUNT_MISMATCH`) and logged. The network call happens before the database transaction, so no lock is held while waiting.
4. **Credit once.** In one PostgreSQL transaction: lock the payment row, credit only if still PENDING, post `EXTERNAL -> wallet` through the ledger service, mark the payment SUCCEEDED. Three independent guards stop a double credit: the row lock plus status check, the ledger transaction's UNIQUE idempotency key `fund:<reference>`, and `payments.ledger_transaction_id` UNIQUE with a trigger that forbids leaving SUCCEEDED.
5. **Failure handling.** If verification fails (provider down) the event stays unprocessed and the webhook returns 5xx so the provider retries. If the wallet is frozen the payment stays PENDING and the webhook is acknowledged (no endless retries); `GET /wallet/fund/:reference` credits it once the wallet is active. That same endpoint is also the fallback for a missed webhook: for a PENDING payment it asks the provider and settles through the same idempotent path.

`idempotency_keys` + `src/modules/idempotency/idempotency.middleware.js` (shared by fund, and later checkout and payout):

| Situation | Result |
| --- | --- |
| no / malformed `Idempotency-Key` | `400` |
| same key + same request | the original response again (`Idempotent-Replayed: true`), the action does not run |
| same key + different request (method, path or body) | `409 IDEMPOTENCY_KEY_REUSED` |
| same key while the first request is still running | `409 REQUEST_IN_PROGRESS` (retry shortly) |
| the first request failed (non-2xx) | the key is forgotten, so the client can retry |
| the first request's server died mid-way | after `IDEMPOTENCY_LOCK_SECONDS` another request may take over (atomic UPDATE) |

Keys are per user and expire after `IDEMPOTENCY_TTL_HOURS`. The UNIQUE (user, key) constraint decides a race between two identical simultaneous requests. The response is stored before it is sent, so a client that retries instantly always finds it. Body key order does not matter (canonical JSON hash).

Database guards (`payments`): amount > 0, NGN only, reference UNIQUE, user/reference/amount immutable, status never leaves SUCCEEDED/FAILED, SUCCEEDED requires a ledger transaction, never deleted. `npm run audit:ledger` has a new check that every SUCCEEDED payment matches a WALLET_FUNDING transaction of the same amount.

## Cart (Module C)

`GET /cart`, `POST /cart/items`, `PATCH /cart/items/:itemId`, `DELETE /cart/items/:itemId`. A cart belongs to the logged-in user (no user id in any URL, so no way to touch someone else's). A cart may mix vendors.

- **Stale prices:** the cart stores the price the buyer saw (`addedPriceKobo`) only to warn about changes. Every read re-prices from the product: `currentPriceKobo`, `priceChanged`, line totals and `totalKobo` all use the CURRENT price. `vendors` groups the purchasable lines by vendor with subtotals (the shape of the parent order and its sub-orders on Day 9).
- **Stock:** adding or changing a quantity is checked against the product's (or the chosen variant's) stock, counting what is already in the cart (`2 + 2` against a stock of 3 is refused, `409 INSUFFICIENT_STOCK` with `availableStock`). Stock can also change *after* adding, so every line carries an `issue` (`PRODUCT_UNAVAILABLE`, `VARIANT_UNAVAILABLE`, `OUT_OF_STOCK`, `INSUFFICIENT_STOCK`) and unbuyable lines are left out of the total.
- **Rules:** variant required when the product has variants; at most 99 of an item and 50 different items; you cannot buy your own product; unknown fields (e.g. a client-sent price) are rejected.
- **Concurrency:** the cart is saved with optimistic concurrency (a `rev` counter, compare-and-set, retry). Ten simultaneous "add 1" against a stock of 5 leave exactly 5 in the cart; simultaneous adds of different products never lose one. No locks needed.
- **Checkout (Day 9):** `cartService.prepareCheckout(userId)` re-validates everything and prices it at current prices. It throws `409 CART_EMPTY` or `409 CART_INVALID` (with every problem listed), otherwise returns the lines (with `vendorId` and `vendorUserId`), the total and the list of price changes. It never charges the snapshot price. The stock decrement itself is atomic and comes with checkout, because that is where the compensation rule applies.

## Checkout and escrow (Module F, part 1)

`POST /orders/checkout` (needs `Idempotency-Key`), `GET /orders`, `GET /orders/:id`. Tables: `orders` (parent) -> `sub_orders` (one per vendor) -> `order_items`.

The flow, as the brief prescribes:

1. **Validate against MongoDB.** `cartService.prepareCheckout` re-checks stock and prices every line at the CURRENT price (`409 CART_EMPTY` / `CART_INVALID`). Optional `expectedTotalKobo`: if the live total differs, `409 PRICE_CHANGED`.
2. **One PostgreSQL transaction.** Create the order, one sub-order per vendor and the items; lock the buyer's wallet and `PLATFORM_ESCROW` (`SELECT ... FOR UPDATE`, sorted by id so no deadlocks); check the balance; post buyer -> escrow through the ledger service; mark everything PAID. Any failure (for example `409 INSUFFICIENT_FUNDS`) rolls the whole transaction back: no order, no money moved.
3. **Decrement stock in MongoDB**, atomically per item (`stock >= qty` is part of the filter, so two buyers racing for the last unit cannot both win). Variants decrement the variant and the product total in the same single-document update.
4. **If step 3 fails: compensate.** Restore the stock already taken, reverse the escrow payment (the buyer is refunded by a REVERSAL transaction, nothing is edited) and cancel the order. The buyer gets `409 STOCK_UNAVAILABLE` and has not been charged. The cart is kept.
5. Remove the bought lines from the cart.

Cross-database consistency, **case 2 of 2: escrow done, MongoDB stock decrement failed.** Compensation is safe to run any number of times and from several places: it only ever acts on an order that is PAID with its stock step still PENDING and every sub-order still PAID (a healthy or shipped order is never restocked or refunded, whoever asks), the order row is locked and re-checked; the ledger reversal is idempotent and one-shot; each item's restock is *claimed in PostgreSQL before* MongoDB is touched, so a crash can lose a unit of stock but can never invent one (it errs towards under-selling). If the process dies between steps 2 and 3, the order stays `PAID` with `stock_status = PENDING`; the recovery job (`stuck-orders`, cron `ORDER_RECONCILE_CRON`, only orders older than `CHECKOUT_STUCK_SECONDS`) cancels and refunds it. If the compensation itself fails (e.g. the buyer's wallet is frozen) the job keeps retrying.

**The same key never creates two orders**, enforced twice: the middleware replays the stored response, and `UNIQUE (buyer_id, idempotency_key)` on `orders` covers a request taken over after a crash. A checkout that failed and was compensated repeats the same `STOCK_UNAVAILABLE` for that key; a new attempt needs a new key.

The database enforces the money rules, so a code bug cannot create a bad order: line total = quantity x price (CHECK); sub-order subtotal = sum of its items and order total = sum of its sub-orders (deferred constraint triggers, checked at COMMIT); prices, vendors, buyers, totals and commission rate can never change; nothing is deleted; and the **state machine** is a trigger:

```
sub-order: PENDING_PAYMENT -> PAID | CANCELLED
           PAID -> SHIPPED | CANCELLED
           SHIPPED -> DELIVERED | DISPUTED | COMPLETED (auto-complete)
           DELIVERED -> COMPLETED | DISPUTED
           DISPUTED -> COMPLETED | REFUNDED
```

`sub_orders.escrow_held_kobo` is the money PLATFORM_ESCROW still holds for that sub-order (set once when paid, only ever decreases). The audit's 8th check requires the escrow account balance to equal the sum of these. The commission rate in force is copied onto each sub-order at checkout. With orders in place, the review check (`purchaseVerifier`) now reads the real tables: only a COMPLETED sub-order of that buyer containing the product counts.

Not yet built (Day 10): ship, confirm delivery, cancel, release escrow to the vendor (minus commission), auto-complete job.

## Ledger audit

```
npm run audit:ledger
```

Re-derives everything from the raw `ledger_entries` and prints `PASS` or `FAIL` (exit code 0 or 1, so it works in CI or cron). It checks:

1. user wallets + escrow + revenue + payout clearing = total funded - total paid out;
2. every account's cached balance = the sum of its entries;
3. every posted transaction has debits = credits and at least two entries;
4. no entries belong to pending or failed transactions;
5. nobody is overdrawn (except `PLATFORM_EXTERNAL`);
6. reversals are consistent in both directions;
7. every successful top-up payment is backed by a WALLET_FUNDING transaction of the same amount;
8. the PLATFORM_ESCROW balance equals the escrow still held for open sub-orders.

The test suite runs the audit again after the whole run (Jest `globalTeardown`), and has tests that tamper with a ledger inside a rolled-back transaction to prove the audit really reports FAIL.

## Products, search and reviews (Module B, part 2)

Products live in MongoDB (`products`, `reviews`). Money is integer kobo everywhere (`priceKobo`); `priceDisplay` is for humans only.

- **Who can write:** `authorize('vendor')` plus a check that the caller owns an *approved* store. Editing or deleting another vendor's product is `403 NOT_YOUR_PRODUCT`.
- **Variants:** each has its own `priceKobo` and `stock` and a stable `id` (carts and orders will point at it). With variants, the product price is the lowest variant price and the stock is the total; both are derived by the server, never trusted from the client. `PATCH` replaces the variant list: send an existing `id` to keep a variant.
- **Slug:** generated from the name, unique (index); a collision gets a random suffix.
- **Soft delete:** `deletedAt` is set and the row is kept for order history. Deleted and inactive products are `404` publicly.
- **Search (`GET /products`):** full-text on name (weighted higher) and description via a MongoDB text index; filters `category`, `tag`, `vendor`, `minPrice`/`maxPrice` (kobo), `minRating`; sort `newest`, `price_asc`, `price_desc`, `rating`.
- **Cursor pagination, not skip/limit:** the cursor remembers the last row's sort value and `_id` and asks for rows *after* it (`field > v OR (field = v AND _id > id)`). That is an index range scan, so deep pages stay fast, and a product added mid-paging cannot shift rows into duplicates or gaps. The cursor is opaque, bound to its sort, and validated (a forged or mismatched cursor is a 422, never a query).
- **Reviews:** `POST /products/:id/reviews`. Only a buyer with a COMPLETED order containing the product (`403 PURCHASE_REQUIRED` otherwise), one per buyer per product (unique index `productId+buyerId`, `409 ALREADY_REVIEWED`). The product's average is updated in ONE atomic MongoDB pipeline update from `ratingSum`/`ratingCount`, so simultaneous reviews cannot lose a rating. The review is inserted first, then the aggregate; if the aggregate update fails the review is deleted again.
- **Orders check:** "completed order" is a PostgreSQL question (`src/modules/reviews/purchaseVerifier.js`). The orders tables arrive on Days 9-10 (it expects `sub_orders(buyer_id, status)` and `order_items(sub_order_id, product_id)`), so until then the answer is "no" and the endpoint refuses everyone. Tests cover the query itself against throw-away tables.

## Fulfilment: ship, confirm, cancel, release (Module F, part 2)

State machine (also enforced by a database trigger): `PAID -> SHIPPED -> DELIVERED -> COMPLETED`, `PAID -> CANCELLED`.

| Endpoint | Who | What |
|---|---|---|
| `POST /orders/sub-orders/:id/ship` | the owning vendor | PAID -> SHIPPED. Refused (`ORDER_NOT_READY`) until checkout's stock step finished. |
| `POST /orders/sub-orders/:id/confirm-delivery` | the buyer | SHIPPED -> DELIVERED -> COMPLETED in one transaction and the escrow is released. |
| `POST /orders/sub-orders/:id/cancel` | the buyer | PAID only. Escrow refunded to the buyer's wallet, stock put back. |
| `GET /orders/sales` | a vendor | My sub-orders, `?status=`, cursor pagination. |

Choices worth knowing:
- **Release is one ledger transaction with three legs** (`ESCROW_RELEASE`): debit PLATFORM_ESCROW, credit the vendor wallet (subtotal minus commission), credit PLATFORM_REVENUE (commission). Commission uses the rate stored on the sub-order at checkout (default 5%, 500 bps), computed with BigInt and rounded down to a whole kobo; the vendor gets the remainder. A 0% rate posts two legs.
- **Confirming delivery completes the order immediately.** DELIVERED is recorded (`delivered_at`) but passes straight to COMPLETED, because the confirmation is what releases the money.
- **Auto-complete**: a node-cron job (`ESCROW_AUTO_COMPLETE_CRON`, default every 5 minutes) completes SHIPPED sub-orders older than `ESCROW_AUTO_COMPLETE_HOURS` (72). Each candidate is re-checked under its row lock, so a sub-order confirmed, cancelled or DISPUTED in the meantime is skipped; DISPUTED sub-orders are never SHIPPED, so they are never candidates.
- **Concurrency**: every action locks the parent order, then the sub-order, and re-reads the status. Double confirms, confirm vs auto-complete and ship vs cancel are serialised; the loser gets 409 `INVALID_STATE`. The ledger keys `release:<id>` and `refund:<id>` are a second guard, and the DB state machine a third.
- Cancelling restocks MongoDB after the PostgreSQL commit, claiming each item in PostgreSQL first (a crash can lose a unit of stock, never invent one).
- The parent order becomes COMPLETED when every sub-order is finished, or CANCELLED when all of them were cancelled.
- A release or refund that hits a frozen wallet fails whole (`ACCOUNT_NOT_ACTIVE`): nothing moves, the sub-order keeps its state, and the job retries.

## Disputes (Module G)

| Endpoint | Who | What |
|---|---|---|
| `POST /orders/sub-orders/:id/dispute` | the buyer | Open a dispute on a SHIPPED sub-order: `reason` (10+ chars) and up to 10 evidence items (`{type:"text"|"image", value}`; images must be http(s) URLs). |
| `GET /disputes`, `GET /disputes/:id` | buyer, vendor or admin | A user sees only disputes they are part of (404 otherwise); admins see all. `?status=OPEN|RESOLVED`, cursor pagination. |
| `POST /disputes/:id/resolve` | admin | `FULL_REFUND`, `PARTIAL_REFUND` (+ `refundKobo`) or `REJECT`, with a required `note`. |

- **Freeze.** Opening a dispute moves the sub-order to DISPUTED and leaves its escrow where it is. Confirm, cancel and ship all need another status, and the auto-complete job only looks at SHIPPED sub-orders and re-checks under the row lock, so it can never pay a disputed order. One dispute per sub-order (unique constraint).
- **Resolution is one ledger transaction** (`DISPUTE_RESOLUTION`, key `dispute:<id>`) that debits escrow and credits the buyer (refund), the vendor (their part minus commission) and PLATFORM_REVENUE (commission). Commission is taken on the vendor's part only, at the rate recorded on the sub-order, rounded down. `FULL_REFUND` -> sub-order REFUNDED; `PARTIAL_REFUND` and `REJECT` -> COMPLETED. The parent order closes when its last sub-order is settled.
- **Recorded:** the admin's id, the note, the time, the split and the ledger transaction. The database refuses a resolution without them or one whose parts do not add up to the frozen amount, refuses edits to the complaint, makes a resolved dispute final and never deletes a dispute.
- **Concurrency:** opening and resolving lock order -> sub-order -> dispute, so two admins resolving at once, or a dispute racing the buyer's confirmation, produce exactly one outcome; the loser gets 409.
- If the refund cannot be posted (e.g. the buyer's wallet is frozen) the whole resolution rolls back and the dispute stays OPEN.
- The audit has a ninth check: every OPEN dispute has a DISPUTED sub-order holding exactly the frozen amount, every DISPUTED sub-order has an open dispute, and every resolved dispute was settled by a `DISPUTE_RESOLUTION` transaction that debited escrow by exactly that amount.

## Payouts (Module H)

| Endpoint | Who | What |
|---|---|---|
| `POST /payouts` | an approved vendor | `{ amountKobo }`, needs an `Idempotency-Key` header. Minimum N1,000 (`PAYOUT_MINIMUM_KOBO`). |
| `GET /payouts`, `GET /payouts/:id` | the owner (admin may read one) | Status, masked bank account (`******6789`), failure reason. |

How the money moves (every step goes through the ledger service):
1. **Request:** one PostgreSQL transaction moves the amount from the vendor wallet to `PLATFORM_PAYOUT_CLEARING` and creates a PENDING payout, so the money cannot be spent twice while the transfer is in flight.
2. **Job** (`payouts`, every 30 s, `PAYOUT_PROCESS_CRON`): claims PENDING payouts with `FOR UPDATE SKIP LOCKED`, asks the provider about our reference first, and only sends the transfer if the provider has never seen it. Success: clearing -> `PLATFORM_EXTERNAL`, payout SUCCESS. The provider says failed: clearing -> vendor wallet (`PAYOUT_REVERSAL`), payout FAILED with a reason, and the vendor may request again.
3. **Unknown outcome** (timeout, 5xx, process crash): the payout stays PENDING and is retried after `PAYOUT_CLAIM_LEASE_SECONDS`; it is only reversed when the provider reports a definite failure, so money is never refunded for a transfer that may have gone through.

Guarantees:
- **At most one PENDING payout per vendor**: checked in the service and enforced by a partial unique index.
- **No overdraft under concurrency**: the ledger locks the wallet row before reading the balance. Tests fire 2 and 10 simultaneous requests, and also run with the one-pending rule removed to prove the balance check alone holds.
- **Never paid twice**: verify-before-send, the provider treats our reference (`payout-<id>`) as idempotent, and settlement/reversal need the row lock, a PENDING status and a ledger idempotency key.
- The database makes a finished payout final, keeps the amount, owner, bank details and reference unchanged and never deletes a payout.
- **Audit (checks 10a, 10b):** PLATFORM_PAYOUT_CLEARING equals the sum of PENDING payouts, and every payout's request, settlement and reversal transactions have the right type and amount.
- **Providers:** `mock` (default; `transferOutcome` and `settleTransfer` simulate failure and delay; an account number of `0000000000` is rejected) and `paystack` (transfer recipient, then transfer, then verify). Paystack needs a bank code, so the vendor's bank name is matched against Paystack's bank list; an unknown bank fails the payout.

## Notifications, admin tools, reports and seed data (Modules I and J)

### Notifications (in-app)
`GET /notifications` (newest first, cursor pagination, `?unread=true`), `GET /notifications/unread-count`, `PATCH /notifications/:id/read`, `PATCH /notifications/read-all`. You only ever see and change your own.

They are created **asynchronously**: business code publishes an event on a small in-process bus (`src/events/bus.js`) only after its database transaction has committed, and listeners write the notifications on the next tick, each inside its own try/catch. A slow or broken listener (or MongoDB being down) cannot fail or slow down an order, and nothing is announced for something that was rolled back. Each notification has a dedupe key, so the same event delivered twice still produces one.

| Event | Who is notified |
|---|---|
| order placed | the buyer ("order placed") and each vendor ("new order") |
| order shipped | the buyer |
| funds released (confirmation, auto-complete, dispute settlement) | the vendor, with the net amount |
| dispute opened | the vendor, and every admin ("needs review") |
| dispute resolved | the buyer and the vendor |
| payout success / failure | the vendor |

### Admin tools (`/admin`, admin only)
- `GET /admin/users` search (email or name, literal match), filter by role and status, cursor pagination; never returns hashes.
- `PATCH /admin/users/:id/freeze` and `/unfreeze`: a frozen user can log in and read but **cannot place orders or request payouts** (`403 ACCOUNT_FROZEN`). Idempotent; an admin cannot freeze themselves or another admin.
- `GET /admin/wallets/:userId` and `GET /admin/wallets/:userId/ledger` (any wallet and its ledger history with the running balance).
- `GET` / `PUT /admin/settings/commission`: the commission rate (basis points, 0 to 5000) for **new** orders. The rate is copied onto each sub-order at checkout, so a change never alters an order already placed. Every change is kept in an append-only history table.

### Reports (`/admin/reports`, raw SQL, all dates UTC)
- `revenue-by-day?days=30`: platform commission per day, zero-filled, net of reversals.
- `top-vendors?month=2026-11`: the 10 vendors who earned most (after commission) in a month, read from the ledger.
- `escrow`: money in escrow by sub-order status, how much is frozen by disputes, and whether it equals the escrow account.
- `reconciliation`: every inconsistency the audit can find; **empty on a healthy system**.

### Seed data
`npm run migrate && npm run seed` creates 1 admin, 3 vendors, 20 products, 5 funded buyers and four orders (PAID, SHIPPED, COMPLETED, DISPUTED). It goes through the real services, is safe to run again, and refuses to run in production. Set `SEED_PASSWORD` to choose the demo password; otherwise a random one is printed once. Accounts: `admin@kobomarket.test`, `vendor1..3@kobomarket.test`, `buyer1..5@kobomarket.test`.

## Known limitations

- Vendor bank account numbers are stored in plain text in MongoDB (masked in every API response). Encrypting them at rest would be the next step.
- Background jobs run inside the API process. That is fine for one instance; claims and leases already make it safe for several, but a separate worker process (or BullMQ) would be cleaner at scale.
- Ledger reversal of a transaction fails (INSUFFICIENT_FUNDS) if the receiver has already spent the money; resolving that is a business decision (a dispute resolution settles from escrow, which is always funded).
- A vendor `PATCH` that sets stock overwrites the stock value ("set to N"). Checkout decrements (Day 9) are atomic, but an edit made at the same moment as a sale can overwrite it; an optimistic version field would close that.
- The mock provider keeps its transactions in memory, so restarting the API forgets them (verify then says not_found). The idempotency middleware stores the response in PostgreSQL, but a response is only replayed for 2xx results by design.
- Every checkout and every escrow movement locks the single PLATFORM_ESCROW account row, so they are serialised. That keeps the cached balance exact and is plenty for this project; at real scale the escrow balance would be sharded or derived.
- A compensated checkout can under-count stock by a unit if the process dies between a MongoDB decrement and its PostgreSQL flag (it can never over-sell). A vendor stock edit corrects it.
- Search relevance ranking is not offered as a sort (text matching works with every sort); keyset pagination on a text score is awkward.
- If the process dies right after a buyer cancellation commits, the restock of that sub-order's items is not retried (stock may be under-counted until the vendor edits it).
- A dispute has no vendor reply or evidence upload yet: the vendor can read the complaint, and an admin decides. Evidence is text or an image URL, not a file upload.
- A confirmed delivery completes the sub-order at once, so there is no "cooling-off" window to dispute after confirming.
- Payouts: if a vendor's wallet is frozen when a payout fails, the reversal cannot be posted and the payout stays PENDING until the wallet is active again. Paystack payouts have only been tested against a fake HTTP layer, not Paystack's real test mode.
- Notification events are in-process and at-most-once: if the server dies between a commit and the listener, that notification is lost (the order and the money are not).
- The seed script has only been run against the in-memory test backend here, not a real MongoDB.
- A database superuser can disable the ledger triggers, and the demo `docker-compose` connects as one.
