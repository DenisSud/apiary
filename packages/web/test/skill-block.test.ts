import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSkillInvocation } from "../src/skill-block.ts";

// The skill block the service writes into a user message when a prompt goes
// out as `/skill:name`; the transcript renders it as a chip.

test("parseSkillInvocation reads name, description and args", () => {
	const text =
		'<skill name="self-config" location="/skills/self-config/SKILL.md" description="Configure &quot;me&quot;">\nReferences are relative to /skills/self-config.\n\nBody.\n</skill>\n\nSet me up.';
	assert.deepEqual(parseSkillInvocation(text), {
		name: "self-config",
		description: 'Configure "me"',
		args: "Set me up.",
	});
});

test("parseSkillInvocation handles blocks without description or args", () => {
	const text =
		'<skill name="review" location="/skills/review/SKILL.md">\nReferences are relative to /skills/review.\n\nInspect.\n</skill>';
	assert.deepEqual(parseSkillInvocation(text), { name: "review" });
});

test("parseSkillInvocation returns null for ordinary text", () => {
	assert.equal(parseSkillInvocation("hello"), null);
	assert.equal(parseSkillInvocation("/skill:foo bar"), null);
});
