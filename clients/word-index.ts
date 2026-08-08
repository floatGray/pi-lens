/**
 * Identifier-aware inverted word index + BM25 ranking.
 *
 * The lexical half of the "codebase mental model + hybrid ranking" ask (#162):
 * a deterministic, zero-dep index over source identifiers that answers
 * "which files are most relevant to <query>" with BM25 relevance plus a small
 * set of priors (demote tests/vendor and doc files) and an optional graph
 * centrality boost (importedBy count from the reverse-dependency index). It
 * complements LSP/symbol navigation rather than duplicating the host's grep:
 * grep finds raw substrings; this ranks files by identifier relevance.
 *
 * Built from file contents during the session scan, persisted in the project
 * snapshot (serialize/deserialize below), and queried via an MCP tool. No
 * embeddings, no native deps, no daemon — pure in-process TypeScript.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PathKeyedMap } from "./path-keyed-map.js";
import { isAtOrAboveHomeDir, normalizeEphemeralMapKey } from "./path-utils.js";
import {
	createDebounceScheduler,
	type DebounceScheduler,
} from "./persist-debounce.js";
import { getWordIndexMaxFilesDerived } from "./project-scale.js";
import { logWordIndex } from "./word-index-logger.js";

export interface WordHit {
	file: string;
	line: number;
}

/**
 * The single normalizer every word-index path key folds through (#1025). The
 * CHEAP form — slash-fold + win32-lowercase, NO filesystem I/O — because the
 * index is a hot, single-process, in-memory structure whose keys this process
 * produces itself (`collectSourceFilesAsync`'s walk, `path.resolve` at the
 * per-edit seams). `normalizeMapKey`'s `realpathSync` per call would be wrong on
 * the BM25 path. Applied at BOTH the build seam and the per-edit update seam so
 * a file's on-disk casing (walk) and its tool-input casing (edit) can no longer
 * diverge into a duplicate doc entry with stale postings (the #1025 item #2
 * bug). Kept as a named alias so every seam is grep-visible and provably shares
 * ONE normalizer with the {@link PathKeyedMap}s below.
 */
export const wordIndexKey = normalizeEphemeralMapKey;

export interface WordIndex {
	/** token → postings (one entry per (file,line) the token appears on). */
	postings: Map<string, WordHit[]>;
	/**
	 * file → number of indexed tokens (document length, for BM25 normalization).
	 * Path-keyed via {@link wordIndexKey} ({@link PathKeyedMap}) so build-form and
	 * edit-form keys for the same file collapse to one entry (#1025).
	 */
	docLengths: PathKeyedMap<number>;
	totalTokens: number;
	docCount: number;
	/** True when source collection hit its file cap, so searches may be incomplete. */
	truncated?: boolean;
	/**
	 * Forward index (#348 phase 2): file → (token → distinct-line count for that
	 * token in that file). Mirrors exactly what the postings list holds for this
	 * file, so a single-document replace is mechanical — subtract this file's own
	 * contribution from `postings`/`docLengths`/`totalTokens`/`docCount` via the
	 * forward entry, then add the new one, instead of re-walking every other
	 * file's postings to find what to remove. Absent (`undefined`) on indexes
	 * built by phase 1 or deserialized from a pre-phase-2 snapshot — callers that
	 * need incremental updates must treat a missing forward index as "no
	 * incremental primitive available" and fall back to a full rebuild.
	 */
	forward?: PathKeyedMap<Map<string, number>>;
	/** File mtimes captured when each document was tokenized (#958). */
	fileMtimes: PathKeyedMap<number>;
	/**
	 * File byte sizes captured when each document was tokenized (#1105). The
	 * incremental refresh gate is mtime-first (cheap, from the stat it already
	 * runs) but mtime alone is a stale signal: a content change that PRESERVES
	 * mtime (git checkout timestamp restoration, a formatter that preserves
	 * mtime, a same-second/same-clock write) would leave the old postings serving
	 * stale identifiers to symbol_search. Size is the free second axis of the
	 * review-graph gold-standard `size:mtimeMs` signature (builder.ts's
	 * `sourceSignatureEntry`) — the walk already reads `stat.size` to enforce the
	 * byte cap, so comparing it costs nothing yet catches every content change
	 * that alters length. The residual (same mtime AND same byte length, changed
	 * content) matches review-graph's own accepted residual; closing it would
	 * require reading+hashing every REUSED file on every refresh (the blind skip
	 * path), which is exactly the unconditional hot-path hashing the event-loop
	 * discipline forbids.
	 */
	fileSizes: PathKeyedMap<number>;
}

export interface RankedFile {
	file: string;
	score: number;
	/** Number of query-token occurrences in the file (summed term frequency). */
	hits: number;
	/** Distinct lines where a query token occurred, ascending. */
	lines: number[];
}

export interface RankOptions {
	/** Demote files under test/vendor/example paths (default true). */
	demoteTestVendor?: boolean;
	/** Demote documentation/data files so they can't starve a real source match (default true). */
	demoteDocs?: boolean;
	/** file → graph centrality (e.g. importedBy count); boosts well-connected files. */
	centrality?: Map<string, number>;
	/** Max results to return (default 20). */
	limit?: number;
	/**
	 * Optional pre-ranking scope predicate (#771, e.g. symbol_search's `paths`/
	 * `lang` params) — a file failing this check is dropped BEFORE its score
	 * entry is created, so a surviving file's score/priors/centrality boost are
	 * computed identically to an unfiltered run; only which files make it into
	 * the results list changes. Omitted (default) behaves exactly as before.
	 */
	fileFilter?: (file: string) => boolean;
}

