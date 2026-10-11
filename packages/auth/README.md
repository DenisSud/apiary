# @apiary/auth

Provider login sessions over pi's `ModelRuntime`. Transport-agnostic: the
bridge in `packages/connector` adapts it to HTTP + WebSocket, nothing here
knows about either.

pi already implements every provider flow (`apiKey.login`, `oauth.login`) with
`text` / `secret` / `select` / `manual_code` prompts and `info` / `auth_url` /
`device_code` / `progress` events. This package runs one `ModelRuntime` for
the shared agent dir and turns a login into a handle the adapter can drive.

## API

```ts
const service = await AuthService.create({
  authPath: join(sharedAgentDir(), "auth.json"),
  modelsPath: join(sharedAgentDir(), "models.json"),
});

service.providers(); // [{ id, name, oauth, apiKey, configured, source?, type? }]

const handle = service.startLogin(provider, "api_key" | "oauth");
handle.start({
  notify: (event) => {},          // info | auth_url | device_code | progress
  prompt: (request) => {},        // { id, type, message, placeholder?, options? }
});
handle.respond(promptId, value);  // answer the pending prompt
handle.abort();                   // refuse; pending prompt rejects
await handle.done;                // resolves after login + catalog refresh

await service.logout(provider);
```

`startLogin` validates the provider and method and returns the handle; the flow
starts on `start(handlers)`, so an adapter can wire its socket first and no
frames are lost or buffered out of order. After a successful login the runtime
refreshes the model catalog (`allowModelNetwork`, default true) so the new
models appear in `pi.models`.

## Bridge mapping

| package | bridge |
|---|---|
| `handle.id` | `POST /api/auth/login` → `{loginId}` |
| `start(handlers)` | `WS /api/auth/login/:id` attach |
| `prompt` / `notify` | `{type:"prompt", prompt}` / `{type:"notify", event}` frames |
| `respond` | client `{type:"input", id, value}` |
| `abort` | client `{type:"abort"}` or WS close |
| `done` | `{type:"done"}` frame, then close |

## Tests

```sh
node --test test/*.test.ts
```

Tests use a fake `AuthRuntime`; no network, no credentials.
