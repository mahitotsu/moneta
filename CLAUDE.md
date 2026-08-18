# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project context

This is a technology-validation PoC for a blog article, not a reference architecture for
organizational rollout. Prioritize technical validity over organizational realism (review
processes, team ownership, governance) — those are left as discussion points for the article,
not implemented. The same applies to core-banking domain features whose value is independent of
event-driven architecture — overdraft/credit lines, joint/multi-owner accounts, and
multi-currency support are out of scope because they require changes to the write-path domain
model itself, not new loosely-coupled services (see `docs/production-readiness-matrix.md`'s
④ section, D8/D9/D10, for the reasoning and for other domain features — standing orders,
interest, fees, dormancy, regulatory reporting — kept as backlogged validation candidates
*because* they fit the "new service subscribes to existing events/queues" pattern this PoC
argues for). Write path: Web UI (`web-ui/`, React) → CloudFront → API Gateway → SQS FIFO →
Lambda (Rust) → DynamoDB. Read path: DynamoDB Streams outbox → EventBridge → Query service
(Lambda + DynamoDB) → CloudFront → API Gateway → caller. CloudFront unifies the static UI and
both APIs under one origin so the browser never needs CORS — see `0007`.

**`docs/adr/` is the single source of truth for design rationale, constraints, and decision
history — this file only orients and points there.** Don't copy specifics (retry counts,
SQLSTATE codes, backoff parameters, full constraint lists) from an ADR into this file; they've
already drifted out of sync here once. Read the relevant ADR before changing behavior it covers,
and add a new ADR (or revise one) when a non-obvious decision is made or reversed.

- `0001`: microservice boundaries (aggregate ≠ microservice; bounded contexts) and event-driven
  service integration — Notification service remains proposed/out of scope; Query service is
  implemented, see `0004`; Transfer service is implemented, see `0010`.
- `0002`: SQS FIFO message lifecycle, error classification (`DomainError` vs. infra failure),
  transaction granularity, DLQ design — directly reflected in `account-service`'s code.
- `0003`: why `account-domain` and `account-service` are separate crates, and the boundary
  between them.
- `0004`: Query service — transactional outbox (DynamoDB Streams → EventBridge), the
  account-service/Query service ownership boundary, DynamoDB read model, and the
  DynamoDB-direct-integration query API.
- `0006`: write-path API Gateway — Lambda-less APIGW→SQS `SendMessage` direct integration,
  client-generated account IDs, `Idempotency-Key` header, per-command REST resources.
- `0007`: Web UI — React/TypeScript/Vite + TanStack Query, no auth UI (explicit scope
  boundary), and a single CloudFront distribution that unifies the static site and both APIs
  under one origin (prefix-routed via CloudFront Functions) so CORS is never needed, in prod or
  local dev.
- `0008`: Query service extracted into its own crate (`crates/query-service`) — its
  Cargo.toml deliberately excludes `aws-sdk-eventbridge`, so "Query service can only subscribe
  to events, never publish them" is compiler-enforced, not just a comment.
- `0009`: Web UI reworked into a customer persona (dummy sign-in, localStorage-only
  account list, balance/history, self-service freeze/unfreeze/close) and a separate
  external-channel-emulator persona (ATM/incoming transfer/bill payment) that reuses the
  existing Deposit/Withdraw commands unchanged — customers never deposit/withdraw directly
  from the web UI, matching real net-banking. Also adds a second Query service read model
  (`AccountHistoryTable`) for transaction history.
- `0010`: Transfer service (`crates/transfer-service`) — cross-account transfer as an
  orchestration-style saga confined entirely to a new, independent service; account-service and
  query-service get zero code changes except a correlation ID threaded through as inert cargo
  (`account_events.correlation_id` → `EventEnvelope.correlation_id`, never read by domain logic).
  account-service is called the same way any other caller would (direct SQS `SendMessage`
  against its command queue, no API Gateway — deliberately avoiding new VTL, see decision 6);
  compensation is triggered by subscribing to EventBridge events carrying a `correlation_id`,
  which the ADR-0004 outbox already publishes for both `account.event.*` and `account.rejection.*`
  today (ADR-0002 decision 7 was corrected to reflect this — no dedicated rejection-publishing
  mechanism needed). No customer-facing API Gateway/UI yet — submission is SQS-only for now.