// Common language keywords / boilerplate — indexing them adds noise and bloats
// postings without improving relevance. Kept deliberately small and
// language-agnostic.
const STOPWORDS = new Set([
	"the", "and", "for", "let", "var", "const", "function", "return", "if",
	"else", "import", "export", "from", "class", "interface", "type", "enum",
	"new", "this", "self", "void", "null", "true", "false", "async", "await",
	"public", "private", "protected", "static", "def", "fn", "func", "struct",
	"impl", "pub", "use", "mod", "in", "of", "as", "is", "not", "with",
]);

const TEST_VENDOR_RE =
	/(?:(^|[\\/])(?:tests?|__tests__|spec|specs|__mocks__|vendor|node_modules|examples?|fixtures?|\.git|dist|build|coverage)([\\/]|$))|(?:\.(?:test|spec)\.[a-z]+$)/i;

const DOC_FILE_RE = /\.(?:md|mdx|markdown|json|json5|jsonc|txt|rst|lock|ya?ml|toml|csv)$/i;

const TEST_VENDOR_PENALTY = 0.3;
const DOC_FILE_PENALTY = 0.5;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

function isTestOrVendor(file: string): boolean {
	return TEST_VENDOR_RE.test(file);
}

function isDocFile(file: string): boolean {
	return DOC_FILE_RE.test(file);
}

/**
 * Split an identifier into lowercased sub-tokens across camelCase, PascalCase,
 * snake_case, kebab-case, dotted, and digit boundaries — and keep the whole
 * lowercased identifier too. `getUserByID` → [getuserbyid, get, user, by, id];
 * `MAX_RETRY_2` → [max_retry_2, max, retry, 2] (whole kept, plus parts).
 */
export function splitIdentifier(identifier: string): string[] {
	const parts = new Set<string>();
	const whole = identifier.toLowerCase();
	if (whole.length >= 2 && !STOPWORDS.has(whole)) parts.add(whole);
	for (const chunk of identifier.split(/[^A-Za-z0-9]+/)) {
		if (!chunk) continue;
		const spaced = chunk
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase → camel Case
			.replace(/[A-Z](?=[A-Z][a-z])/g, "$& ") // HTTPServer → HTTP Server (linear; lookahead avoids super-linear backtracking, S5852)
			.replace(/([A-Za-z])([0-9])/g, "$1 $2") // retry2 → retry 2
			.replace(/([0-9])([A-Za-z])/g, "$1 $2"); // 2fa → 2 fa
		for (const sub of spaced.split(/\s+/)) {
			const token = sub.toLowerCase();
			if (token.length >= 2 && !STOPWORDS.has(token)) parts.add(token);
		}
	}
	return [...parts];
}

/** Extract identifier-like tokens from a line and split each into sub-tokens. */
export function tokenizeLine(line: string): string[] {
	const tokens: string[] = [];
	const matches = line.match(/[A-Za-z_$][A-Za-z0-9_$]*/g);
	if (!matches) return tokens;
	for (const match of matches) {
		for (const token of splitIdentifier(match)) tokens.push(token);
	}
	return tokens;
}

/**
 * Build the inverted index from file contents. One posting per (token, file,
 * line) — a token repeated on the same line counts once — so term frequency is
 * "lines mentioning the token", a stable signal that doesn't over-weight a line
 * that repeats an identifier. Document length is the total indexed token count.
 */
export function buildWordIndex(
	files: Array<{
		path: string;
		content: string;
		mtimeMs?: number;
		size?: number;
	}> & {
		truncated?: boolean;
	},
): WordIndex {
	const postings = new Map<string, WordHit[]>();
	const docLengths = new PathKeyedMap<number>(wordIndexKey);
	const forward = new PathKeyedMap<Map<string, number>>(wordIndexKey);
	const fileMtimes = new PathKeyedMap<number>(wordIndexKey);
	const fileSizes = new PathKeyedMap<number>(wordIndexKey);
	let totalTokens = 0;

	for (const { path: filePath, content, mtimeMs, size } of files) {
		const lines = content.split(/\r?\n/);
		let docLength = 0;
		const tokenLineCounts = new Map<string, number>();
		for (let i = 0; i < lines.length; i += 1) {
			const lineTokens = tokenizeLine(lines[i]);
			docLength += lineTokens.length;
			const seenOnLine = new Set<string>();
			for (const token of lineTokens) {
				if (seenOnLine.has(token)) continue;
				seenOnLine.add(token);
				const arr = postings.get(token);
				if (arr) arr.push({ file: filePath, line: i + 1 });
				else postings.set(token, [{ file: filePath, line: i + 1 }]);
				tokenLineCounts.set(token, (tokenLineCounts.get(token) ?? 0) + 1);
			}
		}
		docLengths.set(filePath, docLength);
		forward.set(filePath, tokenLineCounts);
		fileMtimes.set(filePath, mtimeMs ?? 0);
		fileSizes.set(filePath, size ?? Buffer.byteLength(content, "utf-8"));
		totalTokens += docLength;
	}

	return {
		postings,
		docLengths,
		totalTokens,
		docCount: files.length,
		truncated: files.truncated ?? false,
		forward,
		fileMtimes,
		fileSizes,
	};
}

/**
 * Remove `filePath`'s postings/docLength/forward entry from `index` in place,
 * using the forward index to know exactly which tokens to touch (no scan of
 * unrelated postings). No-op (returns false) if the index has no forward
 * index yet (pre-phase-2 / deserialized-old-shape) or the file isn't present —
 * callers must treat `false` as "fall back to a full rebuild", never as
 * silent success.
 */
