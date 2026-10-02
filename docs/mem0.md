# mem0 — semantic memory (design)

Status: shipped, 2026-10-01. The service is live on the RPi (fresh deploy,
consumer keys); the capture pipeline and recall are live in
`base/extensions/mem0/` (fleet) and the personal agent's installed copy. The
notes corpus was migrated into the `denis` namespace on 2026-10-01. The
curated notes system (`docs/memory.md`) stays; mem0 takes over automatic
recall and capture.

## What it is

Every agent recalls and stores facts in a self-hosted mem0 at
`https://memory.sudakov.site`. mem0 is a **dependent service**: one compose
stack on the RPi, independent of every consumer — stopping bots must not stop
memory. Consumers hold only the URL and an API key.

```text
bots container / personal agent
  └─ extension: recall (automatic) + tools (explicit) + capture (pipeline)
      └─ HTTPS → memory.sudakov.site → mem0 server
            ├─ extraction LLM + embeddings → Ollama (PC)
            └─ pgvector (RPi)
```

Role split with notes: mem0 is the **automatic** layer (recall per input,
capture from every session); notes stay the **curated** layer the agent edits
deliberately. mem0 rows are facts, never transcripts.

## Consumers and namespaces

| consumer | user_id | notes |
|---|---|---|
| fleet bot `<name>` | `bot:<name>` | derived from the agent dir; no per-bot config needed |
| personal agent | `denis` | set in its `settings.json` |

Recall and writes are scoped to the consumer's own namespace only. The
`shared` namespace (cross-bot reads) is deferred; it lands when a corpus
exists that needs it.

## Capture pipeline

The naive version — every finished turn sent to mem0 — produces one extraction
LLM call per turn and floods memory with conversational noise. The pipeline
replaces it with three stages: **buffer → gate → batch**.

```text
turn_end ──append──▶ buffer (user/assistant text, redacted)
                        │ flush trigger (see below)
                        ▼
                     gate: tev1:4b (Ollama) — "worth remembering?"
                        │ true / error            │ false
                        ▼                          ▼
                 mem0 /memories (batch)          drop + log
                   → server extraction (LLM, reasoning off)
                   → embeddings → pgvector
```

Design rules:

- **The batch is the unit.** One gate call and one `add` call per flush, not
  per turn. A batched conversation also gives the extractor coherent context,
  which improves fact quality beyond what a bigger model alone would.
- **The gate is coarse, extraction is fine.** The gate decides *whether the
  batch is worth extracting at all*; mem0's extractor decides *which facts to
  keep*. Gate false positives cost one extraction call; gate false negatives
  lose a batch. The gate therefore errs permissive on failure.
- **Explicit writes bypass the pipeline.** `mem0_memory add` and
  `/mem0 add` go straight to mem0; the gate only governs automatic capture.
- **Fire-and-forget.** Capture never blocks a turn; flushes serialize through
  one promise chain. Recall is separate and unaffected.

### Buffer

- Entries are `(role, text)` for user and assistant messages; tool calls,
  tool results and thinking blocks are excluded — facts live in prose, not in
  payloads. Text is redacted (private keys, bearer/API tokens, `key=value`
  secrets) before buffering, so nothing raw is held or sent.
- The buffer lives in the extension process, keyed by session. A session
  switch or `session_shutdown` flushes it best-effort.

### Flush triggers

| trigger | default | meaning |
|---|---|---|
| `flushMessages` | 12 | flush when the buffer holds this many messages |
| `flushIdleMs` | 180000 (3 min) | flush this long after the last append |
| `capMessages` | 64 | hard cap; forces a flush, bounds process memory |
| session end | — | best-effort flush on shutdown or session switch |

Per-message text is truncated (1000 chars) before it enters a gate or add call.

### Gate

One chat call to an OpenAI-compatible endpoint (Ollama) with a fixed
criteria-based prompt: durable facts about the user, their preferences,
environment, projects, decisions, corrections, lasting context → keep;
routine task chatter, tool status, greetings, acknowledgments, ephemerality →
skip. The model answers `{"remember": true|false}`; the parser is lenient
(accepts bare `true`/`false`) and a parse failure counts as `true`.

- Timeout 5 s; on timeout/HTTP error/parse error → **treat as `true`**
  (fail-open toward remembering) and log once.
- Gate off (`gate.enabled: false` or no endpoint) → every batch is sent.

### Model choice — measured, not assumed

Probe: 8 labeled conversation excerpts (4 keep, 4 skip), same criteria prompt,
`temperature: 0`, thinking disabled, reference deployment (RTX 5070, Ollama
0.35). Warm calls after the first per model.

| model | accuracy | warm latency | cold load | verdict |
|---|---|---|---|---|
| `tev1:0.8b` | 5/8 | ~30–150 ms | ~1.0 s | rejected: missed 3/4 skip cases, inconsistent output shape |
| `tev1:4b` | 8/8 | ~100 ms | ~1.2 s | **gate default** |
| `qwen3.5:4b` | 8/8 | ~80–160 ms | ~6.4 s | viable, but 5× colder to load than tev1:4b |

