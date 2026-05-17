import { claudeCodeMapper } from "./claude-code/mapper";
import { codexMapper } from "./codex/mapper";
import { opencodeMapper } from "./opencode/mapper";
import { piMapper } from "./pi/mapper";
import type { Mapper } from "./types";

const mapperRegistry: Record<string, Mapper> = {
	"claude-code": claudeCodeMapper,
	codex: codexMapper,
	opencode: opencodeMapper,
	pi: piMapper,
};

const getMapper = (agent: string): Mapper | null => {
	return mapperRegistry[agent] ?? null;
};

export { mapperRegistry, getMapper };