export function removeWordIndexDocument(
	index: WordIndex,
	filePath: string,
): boolean {
	if (!index.forward) return false;
	const tokenLineCounts = index.forward.get(filePath);
	if (!tokenLineCounts) return false;

	// `postings` is token-keyed (not a PathKeyedMap), so its `WordHit.file`
	// display strings must be compared through the SAME normalizer the path maps
	// use — otherwise a build-form hit (`SUB/a.ts`) survives an edit-form removal
	// (`sub/a.ts`) on a case-insensitive FS and lingers as a stale posting
	// (the #1025 item #2 bug this fix closes).
	const removedKey = wordIndexKey(filePath);
	for (const token of tokenLineCounts.keys()) {
		const arr = index.postings.get(token);
		if (!arr) continue;
		const next = arr.filter((hit) => wordIndexKey(hit.file) !== removedKey);
		if (next.length > 0) index.postings.set(token, next);
		else index.postings.delete(token);
	}

	const docLength = index.docLengths.get(filePath) ?? 0;
	index.docLengths.delete(filePath);
	index.forward.delete(filePath);
	index.fileMtimes.delete(filePath);
	index.fileSizes.delete(filePath);
	index.totalTokens -= docLength;
	index.docCount = Math.max(0, index.docCount - 1);
	return true;
}

/**
 * Add or replace `filePath`'s document in `index` in place: removes the prior
 * postings for this file (if any, via {@link removeWordIndexDocument}'s
 * forward-index lookup) then re-tokenizes `content` and adds the new
 * postings/docLength/forward entry. df/N/totalTokens (avgdl) are updated as
 * running stats — no full recompute over other documents.
 *
 * Returns `false` (no-op on `index`) when the index has no forward index —
 * the caller must fall back to a full {@link buildWordIndex} rebuild in that
 * case (documented at the `forward` field and enforced by callers, not
 * silently patched here: a partially-forward-consistent index would corrupt
 * future incremental updates).
 */
export function updateWordIndexDocument(
	index: WordIndex,
	doc: { path: string; content: string },
): boolean {
	if (!index.forward) return false;

	// Remove the old contribution first (no-op if this is a brand new doc).
	if (index.forward.has(doc.path)) {
		removeWordIndexDocument(index, doc.path);
	}

	// Tokenize with line numbers attached (needed for WordHit.line) — this also
	// yields the forward-index entry (distinct-line count per token) so the
	// tokenization work happens exactly once for this document.
	const lines = doc.content.split(/\r?\n/);
	const perTokenHits = new Map<string, number[]>();
	let docLength = 0;
	for (let i = 0; i < lines.length; i += 1) {
		const lineTokens = tokenizeLine(lines[i]);
		docLength += lineTokens.length;
		const seenOnLine = new Set<string>();
		for (const token of lineTokens) {
			if (seenOnLine.has(token)) continue;
			seenOnLine.add(token);
			const arr = perTokenHits.get(token);
			if (arr) arr.push(i + 1);
			else perTokenHits.set(token, [i + 1]);
		}
	}

	const tokenLineCounts = new Map<string, number>();
	for (const [token, lineNumbers] of perTokenHits) {
		tokenLineCounts.set(token, lineNumbers.length);
		const hits = lineNumbers.map((line) => ({ file: doc.path, line }));
		const arr = index.postings.get(token);
		if (arr) arr.push(...hits);
		else index.postings.set(token, hits);
	}

	index.docLengths.set(doc.path, docLength);
	index.forward.set(doc.path, tokenLineCounts);
	// Per-edit callers generally already have content but not a stat. -1 is an
	// impossible real mtime, so it deliberately makes the document stale at the
	// next startup refresh (`-1 !== realMtime` always) — unlike 0, which is a
	// legal on-disk mtime (SOURCE_DATE_EPOCH=0, archive extraction) and would
	// collide, leaving such a file never re-tokenized (#958 review F2).
	index.fileMtimes.set(doc.path, -1);
	// Size is likewise recorded for the #1105 mtime+size refresh gate. The -1
	// mtime already forces a re-read next session, so this value only keeps the
	// map dense (parallel to fileMtimes); store the real byte length so a
	// deserialize→reserialize round-trip before any refresh carries a truthful
	// size rather than a placeholder.
	index.fileSizes.set(doc.path, Buffer.byteLength(doc.content, "utf-8"));
	index.totalTokens += docLength;
	index.docCount += 1;
	return true;
}

/** Bounds shared by every word-index build path — keep the walk off the
 * critical path on large repos: cap the file count, and skip files too large
 * to be hand-written source (generated/bundled output the source filter
 * didn't already exclude).
 *
 * Deprecated (#776): `collectWordIndexDocs` below no longer reads this
 * constant directly — it derives its cap from `getWordIndexMaxFilesDerived`
 * (project-scale.ts's `maxProjectFiles` knob), which reproduces this same
 * 6,000 default at the default base. Kept exported for tests/callers that
 * still reference the literal. */
export const WORD_INDEX_MAX_FILES = 6000;
export const WORD_INDEX_MAX_BYTES = 512 * 1024;

/**
 * Collect the bounded `{path, content}` doc set `buildWordIndex` consumes —
 * the ONE file-walk-and-read implementation shared by every build path
 * (session-start task, quick-mode warmup, cold-query background trigger),
 * so a bound/skip-rule change lands in one place instead of three copies.
 * `shouldContinue` lets a session-scoped caller abort early (session
 * superseded) without this module knowing about RuntimeCoordinator.
 */
