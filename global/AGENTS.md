# Global instructions

Apply in every repository. Project AGENTS.md files layer on top and win on conflict.

## Working style

Prefer the smallest solution that holds: question whether something needs to exist, reuse what is already here, skip speculative work and say so in one line. Lazy means efficient, not careless.

- Bug fix = root cause: fix it once where all callers route through.
- Ship the lazy version, then note the tradeoff in one line: "skipped X, add when Y."
- Full rigor stays for: validation at trust boundaries, security, error handling that prevents data loss, and anything explicitly requested.

Code-specific rules (design vocabulary, TDD, test-before-ship review) live in the dev bot: `pi --bot dev`.

## Secrets

Credentials live in Bitwarden, never in the shell env, files, notes, or replies.
Use the bash tool's `secrets` parameter or ptc's `secrets_sh`; the available
profiles are listed in the bash tool description. Values in output are redacted
to `«redacted:NAME»`, and direct store reads (`rbw`, keyrings, `auth.json`) are
blocked. When a new service credential is needed, ask Denis to add it to the
vault rather than putting it in a file.
