# Product

What pi-bots is, who it is for, and what "done" means. This is the north
star: outcomes and principles, not implementation. The epics in the issue
tracker hold the specs of record; the code holds the how.

## The product in one line

A personal fleet of AI coworkers you own: one container, one app. Create an
agent with a name; it sets itself up, remembers, and keeps working — without
the user ever editing a file.

## Who it is for

- The self-hoster who wants their agents, memory and credentials on their own
  hardware.
- The hosted user who wants the same product without running anything.
- The maintainer is a user: personal deployments are made through the product,
  not special-cased in the base.

## The north-star journey

Open the app → connect a model provider once → describe yourself once →
create an agent with just a name → the agent interviews you and configures
itself → give it work in chat; it acts, remembers, and improves its working
rules → leave it running: it works on schedules and triggers and reports back
→ see, steer, branch and manage everything from the app, and retire agents
when done.

## Principles

1. **The agent is a user of its own files.** The service owns a thin,
   enforced floor — model, tool floor, mandatory packages, auth. Everything
   above it, the agent configures itself.
2. **No file editing in the product.** Everything a user needs is in the app.
   Git is an implementation detail; rollback is a feature.
3. **Memory is automatic.** The agent remembers without hand-managed files or
   manual compaction; curated notes remain the deliberate layer.
4. **Agents are always on.** They are persistent: they keep context between
   conversations, run on schedules and triggers, and report back. Watching a
   chat window is not required.
5. **Secrets are used by name, never seen by the model.** Quality and safety
   are enforced by the system, not by asking the model nicely.
6. **One backend, many clients.** The service is the product; the web app,
   the TUI and later native clients are presentations of it.
7. **One container per user.** Agents, memory and credentials move together;
   self-hosted and hosted use the same image and the same code.
8. **The base stays generic.** A personal deployment is a deployment, not a
   fork.

## Pillars

| pillar | outcome | tracked in |
|---|---|---|
| Fleet | create, see, adjust and retire agents without touching files | #1 |
| Models & profile | connect a provider once; every agent knows who the user is | #4 |
| Conversation | legible messages; rewind, fork, attach; never have to sit and watch | #7 |
| Memory & behavior | the agent learns how to work with this user and remembers what matters | #10 |
| Orchestration | agents run themselves, and together | #6 |
| Secrets & safety | credentials used by name; risky actions judged before they run | #13 |
| Deployment | one image runs on a laptop or as a hosted instance; moving costs nothing | #18, #36 |
| Artifacts (late) | agent-built apps are previewed and deployed from chat | #12 |

## v1 is done when

A non-technical user goes from an empty install to an agent doing real work
for them — and manages the fleet over time — without a terminal or a text
editor.

## Not v1

Switching models from chat (service-managed), authoring packages by the user,
billing and quotas, named teams, a marketplace, native mobile apps.

## Phases

1. Foundations — connector, web app, lifecycle, self-config, admin layer (done).
2. Service v1 — the pillars above made real (in progress).
3. Container & hosted — self-host completeness, then per-user instances.
4. Late stage — artifacts and beyond.

## Iterating this doc

It states outcomes only; if a sentence needs code to be understood, it is in
the wrong document. Change it intentionally, by PR — never by drift.