export async function collectWordIndexDocs(
	root: string,
	shouldContinue: () => boolean = () => true,
): Promise<
	Array<{ path: string; content: string; mtimeMs: number; size: number }> & {
		truncated: boolean;
		/**
		 * Files the walk enumerated but this pass could NOT index — unreadable
		 * (vanished / locked) or over `WORD_INDEX_MAX_BYTES`. Surfaced (L1, #958)
		 * so the full-build path can report coverage honestly (#533) instead of
		 * silently dropping them with no count, the way the incremental path
		 * already reports its own `skipped`.
		 */
		skipped: number;
	}
> {
	const { collectSourceFilesAsync } = await import("./source-filter.js");
	// #747 hardening: pass the cap INTO the walk — without it,
	// `collectSourceFilesAsync` defaults to an unbounded traversal and the
	// `WORD_INDEX_MAX_FILES` slice below only trims the result AFTER the whole
	// tree (all of $HOME, on a misrooted cwd) has already been enumerated.
	// #760: the walk is additionally bounded by source-filter's default
	// visited-entry budget (DEFAULT_MAX_SCAN_ENTRIES), so a mixed tree with few
	// source files among a huge pile of non-source files can't force a
	// full-tree walk either; an index over the truncated list is acceptable.
	const maxFiles = getWordIndexMaxFilesDerived(root);
	// #894 review: prioritize code kinds within the cap — with broadened
	// enumeration, thousands of data/doc files (locale JSON, fixtures, …)
	// ahead of the code dirs in walk order could exhaust `maxFiles` and evict
	// real source files from the index entirely (DOC_FILE_PENALTY can't
	// rescue a file that never made the slice).
	const files = await collectSourceFilesAsync(root, {
		maxFiles,
		prioritizeCodeKinds: true,
	});
	const truncated = files.length === maxFiles;
	const docs = Object.assign(
		[] as Array<{
			path: string;
			content: string;
			mtimeMs: number;
			size: number;
		}>,
		{ truncated, skipped: 0 },
	);
	if (!shouldContinue()) return docs;
	let processed = 0;
	for (const file of files.slice(0, maxFiles)) {
		try {
			const stat = fs.statSync(file);
			if (stat.size <= WORD_INDEX_MAX_BYTES) {
				docs.push({
					path: file,
					content: fs.readFileSync(file, "utf-8"),
					mtimeMs: stat.mtimeMs,
					size: stat.size,
				});
			} else {
				// Over the byte cap — enumerated but deliberately not indexed. Count
				// it (L1, #958) so callers can keep coverage honest instead of the
				// old silent drop.
				docs.skipped += 1;
			}
		} catch {
			// unreadable / vanished file — skip, but count it (see above).
			docs.skipped += 1;
		}
		if (++processed % 100 === 0) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			if (!shouldContinue()) return docs;
		}
	}
	return docs;
}

export interface WordIndexRefreshResult {
	mode: "incremental";
	refreshed: number;
	dropped: number;
	/** Files that were stale but unreadable this pass; posting left intact. */
	skipped: number;
	reused: number;
}

const WORD_INDEX_INCREMENTAL_CHURN_THRESHOLD = 0.3;

/**
 * Refresh a serializer-v2 index from the current bounded source-file set.
 * The walk/stat pass is cheap; only stale/new documents are read and tokenized.
 * Throws when the index cannot be updated safely so callers can full-rebuild.
 */
