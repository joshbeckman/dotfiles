import { describe, expect, it } from "vitest";
import { choiceProblem, summarizeChoices, withChoices } from "../src/threads/choices.ts";
import { parseChoice, parseChoices, choiceText, draftHasChoice, toggleChoice } from "../web/choices.js";

const choices = [
	"Which approach? => Fix forward => Keep the change.",
	"^ => Revert => Revert the change.",
	"When? => Today => Ship today.",
	"^ => Later => Ship later.",
];
const options = parseChoices(choices.map((line) => `- ${line}`).join("\n"))!;

describe("contextual choices", () => {
	it("shares contextual parsing across CLI, previews and browser, with fence-local shorthand", () => {
		expect(options).toEqual([
			{ question: "Which approach?", label: "Fix forward", reply: "Keep the change." },
			{ question: "Which approach?", label: "Revert", reply: "Revert the change." },
			{ question: "When?", label: "Today", reply: "Ship today." },
			{ question: "When?", label: "Later", reply: "Ship later." },
		]);
		expect(choiceProblem(choices)).toBeUndefined();
		expect(summarizeChoices(withChoices("", choices))).toBe("Fix forward / Revert / Today / Later");
		expect(parseChoices("- ^ => Orphan => No question")).toBeNull();
		expect(choiceProblem(["^ => Orphan => No question"])).toContain("preceding question");
		expect(parseChoices("-  => Label => Reply")).toBeNull();
		expect(parseChoices("- Q? =>  => Reply")).toBeNull();
		expect(parseChoices("- Q? => Label => Reply\nnot a choice")).toBeNull();
		expect(parseChoices("- ^ => Orphan => Reply")).toBeNull();
		expect(summarizeChoices("```choices\n- ^ => Orphan => Reply\n```")).toContain("```choices");
		expect(choiceProblem([`${"q".repeat(201)} => A => B`])).toContain("200 characters");
		expect(choiceProblem(["Q? => A => B\nC"])).toContain("one line");
		expect(parseChoice("Q? => Label => a => b")).toEqual({ question: "Q?", label: "Label", reply: "a => b" });
		expect(parseChoice("Q? => Label => ")).toEqual({ question: "Q?", label: "Label", reply: "Label" });
	});

	it("composes, switches and toggles answers without losing other questions or prose", () => {
		let draft = toggleChoice("My notes.", options[0]!, options);
		expect(draft).toBe("My notes.\n\n> Which approach?\n\nKeep the change.");
		draft = toggleChoice(draft, options[2]!, options);
		expect(draftHasChoice(draft, choiceText(options[0]!))).toBe(true);
		expect(draftHasChoice(draft, choiceText(options[2]!))).toBe(true);
		draft = toggleChoice(draft, options[1]!, options);
		expect(draft).toBe("My notes.\n\n> Which approach?\n\nRevert the change.\n\n> When?\n\nShip today.");
		expect(draftHasChoice(draft, choiceText(options[0]!))).toBe(false);
		draft = toggleChoice(draft, options[1]!, options);
		expect(draft).not.toContain("Which approach?");
		expect(draft).toContain("> When?\n\nShip today.");
		expect(draft).toContain("My notes.");
		expect(toggleChoice(choiceText(options[0]!), options[0]!, options)).toBe("");
	});

	it("uses question context, not a bare answer, and preserves hand-edited answers", () => {
		const a = { question: "First?", label: "Yes", reply: "Yes" };
		const b = { question: "Second?", label: "Yes", reply: "Yes" };
		const draft = toggleChoice("", a, [a, b]);
		expect(draftHasChoice(draft, choiceText(b))).toBe(false);
		expect(toggleChoice(draft, b, [a, b])).toBe("> First?\n\nYes\n\n> Second?\n\nYes");
		const edited = "> Which approach?\n\nKeep the change, but add a test.\n\nMy notes.";
		expect(toggleChoice(edited, options[1]!, options)).toBe(`${edited}\n\n${choiceText(options[1]!)}`);
		expect(draftHasChoice(edited, choiceText(options[0]!))).toBe(false);
	});

	it("does not overwrite soft-line continuations or toggle contextual answers via legacy buttons", () => {
		const contextual = { question: "Proceed?", label: "Yes", reply: "Yes" };
		const no = { question: "Proceed?", label: "No", reply: "No" };
		const legacy = { label: "Yes", reply: "Yes" };
		const draft = choiceText(contextual);
		expect(draftHasChoice(draft, "Yes")).toBe(false);
		expect(toggleChoice(draft, legacy)).toBe(`${draft}\n\nYes`);
		expect(draftHasChoice(toggleChoice(draft, legacy), "Yes")).toBe(true);
		expect(draftHasChoice(toggleChoice(draft, legacy), choiceText(contextual))).toBe(true);
		const withLegacy = `${draft}\n\nYes`;
		expect(draftHasChoice(withLegacy, "Yes")).toBe(true);
		expect(toggleChoice(withLegacy, legacy)).toBe(draft);
		const edited = `${draft}\nbut only after the tests pass.`;
		expect(draftHasChoice(edited, choiceText(contextual))).toBe(false);
		expect(toggleChoice(edited, no, [contextual, no])).toBe(`${edited}\n\n${choiceText(no)}`);
	});

	it("retains independent legacy toggles and supports mixed fences", () => {
		const legacy = parseChoices("- Ship it\n- Hold => Wait")!;
		expect(legacy).toEqual([{ label: "Ship it", reply: "Ship it" }, { label: "Hold", reply: "Wait" }]);
		let draft = toggleChoice("Notes", legacy[0]!);
		draft = toggleChoice(draft, legacy[1]!);
		expect(draft).toBe("Notes\nShip it\nWait");
		expect(toggleChoice(draft, legacy[0]!)).toBe("Notes\nWait");
		expect(parseChoices("- Q? => Yes => Yes\n- Legacy\n- ^ => No => No")?.[2]?.question).toBe("Q?");
	});
});
