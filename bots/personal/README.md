# personal bot

Denis's private communication bot: Gmail (read + drafts, never send) and the
personal CalDAV calendar on the home RPi. It layers on the shared `pi-bots`
base setup:

```
pi-bot personal          # or: pi --bot personal
```

Everything here is real data belonging to a real person — see
`APPEND_SYSTEM.md` for the rules the agent operates under.

## Tools

| Tool | What it does |
|---|---|
| `email_search` | Gmail search syntax (`X-GM-RAW`), All Mail by default, envelope only |
| `email_get_message` | Headers + decoded text body + attachment metadata (20k char cap) |
| `email_get_thread` | Every message of one Gmail thread, envelope only |
| `email_get_attachment` | Downloads one part to `~/Downloads/email-attachments/` |
| `email_list_drafts` / `email_create_draft` / `email_update_draft` / `email_delete_draft` | The drafts lifecycle |
| `calendar_list_events` | Time-range query, recurrences expanded by the server |
| `calendar_get_event` / `calendar_create_event` / `calendar_update_event` / `calendar_delete_event` | Event CRUD with ETag preconditions |

## Safety model

- **No send, no mail deletion.** There is no SMTP client in this package, and
  the only `EXPUNGE`/`STORE \Deleted` path in `extensions/gmail/` is
  `deleteDraft`, which resolves the message inside `[Gmail]/Drafts` and refuses
  anything else. `extensions/gmail/guard.ts` is the single place that decides
  what may be written where — read it before adding an operation.
- **Audit log.** Every tool call is appended to
  `~/.local/state/pi-personal/{gmail,calendar}-audit.jsonl` (ring buffer, last
  100 entries). Calendar deletions additionally store the full ICS of the event
  *before* the DELETE, so an accidental removal can be restored by hand.
- **Untrusted content.** Mail bodies and calendar descriptions are data. The
  bot's `APPEND_SYSTEM.md` says so explicitly, and no tool turns message
  content into an action.
- **Secrets.** Resolved per process from Bitwarden through the security
  extension (`gmail`, `radicale-denis`, `radicale-agent`); they never appear in
  files, logs, tool output, or the audit log.

## Layout

```
bots/personal/
├── APPEND_SYSTEM.md        # personal-agent instructions (untrusted-email rule, calendar etiquette)
├── info.yaml               # prerequisites + capability matrix
├── package.json            # deps: imapflow, html-to-text, iconv-lite
├── lib/audit.ts            # shared JSONL ring-buffer audit log
├── extensions/gmail/       # IMAP client, MIME decoding, guard, 8 tools
├── extensions/calendar/    # CalDAV client, ICS build/parse, 5 tools
└── radicale/               # the server side: compose.yml, config, rights, deploy.mjs
```

## Tests

```bash
extensions/gmail/test/run.sh harness      # fake IMAP server, stub rbw, no network
extensions/gmail/test/run.sh live         # real Gmail login (read-only)
GMAIL_LIVE_WRITE=1 extensions/gmail/test/run.sh live   # + draft create/update/delete
extensions/calendar/test/run.sh harness   # mocked fetch, no network
extensions/calendar/test/run.sh live      # real CalDAV against cal.sudakov.site
CALENDAR_LIVE_WRITE=1 extensions/calendar/test/run.sh live
```

The harnesses drive the registered tools through a stubbed `pi` API, so the
guard, id resolution, MIME/ICS handling and the audit log are all exercised
without touching the network or the vault. Live modes use the real secrets
profiles and therefore need `rbw unlock`.

## Prerequisites

- `gmail` secrets profile → Bitwarden `pi/Google-app-password` (a valid Gmail
  app password; regenerate it when Google revokes it).
- `radicale-denis` / `radicale-agent` secrets profiles → the two Radicale
  accounts; the server itself is deployed from `radicale/` (see its README).
- IMAP must be enabled in Gmail (Settings → Forwarding and POP/IMAP).