export async function refreshWordIndexIncrementally(
	index: WordIndex,
	root: string,
	shouldContinue: () => boolean = () => true,
): Promise<WordIndexRefreshResult> {
	if (!index.forward || !index.fileMtimes || !index.fileSizes) {
		throw new Error("word index lacks incremental metadata");
	}
	const { collectSourceFilesAsync } = await import("./source-filter.js");
	const maxFiles = getWordIndexMaxFilesDerived(root);
	const walked = await collectSourceFilesAsync(root, {
		maxFiles,
		prioritizeCodeKinds: true,
	});
	if (!shouldContinue()) throw new Error("word index refresh superseded");

	// This set-difference must run in the SAME normalized key space the path
	// maps use (#1025 review). Otherwise a file whose stored displayPath became
	// the edit form (last-writer-wins after a case/separator-divergent per-edit
	// update) no longer string-matches its walk form here — even though
	// `fileMtimes.get(walkForm)` folds and hits — which would (1) double-count
	// churn (the same file scored as both "dropped" and "added"), possibly
	// crossing the threshold and forcing a needless full rebuild, and (2) drop
	// then re-add an unchanged file, opening a regression window because the drop
	// loop runs BEFORE the re-read: a transient read failure (skipped++) would
	// strand the file with no postings. Keying `current` and `oldSet` through
	// `wordIndexKey` keeps build/edit/refresh convergent; `current`'s value
	// retains the raw walk path for the stat/read and for the display key.
	const current = new Map<
		string,
		{ path: string; mtimeMs: number; size: number }
	>();
	for (const file of walked) {
		try {
			const stat = fs.statSync(file);
			if (stat.size <= WORD_INDEX_MAX_BYTES) {
				current.set(wordIndexKey(file), {
					path: file,
					mtimeMs: stat.mtimeMs,
					size: stat.size,
				});
			}
		} catch {
			// A file vanishing between walk and stat is simply absent.
		}
	}

	const oldSet = new Set([...index.docLengths.keys()].map(wordIndexKey));
	let changedSet = 0;
	for (const key of oldSet) if (!current.has(key)) changedSet++;
	for (const key of current.keys()) if (!oldSet.has(key)) changedSet++;
	const denominator = Math.max(oldSet.size, current.size, 1);
	if (changedSet / denominator > WORD_INDEX_INCREMENTAL_CHURN_THRESHOLD) {
		throw new Error("word index file-set churn exceeds incremental threshold");
	}

	let dropped = 0;
	for (const key of oldSet) {
		if (!current.has(key)) {
			// `key` is already folded; removeWordIndexDocument re-folds it
			// idempotently via the PathKeyedMap, so the drop hits the right entry.
			if (!removeWordIndexDocument(index, key)) {
				throw new Error(`failed to drop word-index document: ${key}`);
			}
			dropped++;
		}
	}

	let refreshed = 0;
	let skipped = 0;
	let processed = 0;
	for (const { path: file, mtimeMs, size } of current.values()) {
		// #1105: mtime-first, size-second freshness — mtime alone is a stale
		// signal (mtime-preserving content changes serve stale identifiers to
		// symbol_search). Size is free (the stat above already read it) and
		// catches every content change that alters byte length. Both come from the
		// SAME stat, so a mismatch on EITHER axis re-reads. `?? -1` makes a file
		// absent from the (possibly legacy, pre-#1105) size map always count as
		// changed → one-time re-read that repopulates the size, the safe direction.
		if (
			index.fileMtimes.get(file) !== mtimeMs ||
			(index.fileSizes.get(file) ?? -1) !== size
		) {
			// A file the walk/stat pass saw can still fail to read here — a
			// transient exclusive lock (antivirus, an editor, a build step) or a
			// file that vanished in the interim. Match collectWordIndexDocs'
			// tolerance: skip this one file and leave its existing posting (and
			// its old mtime, so it is retried next session) rather than aborting
			// the whole incremental pass into a full rebuild (#958 review F1).
			let content: string;
			try {
				content = fs.readFileSync(file, "utf-8");
			} catch {
				skipped++;
				continue;
			}
			if (!updateWordIndexDocument(index, { path: file, content })) {
				throw new Error(`failed to refresh word-index document: ${file}`);
			}
			// updateWordIndexDocument stamps mtime=-1 (per-edit convention); the
			// refresh path KNOWS the real on-disk stat, so overwrite both axes with
			// the true values so this document is not needlessly re-read next pass.
			index.fileMtimes.set(file, mtimeMs);
			index.fileSizes.set(file, size);
			refreshed++;
		}
		if (++processed % 100 === 0) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			if (!shouldContinue()) throw new Error("word index refresh superseded");
		}
	}
	index.truncated = walked.length === maxFiles;
	return {
		mode: "incremental",
		refreshed,
		dropped,
		skipped,
		reused: current.size - refreshed - skipped,
	};
}

/**
 * Rank files for a query by BM25 over the query's identifier tokens, then apply
 * priors: demote test/vendor and doc/data files, and boost by graph centrality
 * when supplied. Returns the top {@link RankOptions.limit} files, highest first.
 */
export function searchWordIndex(
	index: WordIndex,
	query: string,
	options: RankOptions = {},
): RankedFile[] {
	const {
		demoteTestVendor = true,
		demoteDocs = true,
		centrality,
		limit = 20,
		fileFilter,
	} = options;

	const queryTokens = [...new Set(tokenizeLine(query))];
	if (queryTokens.length === 0) return [];

	const docCount = index.docCount || 1;
	const avgDocLength = index.totalTokens / docCount || 1;

	const scores = new Map<
		string,
		{ score: number; hits: number; lines: Set<number> }
	>();

	for (const token of queryTokens) {
		const posting = index.postings.get(token);
		if (!posting) continue;

		const linesByFile = new Map<string, number[]>();
		for (const hit of posting) {
			const arr = linesByFile.get(hit.file);
			if (arr) arr.push(hit.line);
			else linesByFile.set(hit.file, [hit.line]);
		}

		const docFrequency = linesByFile.size;
		const idf = Math.log(
			1 + (docCount - docFrequency + 0.5) / (docFrequency + 0.5),
		);

		for (const [file, lines] of linesByFile) {
			if (fileFilter && !fileFilter(file)) continue;
			const termFrequency = lines.length;
			const docLength = index.docLengths.get(file) ?? avgDocLength;
			const denominator =
				termFrequency +
				BM25_K1 * (1 - BM25_B + BM25_B * (docLength / avgDocLength));
			const termScore =
				idf * ((termFrequency * (BM25_K1 + 1)) / denominator);

			const entry = scores.get(file) ?? {
				score: 0,
				hits: 0,
				lines: new Set<number>(),
			};
			entry.score += termScore;
			entry.hits += termFrequency;
			for (const line of lines) entry.lines.add(line);
			scores.set(file, entry);
		}
	}

	const results: RankedFile[] = [];
	for (const [file, entry] of scores) {
		let score = entry.score;
		if (demoteTestVendor && isTestOrVendor(file)) score *= TEST_VENDOR_PENALTY;
		if (demoteDocs && isDocFile(file)) score *= DOC_FILE_PENALTY;
		const connections = centrality?.get(file);
		if (connections && connections > 0) {
			score *= 1 + Math.log(1 + connections) / 4;
		}
		results.push({
			file,
			score,
			hits: entry.hits,
			lines: [...entry.lines].sort((a, b) => a - b),
		});
	}

	results.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
	return results.slice(0, Math.max(0, limit));
}

