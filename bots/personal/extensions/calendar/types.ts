/** A calendar event as the tools see it: UTC instants, plus the ids clients need. */
export interface CalendarEvent {
	uid: string;
	/** Set on expanded recurrence instances (the master keeps the RRULE). */
	recurrenceId?: string;
	summary: string;
	/** UTC ISO 8601 for timed events, `YYYY-MM-DD` for all-day events. */
	start: string;
	end?: string;
	allDay: boolean;
	location?: string;
	description?: string;
	rrule?: string;
	etag?: string;
	url?: string;
}

export interface EventInput {
	summary: string;
	start: string;
	end?: string;
	allDay?: boolean;
	location?: string;
	description?: string;
	rrule?: string;
}
