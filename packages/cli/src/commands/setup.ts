import { errAsync, ResultAsync } from "neverthrow";
import { getProjectRoot } from "@/lib/pending";
import { CliError, toCliError } from "@/utils/errors";
import { createLogger } from "@/utils/logger";

const log = createLogger("setup");

import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import opencodePluginSource from "@residue/adapter/opencode/template.ts.txt" with {
	type: "text",
};
// Embedded at build time so the binary doesn't need to resolve a file path at runtime
import piAdapterSource from "@residue/adapter/pi/template.ts.txt" with {
	type: "text",
};

type HookHandler = {
	type: string;
	command: string;
	timeout?: number;
};

type HookEntry = {
	matcher: string;
	hooks: HookHandler[];
};

type ClaudeSettings = {
	hooks?: Record<string, HookEntry[]>;
	[key: string]: unknown;
};

const CLAUDE_HOOK_COMMAND = "residue hook claude-code";
const CODEX_SESSION_START_COMMAND =
	"bash ~/.codex/hooks/residue-session-start.sh";
const CODEX_SESSION_END_COMMAND = "bash ~/.codex/hooks/residue-session-end.sh";

const CODEX_SESSION_START_SOURCE = `#!/usr/bin/env bash
set -uo pipefail

payload="$(cat)"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

transcript_path="$(
  PAYLOAD="$payload" python3 - <<'PY'
import json
import os
import sqlite3

payload = json.loads(os.environ.get("PAYLOAD") or "{}")
path = payload.get("transcript_path")
if isinstance(path, str) and path:
    print(path)
    raise SystemExit

cwd = payload.get("cwd") or os.getcwd()
db_path = os.path.expanduser("~/.codex/state_5.sqlite")
try:
    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            "select rollout_path from threads where cwd = ? order by updated_at desc limit 1",
            (cwd,),
        ).fetchone()
    if row and row[0]:
        print(row[0])
except Exception:
    pass
PY
)"

if [ -z "$transcript_path" ]; then
  exit 0
fi

agent_version="$(
  if command -v codex >/dev/null 2>&1; then
    codex --version 2>/dev/null | head -1
  else
    printf 'unknown'
  fi
)"

residue session start --agent codex --data "$transcript_path" --agent-version "\${agent_version:-unknown}" >/dev/null 2>&1 || true
`;

const CODEX_SESSION_END_SOURCE = `#!/usr/bin/env bash
set -uo pipefail

payload="$(cat)"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

transcript_path="$(
  PAYLOAD="$payload" python3 - <<'PY'
import json
import os
import sqlite3

payload = json.loads(os.environ.get("PAYLOAD") or "{}")
path = payload.get("transcript_path")
if isinstance(path, str) and path:
    print(path)
    raise SystemExit

cwd = payload.get("cwd") or os.getcwd()
db_path = os.path.expanduser("~/.codex/state_5.sqlite")
try:
    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            "select rollout_path from threads where cwd = ? order by updated_at desc limit 1",
            (cwd,),
        ).fetchone()
    if row and row[0]:
        print(row[0])
except Exception:
    pass
PY
)"

if [ -z "$transcript_path" ]; then
  exit 0
fi

agent_version="$(
  if command -v codex >/dev/null 2>&1; then
    codex --version 2>/dev/null | head -1
  else
    printf 'unknown'
  fi
)"

session_id="$(residue session start --agent codex --data "$transcript_path" --agent-version "\${agent_version:-unknown}" 2>/dev/null || true)"
if [ -n "$session_id" ]; then
  residue session end --id "$session_id" >/dev/null 2>&1 || true
fi
`;

function hasResidueHook(entries: HookEntry[]): boolean {
	return entries.some((entry) =>
		entry.hooks.some((h) => h.command === CLAUDE_HOOK_COMMAND),
	);
}

function hasCommandHook(
	entries: Array<{ hooks?: HookHandler[] }>,
	command: string,
): boolean {
	return entries.some((entry) =>
		(entry.hooks ?? []).some((hook) => hook.command === command),
	);
}

function setupClaudeCode(projectRoot: string): ResultAsync<void, CliError> {
	const claudeDir = join(projectRoot, ".claude");
	const settingsPath = join(claudeDir, "settings.json");

	return ResultAsync.fromPromise(
		(async () => {
			await mkdir(claudeDir, { recursive: true });

			let settings: ClaudeSettings = {};
			try {
				await stat(settingsPath);
				const raw = await readFile(settingsPath, "utf-8");
				settings = JSON.parse(raw) as ClaudeSettings;
			} catch {
				// file does not exist or is invalid
			}

			if (!settings.hooks) {
				settings.hooks = {};
			}

			let isChanged = false;

			// SessionStart hook
			if (!settings.hooks.SessionStart) {
				settings.hooks.SessionStart = [];
			}
			if (!hasResidueHook(settings.hooks.SessionStart)) {
				settings.hooks.SessionStart.push({
					matcher: "startup",
					hooks: [
						{ type: "command", command: CLAUDE_HOOK_COMMAND, timeout: 10 },
					],
				});
				isChanged = true;
			}

			// SessionEnd hook
			if (!settings.hooks.SessionEnd) {
				settings.hooks.SessionEnd = [];
			}
			if (!hasResidueHook(settings.hooks.SessionEnd)) {
				settings.hooks.SessionEnd.push({
					matcher: "",
					hooks: [
						{ type: "command", command: CLAUDE_HOOK_COMMAND, timeout: 10 },
					],
				});
				isChanged = true;
			}

			if (!isChanged) {
				log.info("residue hooks already configured in .claude/settings.json");
				return;
			}

			await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
			log.info("Configured Claude Code hooks in .claude/settings.json");
		})(),
		toCliError({ message: "Failed to setup Claude Code", code: "IO_ERROR" }),
	);
}