/**
 * Build a centrality map (file → importedBy count) keyed by THIS index's file
 * paths, from the project snapshot's `reverseDeps` (importedBy). The snapshot
 * keys are normalized (`normalizeMapKey(resolve(...))`) while the index keys are
 * the raw scanned paths, so the caller injects a `normalizeKey` bridge; it
 * defaults to identity for testing. Pass the result to {@link searchWordIndex}
 * as `centrality` to boost well-connected files. Kept here (not in the engine)
 * so it stays pure + unit-testable without the normalizer dependency.
 */
export function centralityFromReverseDeps(
	index: WordIndex,
	reverseDeps: Record<string, string[]> | undefined,
	normalizeKey: (file: string) => string = (file) => file,
): Map<string, number> {
	const centrality = new Map<string, number>();
	if (!reverseDeps) return centrality;
	for (const file of index.docLengths.keys()) {
		const importers = reverseDeps[normalizeKey(file)];
		if (importers && importers.length > 0) {
			centrality.set(file, importers.length);
		}
	}
	return centrality;
}

// --- Persistence (compact JSON for the project snapshot) ---------------------

export interface SerializedWordIndex {
	/** Serializer version; pre-v2 indexes lack per-file freshness metadata. */
	version: 2;
	/** Distinct file paths; postings reference files by index to shrink the JSON. */
	files: string[];
	/** token → flat [fileIdx, line, fileIdx, line, …] pairs. */
	postings: Array<[string, number[]]>;
	/** Parallel to {@link files}: indexed token count per file. */
	docLengths: number[];
	totalTokens: number;
	/** Number of files actually represented in this index. */
	indexedFileCount?: number;
	/** True when source collection reached its configured file cap. */
	truncated?: boolean;
	/** Parallel to {@link files}: mtime at which each document was tokenized. */
	fileMtimes: number[];
	/**
	 * Parallel to {@link files}: byte size at which each document was tokenized
	 * (#1105, the second axis of the mtime+size refresh gate). Optional so a
	 * pre-#1105 snapshot still parses — a missing `fileSizes` deserializes to an
	 * empty size map, which makes every file count as size-changed on the next
	 * refresh (one-time full re-read that repopulates sizes, the SAFE direction),
	 * exactly how the review graph degrades to mtime-only against a pre-#202
	 * cache. Never version-bumped for the same reason: the absence is self-healing.
	 */
	fileSizes?: number[];
	/**
	 * Forward index (#348 phase 2): `[fileIdx, [[token, lineCount], …]]` per
	 * file. Optional so pre-phase-2 snapshots parse unchanged. When ABSENT on
	 * load, {@link deserializeWordIndex} returns a `WordIndex` with `forward:
	 * undefined` — callers that want incremental per-edit updates must treat
	 * that as "no incremental primitive available" and trigger one full
	 * rebuild (never migrate an old snapshot's shape in place).
	 */
	forward?: Array<[number, Array<[string, number]>]>;
}

/** Persisted word-index serialization format version. Bump on breaking format changes. */
export const WORD_INDEX_FORMAT_VERSION = 2;

export function serializeWordIndex(index: WordIndex): SerializedWordIndex {
	const files = [...index.docLengths.keys()];
	const fileIndex = new Map<string, number>();
	files.forEach((file, i) => fileIndex.set(file, i));

	const postings: Array<[string, number[]]> = [];
	for (const [token, hits] of index.postings) {
		const flat: number[] = [];
		for (const hit of hits) {
			const idx = fileIndex.get(hit.file);
			if (idx === undefined) continue;
			flat.push(idx, hit.line);
		}
		if (flat.length > 0) postings.push([token, flat]);
	}

	const forward: Array<[number, Array<[string, number]>]> | undefined =
		index.forward
			? files.map((file, i) => [
					i,
					[...(index.forward!.get(file) ?? new Map()).entries()],
				])
			: undefined;

	return {
		version: WORD_INDEX_FORMAT_VERSION,
		files,
		postings,
		docLengths: files.map((file) => index.docLengths.get(file) ?? 0),
		totalTokens: index.totalTokens,
		indexedFileCount: index.docCount,
		truncated: index.truncated,
		fileMtimes: files.map((file) => index.fileMtimes.get(file) ?? 0),
		fileSizes: files.map((file) => index.fileSizes.get(file) ?? 0),
		forward,
	};
}

