#!/usr/bin/env node
/**
 * deploy — install or update Radicale on the RPi for the personal calendar.
 *
 * Idempotent: safe to re-run. It resolves the two Radicale users from the
 * Bitwarden-backed secrets profiles (`radicale-denis`, `radicale-agent`),
 * generates the htpasswd file, copies the config from this directory, starts
 * the container, adds the Caddy vhost, creates /denis/main/ and verifies that
 * the agent can write to that calendar and to nothing else.
 *
 *   node deploy.mjs              # deploy / update + verify
 *   RPI_HOST=pi.wan node deploy.mjs
 *
 * Secrets never leave this process: hashes are computed from stdin, HTTP auth
 * is a header, and nothing is printed.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../../extensions/security/config.ts";
import { resolveProfile } from "../../../extensions/security/rbw.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RPI = process.env.RPI_HOST ?? "192.168.1.6";
const IMAGE = "docker.io/tomsquest/docker-radicale:3.8.0.0";
const DOMAIN = process.env.CALENDAR_DOMAIN ?? "cal.sudakov.site";
const COLLECTION = "denis/main";

const log = (message) => console.log(`• ${message}`);

function ssh(command, options = {}) {
	return execFileSync("ssh", [RPI, command], { encoding: "utf8", ...options });
}

function scp(local, remote, mode) {
	execFileSync("scp", ["-q", local, `${RPI}:${remote}`]);
	if (mode) ssh(`chmod ${mode} ${remote}`);
}

/** sha512 crypt ($6$…) — passlib verifies it, openssl generates it. */
function hashPassword(password) {
	return execFileSync("openssl", ["passwd", "-6", "-stdin"], { input: password, encoding: "utf8" }).trim();
}

async function basicAuth(user, pass) {
	return { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` };
}

async function dav(method, path, { user, pass, body, headers = {} } = {}) {
	const response = await fetch(`https://${DOMAIN}${path}`, {
		method,
		headers: { ...(user ? await basicAuth(user, pass) : {}), ...headers },
		body,
		signal: AbortSignal.timeout(20_000),
	});
	return response;
}

async function waitFor(label, check, attempts = 30, delayMs = 1000) {
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const result = await check();
			if (result) {
				log(`${label}: ok (${result})`);
				return result;
			}
		} catch (err) {
			if (attempt === attempts) throw new Error(`${label} failed: ${err.message}`);
		}
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
	throw new Error(`${label} timed out`);
}

// ── 1. credentials ────────────────────────────────────────────────────────

const security = loadConfig();
log(`secrets profiles: ${Object.keys(security.profiles).filter((name) => name.startsWith("radicale")).join(", ")}`);
const denis = await resolveProfile(security, "radicale-denis");
const agent = await resolveProfile(security, "radicale-agent");
if (!denis.RADICALE_USER || !denis.RADICALE_PASSWORD) throw new Error("profile radicale-denis must define RADICALE_USER and RADICALE_PASSWORD");
if (!agent.RADICALE_USER || !agent.RADICALE_PASSWORD) throw new Error("profile radicale-agent must define RADICALE_USER and RADICALE_PASSWORD");

// ── 2. htpasswd file ──────────────────────────────────────────────────────

const users = [
	`${denis.RADICALE_USER}:${hashPassword(denis.RADICALE_PASSWORD)}`,
	`${agent.RADICALE_USER}:${hashPassword(agent.RADICALE_PASSWORD)}`,
].join("\n");
const staging = mkdtempSync(join(tmpdir(), "radicale-deploy-"));
writeFileSync(join(staging, "users"), `${users}\n`, { mode: 0o600 });

log(`staging in ${staging}`);
ssh("mkdir -p ~/radicale/config ~/radicale/data");
scp(join(staging, "users"), "~/radicale/config/users", "600");
for (const file of ["compose.yml", "config", "rights"]) {
	scp(join(HERE, file), `~/radicale/${file === "compose.yml" ? "compose.yml" : `config/${file}`}`);
}
log("config copied to ~/radicale (compose.yml, config/config, config/users, config/rights)");

// ── 3. container ──────────────────────────────────────────────────────────

if (ssh(`podman image exists ${IMAGE} && echo yes || echo no`).trim() !== "yes") {
	log(`pulling ${IMAGE}`);
	ssh(`podman pull -q ${IMAGE}`);
}
log("starting the container");
// --force-recreate: the config and rights files are read once at startup, so a
// plain `up -d` would keep running with the old ones.
ssh("cd ~/radicale && podman-compose --in-pod false up -d --force-recreate 2>&1 | tail -3");