The 0.8b model fails exactly where the gate exists to help: it classified test
runs, container status and directory listings as worth remembering. tev1:4b
wins on accuracy and cold-start; a per-flush call at ~100 ms is noise.

Extraction runs **server-side** and is chosen by mem0's `/configure`, not by
the client — no extension change to swap it. Current: `qwen3.5:4b`, reasoning
off (thinking consumes the token budget; `reasoning_effort: "none"` on the
OpenAI-compat endpoint). Decision 2026-10-01: keep 4b for now; `qwen3.5:9b`
stays an evaluation option (the reference GPU fits it), not a target. The
probe above is 8 cases: expand it before trusting the gate's precision.

Extraction probe (2026-10-01, same deployment): realistic fact-rich payloads
extract 3–4 facts, 5/5 runs — robust. A synthetic two-message batch carrying
one trivial fact ("the smoke lamp number is 42") flaked: 3/5 at
`temperature: 0.2`, 2/5 at `0`; `qwen2.5:7b` extracted nothing on it. The 4b
treats borderline-trivial facts as optional at the margins; real conversation
is not that thin. Keep `qwen3.5:4b` @ 0.2 and revisit only if real traffic
shows losses.

### Failure matrix

| failure | behavior |
|---|---|
| gate endpoint down / slow / unparseable | batch sent anyway (fail-open) |
| mem0 down / slow | batch dropped; log line; nothing blocks |
| service returns 4xx/5xx | same as down; tools surface the error to the model |
| process dies mid-session | unfushed buffer lost (bounded by `capMessages`) |

Observability: `/mem0 status` reports provider, capture/Gate state and buffer
depth; `DEBUG=mem0` logs gate verdicts and flush sizes; the footer indicator
shows the live memory count.

## Recall path

Unchanged from the ported extension:

1. `input` starts a background search (topK 5) with the user text.
2. `before_agent_start` consumes it with a 3 s timeout — miss ⇒ skip, never
   block the turn.
3. Results are injected as a custom user-channel message (`mem0-recall`),
   never into the system prompt (prefix-cache safe), each entry wrapped as
   `[UNTRUSTED MEMORY DATA]`; entries matching injection patterns are blocked.

### Recall noise — measured + plan (2026-10-02)

**TL;DR: mem0 returns pure nearest-neighbors — no score threshold. `"are we
there yet?"` still pulled 5 entries at scores 0.20–0.24; genuinely relevant
queries score 0.32–0.66. Fix (implemented 2026-10-02, both live in the
extension, not the server): client `minScore` filter, then an optional tev1
relevance pass over the survivors via `/v1/systemone`.**

Search scores on the live corpus: irrelevant top hits 0.20–0.24, routine
queries 0.32–0.40, on-topic queries 0.56–0.66. The server applies no floor,
so empty or off-topic inputs always surface SOMETHING. Implemented:

1. `minScore` config (client-side filter on returned scores; 0.30 default,
   entries without a score are kept, 0 disables). Zero-risk, kills the
   common case.
2. `recallFilter` (default off): ONE tev1 call via Ollama's `/v1/systemone`
   endpoint (Jev-style typed API, Ollama 0.35+) — one `noul` question per
   candidate ("is memory_N relevant to the current message?"), state carries
   the current message + up to 2 prior user turns + the candidate texts.
   Keep at noul ≥ 0.5. Runs only when at least one entry passes `minScore`,
   so most turns stay model-free. Warm call ≈ 125 ms on the PC; probe
   separation: on-topic 0.93 vs off-topic 0.05. Fail-open like the gate:
   timeout/HTTP error/missing answer keeps the entry, so a cold or misbehaving
   filter never starves recall.