export function deserializeWordIndex(
	data: SerializedWordIndex | null | undefined,
): WordIndex | null {
	if (
		!data ||
		data.version !== WORD_INDEX_FORMAT_VERSION ||
		!Array.isArray(data.files) ||
		!Array.isArray(data.postings) ||
		!Array.isArray(data.docLengths) ||
		!Array.isArray(data.fileMtimes) ||
		data.fileMtimes.length !== data.files.length
	) {
		return null;
	}
	const docLengths = new PathKeyedMap<number>(wordIndexKey);
	const fileMtimes = new PathKeyedMap<number>(wordIndexKey);
	const fileSizes = new PathKeyedMap<number>(wordIndexKey);
	data.files.forEach((file, i) => docLengths.set(file, data.docLengths[i] ?? 0));
	data.files.forEach((file, i) => fileMtimes.set(file, data.fileMtimes[i] ?? 0));
	// #1105: `fileSizes` is optional on the wire (pre-#1105 snapshots omit it).
	// Only populate when the array is present AND parallel to `files`; otherwise
	// leave it empty so the refresh gate re-reads every file once to repopulate,
	// rather than trusting a bogus/misaligned size. Never treated as "current".
	if (
		Array.isArray(data.fileSizes) &&
		data.fileSizes.length === data.files.length
	) {
		data.files.forEach((file, i) =>
			fileSizes.set(file, data.fileSizes?.[i] ?? 0),
		);
	}

	const postings = new Map<string, WordHit[]>();
	for (const [token, flat] of data.postings) {
		if (typeof token !== "string" || !Array.isArray(flat)) continue;
		const hits: WordHit[] = [];
		for (let i = 0; i + 1 < flat.length; i += 2) {
			const file = data.files[flat[i]];
			const line = flat[i + 1];
			if (typeof file === "string" && typeof line === "number") {
				hits.push({ file, line });
			}
		}
		if (hits.length > 0) postings.set(token, hits);
	}

	let forward: PathKeyedMap<Map<string, number>> | undefined;
	if (Array.isArray(data.forward)) {
		forward = new PathKeyedMap<Map<string, number>>(wordIndexKey);
		for (const entry of data.forward) {
			if (!Array.isArray(entry) || entry.length !== 2) continue;
			const [fileIdx, tokenCounts] = entry;
			const file = data.files[fileIdx];
			if (typeof file !== "string" || !Array.isArray(tokenCounts)) continue;
			const perToken = new Map<string, number>();
			for (const pair of tokenCounts) {
				if (!Array.isArray(pair) || pair.length !== 2) continue;
				const [token, count] = pair;
				if (typeof token === "string" && typeof count === "number") {
					perToken.set(token, count);
				}
			}
			forward.set(file, perToken);
		}
	}

	return {
		postings,
		docLengths,
		totalTokens:
			typeof data.totalTokens === "number" ? data.totalTokens : 0,
		docCount: data.files.length,
		truncated: data.truncated === true,
		forward,
		fileMtimes,
		fileSizes,
	};
}

// --- Cold-query background build trigger (#348) -------------------------------
//
// `symbol_search` (pi tool) / `pilens_symbol_search` (MCP) are stateless callers:
// no RuntimeCoordinator, no session lifecycle — just a synchronous read of the
// persisted snapshot via `symbolSearch()`. When the index is missing (e.g. the
// session-start / warmup lifecycle in runtime-session.ts hasn't run yet, or this
// is an MCP-only session that never ran pilens_session_start), the tool must
// never block the query on a project walk (#348 decision 3): it triggers a
// single background build, keyed by the resolved cwd so a burst of queries in
// the same cold window only pays for one walk, and returns immediately.

export type WordIndexBuildStatus =
	| { state: "building" }
	| { state: "refused"; reason: string }
	| { state: "failed"; reason: string };

const buildStatuses = new Map<string, WordIndexBuildStatus>();

export function getWordIndexBuildStatus(
	cwd: string,
): WordIndexBuildStatus | undefined {
	return buildStatuses.get(path.resolve(cwd));
}

/** Test-only: reset the in-flight-build guard between test files/cases. */
export function _resetWordIndexBuildGuardForTests(): void {
	buildStatuses.clear();
}

/**
 * Fire a one-time bounded background build for `cwd` if one isn't already
 * running. Persists into the existing project snapshot (preserving its other
 * fields) so the next query — or the next real session — picks it up. Errors
 * are swallowed (this is best-effort warmth, not a request the caller is
 * waiting on); the guard always clears in a `finally` so a failed build can be
 * retried by a later query.
 */
export function triggerBackgroundWordIndexBuild(
	cwd: string,
	dbg?: (msg: string) => void,
	options: { homeDir?: string } = {},
): WordIndexBuildStatus {
	const key = path.resolve(cwd);
	// #747 hardening: this trigger is the one word-index build path with NO
	// session lifecycle in front of it (cold `symbol_search` queries, in-process
	// and via MCP where cwd can be a raw tool argument) — the session-start and
	// quick-mode-warmup builds sit behind `canWarmCaches`, which already refuses
	// a home-rooted cwd. Apply the same `isAtOrAboveHomeDir` ceiling here so a
	// cold query from $HOME never starts a whole-home walk-and-read.
	if (isAtOrAboveHomeDir(key, options.homeDir)) {
		const reason = `root at/above home directory (${key})`;
		dbg?.(`word-index cold-build: skipped — ${reason}`);
		logWordIndex({
			phase: "cold_build_refused",
			cwd: key,
			trigger: "cold_query",
			reason,
		});
		const status = { state: "refused", reason } as const;
		buildStatuses.set(key, status);
		return status;
	}
	const current = buildStatuses.get(key);
	if (current?.state === "building") return current;
	const status = { state: "building" } as const;
	buildStatuses.set(key, status);
	void (async () => {
		const startMs = Date.now();
		try {
			const { loadProjectSnapshot, saveProjectSnapshot, PROJECT_SNAPSHOT_VERSION } =
				await import("./project-snapshot.js");
			const docs = await collectWordIndexDocs(key);
			const index = buildWordIndex(docs);
			const existing = loadProjectSnapshot(key);
			const snapshot = existing ?? {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: key,
				generatedAt: new Date().toISOString(),
				seq: 0,
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [],
			};
			snapshot.generatedAt = new Date().toISOString();
			snapshot.wordIndex = serializeWordIndex(index);
			saveProjectSnapshot(key, snapshot);
			dbg?.(
				`word-index cold-build: ${index.docCount} files, ${index.postings.size} tokens (${Date.now() - startMs}ms)`,
			);
			// M2, #958: durable decision/coverage record for the MCP-critical cold
			// path (this is where symbol_search reads the index and dbg is a no-op).
			logWordIndex({
				phase: "cold_build",
				cwd: key,
				trigger: "cold_query",
				durationMs: Date.now() - startMs,
				indexedFileCount: index.docCount,
				tokens: index.postings.size,
				truncated: index.truncated,
				skipped: docs.skipped,
			});
			buildStatuses.delete(key);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			buildStatuses.set(key, { state: "failed", reason });
			dbg?.(`word-index cold-build: failed: ${reason}`);
			logWordIndex({
				phase: "cold_build_failed",
				cwd: key,
				trigger: "cold_query",
				durationMs: Date.now() - startMs,
				error: reason,
			});
		}
	})();
	return status;
}

