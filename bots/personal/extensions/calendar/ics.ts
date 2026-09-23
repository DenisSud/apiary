/**
 * calendar/ics — the small iCalendar surface these tools need: parse the
 * VEVENTs out of a VCALENDAR, build a VEVENT, and convert between wall-clock
 * times in a named zone and UTC.
 *
 * Deliberately partial: no VTIMEZONE (timed events are stored in UTC), no
 * VALARM, no ATTENDEE — the personal calendar is a single-user calendar and
 * reminders/participants are out of scope (see README).
 */
import type { CalendarEvent } from "./types.ts";

export function unfoldLines(ics: string): string[] {
	return ics
		.replace(/\r\n/g, "\n")
		.replace(/\n[ \t]/g, "")
		.split("\n")
		.filter((line) => line.trim());
}

/** Split `NAME;PARAM=VALUE:content` — the colon may sit inside a quoted param. */
export function splitProperty(line: string): { name: string; params: Record<string, string>; value: string } {
	let quoted = false;
	let colon = -1;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === '"') quoted = !quoted;
		else if (char === ":" && !quoted) {
			colon = i;
			break;
		}
	}
	if (colon < 0) return { name: line.toUpperCase(), params: {}, value: "" };

	const head = line.slice(0, colon);
	const value = line.slice(colon + 1);
	const [name, ...rest] = head.split(";");
	const params: Record<string, string> = {};
	for (const part of rest) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, "");
	}
	return { name: name.toUpperCase(), params, value };
}

export function unescapeText(value: string): string {
	return value
		.replace(/\\n/gi, "\n")
		.replace(/\\,/g, ",")
		.replace(/\\;/g, ";")
		.replace(/\\\\/g, "\\");
}

export function escapeText(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/\r?\n/g, "\\n")
		.replace(/;/g, "\\;")
		.replace(/,/g, "\\,");
}

// ── time zones (no dependency: Intl knows the tz database) ─────────────────

export function zoneOffsetMs(date: Date, timeZone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hour12: false,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(date);
	const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
	const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
	return asUtc - date.getTime();
}

/** `YYYY-MM-DDTHH:MM:SS` in `timeZone` → UTC ISO string. */
export function zonedToUtcIso(local: string, timeZone: string): string {
	const naive = Date.parse(`${local}Z`);
	if (Number.isNaN(naive)) throw new Error(`calendar: cannot parse local time ${JSON.stringify(local)}`);
	// Two passes: the first guess lands before/after a DST switch, the second
	// uses the offset that actually applies at the target instant.
	let offset = zoneOffsetMs(new Date(naive), timeZone);
	offset = zoneOffsetMs(new Date(naive - offset), timeZone);
	return new Date(naive - offset).toISOString();
}

/** UTC instant → `YYYY-MM-DD HH:MM` in `timeZone`, for display. */
export function formatInZone(iso: string, timeZone: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return new Intl.DateTimeFormat("sv-SE", { timeZone, dateStyle: "short", timeStyle: "short" }).format(date);
}

/** UTC instant → `YYYY-MM-DD` in `timeZone` (for all-day events). */
export function toDateOnly(iso: string, timeZone: string): string {
	if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
	return new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(new Date(iso));
}

export interface ParsedInstant {
	/** UTC ISO 8601 for timed values, `YYYY-MM-DD` for all-day values. */
	iso: string;
	allDay: boolean;
}

/** Accepts RFC3339, `YYYY-MM-DD HH:MM[:SS]` (interpreted in `timeZone`), or `YYYY-MM-DD`. */
export function parseInstant(input: string, timeZone: string): ParsedInstant {
	const value = input.trim();
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { iso: value, allDay: true };
	const naive = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/.exec(value);
	if (naive) return { iso: zonedToUtcIso(`${naive[1]}T${naive[2]}${naive[3] ?? ":00"}`, timeZone), allDay: false };
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		throw new Error(
			`calendar: cannot parse ${JSON.stringify(input)} — use RFC3339 (2026-09-24T15:00:00+03:00), a local time (2026-09-24 15:00, ${timeZone}) or a date (2026-09-24)`,
		);
	}
	return { iso: parsed.toISOString(), allDay: false };
}

