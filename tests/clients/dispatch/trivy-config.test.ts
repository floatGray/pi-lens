import { beforeEach, describe, expect, it, vi } from "vitest";
import { suppressTrivyConfigDockerOverlap } from "../../../clients/dispatch/dispatcher.js";
import {
	looksLikeKubernetesManifest,
	parseTrivyConfigOutput,
} from "../../../clients/dispatch/runners/trivy-config.js";
import type { Diagnostic } from "../../../clients/dispatch/types.js";

// ── appliesTo — Terraform is in scope, Terragrunt is deliberately excluded ────

describe("trivy-config appliesTo", () => {
	it("applies to docker, yaml, and terraform, but not terragrunt", async () => {
		const trivyConfigRunner = (
			await import("../../../clients/dispatch/runners/trivy-config.js")
		).default;
		expect(trivyConfigRunner.appliesTo).toEqual(["docker", "yaml", "terraform"]);
		expect(trivyConfigRunner.appliesTo).not.toContain("terragrunt");
	});
});

// ── Terraform files skip the yaml/k8s content gate ─────────────────────────────

const { safeSpawnAsync, isTrivyEnabled, resolveSeverityFloor } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	isTrivyEnabled: vi.fn(),
	resolveSeverityFloor: vi.fn(),
}));

vi.mock("../../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
}));

vi.mock("../../../clients/trivy-client.js", () => ({
	isTrivyEnabled,
	resolveSeverityFloor,
}));

vi.mock("../../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	createAvailabilityChecker: () => ({
		isAvailableAsync: async () => true,
		getCommand: () => "trivy",
	}),
}));

function createCtx(kind: "terraform" | "yaml", filePath: string, cwd: string) {
	return {
		filePath,
		cwd,
		kind,
		pi: { getFlag: () => false },
		autofix: false,
		deltaMode: true,
		hasTool: async () => true,
		log: () => {},
	};
}

describe("trivy-config run() — terraform pass-through", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		isTrivyEnabled.mockReset();
		resolveSeverityFloor.mockReset();
		isTrivyEnabled.mockReturnValue(true);
		resolveSeverityFloor.mockReturnValue(["HIGH", "CRITICAL"]);
	});

	it("scans a .tf file directly, without the yaml k8s-manifest gate", async () => {
		safeSpawnAsync.mockResolvedValue({
			error: null,
			status: 0,
			stdout: JSON.stringify({ Results: [] }),
			stderr: "",
		});

		const runner = (
			await import("../../../clients/dispatch/runners/trivy-config.js")
		).default;

		const result = await runner.run(
			createCtx("terraform", "/tmp/main.tf", "/tmp") as never,
		);

		expect(safeSpawnAsync).toHaveBeenCalledWith(
			"trivy",
			expect.arrayContaining(["config", "/tmp/main.tf"]),
			expect.objectContaining({ cwd: "/tmp" }),
		);
		expect(result.status).toBe("succeeded");
	});

	// trivy exits nonzero with an empty stdout when it never scanned — a bad
	// policy bundle, an unreadable file, a rejected flag. A nonzero exit is not a
	// spawn failure, so `result.error` is unset and an error-only guard reports a
	// clean scan for a file trivy never read.
	it("skips when trivy exits nonzero without producing output", async () => {
		safeSpawnAsync.mockResolvedValue({
			status: 1,
			stdout: "",
			stderr: "FATAL failed to load policies",
		});

		const runner = (
			await import("../../../clients/dispatch/runners/trivy-config.js")
		).default;

		const result = await runner.run(
			createCtx("terraform", "/tmp/main.tf", "/tmp") as never,
		);

		expect(result.status).toBe("skipped");
		expect(result.diagnostics).toEqual([]);
	});
});

// ── Kubernetes manifest heuristic ─────────────────────────────────────────────

describe("looksLikeKubernetesManifest", () => {
	it("matches a manifest with apiVersion + kind", () => {
		expect(
			looksLikeKubernetesManifest(
				"apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n",
			),
		).toBe(true);
	});

	it("matches when one document in a multi-doc file is a manifest", () => {
		const content = [
			"# config\nfoo: bar",
			"apiVersion: v1\nkind: Service\nmetadata:\n  name: svc",
		].join("\n---\n");
		expect(looksLikeKubernetesManifest(content)).toBe(true);
	});

	it("does NOT match a CI workflow / plain yaml (no apiVersion+kind)", () => {
		expect(
			looksLikeKubernetesManifest("name: CI\non: [push]\njobs:\n  build:\n"),
		).toBe(false);
		expect(looksLikeKubernetesManifest("kind: only-kind-no-apiversion")).toBe(
			false,
		);
	});
});

