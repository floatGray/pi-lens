import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "./test-utils.js";

const safeSpawnAsync = vi.fn();
vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
	safeSpawn: vi.fn(),
	which: vi.fn(async () => "/usr/bin/terragrunt"),
}));

async function loadFormatFile() {
	const mod = await import("../../clients/formatters.ts");
	return {
		formatFile: mod.formatFile,
		formatter: mod.terragruntHclFormatter,
		rubocop: mod.rubocopFormatter,
	};
}

describe("formatFile", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
	});

	// A formatter that never ran leaves the file byte-identical, which is
	// indistinguishable from "already formatted" unless the exit status is part
	// of the success test. `SpawnResult.error` is unset on a normal nonzero exit,
	// so an error-only check reports a clean format for an old terragrunt binary
	// that does not know the `hcl` command group.
	it("reports failure when the formatter exits nonzero", async () => {
		const env = setupTestEnvironment("pi-lens-format-file-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");
			safeSpawnAsync.mockResolvedValue({
				status: 1,
				stdout: "",
				stderr: 'Error: unknown command "hcl" for "terragrunt"',
			});

			const { formatFile, formatter } = await loadFormatFile();
			const result = await formatFile(filePath, formatter);

			expect(result.success).toBe(false);
			expect(result.changed).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("reports failure when the spawn itself fails", async () => {
		const env = setupTestEnvironment("pi-lens-format-file-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");
			safeSpawnAsync.mockResolvedValue({
				status: null,
				error: new Error("Process timed out after 15000ms"),
				failure: "timeout",
				stdout: "",
				stderr: "",
			});

			const { formatFile, formatter } = await loadFormatFile();
			const result = await formatFile(filePath, formatter);

			expect(result.success).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("reports success with changed=true when a clean run rewrites the file", async () => {
		const env = setupTestEnvironment("pi-lens-format-file-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals   {}\n");
			safeSpawnAsync.mockImplementation(async () => {
				fs.writeFileSync(filePath, "locals {}\n");
				return { status: 0, stdout: "", stderr: "" };
			});

			const { formatFile, formatter } = await loadFormatFile();
			const result = await formatFile(filePath, formatter);

			expect(result.success).toBe(true);
			expect(result.changed).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	// The reason the exit-status check is opt-in: `rubocop -a` exits 1 when
	// offenses remain after it has already rewritten the file. Failing that would
	// surface a formatter error on every file with an unfixable offense.
	it("keeps a nonzero exit non-fatal for lint-autofix formatters", async () => {
		const env = setupTestEnvironment("pi-lens-format-file-");
		try {
			const filePath = path.join(env.tmpDir, "app.rb");
			fs.writeFileSync(filePath, "puts  'hi'\n");
			safeSpawnAsync.mockImplementation(async () => {
				fs.writeFileSync(filePath, "puts 'hi'\n");
				return {
					status: 1,
					stdout: "1 file inspected, 1 offense detected, 1 offense corrected",
					stderr: "",
				};
			});

			const { formatFile, rubocop } = await loadFormatFile();
			const result = await formatFile(filePath, rubocop);

			expect(result.success).toBe(true);
			expect(result.changed).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("reports success with changed=false when a clean run leaves the file alone", async () => {
		const env = setupTestEnvironment("pi-lens-format-file-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");
			safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "", stderr: "" });

			const { formatFile, formatter } = await loadFormatFile();
			const result = await formatFile(filePath, formatter);

			expect(result.success).toBe(true);
			expect(result.changed).toBe(false);
		} finally {
			env.cleanup();
		}
	});
});
