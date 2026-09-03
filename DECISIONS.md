# DECISIONS

Design record for the **Reliable Checkout & Rewards Service** (the `be/` track).
The governing brief is [`be/README.md`](be/README.md); the root brief that used to
live here was an older, softer version and does not describe this assignment.

Approximate time spent: **~5 hours**, within the 4–6h timebox. Where I stopped
short of production hardening I say so explicitly below rather than leave a silent gap.

---

## System invariants

These are the properties the tests and the code are built to protect. Each one
has at least one test that fails if the invariant is broken (see the mutation-test
note under *Testing strategy*).

1. **No oversell.** The system never sells more units of a product than exist.
   `sold + remaining == initial` holds across arbitrary concurrent checkouts.
2. **All-or-nothing checkout.** A checkout either places the whole order or
   changes nothing — no line is charged while another fails.
3. **At-most-once order per cart.** A cart produces at most one order; retries
   return the same order and never charge inventory twice.
4. **Immutable order snapshot.** An order records the product name, unit price,
   quantity, and line total *as of checkout*, so it still explains itself after
   the catalogue changes.
5. **Coupon is single-use and failure-safe.** A coupon is redeemed at most once,
   is never consumed by a checkout that ultimately fails, and cannot be redeemed
   by two concurrent checkouts.
6. **One coupon per reached milestone.** Every *n*th placed order makes exactly
   one coupon eligible; generation never mints two for the same milestone.
7. **Money is exact and non-negative.** All money is integer cents; a discount is
   deterministic and can never drive an order total below zero.
8. **Reporting is a pure projection.** The admin report reconciles with orders and
   coupons and never mutates state, however many times it is called.

---

## Ambiguities in the brief and the semantics I chose

The brief deliberately leaves several things unspecified. Each choice below is one
an interviewer can probe, so I name the trade-off honestly.

- **What is the idempotency unit?** The brief talks about retried checkouts but not
  *how* a retry is identified. I made **the cart the idempotency unit**: a cart
  checks out at most once, and re-checking-out a placed cart returns its existing
  order. I did **not** implement an `Idempotency-Key` header.
  *Honest limit:* this protects the realistic retry (same client, same cart, same
  request replayed). A client that loses the response and then creates a **new
  cart** with the same items will get a **second order** — the system cannot tell
  those two intents apart without a client-supplied key. Naming this is the point;
  see *Idempotency strategy* for how a key would slot in.

- **Coupon supplied on an idempotent retry.** If a cart is checked out **without**
  a coupon and the retry supplies one, the retry returns the **original order** —
  no discount is retro-applied and the coupon is **not** consumed. Symmetrically,
  a retry with a **bogus** coupon code also returns the original order (200), even
  though that same bogus code on a *fresh* cart is a `400 COUPON_INVALID`. This
  asymmetry is deliberate: once an order exists, idempotency wins over
  re-validation — the order is a settled fact and a retry must not mutate it. I
  verified redemption does not leak in this path.

- **Coupon ownership.** The brief has no customer/account model, so coupons have no
  owner. Codes are **predictable** (`SAVE10-3`, `SAVE10-6` — discount + milestone).
  Unminted codes are correctly rejected, so predictability is not exploitable
  *today*; but a coupon that has been minted is usable by **anyone** who knows the
  code. That is an accepted consequence of the brief not specifying ownership. With
  a customer model I would bind a coupon to an account and make codes opaque.

- **Price change between add and checkout.** A cart stores product references and
  quantities, **not** frozen prices. Totals are computed live from the current
  catalogue when the cart is viewed, and are frozen only into the order snapshot at
  checkout. So a price change before checkout is quoted and charged at the **new**
  price. (Documented as required by the brief.)

- **Coupon generation is pull, not push.** A milestone becoming eligible does not
  auto-mint a coupon; an administrator must request generation. This matches "An
  administrator can request coupon generation" and keeps minting an explicit,
  auditable action.

---

## Material design decisions

### Decision: Concurrency via a synchronous critical section

**Context:** The core correctness requirement is that concurrent checkouts must
not oversell, and concurrent redemptions must not double-spend a coupon.

**Options considered:**
- **A — Locks/mutex around checkout.** Explicit async lock per product or cart.
- **B — One synchronous critical section.** Do the read-validate-decrement-commit
  with no `await` in the middle, relying on Node's single-threaded event loop.
- **C — Optimistic concurrency** with a version check and retry.

**Choice:** B. `checkout()` is fully synchronous from the moment it reads inventory
to the moment it commits the order, coupon, and cart.