// ── Parser ────────────────────────────────────────────────────────────────────

describe("parseTrivyConfigOutput", () => {
	it("maps Misconfigurations[] with severity → semantic", () => {
		const report = JSON.stringify({
			Results: [
				{
					Target: "Dockerfile",
					Class: "config",
					Type: "dockerfile",
					Misconfigurations: [
						{
							ID: "DS026",
							Title: "No HEALTHCHECK defined",
							Severity: "CRITICAL",
							Resolution: "Add a HEALTHCHECK instruction.",
							CauseMetadata: { StartLine: 3 },
						},
						{
							ID: "DS002",
							Title: "Image runs as root",
							Severity: "HIGH",
							CauseMetadata: { StartLine: 1 },
						},
					],
				},
			],
		});
		const diags = parseTrivyConfigOutput(report, "Dockerfile");
		expect(diags).toHaveLength(2);
		expect(diags[0]).toMatchObject({
			rule: "DS026",
			line: 3,
			severity: "error",
			semantic: "blocking",
			defectClass: "safety",
			tool: "trivy-config",
		});
		expect(diags[0].message).toContain("Add a HEALTHCHECK");
		expect(diags[1]).toMatchObject({
			rule: "DS002",
			line: 1,
			severity: "warning",
			semantic: "warning",
		});
	});

	it("defaults line to 1 when CauseMetadata is missing, skips rows without ID", () => {
		const report = JSON.stringify({
			Results: [
				{
					Target: "deploy.yaml",
					Misconfigurations: [
						{ Title: "no id", Severity: "HIGH" },
						{ ID: "KSV001", Title: "Privileged", Severity: "HIGH" },
					],
				},
			],
		});
		const diags = parseTrivyConfigOutput(report, "deploy.yaml");
		expect(diags).toHaveLength(1);
		expect(diags[0]).toMatchObject({ rule: "KSV001", line: 1 });
	});

	it("is defensive against malformed / empty input", () => {
		expect(parseTrivyConfigOutput("", "f")).toEqual([]);
		expect(parseTrivyConfigOutput("not json", "f")).toEqual([]);
		expect(parseTrivyConfigOutput("{}", "f")).toEqual([]);
		expect(
			parseTrivyConfigOutput(JSON.stringify({ Results: null }), "f"),
		).toEqual([]);
	});
});

// ── Dockerfile overlap dedup vs hadolint (#131 Mode 2 acceptance gate) ─────────

describe("suppressTrivyConfigDockerOverlap", () => {
	function diag(tool: string, line: number, rule: string): Diagnostic {
		return {
			id: `${tool}-${rule}-${line}`,
			message: `${rule} at ${line}`,
			filePath: "Dockerfile",
			line,
			column: 1,
			severity: "warning",
			semantic: "warning",
			tool,
			rule,
			fixable: false,
		};
	}

	it("drops the trivy-config finding where hadolint already flags the same line", () => {
		const out = suppressTrivyConfigDockerOverlap([
			diag("hadolint", 7, "DL3007"), // :latest
			diag("trivy-config", 7, "DS001"), // :latest — overlap, dropped
			diag("trivy-config", 12, "DS026"), // net-new security check, kept
		]);
		expect(out.map((d) => `${d.tool}:${d.line}`)).toEqual([
			"hadolint:7",
			"trivy-config:12",
		]);
	});

	it("keeps Kubernetes findings (no hadolint diagnostics for YAML)", () => {
		const k8s = [
			{ ...diag("trivy-config", 5, "KSV017"), filePath: "deploy.yaml" },
			{ ...diag("trivy-config", 9, "KSV001"), filePath: "deploy.yaml" },
		];
		expect(suppressTrivyConfigDockerOverlap(k8s)).toHaveLength(2);
	});

	it("is a no-op when no hadolint diagnostics are present", () => {
		const only = [diag("trivy-config", 1, "DS002")];
		expect(suppressTrivyConfigDockerOverlap(only)).toEqual(only);
	});
});
