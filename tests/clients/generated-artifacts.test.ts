import { describe, expect, it } from "vitest";
import {
	isDeclarationFile,
	isGeneratedOrArtifact,
} from "../../clients/generated-artifacts.js";

describe("generated-artifacts basename shape-coherence (refs #1161, sibling of #1150/#1152)", () => {
	// Pre-fix, `hasStrongGeneratedArtifactPath`/`hasWeakGeneratedFileNamePattern`
	// used the module-default `path.basename(filePath)`. On Linux CI that is
	// POSIX `basename`, which finds no `/` in a `C:\...` path and returns the
	// whole string unchanged — so `LOCKFILE_NAMES.has(base.toLowerCase())`
	// misses a Windows-shaped lockfile path entirely. This test is meaningful
	// on BOTH OSes per the #1024 discipline: it feeds the literal Windows-shaped
	// string as INPUT (never a normalized/expected key), so on native Windows
	// it exercises the (unchanged, already-correct) win32 `basename` path, and
	// on Linux it exercises the new shape-committed `win32.basename` branch
	// this fix adds. Pre-fix this FAILED on Linux (lockfile under-detected)
	// while the forward-slash-shaped equivalent already passed.
	it("detects a Windows-shaped lockfile path regardless of running OS", () => {
		for (const filePath of [
			"C:\\proj\\package-lock.json",
			"C:\\proj\\yarn.lock",
			"C:\\proj\\pnpm-lock.yaml",
			"\\\\server\\share\\proj\\package-lock.json",
		]) {
			expect(isGeneratedOrArtifact(filePath)).toBe(true);
		}
	});

	it("still detects a POSIX-shaped lockfile path (no regression for the common case)", () => {
		expect(isGeneratedOrArtifact("/home/dev/project/package-lock.json")).toBe(
			true,
		);
	});

	// Same shape-2 defect, this time in `isDeclarationFile` (used by the
	// `includeDeclarations` opt-in in `classifyGeneratedOrArtifactDetailed`).
	it("detects a Windows-shaped .d.ts declaration path regardless of running OS", () => {
		for (const filePath of [
			"C:\\proj\\src\\types.d.ts",
			"C:\\proj\\src\\types.d.mts",
			"C:\\proj\\src\\types.d.cts",
			"\\\\server\\share\\proj\\types.d.ts",
		]) {
			expect(isDeclarationFile(filePath)).toBe(true);
		}
	});

	it("still detects a POSIX-shaped .d.ts declaration path (no regression for the common case)", () => {
		expect(isDeclarationFile("/home/dev/project/src/types.d.ts")).toBe(true);
	});

	it("does not misclassify a hand-written file with 'gen' in a Windows-shaped path (no over-broad match)", () => {
		expect(isGeneratedOrArtifact("C:\\proj\\src\\general.ts")).toBe(false);
	});
});
