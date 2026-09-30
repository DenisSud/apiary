import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthError,
  AuthService,
  type AuthEvent,
  type AuthInteraction,
  type AuthPromptRequest,
  type AuthRuntime,
  type AuthType,
} from "../src/index.ts";

function makeRuntime(
  login: (id: string, type: AuthType, interaction: AuthInteraction) => Promise<unknown>,
  options: {
    provider?: { id: string; name: string; auth: { apiKey?: unknown; oauth?: unknown } };
    status?: () => { configured: boolean; source?: string; label?: string };
    usingOAuth?: () => boolean;
  } = {},
): { runtime: AuthRuntime; refreshes: unknown[]; logouts: string[] } {
  const provider = options.provider ?? { id: "acme", name: "Acme", auth: { apiKey: {}, oauth: {} } };
  const refreshes: unknown[] = [];
  const logouts: string[] = [];
  return {
    refreshes,
    logouts,
    runtime: {
      getProviders: () => [provider],
      getProvider: (id) => (id === provider.id ? provider : undefined),
      getProviderAuthStatus: options.status ?? (() => ({ configured: false })),
      isUsingOAuth: options.usingOAuth ?? (() => false),
      login,
      refresh: async (refreshOptions) => {
        refreshes.push(refreshOptions);
      },
      logout: async (id) => {
        logouts.push(id);
      },
    },
  };
}

function collect(): { events: AuthEvent[]; prompts: AuthPromptRequest[]; handlers: { notify: (e: AuthEvent) => void; prompt: (p: AuthPromptRequest) => void } } {
  const events: AuthEvent[] = [];
  const prompts: AuthPromptRequest[] = [];
  return {
    events,
    prompts,
    handlers: {
      notify: (event) => events.push(event),
      prompt: (prompt) => prompts.push(prompt),
    },
  };
}

test("providers lists login methods and configured status", () => {
  const plain = new AuthService(makeRuntime(async () => ({})).runtime);
  assert.deepEqual(plain.providers(), [
    { id: "acme", name: "Acme", oauth: true, apiKey: true, configured: false },
  ]);

  const configured = new AuthService(
    makeRuntime(async () => ({}), {
      status: () => ({ configured: true, source: "stored" }),
      usingOAuth: () => true,
    }).runtime,
  );
  assert.deepEqual(configured.providers(), [
    { id: "acme", name: "Acme", oauth: true, apiKey: true, configured: true, source: "stored", type: "oauth" },
  ]);
});

test("api key login prompts, responds, refreshes and logs out", async () => {
  let captured: string | undefined;
  const { runtime, refreshes, logouts } = makeRuntime(async (_id, _type, interaction) => {
    interaction.notify({ type: "info", message: "hello" });
    captured = await interaction.prompt({ type: "secret", message: "API key?" });
    return { type: "api_key", key: captured };
  });
  const service = new AuthService(runtime);
  const { events, prompts, handlers } = collect();

  const handle = service.startLogin("acme", "api_key");
  handle.start(handlers);
  assert.match(handle.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(events, [{ type: "info", message: "hello" }]);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]!.type, "secret");
  assert.equal(prompts[0]!.message, "API key?");

  handle.respond(prompts[0]!.id, "sk-test");
  await handle.done;
  assert.equal(captured, "sk-test");
  assert.deepEqual(refreshes, [{ allowNetwork: true }]);

  await service.logout("acme");
  assert.deepEqual(logouts, ["acme"]);
});

test("select options and manual code placeholders reach the adapter", async () => {
  const answers: string[] = [];
  const { runtime } = makeRuntime(async (_id, _type, interaction) => {
    answers.push(
      await interaction.prompt({
        type: "select",
        message: "Choose",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B", description: "second" },
        ],
      }),
    );
    answers.push(await interaction.prompt({ type: "manual_code", message: "Paste code", placeholder: "code" }));
    return {};
  });
  const service = new AuthService(runtime);
  const { prompts, handlers } = collect();
  const handle = service.startLogin("acme", "oauth");
  handle.start(handlers);

  assert.deepEqual(prompts[0]!.options, [
    { id: "a", label: "A" },
    { id: "b", label: "B", description: "second" },
  ]);
  handle.respond(prompts[0]!.id, "b");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prompts[1]!.type, "manual_code");
  assert.equal(prompts[1]!.placeholder, "code");
  handle.respond(prompts[1]!.id, "123456");
  await handle.done;
  assert.deepEqual(answers, ["b", "123456"]);
});

test("abort rejects the pending prompt and the login", async () => {
  const { runtime } = makeRuntime(async (_id, _type, interaction) => {
    await interaction.prompt({ type: "secret", message: "API key?" });
    return {};
  });
  const service = new AuthService(runtime);
  const { prompts, handlers } = collect();
  const handle = service.startLogin("acme", "api_key");
  handle.start(handlers);

  handle.abort();
  await assert.rejects(handle.done, /cancel/i);
  assert.throws(() => handle.respond(prompts[0]!.id, "late"), AuthError);
});

test("unknown providers and unsupported methods are rejected", () => {
  const { runtime } = makeRuntime(async () => ({}), { provider: { id: "keyless", name: "Keyless", auth: { apiKey: {} } } });
  const service = new AuthService(runtime);
  assert.throws(() => service.startLogin("nope", "api_key"), /unknown provider/);
  assert.throws(() => service.startLogin("keyless", "oauth"), /no OAuth login/);
  const handle = service.startLogin("keyless", "api_key");
  assert.equal(handle.type, "api_key");
  handle.abort();
});