# KoboMarket demo video: script and shot list

Target length: 8 to 10 minutes. Record the screen with a voice-over; Postman (collection imported) on one side, a terminal and Swagger UI ready in other tabs. Each step lists what to do, what to say and what the viewer should see.

## Before recording (not on camera)

```bash
cp .env.example .env            # set JWT_ACCESS_SECRET to a long random value
docker-compose up --build -d
docker-compose exec api npm run seed   # note the printed password, or set SEED_PASSWORD
```

Import `docs/KoboMarket.postman_collection.json`. Set the collection variable `password` to the seed password.
Seeded logins: `admin@kobomarket.test`, `vendor1@kobomarket.test`, `buyer1@kobomarket.test` (and vendor2/3, buyer2..5).
Tip: keep three Postman environments or just switch the `email` variable and re-run **Auth -> POST /auth/login**; its script stores `{{token}}`.

## 1. Intro and architecture (0:00 - 1:00)

- Show the architecture diagram from the README.
- Say: "KoboMarket is a multi-vendor marketplace. MongoDB holds users, vendors and products. PostgreSQL holds the money: a double-entry ledger, orders, escrow, payouts and disputes. Buyers pay into escrow; the vendor is paid only after delivery."
- Show the money-flow diagram: wallet -> escrow -> vendor + commission -> payout.

## 2. Swagger and health (1:00 - 1:30)

- Open http://localhost:3000/api-docs. Scroll the tag list (Auth ... Admin, Webhooks).
- Say: "Every endpoint is documented, and a test fails if a route is missing from these docs."

## 3. Fund a wallet with idempotency (1:30 - 3:00)

1. Login as `buyer1`.
2. **Wallet -> POST /wallet/fund** (`amountKobo: 500000`). Point at the `Idempotency-Key` header (`{{$guid}}`) and the returned `reference`.
3. Send the SAME request again without changing the key: same response, no second payment. Say: "Same key, same request, same answer."
4. Change the body amount but keep the key: **409**. Say: "Same key with a different request is refused."
5. **Webhooks -> POST /dev/mock-payments/{{reference}}/pay** (default body sends the webhook 3 times).
6. **Wallet -> GET /wallet**: balance rose by exactly 500000 once. Say: "Three deliveries, one credit."

## 4. Checkout into escrow (3:00 - 4:30)

1. **Products -> GET /products**; copy a product id into `{{productId}}`.
2. **Cart -> POST /cart/items**, then **GET /cart**.
3. **Orders -> POST /orders/checkout**. The response shows the order and its sub-orders (one per vendor).
4. **GET /wallet**: buyer balance dropped. Show in Swagger or the admin ledger that the money sits in PLATFORM_ESCROW, not with the vendor.

## 5. Fulfilment and release (4:30 - 6:00)

1. Login as the vendor; **Orders -> GET /orders/sales**, then **POST /orders/sub-orders/{{subOrderId}}/ship**.
2. Try shipping again: **409 INVALID_STATE** (state machine).
3. Login as the buyer; **POST .../confirm-delivery**.
4. Login as the vendor; **GET /wallet**: net amount received, commission (5%) went to PLATFORM_REVENUE. Say: "One ledger transaction with three legs."
5. **Notifications -> GET /notifications** for the vendor: NEW_ORDER and FUNDS_RELEASED.

## 6. Dispute and admin resolution (6:00 - 7:15)

1. Seeded data already holds one DISPUTED order. As admin, **Disputes -> GET /disputes**.
2. **POST /disputes/{{id}}/resolve** with `PARTIAL_REFUND` and a `refundKobo` and `note`. Say: "Escrow was frozen while disputed. The refund goes back to the buyer, the rest to the vendor, commission only on the vendor's part. The admin id and note are recorded."

## 7. Payout (7:15 - 8:15)

1. As the vendor, **Payouts -> POST /payouts** (`amountKobo: 100000`, the N1,000 minimum). Wallet drops immediately.
2. Send a second payout while the first is PENDING: **409 PAYOUT_PENDING_EXISTS**.
3. Wait up to 30 seconds; **GET /payouts**: status SUCCESS. Say: "A background job verifies with the provider first, then sends; failure would reverse the money to the wallet."

## 8. Admin controls and the proof (8:15 - 9:30)

1. **Admin -> GET /admin/reports/revenue-by-day**, **top-vendors**, **escrow**.
2. **GET /admin/reports/reconciliation**: empty list. Say: "This report must always be empty."
3. **Admin -> PATCH /admin/users/{{id}}/freeze** on a buyer; that buyer's checkout now returns 403 ACCOUNT_FROZEN.
4. In the terminal run `docker-compose exec api npm run audit:ledger` and show **PASS**.
5. Run `npm test` and show the green summary and "Ledger audit after the test run: PASS".

## 9. Close (9:30 - 10:00)

- One sentence on limitations (README "Known limitations") and on what you would do next: a worker process, encrypting bank details, real Paystack test-mode run.

## Checklist before you stop recording

- Passwords and tokens are not visible in the shown logs or terminal history.
- The ledger audit and the test run both show PASS.
