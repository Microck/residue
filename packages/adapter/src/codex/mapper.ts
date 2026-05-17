import type { Mapper, Message, ToolCall } from "../types";

type CodexContentPart = {
	type?: string;
	text?: string;
};

type CodexPayload =
	| {
			type: "message";
			role?: string;
			content?: CodexContentPart[];
			phase?: string;
	  }
	| {
			type: "function_call";
			name?: string;
			arguments?: string;
			call_id?: string;
	  }
	| {
			type: "function_call_output";
			call_id?: string;
			output?: string;
	  };

type CodexEntry = {
	timestamp?: string;
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
			// Keep Codex transcript parsing best-effort; one malformed line should
			// not make the whole uploaded session unreadable.
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
		.join("\n");
}

const codexMapper: Mapper = (raw: string): Message[] => {
	if (!raw.trim()) return [];

	const messages: Message[] = [];
	const pendingToolCalls = new Map<string, ToolCall>();
	let currentAssistant: Message | null = null;

	const flushAssistant = () => {
		if (currentAssistant) {
			messages.push(currentAssistant);
			currentAssistant = null;
		}
	};

	for (const entry of parseLines(raw)) {
		if (entry.type !== "response_item" || !entry.payload) continue;

		const payload = entry.payload;

		if (payload.type === "message") {
			const content = extractMessageText(payload.content);
			if (!content.trim()) continue;

			if (payload.role === "user") {
				flushAssistant();
				messages.push({
					role: "human",
					content,
					timestamp: entry.timestamp,
				});
				continue;
			}

			if (payload.role === "assistant") {
				// Consecutive assistant message chunks belong to the same visible turn.
				if (!currentAssistant) {
					currentAssistant = {
						role: "assistant",
						content,
						timestamp: entry.timestamp,
						tool_calls: [],
					};
				} else {
					currentAssistant.content = currentAssistant.content
						? `${currentAssistant.content}\n${content}`
						: content;
				}
			}
			continue;
		}

		if (payload.type === "function_call") {
			if (!currentAssistant) {
				currentAssistant = {
					role: "assistant",
					content: "",
					timestamp: entry.timestamp,
					tool_calls: [],
				};
			}
			const toolCall: ToolCall = {
				name: payload.name ?? "tool",
				input: payload.arguments ?? "",
				output: "",
			};
			currentAssistant.tool_calls?.push(toolCall);
			if (payload.call_id) {
				pendingToolCalls.set(payload.call_id, toolCall);
			}
			continue;
		}

		if (payload.type === "function_call_output") {
			const callId = payload.call_id;
			const toolCall = callId ? pendingToolCalls.get(callId) : undefined;
			if (toolCall && callId) {
				toolCall.output = payload.output ?? "";
				pendingToolCalls.delete(callId);
			}
		}
	}

	flushAssistant();

	return messages.map((message) =>
		message.tool_calls?.length === 0
			? { ...message, tool_calls: undefined }
			: message,
	);
};

export { codexMapper };
