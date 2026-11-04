export interface Choice {
	question?: string;
	label: string;
	reply: string;
}
export function parseChoice(line: string, previousQuestion?: string): Choice | undefined;
export function parseChoices(text: string | null | undefined): Choice[] | null;
export function choiceText(option: Choice): string;
export function draftHasChoice(draft: string, reply: string): boolean;
export function toggleChoice(draft: string, option: Choice, peers?: Choice[]): string;