**Why:** Under one Node process, a synchronous function runs to completion without
interleaving, so two "concurrent" checkouts *serialize* — the second only starts
after the first has decremented inventory. That makes oversell and double-redeem
**structurally impossible** rather than defended against, with no lock bookkeeping
to get wrong. It is also the smallest thing that is correct, which suits the timebox.

**Consequences:** The reasoning is airtight *within one process* and easy to defend
in an interview. It does **not** survive multiple processes — that is exactly where
the repository interface becomes a transaction (see *Multi-instance*). The critical
section must contain **no `await`**; I treat that as an invariant of the checkout
code and call it out in comments so a future edit doesn't silently break atomicity.

### Decision: Cart as the idempotency unit

**Context:** A retried checkout must not create a second order or double-charge.

**Options considered:**
- **A — `Idempotency-Key` header** deduplicated in a store.
- **B — Cart status.** The cart transitions `OPEN → CHECKED_OUT` and links its order.

**Choice:** B — reuse the cart's own lifecycle as the dedup key.

**Why:** In a single synchronous process there is no "in-flight window" to protect
against, so a full idempotency-key subsystem is machinery the design doesn't need
yet. The cart already has the identity and state to answer "did this check out?",
and that check generalises cleanly to a conditional `UPDATE ... WHERE status =
'OPEN'` across instances.

**Consequences:** Simple and retry-safe for the realistic case. The honest gap
(new cart → second order) is documented above. Adding an `Idempotency-Key` later is
additive: dedup on the key at the HTTP edge, map it to the same cart resolution.

### Decision: Immutable order snapshot

**Context:** "An order must retain enough information to explain what was purchased
and how its total was calculated, even if product data later changes."

**Options considered:**
- **A — Store product ids only** and re-read names/prices when displaying an order.
- **B — Copy name, unit price, quantity, and line total into the order at checkout.**

**Choice:** B.

**Why:** An order is a historical fact. Re-reading live product data would make a
past order silently change when a product is renamed or repriced — a
reconciliation and support nightmare. Copying is cheap and makes the order
self-explanatory forever.

**Consequences:** Orders are stable and the report can sum line snapshots without
touching the catalogue. Slight duplication of data, which is the correct trade for
an audit record. A test renames and reprices a product after checkout and asserts
the order is unchanged.

### Decision: Money as integer cents with round-half-up

**Context:** "Calculate money without floating-point rounding errors" and discounts
must be deterministic and never negative.

**Options considered:**
- **A — Floating-point dollars.** Rejected outright — `0.1 + 0.2` drift is exactly
  the failure the brief calls out.
- **B — A decimal/bignum library.** Correct but heavier than a small in-memory
  service needs.
- **C — Integer cents everywhere**, with an explicit rounding rule for percentages.

**Choice:** C. Every money value is an integer count of cents. A percentage
discount is `floor((subtotal * percent + 50) / 100)` — deterministic round-half-up
in pure integer arithmetic — and is then **clamped to the subtotal** so the total
can never go negative.

**Why:** No float ever enters a money path, so there is nothing to drift. Two
independent belts protect the "never negative" invariant: the rounding formula
cannot exceed the subtotal for `percent ≤ 100`, **and** the explicit `Math.min`
clamp catches any future misuse.

**Consequences:** Exact and easy to reason about. Callers must remember amounts are
cents (I keep a `Cents` type alias and format only at the presentation edge). No
multi-currency — out of scope for the brief.

### Decision: A single typed error model

**Context:** "Return errors that are distinguishable and useful to an API client."

**Options considered:**
- **A — Throw strings / ad-hoc `{message}`** and let clients parse text.
- **B — One `AppError` type** carrying a stable machine `code`, an HTTP status, and
  optional structured details, mapped to JSON by one Express error middleware.

**Choice:** B.

**Why:** A client should branch on a stable `code` (`INSUFFICIENT_INVENTORY`,
`COUPON_ALREADY_REDEEMED`, …), never on a message. Centralising the map keeps
status codes consistent and handlers thin — they just `throw`, and because the
services are synchronous, Express catches the throw and routes it to the middleware.

**Consequences:** Adding an error is one union member plus one status entry.
Framework-level failures (a malformed or oversized JSON body) are thrown by
body-parser *before* our router, so I added a small translation step that maps
those to `400 MALFORMED_REQUEST` / `413 PAYLOAD_TOO_LARGE` instead of a misleading
`500`. Anything genuinely unexpected still surfaces as `500 INTERNAL`.

