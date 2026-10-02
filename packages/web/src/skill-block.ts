// Skill invocation blocks in user messages. The service expands a
// `/skill:name args` prompt into `<skill ...>…</skill>` before the message is
// stored, so the transcript can render the invocation as a chip instead of
// the expanded body. The block format is the fork's
// (`formatSkillInvocation` in the agent package); this reader mirrors it.

export interface SkillInvocation {
	name: string;
	/** The skill's frontmatter description, when the block carries one. */
	description?: string;
	/** What the user wrote after the command, if anything. */
	args?: string;
}

const SKILL_BLOCK =
	/^<skill name="([^"]+)" location="([^"]+)"(?: description="([^"]*)")?>\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;

export function parseSkillInvocation(text: string): SkillInvocation | null {
	const match = SKILL_BLOCK.exec(text);
	if (match === null) return null;
	const description = match[3] === undefined ? undefined : unescapeAttribute(match[3]);
	const args = match[4]?.trim();
	return {
		name: unescapeAttribute(match[1]),
		...(description === undefined || description === "" ? {} : { description }),
		...(args === undefined || args === "" ? {} : { args }),
	};
}

/** Undo the attribute escaping the formatter applies. */
function unescapeAttribute(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}