/** CalDAV time-range value: `YYYYMMDDTHHMMSSZ`. */
export function caldavStamp(iso: string): string {
	return `${new Date(iso).toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
}

// ── VEVENT ↔ CalendarEvent ─────────────────────────────────────────────────

function parseIcsDate(value: string, params: Record<string, string>, timeZone: string): ParsedInstant {
	const date = /^(\d{4})(\d{2})(\d{2})/.exec(value);
	if (!date) throw new Error(`calendar: unsupported date value ${JSON.stringify(value)}`);
	const [y, m, d] = [date[1], date[2], date[3]];
	if (params.VALUE === "DATE" || /^\d{8}$/.test(value)) return { iso: `${y}-${m}-${d}`, allDay: true };

	const time = /T(\d{2})(\d{2})(\d{2})/.exec(value);
	const clock = time ? `${time[1]}:${time[2]}:${time[3]}` : "00:00:00";
	if (value.endsWith("Z")) return { iso: new Date(`${y}-${m}-${d}T${clock}Z`).toISOString(), allDay: false };
	// TZIDs are either IANA names (Europe/Moscow) or a globally unique form
	// with a prefix (/freeassociation.sourceforge.net/Europe/Moscow).
	const tzid = params.TZID ? params.TZID.replace(/^\/[^/]+\//, "") : timeZone;
	try {
		return { iso: zonedToUtcIso(`${y}-${m}-${d}T${clock}`, tzid), allDay: false };
	} catch {
		return { iso: zonedToUtcIso(`${y}-${m}-${d}T${clock}`, timeZone), allDay: false };
	}
}

function parseIcsDateSafe(value: string | undefined, params: Record<string, string>, timeZone: string): ParsedInstant | undefined {
	if (!value) return undefined;
	try {
		return parseIcsDate(value, params, timeZone);
	} catch {
		return undefined;
	}
}

export interface IcsEventSource {
	ics: string;
	etag?: string;
	url?: string;
}

/** All VEVENTs in a VCALENDAR (an expanded REPORT returns one per instance). */
export function parseEvents(source: IcsEventSource, timeZone: string): CalendarEvent[] {
	const events: CalendarEvent[] = [];
	let current: Map<string, { params: Record<string, string>; value: string }> | undefined;

	for (const line of unfoldLines(source.ics)) {
		if (line === "BEGIN:VEVENT") {
			current = new Map();
			continue;
		}
		if (line === "END:VEVENT") {
			if (current) {
				const event = toEvent(current, source, timeZone);
				if (event) events.push(event);
			}
			current = undefined;
			continue;
		}
		if (!current) continue;
		const { name, params, value } = splitProperty(line);
		current.set(name, { params, value });
	}
	return events;
}

function toEvent(
	fields: Map<string, { params: Record<string, string>; value: string }>,
	source: IcsEventSource,
	timeZone: string,
): CalendarEvent | undefined {
	const raw = (name: string): { params: Record<string, string>; value: string } | undefined => fields.get(name);
	const text = (name: string): string | undefined => {
		const field = raw(name);
		return field ? unescapeText(field.value) : undefined;
	};

	const uid = text("UID");
	if (!uid) return undefined;
	const start = parseIcsDateSafe(raw("DTSTART")?.value, raw("DTSTART")?.params ?? {}, timeZone);
	if (!start) return undefined;
	const end = parseIcsDateSafe(raw("DTEND")?.value, raw("DTEND")?.params ?? {}, timeZone);
	const recurrenceId = parseIcsDateSafe(raw("RECURRENCE-ID")?.value, raw("RECURRENCE-ID")?.params ?? {}, timeZone);

	return {
		uid,
		recurrenceId: recurrenceId?.iso,
		summary: text("SUMMARY") ?? "(no title)",
		start: start.iso,
		end: end?.iso,
		allDay: start.allDay,
		location: text("LOCATION"),
		description: text("DESCRIPTION"),
		rrule: raw("RRULE")?.value,
		etag: source.etag,
		url: source.url,
	};
}

/** Fold long content lines at 75 octets, continuation lines start with a space. */
export function foldLine(line: string): string[] {
	if (Buffer.byteLength(line, "utf8") <= 75) return [line];
	const out: string[] = [];
	let start = 0;
	let limit = 75;
	while (start < line.length) {
		let end = start;
		let size = 0;
		while (end < line.length) {
			const code = line.codePointAt(end) as number;
			const width = code > 0xffff ? 4 : code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
			if (size + width > limit) break;
			size += width;
			end += code > 0xffff ? 2 : 1;
		}
		out.push((out.length ? " " : "") + line.slice(start, end));
		start = end;
		limit = 74;
	}
	return out;
}

export interface BuildEventInput {
	uid: string;
	summary: string;
	start: ParsedInstant;
	end?: ParsedInstant;
	location?: string;
	description?: string;
	rrule?: string;
	/** Creation timestamp; injected for deterministic tests. */
	now?: Date;
}

export function buildEvent(input: BuildEventInput): string {
	const stamp = (input.now ?? new Date()).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
	const icsDate = (value: ParsedInstant): string =>
		value.allDay ? `;VALUE=DATE:${value.iso.replace(/-/g, "")}` : `:${caldavStamp(value.iso)}`;

	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//pi-personal//calendar//EN",
		"BEGIN:VEVENT",
		`UID:${input.uid}`,
		`DTSTAMP:${stamp}`,
		`SUMMARY:${escapeText(input.summary)}`,
		`DTSTART${icsDate(input.start)}`,
	];
	if (input.end) lines.push(`DTEND${icsDate(input.end)}`);
	if (input.location) lines.push(`LOCATION:${escapeText(input.location)}`);
	if (input.description) lines.push(`DESCRIPTION:${escapeText(input.description)}`);
	if (input.rrule) lines.push(`RRULE:${input.rrule}`);
	lines.push("END:VEVENT", "END:VCALENDAR");
	return `${lines.flatMap(foldLine).join("\r\n")}\r\n`;
}