### Decision: Bounded cart quantity (domain cap, not `MAX_SAFE_INTEGER`)

**Context:** A cart line quantity is a positive integer, but an unbounded one lets a
line total exceed `2^53`, at which point integer arithmetic silently loses
precision and the money invariant is defeated *without any float involved*.

**Options considered:**
- **A — Guard at `Number.MAX_SAFE_INTEGER`.** Technically prevents the overflow.
- **B — A domain cap** (`MAX_LINE_QUANTITY = 1000`), enforced on the **accumulated**
  line quantity.

**Choice:** B, cap 1000, applied to the running total so repeated small adds can't
creep past it either — not just one absurd request.

**Why:** A `MAX_SAFE_INTEGER` guard answers "why 9007199254740991?" with "because
of IEEE-754", which is a technical accident, not a business rule. "A line may hold
at most 1000 units" is a defensible domain statement, interviews far better, and
keeps every reachable subtotal comfortably exact. It gets its own distinguishable
code, `QUANTITY_LIMIT_EXCEEDED` (422).

**Consequences:** Legitimate orders are unaffected; the overflow class is closed at
the boundary. The number is a policy knob, not a constant of the universe.

---

## Transaction, concurrency, and idempotency strategy

- **Transaction boundary (today):** the synchronous body of `checkout()` is the
  transaction. It reads inventory and validates the coupon (both read-only), then
  in one uninterrupted run decrements inventory, redeems the coupon, writes the
  order, and closes the cart. No `await` splits it, so it is atomic under the event
  loop. **All validation happens before any mutation**, so a failure (insufficient
  inventory, unavailable coupon) leaves inventory *and* the coupon untouched.
- **Concurrency:** because the section can't interleave, concurrent checkouts
  serialize; the second observes the first's decrements. Coupon redemption sits in
  the same section, so two checkouts racing for one coupon resolve to exactly one
  redemption and one `COUPON_ALREADY_REDEEMED`.
- **Idempotency:** cart status. First checkout: `201` + new order. Retry: `200` +
  the same order, no new inventory movement.

## Money and rounding rules

Integer cents everywhere. `lineTotal = unitPrice × quantity`. Discount =
`min(subtotal, floor((subtotal × percent + 50) / 100))` — round-half-up, clamped.
Total = `subtotal − discount`, always ≥ 0.

## Error-model choices

One `AppError { code, status, details }` → JSON `{ error: { code, message, details }}`.
Stable codes include `VALIDATION_ERROR`, `MALFORMED_REQUEST`, `PAYLOAD_TOO_LARGE`,
`PRODUCT_NOT_FOUND`, `INVALID_QUANTITY`, `QUANTITY_LIMIT_EXCEEDED`,
`INSUFFICIENT_INVENTORY`, `CART_NOT_FOUND`, `CART_EMPTY`, `ITEM_NOT_IN_CART`,
`CART_ALREADY_CHECKED_OUT`, `ORDER_NOT_FOUND`, `COUPON_INVALID`,
`COUPON_ALREADY_REDEEMED`, `COUPON_NOT_ELIGIBLE`. Statuses are assigned once in a
central map. Full list per endpoint is in the README.

---

## Testing strategy

The brief values "a small number of meaningful tests over high superficial
coverage" and requires at least one competing/repeated-operation test. Beyond the
happy paths, the suite exercises:

- **Concurrent oversell** — 6 carts race for 1 hoodie → exactly 1 placed, 5 `409`,
  inventory 0.
- **Conservation** — 15 carts race for 3 stickers → `sold + remaining == initial`,
  never negative (strictly stronger than "exactly one succeeded").
- **Concurrent retries of one cart** → a single order id, charged once (with an
  explicit 2xx + defined-id check so the assertion cannot pass vacuously).
- **Coupon failure-safety** — a coupon on a checkout that fails on inventory stays
  `AVAILABLE` and is redeemable afterwards.
- **Concurrent redemption** — two carts, one coupon → exactly one redeems.
- **Concurrent generation** — many admin requests at one milestone → one coupon.
- **Malformed/oversized bodies** → `400` / `413`, never `500`.
- **Report is a pure projection** — two calls are byte-identical.

**Mutation check (guarding against vacuous tests):** the brief warns that a test
that passes on both correct and broken code is worse than none. I verified the key
tests actually fail when the implementation is wrong by temporarily breaking it:
disabling the inventory guard turned 4 tests red; disabling cart idempotency turned
2 red; disabling the coupon single-use guard turned 2 red. Each break was reverted.