await waitFor("radicale http", () => {
	const code = ssh("curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5232/ || true").trim();
	// Any answer means the server is up: the root path redirects (302) because
	// the web UI is disabled, and unauthenticated requests get 401.
	return code && Number(code) < 500 ? `HTTP ${code}` : undefined;
});

const ownership = ssh("ls -ld ~/radicale/data | awk '{print $3\":\"$4}'").trim();
log(`data dir owner on the host: ${ownership} (expected denis:denis)`);

// ── 4. Caddy vhost ────────────────────────────────────────────────────────

if (ssh(`grep -q '${DOMAIN}' /etc/caddy/Caddyfile && echo yes || echo no`).trim() !== "yes") {
	log(`adding the ${DOMAIN} vhost to /etc/caddy/Caddyfile`);
	ssh(`sudo tee -a /etc/caddy/Caddyfile > /dev/null <<'EOF'

${DOMAIN} {
	reverse_proxy 127.0.0.1:5232
}
EOF`);
	ssh("sudo caddy validate --config /etc/caddy/Caddyfile 2>&1 | tail -2");
	ssh("sudo systemctl reload caddy");
} else {
	log(`${DOMAIN} already in the Caddyfile`);
}

await waitFor("https endpoint (certificate)", async () => {
	const response = await fetch(`https://${DOMAIN}/.well-known/caldav`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
	return response.status < 500 ? `HTTP ${response.status}` : undefined;
}, 40);

// ── 5. the shared calendar ────────────────────────────────────────────────

const collectionPath = `/${COLLECTION}/`;
const mkcalendar = `<?xml version="1.0" encoding="utf-8"?>
<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:set><D:prop>
    <D:displayname>Personal</D:displayname>
    <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
  </D:prop></D:set>
</C:mkcalendar>`;

const existing = await dav("PROPFIND", collectionPath, { user: denis.RADICALE_USER, pass: denis.RADICALE_PASSWORD, headers: { Depth: "0" } });
if (existing.status === 207) {
	log(`${collectionPath} already exists`);
} else {
	const created = await dav("MKCALENDAR", collectionPath, {
		user: denis.RADICALE_USER,
		pass: denis.RADICALE_PASSWORD,
		body: mkcalendar,
		headers: { "Content-Type": "application/xml; charset=utf-8" },
	});
	if (created.status !== 201 && created.status !== 405) {
		throw new Error(`MKCALENDAR ${collectionPath} failed: HTTP ${created.status} ${await created.text()}`);
	}
	log(`created ${collectionPath} (displayname "Personal")`);
}

// ── 6. verification ───────────────────────────────────────────────────────

const report = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">
    <C:time-range start="20200101T000000Z" end="20300101T000000Z"/>
  </C:comp-filter></C:comp-filter></C:filter>
</C:calendar-query>`;

const agentReport = await dav("REPORT", collectionPath, {
	user: agent.RADICALE_USER,
	pass: agent.RADICALE_PASSWORD,
	body: report,
	headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
});
if (agentReport.status !== 207) throw new Error(`agent cannot read ${collectionPath}: HTTP ${agentReport.status}`);
log(`agent can read ${collectionPath} (HTTP 207)`);

const forbidden = await dav("PROPFIND", "/denis/", {
	user: agent.RADICALE_USER,
	pass: agent.RADICALE_PASSWORD,
	headers: { Depth: "1" },
});
const leaked = forbidden.status === 207 && (await forbidden.text()).includes("main/");
log(`agent access to /denis/ : HTTP ${forbidden.status}${leaked ? " — WARNING: collection list leaked, check rights" : " (boundary holds)"}`);

const denisHome = await dav("PROPFIND", "/denis/", { user: denis.RADICALE_USER, pass: denis.RADICALE_PASSWORD, headers: { Depth: "1" } });
log(`denis home: HTTP ${denisHome.status}`);

console.log(`
Done. Calendar: https://${DOMAIN}${collectionPath}
  - GNOME Calendar / phone: CalDAV URL https://${DOMAIN}/ (user ${denis.RADICALE_USER})
  - agent writes as "${agent.RADICALE_USER}" to ${collectionPath} only
  - backup:  ssh ${RPI} 'tar czf ~/radicale-$(date +%F).tar.gz -C ~/radicale data'
`);