// --- Debounced per-edit persist (#348 phase 2) --------------------------------
//
// The per-edit seam (dispatch/integration.ts) updates `runtime.wordIndex` in
// memory on every write, same as the review graph's per-edit rebuild. Without
// coalescing, persisting that in-memory index on every single edit would mean
// one full-snapshot JSON.stringify+write per keystroke-adjacent edit — the
// same OOM-risking spike the graph's #260 circuit-breaker exists to prevent.
// This reuses `createDebounceScheduler` (persist-debounce.ts) rather than
// growing a second copy of the graph's bespoke pending-map+timer bookkeeping;
// only the "write" callback differs, because the target differs: the graph
// owns its own cache file, but the word index must merge into the SHARED
// project-snapshot file via `saveRuntimeProjectSnapshot`/`saveProjectSnapshot`
// (preserving unrelated snapshot fields, and honoring the seq-laundering guard
// in project-snapshot.ts — see saveRuntimeProjectSnapshot's comment).

const WORD_INDEX_PERSIST_DEBOUNCE_MS_DEFAULT = 1500;

function wordIndexPersistDebounceMs(): number {
	const raw = Number(process.env.PI_LENS_WORD_INDEX_PERSIST_DEBOUNCE_MS);
	return Number.isFinite(raw) && raw >= 0
		? raw
		: WORD_INDEX_PERSIST_DEBOUNCE_MS_DEFAULT;
}

interface PendingWordIndexPersist {
	cwd: string;
	index: WordIndex;
	dbg?: (msg: string) => void;
}

let wordIndexPersistScheduler:
	| DebounceScheduler<PendingWordIndexPersist>
	| undefined;

function getWordIndexPersistScheduler(): DebounceScheduler<PendingWordIndexPersist> {
	if (wordIndexPersistScheduler) return wordIndexPersistScheduler;
	wordIndexPersistScheduler = createDebounceScheduler<PendingWordIndexPersist>({
		debounceMs: wordIndexPersistDebounceMs,
		write(_key, pending) {
			void writeWordIndexSnapshot(pending.cwd, pending.index, pending.dbg);
		},
	});
	return wordIndexPersistScheduler;
}

async function writeWordIndexSnapshot(
	cwd: string,
	index: WordIndex,
	dbg?: (msg: string) => void,
): Promise<void> {
	try {
		const { loadProjectSnapshot, saveProjectSnapshot, PROJECT_SNAPSHOT_VERSION } =
			await import("./project-snapshot.js");
		const existing = loadProjectSnapshot(cwd);
		const snapshot = existing ?? {
			version: PROJECT_SNAPSHOT_VERSION,
			projectRoot: path.resolve(cwd),
			generatedAt: new Date().toISOString(),
			seq: 0,
			files: {},
			symbols: {},
			reverseDeps: {},
			cachedExports: [],
		};
		snapshot.generatedAt = new Date().toISOString();
		snapshot.wordIndex = serializeWordIndex(index);
		saveProjectSnapshot(cwd, snapshot);
		dbg?.(
			`word-index persist: ${index.docCount} files, ${index.postings.size} tokens`,
		);
		// #958 review F1: durably record persist SUCCESS too, not just failures —
		// in the MCP host (`dbg` is a no-op) this is the only signal that the index
		// is actually being kept fresh across edits. Debounced (~1.5s), so not
		// spammy. Mirrors the review graph's persist_succeeded.
		logWordIndex({
			phase: "persist_succeeded",
			cwd: path.resolve(cwd),
			trigger: "per_edit",
			indexedFileCount: index.docCount,
			tokens: index.postings.size,
		});
	} catch (err) {
		dbg?.(`word-index persist: failed: ${err}`);
		// M3, #958: a swallowed persist means every LATER symbol_search reads a
		// stale index with no trace — the exact silent-failure this durable log
		// exists to surface (dbg is a no-op in the MCP host).
		logWordIndex({
			phase: "persist_failed",
			cwd: path.resolve(cwd),
			trigger: "per_edit",
			indexedFileCount: index.docCount,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Schedule a debounced persist of `index` for `cwd`, coalescing a burst of
 * per-edit updates into one write after a quiet window (default 1500ms,
 * override via `PI_LENS_WORD_INDEX_PERSIST_DEBOUNCE_MS`, mirroring the review
 * graph's `PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS`). Merges through the same
 * `saveProjectSnapshot` path phase 1 uses — preserves unrelated snapshot
 * fields and respects the seq-laundering guard (only ever writes wordIndex
 * for the CURRENT in-memory index, never re-stamps a stale one).
 */
export function scheduleWordIndexPersist(
	cwd: string,
	index: WordIndex,
	dbg?: (msg: string) => void,
): void {
	const key = path.resolve(cwd);
	getWordIndexPersistScheduler().schedule(key, { cwd: key, index, dbg });
}

/** Test hook: force any pending debounced word-index persist to write immediately. */
export function flushWordIndexPersistsForTests(): void {
	getWordIndexPersistScheduler().flushAll();
}