The capture gate also moved to `/v1/systemone` the same day: one `noul`
question ("does this batch contain durable information?") instead of a
chat-completions JSON prompt, which was the wrong interface for a decision
model (Ollama builds tev1's prompt itself on systemone). Threshold stays
0.5; config shape (`baseUrl`, `model`, `timeoutMs`, `apiKey`) is unchanged.

The injected block stays small (`MAX_BLOCK_BYTES` 8 KB, 50 lines); the issue
is relevance, not size.

## Config reference

`settings.json`, key `pi-memory-mem0`. Precedence: settings > environment >
built-in defaults. The container deployment needs no per-bot settings: the
launcher exports the `MEM0_*` variables, and bots derive their namespace from
the agent dir.

```json
{
  "pi-memory-mem0": {
    "baseUrl": "https://memory.sudakov.site",
    "apiKeyProfile": "mem0",
    "memoryMode": "hybrid",
    "autoCapture": true,
    "autoRecall": true,
    "toolEnabled": true,
    "topK": 5,
    "minScore": 0.3,
    "recallFilter": {
      "enabled": true,
      "baseUrl": "http://192.168.1.20:11434/v1",
      "model": "tev1:4b",
      "timeoutMs": 1500
    },
    "capture": {
      "flushMessages": 12,
      "flushIdleMs": 180000,
      "capMessages": 64,
      "gate": {
        "enabled": true,
        "baseUrl": "http://192.168.1.20:11434/v1",
        "model": "tev1:4b",
        "timeoutMs": 5000
      }
    }
  }
}
```

In the container: `apiKey` comes from `MEM0_API_KEY` (a consumer key injected
at run time), `baseUrl` from `MEM0_BASE_URL`; the gate endpoint from
`MEM0_GATE_BASE_URL` / `MEM0_GATE_MODEL`; the recall-filter endpoint from
`MEM0_FILTER_BASE_URL` / `MEM0_FILTER_MODEL`. `apiKeyProfile` (rbw) is the
host-only resolution path; the image has no rbw.

## Service operations

- Stack: `deploy/mem0/compose.yml` (mem0 + pgvector), rootless podman on the
  RPi, Caddy TLS in front, no published port. Secrets are piped at `up` time
  from Bitwarden, never stored.
- After a fresh deploy, `/configure` must replay the deployment config
  (LLM/embedder models, `openai_base_url`, reasoning off, 768 dims on both the
  embedder and the vector store — pgvector table dims freeze at first insert).
- The server keeps a chat log (`/app/history/history.db`) and feeds recent
  messages into extraction context: a deleted memory can be re-extracted from
  that context. A fresh install starts clean; keep this in mind when a fact
  must vanish for good.
- Consumers authenticate with **non-admin consumer keys** (`m0sk_`, one per
  consumer — personal agent, fleet container), never the admin key. Caveat:
  this server does not scope keys to namespaces — any valid key can read and
  write any `user_id` string. A consumer key removes admin powers
  (`/configure`, `/reset`, unfiltered listing) and makes the consumer
  revocable; namespace isolation stays client-side.
- Admin key rotation is low priority once consumers no longer use it. Still
  open: nightly `pg_dump` + off-RPi copy. Tracked in the service backlog.

## Evaluation plan (P3)

1. Expand the gate probe to ~50 labeled excerpts from real sessions; measure
   precision/recall per model; keep the gate only if false negatives are
   negligible (a missed batch is silent).
2. Extraction quality: 4b measured on synthetic + realistic probes (see
   above); compare against 9b only if real traffic shows losses.
3. Tune flush sizes from session telemetry (flushes per session, messages per
   flush, skip rate).
4. Re-check the dedup command cadence once capture volume is known.

## Known gaps (adversarial review, 2026-10-02)

First recorded here (prior list lived in an ephemeral session memo). Not yet
fixed; tests to be added with each fix.

- **High**
  - `provider.ts` `getAll` sends no `top_k` → server default 20 truncates the
    status line, `/mem0 profile`, `mem0_memory get_all` (~922 memories).
  - `provider.ts` `getDedupGroups` hard-throws at ≥1000 memories (server caps
    `top_k` at 1000, no pagination server-side yet).
  - `privacy.ts` redaction gaps — verified leaks: JSON `"password": "…"`,
    `AWS_SECRET_ACCESS_KEY=…`, DB-URL passwords (`postgres://user:pw@host`),
    `Authorization: Basic …`, bare `sk-…`, `xoxb-…`, `ssh-rsa …`.
  - Recall-block accumulation (`index.ts` + `prefetch.ts`): one 8 KB/
    50-line block per prompt persists in context. Fix: handle the `context`
    event and keep only the newest `mem0-recall` block.
- **Medium**: `turn_end` captures aborted/errored assistant text; `input`
  does not ignore `source: "extension"` user messages; recall search query is
  not truncated; `parseGateAnswer` falls back to the first bare `true|false`;
  gate excerpt cap 12 000 chars > gate box `n_ctx_slot = 4096`;
  `refreshMemoryStatus` full-fetches on every add.
- **Low**: prefetch race timer not cleared; `cachedApiKey` lives for the
  process; `delete` is not scope-checked (server doesn't scope consumer
  keys); `reasoning_effort: 'none'` is Ollama-shaped.
- Tests: `base/extensions/mem0/test/harness.mjs` (26 tests, fake servers, no
  network) covers none of the above yet.
- Server-side need: `offset` support in `deploy/mem0/app/main.py` (`GET
  /memories`, scoped + admin paths) → RPi redeploy; until then dedup stays
  capped for stores ≥1000.

## Open questions

- `shared` namespace and cross-bot recall: needs a corpus; revisit after
  capture runs a week.
- Gate false negatives could be softened by storing skipped batches as
  short-lived memories (`expiration_date`) instead of dropping them; only if
  evaluation shows the gate is too strict.
