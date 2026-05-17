import { summarizeToolInput } from "../shared";
import type { SearchLine } from "../types";

type CodexContentPart = {
	type?: string;
	text?: string;
};

type CodexPayload = {
	type?: string;
	role?: string;
	content?: CodexContentPart[];
	name?: string;
	arguments?: string;
};

type CodexEntry = {
	type?: string;
	payload?: CodexPayload;
};

function parseLines(raw: string): CodexEntry[] {
	const entries: CodexEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as CodexEntry);
		} catch {
			// Ignore malformed lines in best-effort search extraction.
		}
	}
	return entries;
}

function extractMessageText(parts: CodexContentPart[] | undefined): string {
	if (!Array.isArray(parts)) return "";
	return parts
		.filter((part) => part.type === "input_text" || part.type === "output_text")
		.map((part) => part.text ?? "")
		.filter(Boolean)
		.join("\n")
		.trim();
}

function extractCodex(raw: string): SearchLine[] {
	const lines: SearchLine[] = [];

	for (const entry of parseLines(raw)) {
		if (entry.type !== "response_item" || !entry.payload) continue;
		const payload = entry.payload;

		if (payload.type === "message") {
			const text = extractMessageText(payload.content);
			if (!text) continue;
			if (payload.role === "user") {
				lines.push({ role: "human", text });
			} else if (payload.role === "assistant") {
				lines.push({ role: "assistant", text });
			}
			continue;
		}

		if (payload.type === "function_call" && payload.name) {
			let input: Record<string, unknown> | undefined;
			if (payload.arguments) {
				try {
					input = JSON.parse(payload.arguments) as Record<string, unknown>;
				} catch {
					input = { command: payload.arguments };
				}
			}
			lines.push({
				role: "tool",
				text: summarizeToolInput(payload.name, input),
			});
		}
	}

	return lines;
}

function extractFirstMessage(raw: string): string | null {
	for (const entry of parseLines(raw)) {
		if (entry.type !== "response_item" || entry.payload?.type !== "message") {
			continue;
		}
		if (entry.payload.role !== "user") continue;
		const text = extractMessageText(entry.payload.content);
		if (text) return text.slice(0, 200);
	}
	return null;
}

function extractSessionName(raw: string): string | null {
	for (const entry of parseLines(raw)) {
		if (entry.type !== "session_meta") continue;
		const payload = entry.payload as Record<string, unknown> | undefined;
		const title = payload?.title;
		if (typeof title === "string" && title.trim()) return title.trim();
	}
	return null;
}

export { extractCodex, extractFirstMessage, extractSessionName };