- `0011`: 振替(furikae, same-owner)/振込(furikomi, different-owner) distinction — adds
  real `owner_id` data to the `Account` aggregate (`Command::Open`/`Event::Opened`), a
  transfer-service-owned account-owner index projection for server-side kind classification,
  a confirmation step (`PendingConfirmation`/`Cancelled` saga states) required only for
  furikomi, a per-transfer amount limit for furikomi, and recall (組戻し) modeled as a fresh
  `kind = Recall` saga rather than a new terminal state. Customer-facing API Gateway/UI remains
  out of scope, same as `0010` decision 6.
- `0012`: Transfer service's customer-facing increment — decisions 1-5 (backend) are Accepted,
  deployed, and E2E-verified (`api-e2e/`, 20 suites/35 tests); decision 6 (web-ui) is
  implemented, see below. A status-query API Gateway direct-integrated to a new
  `TransferStatusView` table, kept deliberately separate from the operational
  `TransferSagaTable` and populated via DynamoDB Streams → a new `transfer-status-projector`
  Lambda (same shape as the existing `transfer-owner-projector`, not a new
  query-service/transfer-service coupling); a command API Gateway mirroring `0006`'s Lambda-less
  SQS pattern for `Start`/`Confirm`/`Cancel`/`Recall`, deliberately requiring no
  `Idempotency-Key` header (transferId+action already gives VTL a deterministic dedup key,
  unlike account-service's Deposit/Withdraw). `api-e2e/support/transferClient.ts` and
  `sagaState.ts`'s old SQS/DynamoDB-direct backdoor were replaced with real HTTP calls against
  these APIs. Web-ui screens (振替/振込, decision 6) keep the customer's own transfer history in
  localStorage only (same choice `0009` made for account ownership) rather than a new
  server-side per-account index.
- `0013`: account-service's persistence store is DynamoDB, not Aurora DSQL — account-service's
  data-access pattern (single-partition-key reads/writes, one atomic multi-item write per
  message covering account state + outbox event + idempotency log, optimistic concurrency)
  needs none of a relational engine's distinguishing features (JOINs, CHECK/FK constraints,
  direct SQL query access), so it's met by `TransactWriteItems` + `ConditionExpression` the same
  way `0004`/`0010` already do. `accounts` uses AWS's documented version-attribute
  optimistic-locking pattern; the outbox is DynamoDB Streams → a projector Lambda (same shape as
  `0012`'s `transfer-status-projector`) instead of a polling relay; `0005`'s schema-migration
  Custom Resource has no counterpart (DynamoDB is schemaless) and is deleted. Deployed and
  verified against the live stack (`api-e2e/`, 20 suites/35 tests green) — real-deployment gotcha:
  `dynamodb:TransactWriteItems` alone doesn't authorize a transaction; IAM also requires the
  per-item action (`PutItem`/`UpdateItem`/`ConditionCheckItem`) granted separately, discovered
  via `AccessDeniedException` on first deploy (ADR-0013 decision 5).
- `0014`: adds `ui-e2e/` — Playwright, headless Chromium only — as a sibling of `api-e2e/`
  (itself renamed from `e2e/` in this same decision, since it turned out to only ever drive the
  HTTP APIs directly). Same "manual/on-demand, live deployed CloudFront URL only, not in CI"
  placement `api-e2e/` established; test data (accounts, signed-in customer) is seeded directly
  over HTTP and into `localStorage` rather than driven through the browser, so specs stay focused
  on the one thing HTTP-only testing and mocked-API component tests can't reach: the transfer
  screens' (`0012` decision 6) actual DOM/event-handler wiring against the live backend.
- `0015`: replaces furikomi's raw-UUID destination entry with a human-readable account number
  (3-digit branch code + 7-digit number) — `accountId` (UUID, ADR-0006 decision 2) stays the
  sole canonical identifier; the number is a read-only alias added by a new `query-service`
  binary (`account-number-projector`) that, like `0011`'s `owner_projector.rs`, subscribes only
  to `account.event.Opened` and writes a dedicated small table (conditional-put-with-retry for
  the number's uniqueness, deterministic hash-of-`account_id` for the branch — branch has no
  per-branch business separation in this single-bank PoC, so it isn't part of the uniqueness
  key). A new Lambda-less `AccountNumberQueryApi` (same GetItem/Query direct-integration pattern
  as `0012`'s `TransferQueryApi`) exposes both lookup directions. `TransferForm.tsx`'s furikomi
  path becomes branch-select + number-entry + explicit lookup/confirm (showing the resolved
  owner name and branch) before submit; `startTransfer`'s wire request is unchanged. The
  transfer entry point also gets a same-bank/other-bank branch — other-bank is a non-functional,
  clearly-labeled placeholder only (no backend), leaving actual interbank connectivity as the
  still-unstarted `production-readiness-matrix.md` D4 gap.
- `0016`: replaces the dummy, unauthenticated sign-in (`web-ui/src/customerSession.ts`, deleted)
  with real Amazon Cognito authentication, after manual testing surfaced that the account number
  scheme (`0015`) was enumerable and the "add an existing account to my list" UI feature let
  anyone attach any account UUID to their session with zero verification. A Cognito User Pool
  (self-signup, username+password only, `PreSignUp` trigger auto-confirms — no email
  verification) backs a `CognitoUserPoolsAuthorizer` required on every customer-facing endpoint
  except Deposit/Withdraw (external channel, `0009` decision 1). `owner_id` is no longer
  client-supplied: API Gateway VTL injects the verified JWT `sub` as `requested_by`;
  account-service's `persistence::resolve_owner_id`/`is_ownership_violation` use it to source
  `Open`'s owner and reject `Freeze`/`Unfreeze`/`Close` from a non-owner (new
  `DomainError::NotOwner`, `account.rejection.NotOwner`, same ADR-0002 classification — no
  `account-domain` changes). A new `CustomerAccountsTable` (populated by a `query-service`
  projection subscribing only to `account.event.Opened`, same shape as `0011`'s
  `owner_projector.rs`) backs a new `GET /customers/me/accounts` (ownerId from the JWT claim,
  never client input) that replaces the deleted manual-add feature — accounts appear in the
  owner's list automatically the moment they're opened. A new `auth-service` crate (depends only
  on nothing account-related, `0003`'s crate-boundary philosophy) publishes
  `auth.event.SignedUp`/`auth.event.SignedIn` straight to `domainEventBus` from Cognito's
  `PostConfirmation`/`PostAuthentication` Lambda triggers — no DynamoDB outbox needed since the
  trigger invocation itself is the source of truth; nothing subscribes to these two events yet
  (documented as future work). Known residual gap (documented in the ADR's trade-offs): read-side
  item-level authorization isn't implemented — an authenticated user who knows another customer's
  `accountId` can still `GET /accounts/{id}` directly.
- `0017`: replaces the customer's own transfer history (`web-ui/src/transferHistory.ts`, deleted
  — localStorage-only, per `0012` decision 6) with a server-side projection, after seeding
  demo data via raw HTTP calls (bypassing the browser) revealed that history never appeared for
  anyone since it was only ever written when a transfer was started through that exact browser's
  `TransferForm`. A new `transfer-history-projector` (`crates/transfer-service`) subscribes to
  the same `TransferSagaTable` DynamoDB Streams source `transfer-status-projector` already uses
  (multiple independent Lambda triggers on one stream, not a new mechanism) and writes both the
  sender's and receiver's `ownerId` into a new `CustomerTransfersTable`, resolving each side's
  identity via `TransferAccountOwnersTable` (`0011`) — furikomi appears in both parties' history,
  furikae collapses to one entry. The table's range key is `transferId` (not
  `updatedAt#transferId` as first implemented — that version was proven wrong only after live
  deployment, when a saga's several state transitions each produced a separate row instead of
  converging; fixed by moving "newest first" ordering to a dedicated `byUpdatedAt` GSI, same
  "base key stable, sort via GSI" shape as `0015`'s `AccountNumbersTable`). New Lambda-less
  `GET /customers/me/transfers` on `TransferQueryApi`, same `$context.authorizer.claims.sub`
  pattern as `0016` decision 4's `GET /customers/me/accounts`. Separately (same session, not
  itself an ADR-worthy decision but worth knowing when working in this repo): `api-e2e`/`ui-e2e`
  gained automatic per-run teardown for both their Cognito test users and the DynamoDB rows they
  create (`support/testDataCleanup.ts` in each), after discovering `npm test` had never cleaned
  up either and both had grown into the thousands; `infra/scripts/clean-data.ts` gained a
  `cognito` target and `infra/scripts/seed-demo-data.ts` was added to populate a small,
  never-auto-deleted `demo-customer`/`demo-customer-2` pair for manually checking the deployed
  UI actually looks like something, independent of and unaffected by that teardown (it only ever
  deletes what a given test run itself created).
- `0018`: fixes the furikomi confirmation step (`TransferForm.tsx`'s "宛先名義") showing the
  destination's raw Cognito `sub` (UUID) instead of a human-readable name — this system has no
  "legal name" field at all (`0016` decision 1: signup is username+password only), so the fix
  reuses `cognito:username` (the same value `AppBar.tsx` already shows as "{name} 様") as a
  display-only `owner_name`, threaded alongside `owner_id` through `Command::Open`/
  `Event::Opened` (`account-domain`), the `Open` VTL (`$context.authorizer.claims['cognito:username']`,
  bracket notation required for the colon in the claim name), and
  `account_number_projector.rs`'s `AccountNumbersTable`/`AccountNumberQueryApi` — `owner_id`
  stays in the table for ops use but is no longer returned by the query API.
- `0019`: same user report as `0018`, second cause — `TransferListScreen.tsx`,
  `TransferDetailScreen.tsx`, and `TransferForm.tsx`'s own-account dropdowns were showing
  `format.ts`'s `formatAccountNumber(accountId)`, a UUID-hex "looks like an account number"
  decoration that predates `0015`'s real branch+7-digit numbers — `AccountListScreen.tsx`/
  `AccountView.tsx` had already switched to the real number but these three call sites hadn't,
  so a destination could render as e.g. "●●●●C3F8" (hex, from the UUID) next to screens showing
  real all-digit numbers. Fixed by switching all three to the same `useAccountNumber`/
  `getAccountNumber` + `formatFriendlyAccountNumber` path `AccountListScreen`/`AccountView`
  already use (`AccountNumberQueryApi` resolves any `accountId` regardless of caller ownership,
  so this works for `toAccountId` too); `formatAccountNumber` itself is deleted (zero remaining
  callers). No masking introduced — matches the existing "show the real number in full" norm
  those two screens already established.
- `0020`: `TransferListScreen.tsx`/`TransferDetailScreen.tsx` were always framed from the
  sender's point of view (always showing `toAccountId`'s info) — `0017` already puts a furikomi
  in the *receiver's* "送金" tab too, but a received transfer rendered as "sent to my own
  account", with the actual sender nowhere visible. Fixed by comparing `fromAccountId`/
  `toAccountId` against `getMyAccounts()` to find the "counterparty" (furikae excluded — both
  sides are always the same owner); the counterparty's `ownerName` (already returned by
  `AccountNumberQueryApi` since `0018`) is shown only on the non-mine side, suffixed "様へ"
  (sent) / "様より" (received) in the list. List rows also reuse `TransactionHistory.tsx`'s
  existing `ArrowDownLeft`/`ArrowUpRight` icons and positive/negative tone (green=received,
  red=sent) rather than inventing new visual language. Pure frontend change, no backend/infra
  touched — the data was already there, just not compared against "which accounts are mine".
