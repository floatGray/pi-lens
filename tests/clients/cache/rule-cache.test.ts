import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CACHE_VERSION, RuleCache } from "../../../clients/cache/rule-cache.js";
import { ruleFilesForLanguage } from "../../../clients/tree-sitter-query-loader.js";
import { removeTempDirSync } from "../test-utils.js";

const cleanup: string[] = [];

afterEach(() => {
	while (cleanup.length > 0) {
		const dir = cleanup.pop();
		if (dir && fs.existsSync(dir)) {
			removeTempDirSync(dir);
		}
	}
});

function setupProject(): { cwd: string; ruleFile: string } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-rule-cache-"));
	cleanup.push(cwd);
	fs.mkdirSync(path.join(cwd, ".pi-lens"));
	const ruleFile = path.join(cwd, "fake-rule.yml");
	fs.writeFileSync(ruleFile, "id: fake\n", "utf-8");
	return { cwd, ruleFile };
}

describe("RuleCache", () => {
	it("preserves has_fix across a save+load roundtrip", () => {
		const { cwd, ruleFile } = setupProject();
		const cache = new RuleCache("typescript", cwd);

		cache.set(
			[ruleFile],
			[
				{
					id: "console-statement",
					name: "Console Statement",
					severity: "warning",
					language: "typescript",
					message: "remove debug statements",
					query: "(call_expression) @x",
					metavars: ["x"],
					has_fix: true,
					defect_class: "safety",
					inline_tier: "warning",
					filePath: ruleFile,
				},
				{
					id: "deep-nesting",
					name: "Deep Nesting",
					severity: "warning",
					language: "typescript",
					message: "too deep",
					query: "(block) @b",
					metavars: ["b"],
					has_fix: false,
					filePath: ruleFile,
				},
			],
		);

		const loaded = cache.get([ruleFile]);
		expect(loaded).not.toBeNull();
		expect(loaded?.queries).toHaveLength(2);

		const consoleRule = loaded?.queries.find(
			(q) => q.id === "console-statement",
		);
		const nestingRule = loaded?.queries.find((q) => q.id === "deep-nesting");
		expect(consoleRule?.has_fix).toBe(true);
		expect(nestingRule?.has_fix).toBe(false);
		expect(consoleRule?.defect_class).toBe("safety");
		expect(consoleRule?.inline_tier).toBe("warning");
	});

	// #448: the set() projection in the tree-sitter runner once dropped
	// skip_test_files and fix_action, silently killing the #440 test-file
	// carve-out on every cache HIT. Pin every runner-consulted field.
	it("preserves every runner-consulted field across a save+load roundtrip", () => {
		const { cwd, ruleFile } = setupProject();
		const cache = new RuleCache("python", cwd);

		cache.set(
			[ruleFile],
			[
				{
					id: "python-assert-production",
					name: "Assert in production",
					severity: "warning",
					language: "python",
					message: "assert is stripped by -O",
					query: "(assert_statement) @a",
					metavars: ["a"],
					post_filter: "name_matches_param",
					post_filter_params: { max: 3 },
					defect_class: "safety",
					inline_tier: "warning",
					skip_test_files: true,
					has_fix: true,
					fix_action: "remove",
					filePath: ruleFile,
				},
			],
		);

		const loaded = cache.get([ruleFile])?.queries[0];
		expect(loaded).toMatchObject({
			severity: "warning",
			post_filter: "name_matches_param",
			post_filter_params: { max: 3 },
			defect_class: "safety",
			inline_tier: "warning",
			skip_test_files: true,
			has_fix: true,
			fix_action: "remove",
			filePath: ruleFile,
		});
	});

	// #448 follow-up: the v3→v4 bump left orphaned `<language>-rules-v3.json`
	// files on disk forever — nothing ever read or removed them again once the
	// version bumped. `set()` now prunes stale-version siblings after writing.
	it("prunes an orphaned prior-version cache file on set()", () => {
		const { cwd, ruleFile } = setupProject();
		const staleFile = path.join(cwd, ".pi-lens", "cache", "go-rules-v3.json");
		fs.mkdirSync(path.dirname(staleFile), { recursive: true });
		fs.writeFileSync(staleFile, JSON.stringify({ version: "v3" }), "utf-8");

		const cache = new RuleCache("go", cwd);
		cache.set(
			[ruleFile],
			[
				{
					id: "fake",
					name: "Fake",
					severity: "warning",
					language: "go",
					message: "",
					query: "(x) @x",
					metavars: [],
					has_fix: false,
					filePath: ruleFile,
				},
			],
		);

		const currentFile = path.join(
			cwd,
			".pi-lens",
			"cache",
			`go-rules-${CACHE_VERSION}.json`,
		);
		expect(fs.existsSync(staleFile)).toBe(false);
		expect(fs.existsSync(currentFile)).toBe(true);
	});

	// #878: the cache key fingerprints the full EFFECTIVE rule set, so an edit
	// to an inherited rule file (tsx runs the typescript rules) must invalidate
	// the inheriting language's entry — pre-fix only the language's OWN
	// directory was hashed and the stale compiled rules kept running.
	it("invalidates an inheriting language's cache when an inherited rule file changes", () => {
		const { cwd } = setupProject();
		const tsxRule = path.join(
			cwd,
			"rules",
			"tree-sitter-queries",
			"tsx",
			"own.yml",
		);
		const tsRule = path.join(
			cwd,
			"rules",
			"tree-sitter-queries",
			"typescript",
			"inherited.yml",
		);
		const pyRule = path.join(
			cwd,
			"rules",
			"tree-sitter-queries",
			"python",
			"unrelated.yml",
		);
		for (const f of [tsxRule, tsRule, pyRule]) {
			fs.mkdirSync(path.dirname(f), { recursive: true });
			fs.writeFileSync(f, "id: x\nquery: (identifier) @X\n", "utf-8");
		}

		const cache = new RuleCache("tsx", cwd);
		const queries = [
			{
				id: "fake",
				name: "Fake",
				severity: "warning",
				language: "tsx",
				message: "",
				query: "(x) @x",
				metavars: ["x"],
				has_fix: false,
				filePath: tsxRule,
			},
		];

		// Cold: nothing cached. Warm: hit.
		expect(cache.get(ruleFilesForLanguage("tsx", cwd))).toBeNull();
		cache.set(ruleFilesForLanguage("tsx", cwd), queries);
		expect(cache.get(ruleFilesForLanguage("tsx", cwd))).not.toBeNull();

		// Editing an INHERITED (typescript) rule invalidates the tsx entry.
		fs.writeFileSync(
			tsRule,
			"id: x\nquery: (identifier) @X\n# changed\n",
			"utf-8",
		);
		expect(cache.get(ruleFilesForLanguage("tsx", cwd))).toBeNull();

		// Control: an unrelated language's rule change does NOT invalidate it.
		cache.set(ruleFilesForLanguage("tsx", cwd), queries);
		fs.writeFileSync(pyRule, "id: y\nquery: (block) @B\n# changed\n", "utf-8");
		expect(cache.get(ruleFilesForLanguage("tsx", cwd))).not.toBeNull();
	});

	it("invalidates the cache when the schema version changes", () => {
		const { cwd, ruleFile } = setupProject();
		const cache = new RuleCache("typescript", cwd);

		cache.set(
			[ruleFile],
			[
				{
					id: "fake",
					name: "Fake",
					severity: "warning",
					language: "typescript",
					message: "",
					query: "(x) @x",
					metavars: [],
					has_fix: true,
					filePath: ruleFile,
				},
			],
		);

		const cacheFile = path.join(
			cwd,
			".pi-lens",
			"cache",
			`typescript-rules-${CACHE_VERSION}.json`,
		);
		expect(fs.existsSync(cacheFile)).toBe(true);

		const raw = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
		// Pin (#1082/#1116 pattern): the runtime constant must never coincide with
		// this deliberate mismatch literal, or this test would vacuously pass.
		expect(CACHE_VERSION).not.toBe("v2");
		raw.version = "v2";
		fs.writeFileSync(cacheFile, JSON.stringify(raw), "utf-8");

		expect(cache.get([ruleFile])).toBeNull();
	});
});
