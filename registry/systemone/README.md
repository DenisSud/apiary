# systemone — the pre-tool risk guard

A decision-model policy layer above the deterministic security rules, riding
on `@pi-bots/systemone`. For guarded tool calls it asks one classifier two
questions — is the call dangerous, and did the user ask for it — and blocks
when it is dangerous and not clearly authorized:

```
block  iff  danger >= 0.5  and  authorized < 0.7
```

Two questions separate a user-requested destructive command from an injected
one; asking both in one request costs one latency. Only trusted state is
sent: recent user messages plus the proposed call — tool results never
authorize their own execution. Deterministic rules stay first; the guard is
fail-open by default (after 3 consecutive failures, classification pauses
for 60 s). Not a sandbox: adversarial text can steer a classifier.

## Config

`~/.pi/agent/decision.json` → `guard` section (endpoint and shared settings:
`packages/systemone/README.md`):

| field | default | meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `tools` | `["bash","ptc"]` | tool names to classify |
| `threshold` | `0.5` | block when `danger >= threshold` |
| `authorizedThreshold` | `0.7` | …and `authorized < authorizedThreshold` |
| `onError` | `"open"` | `open` = allow on failure, `closed` = block |
| `contextMessages` | `4` | recent user messages in the state |
| `contextChars` | `1500` | per-message cap |
| `blockedMessage` | — | override; placeholders `{tool_name}`, `{danger_probability}`, `{authorization_probability}`, `{threshold}`, `{authorization_threshold}` |

Without the config file the extension registers nothing. Check thresholds on
your own traffic before relying on them.

## Files and tests

`index.ts` + `guard.ts`. `./test/run.sh harness` (mock server, no network) and
`./test/run.sh live` (real endpoint, classifies four samples without
executing). The client and config are tested in `packages/systemone`.

Later consumers of the same layer: search-result filtering, compaction
checkpoints, thinking-level selection.
