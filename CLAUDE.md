# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project context

This is a technology-validation PoC for a blog article, not a reference architecture for
organizational rollout. Prioritize technical validity over organizational realism (review
processes, team ownership, governance) — those are left as discussion points for the article,
not implemented. Write path: Web UI (not yet built) → API Gateway → SQS FIFO → Lambda (Rust) →
Aurora DSQL. Read path: DSQL outbox → EventBridge → Query service (Lambda + DynamoDB) →
API Gateway → caller.

**`docs/adr/` is the single source of truth for design rationale, constraints, and decision
history — this file only orients and points there.** Don't copy specifics (retry counts,
SQLSTATE codes, backoff parameters, full constraint lists) from an ADR into this file; they've
already drifted out of sync here once. Read the relevant ADR before changing behavior it covers,
and add a new ADR (or revise one) when a non-obvious decision is made or reversed.

- `0001`: microservice boundaries (aggregate ≠ microservice; bounded contexts) and event-driven
  service integration — Transfer/Notification service remain proposed/out of scope; Query service
  is now implemented, see `0004`.
- `0002`: SQS FIFO message lifecycle, error classification (`DomainError` vs. infra failure),
  transaction granularity, DLQ design, Aurora DSQL constraints — directly reflected in
  `account-service`'s code.
- `0003`: why `account-domain` and `account-service` are separate crates, and the boundary
  between them.
- `0004`: Query service — transactional outbox (DSQL → EventBridge), the account-service/Query
  service ownership boundary, DynamoDB read model, and the DynamoDB-direct-integration query API.
- `0005`: schema/role/IAM-grant setup is applied automatically on every deploy via a CDK Custom
  Resource, not a manually-run script — `schema.sql` is the idempotent single source of truth,
  embedded directly into the migrator Lambda.
- `0006`: write-path API Gateway — Lambda-less APIGW→SQS `SendMessage` direct integration,
  client-generated account IDs, `Idempotency-Key` header, per-command REST resources.

## Commands

```bash
cargo build --workspace              # build everything
cargo test --workspace               # run all tests (fast — account-domain has zero AWS/DB deps)
cargo test -p account-domain         # domain-only tests, no async runtime needed
cargo test -p account-service        # Lambda handler tests (grouping/batch logic; no live DB needed)
cargo test -p account-domain <name>  # run a single test by name (substring match)
cargo clippy --workspace --all-targets   # must be warning-free before considering work done
```

There is no live Aurora DSQL instance in this environment. `account-service`'s persistence code
(`src/persistence.rs`) is exercised only indirectly — it cannot be integration-tested here.
Rust is installed via `rustup`; if a fresh environment lacks it, `source "$HOME/.cargo/env"`
after install.

## Architecture

### Crate boundary (ADR-0003)

`account-domain` has zero AWS/DB/async dependencies — enforced by what's absent from its
`Cargo.toml`, not just convention. All business rules live there as pure functions.
`account-service` holds everything else (Lambda/SQS glue, DSQL persistence mapping,
orchestration) and is deliberately not further split into a repository-trait layer (ADR-0003
explains why not, given this PoC's current scope). If you're about to add a non-domain
dependency to `account-domain`, stop — it belongs in `account-service`.

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

### Aurora DSQL constraints

The full constraint list (no `SAVEPOINT`, limited SQL surface, OCC conflict handling,
DDL-per-transaction, etc.) lives in ADR-0002's context section — treat that as the single
source of truth rather than copying specifics here, since at least one of them (`SELECT FOR
UPDATE` support) was already found to be more nuanced than first assumed after checking official
docs. `persistence.rs`'s `row_to_state`/`state_to_columns` are the only place the
`AccountState` ⇄ DB-row mapping should live.

### Verify AWS/library behavior before assuming it

This codebase's design went through several rounds of correction where an initial assumption
about AWS behavior (FIFO batch ordering guarantees, `ReportBatchItemFailures` default scope,
whether an official DSQL retry helper already existed) turned out to be wrong or incomplete on
inspection. Check current official docs and existing libraries before implementing new
AWS-integration behavior rather than relying on general knowledge.
