import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	bindingStateLabel,
	composeBoundToCurrentDisk,
	createDiskBindingCache,
	hashDiagnosticContent,
} from "../../../clients/lsp/diagnostic-binding.js";

const tmpDirs: string[] = [];
function mkTmpFile(name: string, content: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-binding-"));
	tmpDirs.push(dir);
	const file = path.join(dir, name);
	fs.writeFileSync(file, content);
	return file;
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("#1095 diagnostic-binding — composeBoundToCurrentDisk (I7)", () => {
	it("ANY contributor mismatching disk → false (a false dominates)", () => {
		expect(composeBoundToCurrentDisk([false, true])).toBe(false);
		expect(composeBoundToCurrentDisk([true, "unknown", false])).toBe(false);
		expect(composeBoundToCurrentDisk([false, "unknown"])).toBe(false);
	});
	it("all contributors unknown (or none) → unknown", () => {
		expect(composeBoundToCurrentDisk(["unknown", "unknown"])).toBe("unknown");
		expect(composeBoundToCurrentDisk([])).toBe("unknown");
	});
	it("≥1 bound, none mismatched → true (unknowns do not block)", () => {
		expect(composeBoundToCurrentDisk([true, "unknown"])).toBe(true);
		expect(composeBoundToCurrentDisk([true, true])).toBe(true);
	});
});

describe("#1095 diagnostic-binding — bindingStateLabel", () => {
	it("maps verdicts to observability labels", () => {
		expect(bindingStateLabel(true)).toBe("bound");
		expect(bindingStateLabel(false)).toBe("mismatch");
		expect(bindingStateLabel("unknown")).toBe("unknown");
	});
});

describe("#1095 diagnostic-binding — createDiskBindingCache (I5, I6, I8)", () => {
	it("no contentHash (version-less server) → unknown, never false", () => {
		const file = mkTmpFile("a.ts", "const x = 1;\n");
		const cache = createDiskBindingCache();
		expect(cache.boundToCurrentDisk(file, {})).toBe("unknown");
		expect(cache.boundToCurrentDisk(file, { version: 3 })).toBe("unknown");
	});

	it("matching disk content → true (T1)", () => {
		const content = "const x = 1;\n";
		const file = mkTmpFile("a.ts", content);
		const cache = createDiskBindingCache();
		expect(
			cache.boundToCurrentDisk(file, {
				contentHash: hashDiagnosticContent(content),
			}),
		).toBe(true);
	});

	it("disk changed after publish (mtime + content) → false (T4)", () => {
		const original = "const x = 1;\n";
		const file = mkTmpFile("a.ts", original);
		const cache = createDiskBindingCache();
		const stored = { contentHash: hashDiagnosticContent(original) };
		expect(cache.boundToCurrentDisk(file, stored)).toBe(true);
		// Rewrite with different bytes AND a distinct mtime.
		const later = new Date(Date.now() + 5000);
		fs.writeFileSync(file, "const x = 2;\n");
		fs.utimesSync(file, later, later);
		expect(cache.boundToCurrentDisk(file, stored)).toBe(false);
	});

	it("mtime changed but content identical → true (hash compare, not mtime-only) (T5)", () => {
		const content = "const x = 1;\n";
		const file = mkTmpFile("a.ts", content);
		const cache = createDiskBindingCache();
		const stored = { contentHash: hashDiagnosticContent(content) };
		expect(cache.boundToCurrentDisk(file, stored)).toBe(true);
		// Bump mtime WITHOUT changing bytes — an mtime-only check would say stale.
		const later = new Date(Date.now() + 5000);
		fs.utimesSync(file, later, later);
		expect(cache.boundToCurrentDisk(file, stored)).toBe(true);
	});

	it("CRLF (+ BOM) Windows-style content round-trips to true (I2, T6)", () => {
		// The payload text pi-lens sends is the raw UTF-8 read — BOM char + CRLF
		// preserved. The disk verify reads with the identical raw UTF-8 transform.
		const crlfBom = "﻿const x = 1;\r\nconst y = 2;\r\n";
		const file = mkTmpFile("crlf.ts", crlfBom);
		const cache = createDiskBindingCache();
		expect(
			cache.boundToCurrentDisk(file, {
				contentHash: hashDiagnosticContent(crlfBom),
			}),
		).toBe(true);
		// A payload hashed from LF-normalized text (the classic Windows bug) would
		// NOT match the CRLF bytes on disk — proving the hash is over exact bytes.
		const lfNormalized = crlfBom.replace(/\r\n/g, "\n").replace(/^﻿/, "");
		expect(
			cache.boundToCurrentDisk(file, {
				contentHash: hashDiagnosticContent(lfNormalized),
			}),
		).toBe(false);
	});

	it("disk stat/read failure with a contentHash present → unknown, never false (T8, #533)", () => {
		const cache = createDiskBindingCache();
		const missing = path.join(os.tmpdir(), "pi-lens-does-not-exist-1095.ts");
		expect(
			cache.boundToCurrentDisk(missing, { contentHash: "deadbeef" }),
		).toBe("unknown");
	});
});