function setupPi(projectRoot: string): ResultAsync<void, CliError> {
	const extensionDir = join(projectRoot, ".pi", "extensions");
	const targetPath = join(extensionDir, "residue.ts");

	return ResultAsync.fromPromise(
		(async () => {
			await mkdir(extensionDir, { recursive: true });

			let isExisting = false;
			try {
				await stat(targetPath);
				isExisting = true;
			} catch {
				// does not exist
			}

			if (isExisting) {
				log.info(
					"residue extension already exists at .pi/extensions/residue.ts",
				);
				return;
			}

			await writeFile(targetPath, piAdapterSource);
			log.info("Installed pi extension at .pi/extensions/residue.ts");
		})(),
		toCliError({ message: "Failed to setup pi", code: "IO_ERROR" }),
	);
}

function setupOpencode(projectRoot: string): ResultAsync<void, CliError> {
	const pluginDir = join(projectRoot, ".opencode", "plugins");
	const targetPath = join(pluginDir, "residue.ts");

	return ResultAsync.fromPromise(
		(async () => {
			await mkdir(pluginDir, { recursive: true });

			let isExisting = false;
			try {
				await stat(targetPath);
				isExisting = true;
			} catch {
				// does not exist
			}

			if (isExisting) {
				log.info(
					"residue plugin already exists at .opencode/plugins/residue.ts",
				);
				return;
			}

			await writeFile(targetPath, opencodePluginSource);
			log.info("Installed opencode plugin at .opencode/plugins/residue.ts");
		})(),
		toCliError({ message: "Failed to setup opencode", code: "IO_ERROR" }),
	);
}

type CodexHooksConfig = {
	hooks?: Record<string, Array<{ matcher?: string; hooks?: HookHandler[] }>>;
	[key: string]: unknown;
};

function setupCodex(): ResultAsync<void, CliError> {
	const codexDir = join(homedir(), ".codex");
	const hookDir = join(codexDir, "hooks");
	const hooksPath = join(codexDir, "hooks.json");

	return ResultAsync.fromPromise(
		(async () => {
			await mkdir(hookDir, { recursive: true });

			const startPath = join(hookDir, "residue-session-start.sh");
			const endPath = join(hookDir, "residue-session-end.sh");
			await writeFile(startPath, CODEX_SESSION_START_SOURCE);
			await writeFile(endPath, CODEX_SESSION_END_SOURCE);
			await chmod(startPath, 0o755);
			await chmod(endPath, 0o755);

			let config: CodexHooksConfig = {};
			try {
				const raw = await readFile(hooksPath, "utf-8");
				config = JSON.parse(raw) as CodexHooksConfig;
			} catch {
				// file does not exist or is invalid
			}

			if (!config.hooks) config.hooks = {};
			if (!config.hooks.SessionStart) config.hooks.SessionStart = [];
			if (!config.hooks.Stop) config.hooks.Stop = [];

			let isChanged = false;
			if (
				!hasCommandHook(config.hooks.SessionStart, CODEX_SESSION_START_COMMAND)
			) {
				config.hooks.SessionStart.push({
					hooks: [
						{
							type: "command",
							command: CODEX_SESSION_START_COMMAND,
							timeout: 10,
						},
					],
				});
				isChanged = true;
			}
			if (!hasCommandHook(config.hooks.Stop, CODEX_SESSION_END_COMMAND)) {
				config.hooks.Stop.push({
					hooks: [
						{
							type: "command",
							command: CODEX_SESSION_END_COMMAND,
							timeout: 10,
						},
					],
				});
				isChanged = true;
			}

			if (isChanged) {
				await writeFile(hooksPath, `${JSON.stringify(config, null, 2)}\n`);
			}
			log.info("Configured Codex hooks in ~/.codex/hooks.json");
		})(),
		toCliError({ message: "Failed to setup Codex", code: "IO_ERROR" }),
	);
}

export function setup(opts: { agent: string }): ResultAsync<void, CliError> {
	return getProjectRoot().andThen((projectRoot) => {
		switch (opts.agent) {
			case "claude-code":
				return setupClaudeCode(projectRoot);
			case "pi":
				return setupPi(projectRoot);
			case "opencode":
				return setupOpencode(projectRoot);
			case "codex":
				return setupCodex();
			default:
				return errAsync(
					new CliError({
						message: `Unknown agent: ${opts.agent}. Supported: claude-code, codex, opencode, pi`,
						code: "VALIDATION_ERROR",
					}),
				);
		}
	});
}
