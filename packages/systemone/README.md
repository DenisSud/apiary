# @pi-bots/systemone

The decision-model layer: a small HTTP client for **System One** decision
endpoints (the TypeSafe wire format; [Kev](https://github.com/jaredpalmer/kev)
is the reference local server) plus the shared config for it. Extensions and
other packages poll from here; policy — which questions to ask, what a
probability means, how failures are handled — stays with the consumer.

## API

```ts
import { DecisionClient, loadConfig } from "@pi-bots/systemone";

const config = loadConfig(); // null when no config file exists
const client = new DecisionClient(config);

const answers = await client.classify(
  {
    user_messages: ["please clean the workspace"],
    tool_call: { name: "bash", args: { command: "rm -rf dist" } },
  },
  [
    { id: "danger", instructions: "…would executing it plausibly cause harm…",
      criteria: { true: "…destructive…", false: "…low risk…" } },
    { id: "authorized", instructions: "…do the user messages ask for this call…" },
  ],
);
answers.danger.probability; // calibrated [0, 1]
```

- `classify(state, questions, signal?)` sends every question in one request and
  resolves to `{ [id]: { probability, latencyMs?, requestId? } }`.
- Timeout is `timeoutMs` from the config; an outer `AbortSignal` can cancel.
- Failures throw `DecisionError` (`timed out`, `aborted`, `HTTP 4xx/5xx`,
  `response is not JSON`, `response has no noul answer for "<id>"`).
- `readNoul(payload, id)` is exported for tests and unusual transports.

The state may be a string, object or array; it is passed through untouched.
Sending only trusted content (user messages, the proposed action — never tool
results or fetched pages) is the caller's job.

## Config

`~/.pi/agent/decision.json` (override `PI_DECISION_CONFIG`). Without the file
`loadConfig()` returns `null` and consumers stay inert.

| field | default | meaning |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8009` | System One endpoint |
| `model` | `kev-latest` | model id sent in each request |
| `timeoutMs` | `2000` | per-request timeout |
| `apiKeyEnv` | — | env var holding the bearer key (optional) |
| `guard.*` | see below | the tool-guard section (consumed by `registry/systemone`) |

`guard`: `enabled` (`true`), `tools` (`["bash"]`), `threshold` (`0.5`),
`authorizedThreshold` (`0.7`), `onError` (`"open"`), `contextMessages` (`4`),
`contextChars` (`1500`), `blockedMessage` (—). See
`registry/systemone/README.md` for what they mean.

Sections for other consumers (compaction, search filtering) are added to this
schema as they are built.

## Wire protocol

`POST {baseUrl}/v1/systemone` with `Authorization: Bearer $apiKeyEnv` when set.

```json
{
  "model": "kev-latest",
  "state": { "…": "the content to evaluate" },
  "questions": {
    "<id>": {
      "type": "noul",
      "instructions": "…",
      "criteria": { "true": "…", "false": "…" }
    }
  }
}
```

Answers are read from `answers` (Kev/TypeSafe), `nouls` (SDK shape) or the root
object: `{ "answers": { "<id>": { "type": "noul", "noul": 0.93 } } }`.

## Running Kev locally

Kev is Apache-2.0, serves the same wire format, and answers in tens of ms on a
GPU (a 12 GB card runs Kev-4B; Kev-0.8B also runs on CPU/Apple Silicon). It
needs Python 3.12/3.13 (not 3.14) and `uv`:

```bash
git clone https://github.com/jaredpalmer/kev.git ~/dev/kev
cd ~/dev/kev
uv sync --extra serve
uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b --port 8009
```

On NixOS the uv-managed Python cannot run without `nix-ld`; use a nixpkgs
interpreter instead: `nix shell nixpkgs#python313 -c python3.13 -m venv .venv`,
`nix shell nixpkgs#uv -c uv pip install --python .venv/bin/python -e ".[serve]"`,
then export the library paths torch needs:
`LD_LIBRARY_PATH="$(nix eval --raw nixpkgs#stdenv.cc.cc.lib)/lib:$(nix eval --raw nixpkgs#zlib)/lib:/run/opengl-driver/lib"`.
Kev-4B needs `KEV_CUDA_GRAPHS=0` on a 12 GB card. Smoke test:
`curl -s localhost:8009/v1/models`. Keep the server bound to `127.0.0.1`
(default); set `KEV_API_KEY` and `apiKeyEnv` if it is reachable by others.

## Tests

`node --test test/*.test.ts` — config parsing and the client against a local
HTTP server, no external network.
