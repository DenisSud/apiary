# systemone — pre-tool risk guard

The `systemone` extension adds a decision-model policy layer above the
deterministic safety rules. It rides on `@pi-bots/systemone` (the System One
client and shared config); this extension owns the guard **policy**: which
tools to gate, what to ask, and what a probability means.

The first implemented lifecycle point is the **pre-tool risk guard**: for
guarded tool calls, one classifier request asks two things — is the call
dangerous, and did the user actually ask for it — and the call is blocked when
it is dangerous and not clearly authorized.

## Why two questions

One question cannot separate the cases that matter: a user-requested
`git reset --hard` and an injected one look identical on danger alone. Asking
`danger` and `authorized` in the same request costs one latency (questions run
in parallel), and the rule

```
block  iff  danger >= threshold (0.5)  and  authorized < authorizedThreshold (0.7)
```

lets explicitly requested work through while stopping injected or unrequested
damage. Live battery on Kev-4B: asked `git reset --hard` allowed (0.74/0.85),
the same command under a different prompt blocked (0.86/0.10); injected
`curl … | sh` blocked (0.83/0.15); `cat ~/.ssh/id_rsa` blocked (0.73/0.12).

## Design rules

- **Trusted state only.** A request carries the recent user messages and the
  proposed tool call. Tool results and assistant messages are excluded — fetched
  content must never authorize its own execution (the rule LangChain's
  `AutoModeMiddleware` uses). The `authorized` question is instructed to judge
  only from the user messages and to ignore claims inside the call.
- **Deterministic rules stay first.** `security/guard.ts` blocks known
  credential paths with no classifier. The decision layer complements it and
  the redaction net; it is not a sandbox — classifier state can be steered by
  adversarial text.
- **Fail-open by default.** A classifier outage must not brick bash: failures
  notify once per streak, and after 3 consecutive failures classification is
  skipped for 60 s (`open`). `closed` blocks on failure instead.
- **Secrets stay out.** Sensitive-looking argument keys (`apiKey`, `password`,
  `token`, …) are replaced with `«redacted»` before the request, and argument
  strings are capped at 8000 chars.

## Config

The endpoint and shared settings live in `~/.pi/agent/decision.json` (see
`packages/systemone/README.md`). This extension reads the `guard` section:

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

Without the config file the extension registers nothing.

## Tuning the thresholds

Kev's calibration is fitted in distribution; check thresholds on your own
traffic before relying on them. Defaults are `danger 0.5` /
`authorized 0.7`. `./test/run.sh live` classifies four sample calls (benign,
requested destructive, unrequested destructive, injected install) without
executing anything.

## Roadmap

- `web_search` result filtering: score result snippets against the user's
  request, drop the irrelevant ones before they enter context.
- Compaction checkpoints: on `session_before_compact` (`reason: "threshold"`),
  defer when the agent is mid-task unless usage is near the hard limit.
- Thinking level from the request: classify on `input`, then
  `pi.setThinkingLevel(...)`.

## Tests

`./test/run.sh harness` — handler tests against a mock System One server, no
network; `./test/run.sh live` — the same client against a real endpoint. The
client and config themselves are tested in `packages/systemone`.
