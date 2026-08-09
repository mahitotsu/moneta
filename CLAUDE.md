# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project context

This is a technology-validation PoC for a blog article, not a reference architecture for
organizational rollout. Prioritize technical validity over organizational realism (review
processes, team ownership, governance) — those are left as discussion points for the article,
not implemented. Write path: Web UI (`web-ui/`, React) → CloudFront → API Gateway → SQS FIFO →
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

Three tiers of testing, in increasing order of what they need and what they actually prove:
`cargo test`/`clippy` (source only, no AWS) → CDK synth tests (source only, no AWS, but proves
the infra actually synthesizes/bundles) → `api-e2e`'s `npm test` (needs a live, up-to-date
deployment; proves the deployed system behaves as documented in `docs/e2e-scenarios.md`). Only
the first two run in CI (`.github/workflows/ci.yml`) — the E2E suite needs real AWS credentials
and a deployed stack, so it stays manual/on-demand.

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
EventBridge subscription for the results), never through shared code or a shared database. If
you're about to add a non-domain dependency to `account-domain`, or reach into another crate's
persistence internals from `query-service` or `transfer-service`, stop — it belongs elsewhere.

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
