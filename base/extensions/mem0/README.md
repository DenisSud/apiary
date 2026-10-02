# mem0 — semantic memory

Every agent recalls and stores facts in a self-hosted mem0 server
(`docs/mem0.md` is the design). Recall is automatic per input; capture is
automatic but buffered, gated and batched; the `mem0_memory` tool and the
`/mem0` command give explicit access.

Vendored from `@amaster.ai/pi-memory-mem0` v0.1.2-beta.15 (Apache-2.0, see
`LICENSE`), stripped to the self-hosted REST backend, plus the capture
pipeline.

## Configuration

`settings.json` key `pi-memory-mem0`; environment fallbacks fill the gaps for
deployments without per-agent settings (the fleet container).

| setting | env | default | meaning |
|---|---|---|---|
| `baseUrl` | `MEM0_BASE_URL` | — | server URL; required |
| `apiKey` | `MEM0_API_KEY` | — | consumer key; required unless `apiKeyProfile` resolves one |
| `apiKeyProfile` | — | — | `security` extension profile (rbw) providing the key |
| `apiKeyVar` | — | `MEM0_ADMIN_API_KEY` | var read from that profile |
| `memoryMode` | — | `hybrid` | `hybrid` / `active` / `passive` preset |
| `autoCapture` / `autoRecall` / `toolEnabled` | — | preset | independent overrides |
| `userId` | — | `bot:<PI_BOT_NAME>` or `$USER` | namespace |
| `userIdScope` | — | `project` | hash the cwd into the namespace (`exact` keeps it verbatim) |
| `topK` | — | `5` | recall and search result limit |
| `capture.flushMessages` | — | `12` | flush when the buffer holds this many messages |
| `capture.flushIdleMs` | — | `180000` | flush this long after the last append |
| `capture.capMessages` | — | `64` | hard buffer cap |
| `capture.gate.enabled` | — | `true` when a gate URL is set | decision gate before capture |
| `capture.gate.baseUrl` | `MEM0_GATE_BASE_URL` | — | OpenAI-compatible endpoint (Ollama) |
| `capture.gate.model` | `MEM0_GATE_MODEL` | `tev1:4b` | gate model |
| `capture.gate.timeoutMs` | — | `5000` | gate timeout; failure means capture |
| `autoCapture` (env form) | `MEM0_AUTO_CAPTURE` | — | `true`/`false` wins over settings (bulk runs) |

## Capture pipeline

`turn_end` text is appended to a per-session buffer (redacted, truncated). A
flush — size, idle, cap, or session end — runs one gate call over the whole
batch; a "no" drops it, everything else posts it to mem0 as a single
conversation. The gate is a small decision model (`docs/mem0.md` measured the
models); the extractor is chosen server-side via mem0's `/configure`.

## Layout

| file | what |
|---|---|
| `index.ts` | hooks, tool and command wiring, config and key resolution |
| `capture.ts` | buffer → gate → batch pipeline |
| `provider.ts` | self-hosted REST client |
| `prefetch.ts` | two-phase recall (kick off on input, consume with timeout) |
| `privacy.ts` | redaction, untrusted-data wrapping, injection scan |
| `tools.ts` | the `mem0_memory` tool |
| `dedup.ts` | exact-duplicate maintenance for `/mem0 dedup` |

## Tests

`./test/run.sh harness` — fake HTTP servers and a stubbed pi API, no network,
no vault. Requires the installed `pi` store (symlinks set up by the script).
