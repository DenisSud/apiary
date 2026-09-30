import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type { AuthEvent, AuthPrompt, AuthType } from "@earendil-works/pi-ai";

/** The slice of `ModelRuntime` login sessions need; tests provide a fake. */
export interface AuthRuntimeProvider {
  readonly id: string;
  readonly name: string;
  readonly auth: { apiKey?: unknown; oauth?: unknown };
}

export interface AuthRuntime {
  getProviders(): readonly AuthRuntimeProvider[];
  getProvider(id: string): AuthRuntimeProvider | undefined;
  getProviderAuthStatus(id: string): { configured: boolean; source?: string; label?: string };
  isUsingOAuth(id: string): boolean;
  login(id: string, type: AuthType, interaction: AuthInteraction): Promise<unknown>;
  refresh(options?: { allowNetwork?: boolean }): Promise<unknown>;
  logout(id: string): Promise<void>;
}

export interface AuthProviderInfo {
  id: string;
  name: string;
  oauth: boolean;
  apiKey: boolean;
  configured: boolean;
  /** Where the active credential comes from ("stored", "environment", …). */
  source?: string;
  /** Credential type in effect when configured. */
  type?: AuthType;
}

/** A prompt plus the id the adapter echoes back with the answer. */
export interface AuthPromptRequest {
  id: string;
  type: AuthPrompt["type"];
  message: string;
  placeholder?: string;
  options?: readonly { id: string; label: string; description?: string }[];
}

export interface AuthHandlers {
  notify(event: AuthEvent): void;
  prompt(prompt: AuthPromptRequest): void;
}

export interface LoginHandle {
  readonly id: string;
  readonly provider: string;
  readonly type: AuthType;
  /** Wire the adapter and start the flow. Call exactly once. */
  start(handlers: AuthHandlers): void;
  respond(promptId: string, value: string): void;
  abort(): void;
  readonly done: Promise<void>;
}

export interface AuthServiceOptions {
  /** Path to the shared `auth.json` the bots symlink. */
  authPath: string;
  /** Path to `models.json`; null disables custom provider config. */
  modelsPath?: string | null;
  /** Allow catalog refreshes after login to reach the network. Default true. */
  allowModelNetwork?: boolean;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class AuthService {
  private readonly runtime: AuthRuntime;
  private readonly allowModelNetwork: boolean;

  constructor(runtime: AuthRuntime, options: { allowModelNetwork?: boolean } = {}) {
    this.runtime = runtime;
    this.allowModelNetwork = options.allowModelNetwork ?? true;
  }

  /** One runtime for the shared agent dir; bots symlink the same auth.json. */
  static async create(options: AuthServiceOptions): Promise<AuthService> {
    const runtime = await ModelRuntime.create({
      authPath: options.authPath,
      modelsPath: options.modelsPath ?? null,
      allowModelNetwork: options.allowModelNetwork ?? true,
    });
    return new AuthService(runtime, { allowModelNetwork: options.allowModelNetwork ?? true });
  }

  providers(): AuthProviderInfo[] {
    const infos: AuthProviderInfo[] = [];
    for (const provider of this.runtime.getProviders()) {
      const status = this.runtime.getProviderAuthStatus(provider.id);
      const source = status.label ?? status.source;
      infos.push({
        id: provider.id,
        name: provider.name,
        oauth: provider.auth.oauth !== undefined,
        apiKey: provider.auth.apiKey !== undefined,
        configured: status.configured,
        ...(source === undefined ? {} : { source }),
        ...(status.configured ? { type: this.runtime.isUsingOAuth(provider.id) ? "oauth" : "api_key" } : {}),
      });
    }
    return infos.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Validate the login and return a handle; the flow starts with `handle.start`. */
  startLogin(provider: string, type: AuthType): LoginHandle {
    const target = this.runtime.getProvider(provider);
    if (target === undefined) throw new AuthError(`unknown provider '${provider}'`);
    if (type === "oauth" && target.auth.oauth === undefined) {
      throw new AuthError(`provider '${provider}' has no OAuth login`);
    }
    if (type === "api_key" && target.auth.apiKey === undefined) {
      throw new AuthError(`provider '${provider}' has no API key login`);
    }

    const id = randomUUID();
    const controller = new AbortController();
    let handlers: AuthHandlers | undefined;
    let started = false;
    let pending: { id: string; resolve: (value: string) => void; reject: (error: Error) => void } | undefined;
    let resolveDone!: () => void;
    let rejectDone!: (error: unknown) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const failPending = (error: Error): void => {
      const current = pending;
      pending = undefined;
      current?.reject(error);
    };
    controller.signal.addEventListener("abort", () => failPending(new Error("Login cancelled")), { once: true });

    const interaction: AuthInteraction = {
      signal: controller.signal,
      notify: (event) => handlers?.notify(event),
      prompt: (prompt) =>
        new Promise<string>((resolve, reject) => {
          const promptId = randomUUID();
          pending = { id: promptId, resolve, reject };
          handlers?.prompt({
            id: promptId,
            type: prompt.type,
            message: prompt.message,
            ...(prompt.type === "select"
              ? {
                  options: prompt.options.map((option) => ({
                    id: option.id,
                    label: option.label,
                    ...(option.description === undefined ? {} : { description: option.description }),
                  })),
                }
              : prompt.placeholder === undefined
                ? {}
                : { placeholder: prompt.placeholder }),
          });
        }),
    };

    return {
      id,
      provider,
      type,
      done,
      start: (nextHandlers) => {
        if (started) throw new AuthError("login already started");
        started = true;
        handlers = nextHandlers;
        void this.runtime
          .login(provider, type, interaction)
          .then(async () => {
            try {
              await this.runtime.refresh({ allowNetwork: this.allowModelNetwork });
            } catch {
              // The login is what matters; the catalog refreshes on the next use.
            }
            resolveDone();
          })
          .catch((error: unknown) => {
            rejectDone(error instanceof Error ? error : new Error(String(error)));
          })
          .finally(() => failPending(new Error("login finished")));
      },
      respond: (promptId, value) => {
        if (pending?.id !== promptId) throw new AuthError(`no pending prompt '${promptId}'`);
        const current = pending;
        pending = undefined;
        current.resolve(value);
      },
      abort: () => controller.abort(),
    };
  }

  async logout(provider: string): Promise<void> {
    await this.runtime.logout(provider);
  }
}