# ptc — programmatic tool calling

One tool (`ptc`) that runs a JavaScript program in a Node child process, with
the session's tools callable inside it as async functions. Loops,
conditionals and parallelism are ordinary code; tool results feed the running
program, never the context. Only what the program prints reaches the model.

## Using it

`ptc { code }` runs the code; `ptc { path }` reruns a saved program — every
run writes its program to a temp dir and reports the path, and edits via
normal tools are picked up on rerun. Static `import` works; `require` does
not (use `await import(...)`). Output is capped head+tail; the full output is
written to a file whose path is reported.

Built-ins (structured JSON in/out): `read`, `grep`, `find`, `sh`. `sh` never
throws on nonzero exit and defaults to a 30 s timeout; the program defaults
to 120 s (`PTC_TIMEOUT_MS` overrides). Unknown tools, call limit (500),
timeout and program exceptions return actionable errors the program can
handle.

## Extending it

Other extensions register their tools with one line:

```ts
registerPtcTool(name, run, { signature? })
```

`name` must match an existing tool registration; `run(args, ctx)` is the
implementation; `signature` is an optional one-line binding contract. The
registry is a `Map` (last write wins, so reloads are safe) and is listed in
the `ptc` description at `session_start` — tool prose is not duplicated.

## Files and tests

`index.ts` (tool + runner), `registry.ts` (registration API), `builtin.ts`
(read/grep/find/sh implementations), `test/run.sh harness` — stubbed
ExtensionAPI, no network.
