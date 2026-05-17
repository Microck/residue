import { describe, expect, it } from "vitest";
import { codexMapper, getMapper } from "@/mappers";

const makeSession = (lines: Record<string, unknown>[]): string =>
	lines.map((line) => JSON.stringify(line)).join("\n");

describe("codex mapper", () => {
	it("is registered in mapper registry", () => {
		const mapper = getMapper("codex");
		expect(mapper).not.toBeNull();
		expect(mapper).toBe(codexMapper);
	});

	it("maps messages and tool calls from response items", () => {
		const raw = makeSession([
			{
				timestamp: "2026-05-17T16:00:00.000Z",
				type: "response_item",
				payload: {
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "set up codex" }],
				},
			},
			{
				timestamp: "2026-05-17T16:00:01.000Z",
				type: "response_item",
				payload: {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "I will inspect hooks." }],
				},
			},
			{
				type: "response_item",
				payload: {
					type: "function_call",
					name: "exec_command",
					arguments: '{"cmd":"residue status"}',
					call_id: "call_1",
				},
			},
			{
				type: "response_item",
				payload: {
					type: "function_call_output",
					call_id: "call_1",
					output: "Worker reachable",
				},
			},
		]);

		const messages = codexMapper(raw);

		expect(messages).toHaveLength(2);
		expect(messages[0]).toEqual({
			role: "human",
			content: "set up codex",
			timestamp: "2026-05-17T16:00:00.000Z",
		});
		expect(messages[1].role).toBe("assistant");
		expect(messages[1].content).toBe("I will inspect hooks.");
		expect(messages[1].tool_calls).toEqual([
			{
				name: "exec_command",
				input: '{"cmd":"residue status"}',
				output: "Worker reachable",
			},
		]);
	});
});
