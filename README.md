# Reliable Checkout & Rewards Service

[![CI](https://github.com/vidishraj/assignment/actions/workflows/ci.yml/badge.svg)](https://github.com/vidishraj/assignment/actions/workflows/ci.yml)

A backend for an ecommerce store: customers create carts, add products, and check
out; the store rewards purchasing activity by making a discount coupon available
after every *n*th successfully placed order. The interesting part is not the CRUD —
it is behaving predictably under **retries, concurrent checkouts, inventory
changes, and coupon races**.

> **Which brief this answers.** This implementation answers the **`be/` track**
> brief in [`be/README.md`](be/README.md) (Reliable Checkout & Rewards Service).
> An older, softer brief previously occupied this root README; it is superseded and
> remains available in git history. The design write-up is in
> [`DECISIONS.md`](DECISIONS.md) — it is a required, heavily-weighted deliverable,
> so read it alongside the code.

The service lives in [`be/`](be/). Everything below runs from there.

## Stack

TypeScript + Node (≥20) + Express. In-memory store by default (with an optional
SQLite store, below) behind a repository interface
(the seam for a real database — see DECISIONS.md). No database, no external
services, no credentials required.

## Setup & run

```bash
cd be
npm install
npm run dev          # start with live reload (tsx) on :3000
# or a production-style run:
npm run build && npm start
```

Configuration (injected, with defaults):

| Env var              | Meaning                                    | Default |
| -------------------- | ------------------------------------------ | ------- |
| `PORT`               | HTTP port                                  | `3000`  |
| `MILESTONE_INTERVAL` | `n` — a coupon is eligible every `n` orders | `5`     |
| `DISCOUNT_PERCENT`   | `x` — coupon discount percent (0–100)      | `10`    |

```bash
MILESTONE_INTERVAL=3 DISCOUNT_PERCENT=10 npm run dev
```

## Tests

```bash
cd be
npm test             # node:test, all *.test.ts
npm run typecheck    # tsc --noEmit
```

The suite favours a few meaningful tests over broad coverage, and deliberately
exercises **competing and repeated** operations (concurrent oversell, conservation,
concurrent retries, coupon failure-safety, concurrent redemption, concurrent
generation). See the *Testing strategy* section of `DECISIONS.md`.

**Same suite, two stores.** The default store is in-memory (dependency-free). An
optional SQLite store (`src/store/sqlite.ts`, via `better-sqlite3`) implements the
same repository interfaces; `npm run test:sqlite` runs the **same** suite against it
inside a real `BEGIN IMMEDIATE` transaction. `better-sqlite3` is an *optional* native
dependency — if it isn't installed, `test:sqlite` skips cleanly and the default
`npm test` and `npm ci` are unaffected.

## Seed data

Six products are seeded on startup, including deliberately scarce stock so
concurrency is real rather than theoretical (all prices in cents):

| id          | name               | price (cents) | inventory |
| ----------- | ------------------ | ------------- | --------- |
| `p-mug`     | Ceramic Mug        | 1299          | 100       |
| `p-tee`     | Cotton T-Shirt     | 1999          | 50        |
| `p-cap`     | Baseball Cap       | 1500          | 20        |
| `p-bottle`  | Steel Water Bottle | 2499          | 8         |
| `p-hoodie`  | Limited Hoodie     | 5999          | **1**     |
| `p-sticker` | Sticker Pack       | 499           | **3**     |

## Money

All money is **integer cents** — no floating point. A percentage discount is
round-half-up and clamped to the subtotal, so an order total is never negative.

---

## API

A machine-readable **OpenAPI 3.1** spec covering every endpoint, schema, status,
and error code is at [`be/openapi.yaml`](be/openapi.yaml) (the `/admin` routes are
tagged administrative). The prose below is the same contract in narrative form.

Base URL `http://localhost:3000`. Request and response bodies are JSON.
**Administrative** operations are the `/admin/*` routes (identified by prefix;
auth is out of scope per the brief).

### Health

`GET /health` → `200` `{ status: "ok", config: { milestoneInterval, discountPercent } }`

### Products

`GET /products` → `200` `{ products: [{ id, name, unitPriceCents, inventory }] }`

### Carts

| Method & path                         | Body               | Success | Notes                                  |
| ------------------------------------- | ------------------ | ------- | -------------------------------------- |
| `POST /carts`                         | —                  | `201`   | Creates an empty cart.                 |
| `GET /carts/:id`                      | —                  | `200`   | Cart view with live prices + subtotal. |
| `POST /carts/:id/items`               | `{ productId, quantity }` | `200` | Adds; **accumulates** onto an existing line. |
| `PUT /carts/:id/items/:productId`     | `{ quantity }`     | `200`   | Sets the exact quantity.               |
| `DELETE /carts/:id/items/:productId`  | —                  | `200`   | Removes the line.                      |

Cart view shape:

```json
{
  "id": "…",
  "status": "OPEN",
  "items": [
    { "productId": "p-mug", "name": "Ceramic Mug", "unitPriceCents": 1299, "quantity": 2, "lineTotalCents": 2598 }
  ],
  "subtotalCents": 2598
}
```

`orderId` is added to this shape once the cart is `CHECKED_OUT` (it links to the
placed order — this is how a client recovers its order after a lost response).

Cart errors: `VALIDATION_ERROR` (400, malformed field — e.g. non-string
`productId`), `CART_NOT_FOUND` (404), `PRODUCT_NOT_FOUND` (404),
`INVALID_QUANTITY` (400, non-positive / non-integer),
`QUANTITY_LIMIT_EXCEEDED` (422, accumulated quantity > 1000),
`ITEM_NOT_IN_CART` (404), `CART_ALREADY_CHECKED_OUT` (409, mutating a placed cart).

### Checkout

`POST /carts/:id/checkout` with optional `{ "couponCode": "SAVE10-3" }`.

- **`201`** on the first placement, returning the order.
- **`200`** on an idempotent retry, returning the **same** order (no double charge).

```json
{
  "id": "…", "cartId": "…", "status": "PLACED",
  "lines": [ { "productId": "p-mug", "productName": "Ceramic Mug", "unitPriceCents": 1299, "quantity": 2, "lineTotalCents": 2598 } ],
  "subtotalCents": 2598, "discountCents": 260, "totalCents": 2338,
  "couponCode": "SAVE10-3", "createdAt": "…"
}
```

Checkout errors: `VALIDATION_ERROR` (400, malformed field — e.g. non-string
`couponCode`), `CART_NOT_FOUND` (404), `CART_EMPTY` (400),
`INSUFFICIENT_INVENTORY` (409, with `{ productId, requested, available }`),
`COUPON_INVALID` (400), `COUPON_ALREADY_REDEEMED` (409).
A checkout that fails validation changes nothing — inventory and any supplied
coupon are left untouched.

### Orders

`GET /orders/:id` → `200` the immutable order (unchanged by later product edits),
or `ORDER_NOT_FOUND` (404).

### Administration

| Method & path          | Success | Purpose                                                            |
| ---------------------- | ------- | ------------------------------------------------------------------ |
| `POST /admin/coupons`  | `201`   | Mint a coupon for the next unrewarded milestone.                   |
| `GET /admin/report`    | `200`   | Reconciliation summary (read-only; safe to call repeatedly).       |

`POST /admin/coupons` returns the coupon, or `COUPON_NOT_ELIGIBLE` (409) when no new
milestone has been reached. `GET /admin/report`:

```json
{
  "totalOrders": 4,
  "purchasedByProduct": { "p-mug": 5 },
  "grossRevenueCents": 6495,
  "totalDiscountsCents": 260,
  "netRevenueCents": 6235,
  "coupons": { "generated": 1, "available": 0, "redeemed": 1 }
}
```

Malformed requests are client errors, not `500`s: an unparseable or non-object JSON
body → `400 MALFORMED_REQUEST`; an oversized body → `413 PAYLOAD_TOO_LARGE`.

## Example: earn and spend a coupon (n=3, x=10)

```bash
cd be && MILESTONE_INTERVAL=3 DISCOUNT_PERCENT=10 npm run dev   # in one shell

# place 3 orders to reach the first milestone
for i in 1 2 3; do
  CART=$(curl -s -XPOST localhost:3000/carts | jq -r .id)
  curl -s -XPOST localhost:3000/carts/$CART/items -H 'content-type: application/json' -d '{"productId":"p-mug","quantity":1}' >/dev/null
  curl -s -XPOST localhost:3000/carts/$CART/checkout >/dev/null
done

curl -s -XPOST localhost:3000/admin/coupons          # → { "code": "SAVE10-3", … }

CART=$(curl -s -XPOST localhost:3000/carts | jq -r .id)
curl -s -XPOST localhost:3000/carts/$CART/items -H 'content-type: application/json' -d '{"productId":"p-mug","quantity":2}' >/dev/null
curl -s -XPOST localhost:3000/carts/$CART/checkout -H 'content-type: application/json' -d '{"couponCode":"SAVE10-3"}'
#   → subtotalCents 2598, discountCents 260, totalCents 2338

curl -s localhost:3000/admin/report | jq
```

## Layout

```
be/
  src/
    domain/types.ts        # Product, Cart, Order, Coupon (+ order snapshot)
    money.ts               # integer-cents helpers + round-half-up discount
    errors.ts              # AppError, code→status map, error middleware
    config.ts              # n / x, injected and validated
    repository.ts          # storage interfaces (the DB seam)
    store/memory.ts        # in-memory repositories
    seed.ts                # seed catalogue
    services/              # cart, checkout, coupon, report
    routes.ts, app.ts, index.ts
    *.test.ts              # focused business-rule + concurrency tests
```

See [`DECISIONS.md`](DECISIONS.md) for invariants, chosen semantics, the
concurrency/idempotency strategy, the multi-instance/production-DB evolution, and
the AI-usage account.