- `0021`: cross-links the per-account transaction history (口座 menu) and per-transfer history
  (送金 menu) — previously there was no way to jump between them despite them showing two
  facets of the same underlying event for transfer-caused money movements. Transfer detail →
  own-side account history needed no backend change (reuses `0020`'s "which side is mine"
  check) and originally added `returnTo?: View` to `CustomerFlow.tsx`'s view union (one-level
  jump memory) — **superseded by `0022`**, which replaced `returnTo` with per-tab navigation
  state. Account history → causing transfer needed threading `EventEnvelope.correlation_id`
  (already the transferId, set by transfer-service per `0010` decision 4, already reaching
  `account_events`) through `query-service`'s `history_entry_from_event`/`query_projector.rs`
  into a new `transferId` field on `TransactionEntry` — no infra/VTL change needed since
  `GET .../transactions` already just concatenates the JSON `entry` blob verbatim (this part is
  unaffected by `0022`). Links render via a new shared `.inline-link-button` CSS class, shown
  only on entries the customer can see (own account, transfer-caused entries).
- `0022`: real-world use of `0021`'s cross-links surfaced that "戻る" (back) meant two different
  things depending on path — normally "return to this tab's list," but via a `0021` cross-link,
  "return to the screen you jumped from" (`returnTo`) — which read as inconsistent/confusing
  the first time a user actually followed cross-tab link → back. Fix (chosen by reasoning from
  the ideal navigation model, not by patching the symptom): give `accounts`/`transfers` tabs
  independent navigation state in `CustomerFlow.tsx`
  (`accountsTabView`/`transfersTabView`, each `{screen:"list"} | {screen:"detail", id}`) instead
  of one shared `View` union, and render `CustomerTabBar` on the detail screens too (previously
  list-screens-only). "戻る" now always means "pop this tab to its list" — deterministic,
  no `returnTo` needed — while switching sections is *only* ever the tab bar's job; a `0021`
  cross-link just sets the target tab's view and flips `activeTab`, leaving the origin tab's
  state untouched, so switching back lands exactly where you left it with zero bookkeeping.
  `DetailAppBar` gained a required `backLabel` prop (was hardcoded to "口座一覧へ戻る" even on
  the transfer-detail screen — a latent bug `0022`'s determinism happens to fix too).
- `0023`: transaction-history rows with no `transferId` (i.e. not caused by a transfer) rendered
  as a bare "入金"/"出金" with no indication of source — traced to `ChannelEmulatorScreen.tsx`'s
  4 forms (ATM deposit/withdrawal, incoming transfer, bill payment) all collapsing into the same
  `deposit`/`withdraw` calls with the channel discarded client-side (`0009` decision 1's
  "counterparty name is decorative, never sent" already applied to the channel choice itself,
  not just the free-text name). Fixes by adding `channel: Option<String>` end-to-end as the same
  kind of opaque transport metadata `0010` decision 4's `correlation_id` already is —
  `EventEnvelope`/`AccountCommandEnvelope`/`account_events`/outbox projector/query-service's
  `history_entry_from_event` each gain a `channel` field alongside `correlation_id`, never typed
  as an `account-domain` enum (mirrors `correlation_id`'s own untyped-string treatment, not
  `FreezeReason`'s). API Gateway's shared `AmountCommandModel` splits into `DepositCommandModel`/
  `WithdrawalCommandModel`, each with a `channel` enum scoped to that direction's valid values,
  validated the same way `FreezeCommandModel`'s `reason` already is. Web-ui's
  `ChannelOperationForm` gains a required `channel` prop wired per-button in
  `ChannelEmulatorScreen.tsx`; `TransactionHistory.tsx` shows a `CHANNEL_LABEL`-mapped line
  (mutually exclusive with `0021`'s transfer-detail link, since `channel`/`transferId` are never
  both set).
- `0024`: adds a 振込(furikomi)-only transfer fee and a points/loyalty program (real-time award
  on receipt, automatic redemption against the fee) as two new crates — `points-service` (a pure
  ledger, depends on nothing) and `fee-service` (owns the fee *policy* — v1 a fixed amount,
  future tiered/stage-based — and decides the points/cash split), chained
  `transfer-service` → `fee-service` → `points-service` with **usage** only (SQS
  command/EventBridge event, never a Cargo dependency, same boundary `0003` draws for
  `account-service`). `account-service`/`query-service` get zero changes. `transfer-service`'s
  saga gains a `ReservingFee` state between confirmation and debit so the cash portion of the fee
  rides in the *same* `Withdraw`/compensating `Deposit` the transfer already issues — no
  separately-issued, independently-failable fee withdrawal — plus a fire-and-forget `AwardPoints`
  on furikomi credit and `RefundFee`/`RefundPoints` on failure/compensation. Furikae and 組戻し
  (recall) stay fee-exempt (`0011`'s existing furikomi-only carve-out); recall does **not**
  retroactively refund the original transfer's fee (deliberate: matches real-bank practice, and
  keeps `0011` decision 5's "recall reuses `start()`, no new terminal state" simplicity intact).
  Real-deployment gotcha (same "verify library behavior" pattern as `0013` decision 5): `time`'s
  human-readable `OffsetDateTime` serialization is not RFC3339, so `fee-service`'s outbox
  projector (whose `fee.event.FeeReserved` must deserialize into `account-domain`'s
  `EventEnvelope`, the one thing it still needs to match despite depending on nothing) round-trips
  through a real `OffsetDateTime` rather than hand-formatting a string. `api-e2e` gained
  `scenarios/transfer-fee-and-points.e2e.test.ts` (award/redemption/refund, reading
  `PointsTable`/`FeeReservationsTable` directly via a new `support/pointsState.ts` — at the time
  neither had a query API yet, see `0025` — same backdoor-but-legitimate stance as
  `support/sagaState.ts`). Known gap surfaced by `docs/decision-tables.md`: the `Compensating`→
  `Compensated` path's `RefundFee` (as opposed to the `PendingDebit`-rejected path's) is unit-
  tested only, never exercised end-to-end.
- `0025`: closes a gap `0024` deliberately deferred — `points-service`'s `PointsTable` had no
  query API at all, so a customer's points balance was invisible everywhere, defeating the
  feature's own point (motivating engagement via points nobody can see). Adds `PointsQueryApi`
  (`GET /customers/me/points`, Lambda-less DynamoDB `GetItem`, ownerId from the Cognito JWT `sub`
  claim — same shape as `0016` decision 4's `GET /customers/me/accounts` — returning
  `{"balance": "0"}` instead of 404 when the customer has never earned any, matching
  `points-service`'s own "missing item = balance 0" treatment) and a `usePointsBalance()` hook
  feeding a badge in `BrandAppBar` (the header on the account-list/transfer-list screens, not
  `DetailAppBar`'s deliberately minimal detail screens, `0022`). Also threads
  `TransferSaga.cash_fee` (already existed since `0024`) through `transfer-status-projector.rs`
  into `TransferStatusView` so `TransferDetailScreen` can show the fee — a decision the ADR's own
  first draft described but initially failed to actually implement, caught only when the user
  found no fee visible anywhere; a second real-deployment bug followed the same thread (existing
  `TransferStatusView` items predating `cash_fee` lack the attribute entirely — DynamoDB doesn't
  backfill schema changes, the same gotcha `0011` hit with `owner_id` — and the VTL's
  `$input.path` on that missing attribute silently returned `""` rather than throwing, rendering
  as a bare "¥" client-side; fixed with a `#if`/`#else` defaulting to `"0"`). Final design,
  reached after a second round of user feedback: show the fee line whenever `cashFee` is present
  **at all**, `¥0` included, rather than hiding it at zero — hiding it made "no fee for this kind
  of transfer" indistinguishable from "fee data unavailable," which defeated the point of adding
  the field in the first place.

## Commands

```bash
cargo build --workspace              # build everything
cargo test --workspace               # run all tests (fast — account-domain has zero AWS/DB deps)
cargo test -p account-domain         # domain-only tests, no async runtime needed
cargo test -p account-service        # Lambda handler tests (grouping/batch logic; no live DB needed)
cargo test -p query-service          # projection tests (event → view, no AWS deps needed)
cargo test -p transfer-service       # saga state-machine tests (no AWS deps needed)
cargo test -p account-domain <name>  # run a single test by name (substring match)
cargo clippy --workspace --all-targets   # must be warning-free before considering work done
```

There are no live AWS resources in this environment. `account-service`'s persistence code
(`src/persistence.rs`, DynamoDB) is exercised only indirectly — it cannot be integration-tested
here. Rust is installed via `rustup`; if a fresh environment lacks it, `source "$HOME/.cargo/env"`
after install.

```bash
cd infra
npm test            # CDK synth assertions (infra/test/) — no live AWS needed, but bundles
                     # Lambdas via Docker so it's slower than the Rust tests above; this is
                     # why it's a GitHub Actions job (ci.yml) rather than in .githooks/pre-commit
npm run deploy       # deploy the current source to the live MonetaAccountPipelineStack
```

Both commands' Docker-based Lambda bundling writes to a persistent host-side cache,
`.rust-lambda-docker-cache/` (git-ignored); each run also auto-trims artifacts unused for 30+
days (by atime, with a size cap as a backstop) via `posttest`/`postdeploy` npm hooks
(`infra/scripts/sweep-rust-lambda-docker-cache.sh`, needs `cargo install cargo-sweep`, silently
skipped if absent). Likewise `cargo build`'s own `/target` is kept bounded on every commit by
`.githooks/pre-commit` (same tool, 14-day threshold since it's touched every commit rather than
only on infra runs).

```bash
cd api-e2e
npm test             # exercises the LIVE DEPLOYED STACK (real HTTP/SQS/DynamoDB calls) —
                      # this tests whatever is currently deployed, not your working tree.
                      # Run `infra`'s `npm run deploy` first if you've changed anything under
                      # crates/ or infra/lib/ since the last deploy, or you'll be testing stale
                      # code and get a misleading pass/fail. See api-e2e/README.md.
```

`api-e2e/` is its own top-level package, independent of `infra/` (it only reads the deployed
stack's CloudFormation outputs — see `api-e2e/README.md` for why it isn't nested under `infra/`
despite testing what `infra/` deploys). It's named `api-e2e` (not just `e2e`) because it only
drives the HTTP APIs directly — it doesn't touch the deployed web-ui through a browser.

```bash
cd ui-e2e
npm test             # same "live deployed stack" caveat as api-e2e above. Drives the deployed
                      # web-ui with headless Chromium (Playwright) — the one thing api-e2e and
                      # web-ui's own vitest component tests can't reach (real DOM/event-handler
                      # wiring against the live backend). See ui-e2e/README.md and ADR-0014.
```

`ui-e2e/` is a sibling of `api-e2e/`, not nested inside it, for the same reason `api-e2e/` isn't
nested inside `infra/` — different test runner (Playwright vs. Jest), different dependency
footprint (a browser binary), different layer under test. Same manual/on-demand, live-stack-only,
not-in-CI placement as `api-e2e/`.

Three tiers of testing, in increasing order of what they need and what they actually prove:
`cargo test`/`clippy` (source only, no AWS) → CDK synth tests (source only, no AWS, but proves
the infra actually synthesizes/bundles) → `api-e2e`/`ui-e2e`'s `npm test` (needs a live,
up-to-date deployment; proves the deployed system behaves as documented in
`docs/e2e-scenarios.md`). Only the first two run in CI (`.github/workflows/ci.yml`) — the E2E
suites need real AWS credentials and a deployed stack, so they stay manual/on-demand.

`.githooks/pre-commit` runs the first tier (cargo + web-ui) on every commit; enable it once per
clone with `git config core.hooksPath .githooks`. CI re-runs that plus the CDK synth tier as a
backstop in case the hook isn't set up or was bypassed.

## Architecture

### Crate boundary (ADR-0003, ADR-0008)

`account-domain` has zero AWS/DB/async dependencies — enforced by what's absent from its
`Cargo.toml`, not just convention. All business rules live there as pure functions.
`account-service` holds everything else on the write path (Lambda/SQS glue, DynamoDB persistence
mapping, orchestration) and is deliberately not further split into a repository-trait layer
(ADR-0003 explains why not, given this PoC's current scope). `query-service` is a third crate
(ADR-0008) holding the DynamoDB projection Lambda; its Cargo.toml has no SQS/EventBridge-publish
dependencies, so it cannot reach into account-service's write-path internals or independently
publish events even accidentally. `transfer-service` (ADR-0010) is a fourth crate holding the
cross-account transfer saga; like `query-service` it depends only on `account-domain` (not
`account-service`) — it talks to account-service exclusively through the same public interface
any other caller would use (SQS `SendMessage` against account-service's command queue,
EventBridge subscription for the results), never through shared code or a shared database.

Three more crates go further and depend on **nothing account-related at all** (not even
`account-domain`) — `auth-service` (ADR-0016), `points-service`, and `fee-service` (both
ADR-0024). `points-service` is the leaf of a one-way **usage** chain
`transfer-service` → `fee-service` → `points-service` — SQS commands and EventBridge events only,
never a Cargo dependency in either direction, the same boundary `account-service`/
`transfer-service` already draw. If you're about to add a non-domain dependency to
`account-domain`, or reach into another crate's persistence internals from `query-service`,
`transfer-service`, `fee-service`, or `points-service`, stop — it belongs elsewhere.

### Domain model conventions (`account-domain`)

`AccountState`/`Command`/`Event` are enums with per-variant data, not a shared struct with
optional fields. `Account::apply` (decide) and `Account::evolve` (fold) never use a wildcard
match arm over these enums — adding a new variant must force a compile error at every call site
that needs updating. Don't add a `_ =>` fallback to these matches; it defeats the design's
purpose. Account creation goes through the same path as everything else (`Command::Open` /
`Event::Opened`, via `Account::apply_to_absent` since there's no existing `Account` to call
`.apply` on yet).

### Message processing invariants (ADR-0002 — read before touching `handler.rs` / `persistence.rs` / `grouping.rs` / `batch.rs`)

Two invariants anchor this design, and both were arrived at by reverting an earlier version
that caused real bugs (silent data loss / unnecessary retries) — see ADR-0002 for the full
reasoning, current retry parameters, and rejected alternatives rather than assuming from this
summary:

1. Domain rejections (`DomainError`) and infrastructure failures are classified and handled
   completely differently. Never let one masquerade as the other.
2. Failure handling is per-message-transaction and per-`MessageGroupId`-scoped, not per-batch.
   When a group fails, every message in it from the failure point onward must be reported —
   never a gap.

### DynamoDB persistence conventions

`account-service` persists `AccountState` in DynamoDB: optimistic concurrency via a `version`
attribute and `ConditionExpression` (not auto-retried by DynamoDB — the retry loop is
application code), and one `TransactWriteItems` call per message covering the account item,
the outbox event item, and the idempotency-log item. Full rationale lives in ADR-0002 and
ADR-0013 — treat those as the single source of truth rather than copying specifics here.
`persistence.rs`'s `item_to_state`/`state_to_item` are the only place the `AccountState` ⇄
DynamoDB-item mapping should live.

### Verify AWS/library behavior before assuming it

This codebase's design went through several rounds of correction where an initial assumption
about AWS behavior (FIFO batch ordering guarantees, `ReportBatchItemFailures` default scope,
whether `dynamodb:TransactWriteItems` alone authorizes a transaction's per-item actions — it
doesn't, see ADR-0013 decision 5) turned out to be wrong or incomplete on inspection. Check
current official docs and existing libraries before implementing new AWS-integration behavior
rather than relying on general knowledge.