---

## Implemented vs intentionally deferred

**Implemented:** products/inventory, carts (create/add/update/remove/view with live
totals), oversell-safe idempotent checkout, immutable orders, milestone coupon
generation and single-use failure-safe redemption, admin report, a typed error
model incl. malformed-body handling, and the test suite above.

**Deferred, on purpose:**
- **Frontend** — the brief marks it optional and says it "will not compensate for an
  unreliable backend." I put the whole budget into backend correctness. A reviewer
  can exercise everything via the documented HTTP API / curl examples.
- **Persistence** — in-memory behind a repository interface. Acceptable per the
  brief; the interface is the seam for a real DB (below).
- **AuthN/AuthZ** — not required. Admin routes are identified by their `/admin`
  prefix; there is no enforcement.
- **Payment** — successful checkout *is* payment success. A payment step would slot
  in as a validation before the mutation phase (a decline aborts with nothing
  charged, exactly like an inventory failure).
- **Rate limiting / observability / pagination** — out of scope for the timebox.

---

## How the design evolves for multiple instances + a production database

The synchronous critical section is correct for one process only. With N instances
behind a load balancer, the guarantees move into the database transaction that the
repository interface stands in for:

- **Inventory / no oversell:** a conditional decrement instead of read-then-write —
  `UPDATE products SET inventory = inventory - :qty WHERE id = :id AND inventory >= :qty`
  and treat "0 rows affected" as `INSUFFICIENT_INVENTORY`, or `SELECT ... FOR UPDATE`
  the rows and decrement inside the transaction. No application lock needed.
- **Order-per-cart idempotency:** a `UNIQUE` constraint on `orders.cart_id` (and/or
  an `idempotency_key` column with a unique index) so a duplicate checkout fails the
  insert and is translated back to "return the existing order."
- **One coupon per milestone:** a **unique partial index** on the coupon milestone so
  two admins racing to generate cannot both insert.
- **Single-use redemption:** redeem with
  `UPDATE coupons SET status='REDEEMED', redeemed_by_order_id=:id WHERE code=:code AND status='AVAILABLE' RETURNING *`
  — the `WHERE status='AVAILABLE'` makes the race a single-winner at the database,
  and "0 rows" ⇒ `COUPON_ALREADY_REDEEMED`.
- **Failure safety:** wrap inventory decrement + coupon redemption + order insert in
  one transaction; any failure rolls back all of it, preserving the same
  all-or-nothing property the synchronous section gives today.

Because the services depend on the repository interfaces and not on the Maps, this
is a store swap, not a rewrite.

---

## How I used AI tools

I used an AI coding assistant throughout to scaffold the TypeScript/Express project,
draft the services, and write tests, reviewing every line before committing. The
useful account is not "AI wrote code"; it is where I **did not trust** it.

**A real correction — the unbounded-quantity defect.** The cart code validated that
a quantity was a positive integer, and its tests were green. It looked correct. It
was not: a request with `quantity: 1e15` passed the positive-integer check, produced
a line total above `2^53`, and silently corrupted the subtotal — defeating the
integer-cents money invariant with no float anywhere in sight. Neither the generated
code nor its generated tests surfaced this, because both reasoned about the
happy-shaped input. It took **adversarial probing from outside the suite** (feeding
deliberately absurd input over real HTTP) to expose it.

I also **redirected** the fix. The obvious guard is `Number.MAX_SAFE_INTEGER`. I
rejected that in favour of a **domain cap of 1000 on the accumulated line quantity**
with its own error code, because a technical overflow guard is not a business rule
and is far weaker to defend in an interview than "a cart line holds at most 1000
units." The lesson I take from this build: generated code and its generated tests
tend to share the same blind spots, so the value I add is the adversarial input and
the judgment about *which* fix is defensible — not the typing.

---

## What I would examine first given another two hours

1. **A first-class `Idempotency-Key`** at the HTTP edge, closing the "new cart →
   second order" gap that cart-based idempotency leaves open.
2. **A property-based concurrency test** — random interleavings of checkouts and
   generations asserting the conservation and single-use invariants, to hunt races
   a fixed 6-way test can't.
3. **Swap in SQLite** behind the existing repository interfaces and re-run the same
   tests, to prove the concurrency story survives a real transaction and to make the
   multi-instance claims above executable rather than asserted.
4. **Coupon ownership / opaque codes**, once a customer model exists.
