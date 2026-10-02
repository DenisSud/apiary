# Secrets for agents — design (2026-10-02)

Status: proposal. Backs the question "how does a bot manage my opengym
account without ever seeing the password". Current fleet state: personal
rbw + Bitwarden folders (g14), mem0-style `X-API-Key` on the RPi services.

## TL;DR

The Bitwarden **password-manager SDK is gone** (`sdk-internal` = internal
use only); what's public is the **Secrets Manager SDK** (Rust + Node/Python
bindings) — machine-facing tokens, projects, revocable ACLs. That's the
right machine layer, but we consume it as a **token + reference boundary**,
not a client library. We build a small **secrets broker** microservice
(alongside mem0) that holds per-tenant proxy credentials and
resolves `tenant/secret` references at the tool boundary; agents see only
`ref:…`. A shared Bitwarden PM server for bots: **no** — bots shouldn't see
a PM vault, and Vaultwarden's API-key model is per-user-not-tenant.
Per-user Vaultwarden comes back in at the **SaaS layer** (human users, one
tiny instance each, import via CSV/KDBX), with tenancy enforced in our
broker. Confidentiality filtering sits at the **tool-result boundary**
(hook above the tools), not inside mem0 — same guard point covers tooltips,
bash env, and memory capture in one place.

## SDK landscape — measured, not assumed

- `bitwarden/sdk-internal`: PM logic living under our extension code, not
  a network API. "Not intended for public use and is not supported."
- `bitwarden/sdk-sm` (Secrets Manager): public, healthy, official
  Node/NAPI + Python bindings for the `bws` token model.
- 1Password: same split (human vault vs service-account tokens for
  machines). Vaultwarden: PM only, community, no machine-token story.
- Self-host BSM needs an Enterprise license file; BSM **cloud free tier**
  is 2 users / 3 projects / 3 machine accounts — enough for the fleet
  today.

## What we build

1. **Claim-refs at the tool boundary** (small, inside
   connector/browser-tool): model writes `ref:opengym.password` into a
   form field or `secrets_profile` arg; the hook (not the model) resolves it
   against the broker and fills the actual value. No secret value ever
   enters a transcript or the model context.
2. **Secrets broker** (microservice, container on the RPi next to mem0):
   per-user tenants (`user:<id>`, `bot:<name>`), each tenant holds its own
   narrow proxy credential (BSM access token / Vaultwarden API key / other
   backend), and drivess `resolve(ref)` and `check_scope(ref)` for bot
   containers over `X-API-Key` — same auth pattern as mem0 today. Backend
   is pluggable; the API is ours, the vendors are replaceable.
3. **SaaS layer** (later, when there are users to sign up): per-user
   Vaultwarden instance as the human vault (small, API-key auth — matches
   what the broker already consumes), broker holds the tenancy. Import via
   CSV/KDBX covers "bring your existing credentials".

**Not** building: a fleet-wide shared Bitwarden PM server for bot
containers. Bots are actors that need scoped, individually-revocable
secrets; an IMAP-to-tenant mapping in a shared PM vault is the wrong
granularity and a wrong blast radius. Denis's personal flow (rbw + folder
`pi`) is unchanged and outside this design.

## Confidentiality vs memory

Two different leaks, two different layers:

- **Memory leak** (a secret gets captured/recalled): `privacy.ts` redacts
  capture input; `minScore` + potential tev1 relevance filtering keep the
  recall block tight.
- **Trans-provider leak** (model output repeats the secret in visible
  text or tool args, i.e. out from under the redaction): lives at the
  **tool-result hook** that pi's Jev/decision middleware already defined
  (`tool_call` as pre-gate, `tool_result` as post-gate). One guard point
  covers the web tool, the bash env, and every future tool — mem0 capture
  stays clean by never seeing redacted content in the first place.

This is the same principle as mem0's namespace discipline: isolate at the
consumer, not the producer.
