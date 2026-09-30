# Vision

## The idea

Run a fleet of pi agents as a service, deployed like JupyterLab: one container
per user holds the agents, their shared environment (tools, packages,
credentials), their memory, and the service that exposes them. Self-hosting is
running that container on your own machine; the hosted product is a
provisioning wrapper that creates the container, connects provider keys and
keeps it running. Both use the same image and the same code.

Every client is a presentation of one backend:

- the web app in `packages/web` (built first),
- the pi TUI, through the connector's bot commands,
- later, native desktop and mobile apps on the same service API.

## Shape today

| piece | what it is | state |
|---|---|---|
| `base/` (pi package: extensions, skills) | what every agent loads: security, sysinfo, memory; skill-authoring, self-config | done |
| registry (`registry/`) | packages an agent declares for itself (ptc, web-search, systemone, grilling, …) | done |
| agents | one pi agent dir each, its own repo, local-first; full lifecycle (create → setup → commit→apply) | done |
| service backend | admin layer (model, package union, tool floor), reconciler, reload pipeline | done |
| connector (`packages/connector`) | registry, launcher, bridge: starts servers, relays the wire, serves the app | done |
| web client (`packages/web`) | bot list, session transcript, composer, session actions | done, HIG redesign in progress |
| container (`deploy/`) | the per-user image and volume, local mode | built; auth in front pending |
| service features | onboarding, package library, provider auth, routines, notifications, … | backlog: issues #1–#32 |

The backend is pi's experimental server stack (server + session workers,
`pi-client`/`pi-protocol` over framed CBOR). We do not write a second
protocol: the connector is a router and the bridge an opaque byte relay.

## Deployment model

1. **Single container (self-host).** One image with node, pi, the base
   package and the service; volumes for the agent dirs, memory and
   credentials. The image and volume exist in local mode (`deploy/`,
   `docs/container.md`); the host-native shape still works too.
2. **Hosted.** A provisioning service creates one container per user from the
   same image, wires provider credentials, and puts auth in front. Billing and
   quotas are the only differences from self-host.
3. **Local mode.** The same image on the user's own machine, with an optional
   local runner so an agent can reach the user's device (issue #15).

## Generic system, personal deployment

The system must fit whatever a user needs: their own agents, packages,
providers, secrets and integrations.

- Generic, in this repo: the base package, the connector, the web client, the
  service features, deployment.
- Personal: a specific fleet, private remotes, homelab, personal-site and
  memory integrations. Those live in the user's agent dirs, the local rules
  overlay and the agent repos — never in the base.

Maintainers are users too: their own deployments are created and managed
through the portal like anyone's, not special-cased in the base.

## Phases

1. **Backend and clients** (done): connector, web app, TUI commands, the
   transcript rendering pass.
2. **Agent lifecycle and self-configuration** (done): scaffold + commit→apply,
   the admin layer, the registry split, the self-config skill, the fork's bot
   docs.
3. **Service v1** (in progress): onboarding (provider auth + first agent),
   agent management, package library, session tree and rewind, routines,
   notifications, secrets, persona templating, multimodal messages.
4. **Container** (in progress): the local image and volumes are built
   (`docs/container.md`); next are auth in front of the bridge and the hosted
   control plane (#24).
5. **Late stage**: artifacts (preview and deploy agent-built apps).

Research items are labelled `research` in the backlog (automatic compaction,
leak detection). Product decisions live in the issues; this file records the
shape they aim at.
