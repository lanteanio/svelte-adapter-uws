import {
	copyFileSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import MarkdownIt from "markdown-it";
import {
	COMPATIBILITY_END,
	COMPATIBILITY_START,
	MIGRATION_COMPATIBILITY_END,
	MIGRATION_COMPATIBILITY_START,
	NPM_BOOLEAN_OPTIONS,
	NPM_BOOLEAN_SHORTHANDS,
	NPM_FIXED_VALUE_SHORTHANDS,
	NPM_VALUE_OPTIONS,
	NPM_VALUE_SHORTHANDS,
	MIGRATION_GUIDE_RELATIVE_PATH,
	parseCompatibility,
	renderCompatibility,
	uwsDeclaredInstallSpec,
	renderMigrationCompatibility,
	replaceCompatibilityBlock,
	validateCompatibility,
	validateLifecycleScripts,
	validateMigrationCompatibility,
	validateMigrationGuideTupleTable,
	validateWorkspaceSiblings,
	validatePublishedCompatibilityDocuments,
	validateReadmeCompatibility,
} from "../scripts/check-compatibility.js";
import {
	authenticatedReadmeSpan,
	migrationBaselineException,
	scanTextWithOffsets,
} from "../scripts/check-uws-pin.js";

const read = (relative) =>
	readFileSync(new URL("../" + relative, import.meta.url), "utf8");
const manifest = read("docs/compatibility.v1.csv");
const readme = read("README.md");
const migration = read("MIGRATION.md");
const pkg = JSON.parse(read("package.json"));
const rows = parseCompatibility(manifest);
const releasePolicy = read("docs/releasing.md");
const crossRepoWorkflow = read(".github/workflows/cross-repo-heads.yml");
const protocolSchema = JSON.parse(read("protocol.schema.json"));
const trainFacts = {
	policy: releasePolicy,
	workflow: crossRepoWorkflow,
	protocolSchema,
};
const TRAIN_FACT_FIELDS = [
	"realtime_version",
	"extensions_version",
	"realtime_head",
	"extensions_head",
	"wire_protocol",
	"procedure",
];
const nativeSpec = (ref) => "github:uNetworking/" + "uWebSockets.js#" + ref;
const nativeArchive = (ref) =>
	"https://github.com/uNetworking/uWebSockets.js/archive/refs/tags/" +
	ref +
	".tar.gz";
const markdown = new MarkdownIt({ html: true });
const checkerDependencies = [
	"argparse",
	"entities",
	"linkify-it",
	"markdown-it",
	"mdurl",
	"parse5",
	"punycode.js",
	"semver",
	"uc.micro",
];

function copyCheckerDependencies(temp) {
	mkdirSync(join(temp, "node_modules"));
	for (const dependency of checkerDependencies) {
		cpSync(
			fileURLToPath(
				new URL("../node_modules/" + dependency, import.meta.url),
			),
			join(temp, "node_modules", dependency),
			{ recursive: true },
		);
	}
}

// The live npm CLI, when this suite runs under one. The classification gates
// in this file are hermetic; the assertions that consult npm itself (its
// parser, its option table, its command dispatch) are PARITY PROBES against
// the environment and must degrade to a visible skip - not an error - when
// the runner is pnpm, yarn, an IDE, or an npm that moved its private layout.
// A thrown "npm_execpath is required" turned every such runner red with zero
// repository change, which is an environment fact, not a finding.
const npmRuntime = (() => {
	const execpath = process.env.npm_execpath;
	if (!execpath) return null;
	try {
		const req = createRequire(execpath);
		return { execpath, packageArg: req("npm-package-arg") };
	} catch {
		return null;
	}
})();
const itNpm = npmRuntime === null ? it.skip : it;

/**
 * Run parity assertions against npm's own parser for one spec. A no-op when
 * no npm CLI is reachable: the surrounding test still executes this file's
 * own classification assertions, which are the actual gate.
 */
function npmParity(spec, assertions) {
	if (npmRuntime === null) return;
	assertions(npmRuntime.packageArg(spec));
}


describe("ecosystem compatibility manifest", () => {
	it("is the source of truth for the adapter package and runtime prerequisites", () => {
		expect(validateCompatibility(rows, pkg)).toEqual([]);
		expect(rows.map((row) => row.channel)).toEqual([
			"legacy",
			"stable",
			"prerelease",
		]);
		expect(rows.filter((row) => row.current === "true")).toHaveLength(1);
		expect(rows.find((row) => row.channel === "stable")).toMatchObject({
			adapter_version: "0.5.8",
			provenance: "npm:svelte-adapter-uws@0.5.8",
			uwebsockets: nativeSpec("v20.67.0"),
		});
	});

	it("records the coordinated release train and passes against the repository facts", () => {
		expect(validateCompatibility(rows, pkg, trainFacts)).toEqual([]);
		expect(rows.find((row) => row.current === "true")).toMatchObject({
			train: "0.6",
			realtime_version: "0.6.0-next.90",
			extensions_version: "0.6.0-next.63",
			realtime_head: "c76a05892aa6f95222644583f49ab22843d29e5c",
			extensions_head: "90c9f887b888cef96a44c2113950f00e0b8f7f33",
			wire_protocol: "1",
			procedure:
				"docs/releasing.md#prerelease-publication docs/releasing.md#abort",
		});
		// The shipped anchors point at real policy headings, and the slug rule
		// (lowercase, spaces to hyphens, everything else stripped) is what maps
		// them; the clean validation above proves the mapping resolves.
		expect(releasePolicy).toContain("## Prerelease publication");
		expect(releasePolicy).toContain("## Abort");
		// Rows written before the train contract keep the documented empty
		// spelling for all six release facts and still pass.
		for (const channel of ["legacy", "stable"]) {
			const row = rows.find((candidate) => candidate.channel === channel);
			expect(row.train).toBe(channel === "legacy" ? "0.4" : "0.5");
			for (const field of TRAIN_FACT_FIELDS) expect(row[field]).toBe("");
		}
	});

	it("requires a well-formed train that prefixes its adapter series", () => {
		for (const broken of ["", "0.6.0", "0.x", "banana"]) {
			const mutated = rows.map((row) =>
				row.current === "true" ? { ...row, train: broken } : row,
			);
			expect(validateCompatibility(mutated, pkg), broken).toContain(
				"prerelease: train must be a major.minor release train",
			);
		}
		const foreign = rows.map((row) =>
			row.current === "true" ? { ...row, train: "0.5" } : row,
		);
		expect(validateCompatibility(foreign, pkg)).toContain(
			"prerelease: train 0.5 does not prefix the adapter series 0.6.0-next",
		);
		const missingStable = rows.map((row) =>
			row.channel === "stable" ? { ...row, train: "" } : row,
		);
		expect(validateCompatibility(missingStable, pkg)).toContain(
			"stable: train must be a major.minor release train",
		);
	});

	it("treats the six train release facts as one all-or-nothing unit", () => {
		const partialCurrent = rows.map((row) =>
			row.current === "true" ? { ...row, realtime_head: "" } : row,
		);
		const partialErrors = validateCompatibility(partialCurrent, pkg);
		expect(partialErrors).toContain(
			"prerelease: train release facts form one unit and must be all present or all empty",
		);
		expect(partialErrors).toContain(
			"prerelease: current row must record all six train release facts",
		);
		const bareCurrent = rows.map((row) =>
			row.current === "true"
				? {
						...row,
						...Object.fromEntries(
							TRAIN_FACT_FIELDS.map((field) => [field, ""]),
						),
					}
				: row,
		);
		expect(validateCompatibility(bareCurrent, pkg)).toContain(
			"prerelease: current row must record all six train release facts",
		);
		const partialStable = rows.map((row) =>
			row.channel === "stable" ? { ...row, wire_protocol: "1" } : row,
		);
		expect(validateCompatibility(partialStable, pkg)).toContain(
			"stable: train release facts form one unit and must be all present or all empty",
		);
	});

	it("rejects out-of-series sibling versions, malformed heads, and malformed procedures", () => {
		const outsideRealtime = rows.map((row) =>
			row.current === "true"
				? { ...row, realtime_version: "0.5.0" }
				: row,
		);
		expect(validateCompatibility(outsideRealtime, pkg)).toContain(
			"prerelease: realtime_version release identity is outside its series",
		);
		const outsideExtensions = rows.map((row) =>
			row.current === "true"
				? { ...row, extensions_version: "0.7.0" }
				: row,
		);
		expect(validateCompatibility(outsideExtensions, pkg)).toContain(
			"prerelease: extensions_version release identity is outside its series",
		);
		const shortHead = rows.map((row) =>
			row.current === "true"
				? { ...row, extensions_head: "90c9f887" }
				: row,
		);
		expect(validateCompatibility(shortHead, pkg)).toContain(
			"prerelease: extensions_head must be a full lowercase git head",
		);
		const upperHead = rows.map((row) =>
			row.current === "true"
				? { ...row, realtime_head: row.realtime_head.toUpperCase() }
				: row,
		);
		expect(validateCompatibility(upperHead, pkg)).toContain(
			"prerelease: realtime_head must be a full lowercase git head",
		);
		const zeroRevision = rows.map((row) =>
			row.current === "true" ? { ...row, wire_protocol: "0" } : row,
		);
		expect(validateCompatibility(zeroRevision, pkg)).toContain(
			"prerelease: wire_protocol must be a positive integer revision",
		);
		for (const procedure of [
			"docs/other.md#abort",
			"docs/releasing.md#Abort",
			"docs/releasing.md#abort  docs/releasing.md#abort",
		]) {
			const mutated = rows.map((row) =>
				row.current === "true" ? { ...row, procedure } : row,
			);
			expect(validateCompatibility(mutated, pkg), procedure).toContain(
				"prerelease: procedure must be space-separated docs/releasing.md anchors",
			);
		}
	});

	it("refuses fact drift against the release policy, the workflow pins, and the protocol schema", () => {
		const missingAnchor = rows.map((row) =>
			row.current === "true"
				? { ...row, procedure: "docs/releasing.md#no-such-heading" }
				: row,
		);
		expect(validateCompatibility(missingAnchor, pkg)).toEqual([]);
		expect(
			validateCompatibility(missingAnchor, pkg, trainFacts),
		).toContain(
			"prerelease: procedure anchor docs/releasing.md#no-such-heading has no matching release policy heading",
		);

		const driftedHead = rows.map((row) =>
			row.current === "true"
				? { ...row, realtime_head: "a".repeat(40) }
				: row,
		);
		expect(validateCompatibility(driftedHead, pkg)).toEqual([]);
		expect(validateCompatibility(driftedHead, pkg, trainFacts)).toContain(
			"prerelease: realtime_head disagrees with the cross-repo workflow REALTIME_REF pin",
		);
		const driftedExtensionsHead = rows.map((row) =>
			row.current === "true"
				? { ...row, extensions_head: "b".repeat(40) }
				: row,
		);
		expect(
			validateCompatibility(driftedExtensionsHead, pkg, trainFacts),
		).toContain(
			"prerelease: extensions_head disagrees with the cross-repo workflow EXTENSIONS_REF pin",
		);
		expect(
			validateCompatibility(rows, pkg, {
				...trainFacts,
				workflow: crossRepoWorkflow.replace(
					"REALTIME_REF:",
					"REALTIME_WAS:",
				),
			}),
		).toContain("cross-repo workflow does not pin REALTIME_REF");

		const driftedRevision = rows.map((row) =>
			row.current === "true" ? { ...row, wire_protocol: "2" } : row,
		);
		expect(validateCompatibility(driftedRevision, pkg)).toEqual([]);
		expect(
			validateCompatibility(driftedRevision, pkg, trainFacts),
		).toContain(
			"prerelease: wire_protocol disagrees with the protocol schema revision",
		);
	});

	it("renders the bounded README block exactly", () => {
		const start = readme.indexOf(COMPATIBILITY_START);
		const end =
			readme.indexOf(COMPATIBILITY_END) + COMPATIBILITY_END.length;
		const rendered = renderCompatibility(rows);
		expect(readme.slice(start, end)).toBe(rendered);
		// Each line names the spec its OWN row records, in that row's own form.
		// The stable row records a git spec because that is what the published
		// stable adapter declares; rewriting it to an archive URL gave npm two
		// non-registry specs for one name, which it does not dedupe.
		const stable = rows.find((row) => row.channel === "stable");
		const prerelease = rows.find((row) => row.channel === "prerelease");
		expect(rendered).toContain(
			"npm install svelte-adapter-uws@latest " + stable.uwebsockets,
		);
		expect(rendered).toContain(
			"npm install svelte-adapter-uws@0.6.0-next.92 " + prerelease.uwebsockets,
		);
		expect(stable.uwebsockets.startsWith("github:")).toBe(true);
		expect(prerelease.uwebsockets).toBe(nativeArchive("v20.69.0"));
		expect(rendered).toContain(
			"staged, unpublished `0.6.0-next.92` candidate",
		);
		expect(rendered).toContain(
			"`@next` tag may currently resolve an earlier published candidate",
		);
		expect(rendered).not.toContain("npm install svelte-adapter-uws@next ");
	});

	it("rejects package, Node, native-pin, and current-channel drift", () => {
		expect(
			validateCompatibility(rows, { ...pkg, version: "0.7.0-next.1" }),
		).toContain(
			"package version 0.7.0-next.1 is outside current adapter series 0.6.0-next",
		);
		expect(
			validateCompatibility(rows, {
				...pkg,
				engines: { node: ">=24.0.0" },
			}),
		).toContain("prerelease: Node floor disagrees with package.json");
		expect(
			validateCompatibility(rows, {
				...pkg,
				optionalDependencies: {
					...pkg.optionalDependencies,
					"uWebSockets.js": nativeSpec("v99.0.0"),
				},
			}),
		).toContain(
			"prerelease: uWebSockets.js pin disagrees with package.json",
		);
		const noCurrent = rows.map((row) => ({ ...row, current: "false" }));
		expect(validateCompatibility(noCurrent, pkg)).toContain(
			"exactly one compatibility row must be current",
		);
	});

	it("binds stable/latest, prerelease/next, package stability, and the publish tag", () => {
		expect(
			validateCompatibility(rows, {
				...pkg,
				publishConfig: { ...pkg.publishConfig, tag: "latest" },
			}),
		).toContain("publishConfig.tag disagrees with current dist tag");

		const inverted = rows.map((row) =>
			row.channel === "stable"
				? { ...row, dist_tag: "next" }
				: row.channel === "prerelease"
					? { ...row, dist_tag: "latest" }
					: row,
		);
		expect(validateCompatibility(inverted, pkg)).toEqual(
			expect.arrayContaining([
				"stable: invalid dist tag role",
				"prerelease: invalid dist tag role",
			]),
		);

		const stableCurrent = rows.map((row) => ({
			...row,
			current: row.channel === "stable" ? "true" : "false",
		}));
		expect(validateCompatibility(stableCurrent, pkg)).toContain(
			"current channel does not match package version stability",
		);
	});

	it("rejects invalid tokens, prerequisite drift, and channel-set drift", () => {
		const invalidCurrent = rows.map((row) =>
			row.channel === "stable" ? { ...row, current: "banana" } : row,
		);
		expect(validateCompatibility(invalidCurrent, pkg)).toContain(
			"stable: current must be true or false",
		);

		const staleStable = rows.map((row) =>
			row.channel === "stable" ? { ...row, node: ">=99.0.0" } : row,
		);
		expect(validateCompatibility(staleStable, pkg)).toContain(
			"stable: published baseline facts disagree with the pinned registry identity",
		);

		expect(validateCompatibility(rows.slice(1), pkg)).toContain(
			"channels must be exactly legacy, stable, prerelease",
		);
	});

	it("cannot admit a free-form note that contradicts structured runtime facts", () => {
		const nodeNoteMutant = rows.map((row) =>
			row.channel === "stable"
				? { ...row, notes: "Current stable line; Node 99 or newer" }
				: row,
		);
		expect(validateCompatibility(nodeNoteMutant, pkg)).toContain(
			"stable: unexpected compatibility field notes",
		);
		expect(manifest.split(/\r?\n/, 1)[0]).not.toContain("notes");
	});

	it("escapes valid union ranges when rendering Markdown tables", () => {
		const nodeRange = ">=22.0.0 || >=24.0.0";
		const rangeRows = rows.map((row) =>
			row.current === "true" ? { ...row, node: nodeRange } : row,
		);
		const rangePackage = {
			...pkg,
			engines: { ...pkg.engines, node: nodeRange },
		};
		const rangeReadme = readme.replace(
			"Node is `" + pkg.engines.node + "`",
			"Node is `" + nodeRange + "`",
		);
		expect(validateCompatibility(rangeRows, rangePackage)).toEqual([]);
		expect(validateReadmeCompatibility(rangeReadme, rangeRows)).toEqual([]);
		expect(renderCompatibility(rangeRows)).toContain(
			"Node `>=22.0.0 \\|\\| >=24.0.0`",
		);
	});

	it("keeps published stable facts separate from the current prerelease worktree", () => {
		const stable = rows.find((row) => row.channel === "stable");
		const current = rows.find((row) => row.current === "true");
		expect(stable.uwebsockets).toBe(nativeSpec("v20.67.0"));
		expect(current.uwebsockets).toBe(
			pkg.optionalDependencies["uWebSockets.js"],
		);
		expect(validateCompatibility(rows, pkg)).toEqual([]);

		const copiedCurrentPin = rows.map((row) =>
			row.channel === "stable"
				? {
						...row,
						uwebsockets: pkg.optionalDependencies["uWebSockets.js"],
					}
				: row,
		);
		expect(validateCompatibility(copiedCurrentPin, pkg)).toContain(
			"stable: published baseline facts disagree with the pinned registry identity",
		);

		const unpinnedIdentity = rows.map((row) =>
			row.channel === "stable"
				? {
						...row,
						adapter_version: "0.5.9",
						provenance: "npm:svelte-adapter-uws@0.5.9",
					}
				: row,
		);
		expect(validateCompatibility(unpinnedIdentity, pkg)).toContain(
			"stable: published baseline provenance is not pinned",
		);

		const falseEcosystemClaims = rows.map((row) =>
			row.channel === "stable"
				? { ...row, realtime: "99.99.x", extensions: "88.88.x" }
				: row,
		);
		expect(validateCompatibility(falseEcosystemClaims, pkg)).toContain(
			"stable: published baseline facts disagree with the pinned registry identity",
		);
	});

	it("rejects semver-valid line breaks before they can split the Markdown table", () => {
		const multiline = ">=22\n<25";
		const multilineRows = rows.map((row) =>
			row.current === "true" ? { ...row, node: multiline } : row,
		);
		const multilinePackage = {
			...pkg,
			engines: { ...pkg.engines, node: multiline },
		};
		expect(
			validateCompatibility(multilineRows, multilinePackage),
		).toContain("prerelease: node must be a single printable line");
		expect(() => renderCompatibility(multilineRows)).toThrow(
			"table cells must be single-line",
		);
	});

	it("rejects duplicate headers, duplicate blocks, and README prerequisite drift", () => {
		expect(() =>
			parseCompatibility(manifest.replace("schema_version", "owner")),
		).toThrow("header must be exactly");
		expect(() =>
			replaceCompatibilityBlock(
				readme + "\n" + renderCompatibility(rows),
				renderCompatibility(rows),
			),
		).toThrow("exactly one compatibility block");
		expect(
			validateReadmeCompatibility(
				readme.replace(
					"Node is `" + pkg.engines.node + "`",
					"Node is `>=99.0.0`",
				),
				rows,
			),
		).toContain(
			"README Node prerequisite disagrees with current compatibility row",
		);

		const competing =
			readme +
			"\n\n| Channel | svelte-adapter-uws | svelte-realtime | svelte-adapter-uws-extensions |\n" +
			"|---|---|---|---|\n| stable | 0.4.x | 0.4.x | 0.4.x |\n";
		expect(validateReadmeCompatibility(competing, rows)).toContain(
			"README contains a competing compatibility presentation outside the generated block",
		);
		expect(() =>
			replaceCompatibilityBlock(competing, renderCompatibility(rows)),
		).toThrow("competing compatibility presentation");

		const competingProse =
			readme +
			"\n\nsvelte-adapter-uws 0.4.x works with svelte-realtime 0.4.x.\n";
		expect(validateReadmeCompatibility(competingProse, rows)).toContain(
			"README contains a competing compatibility presentation outside the generated block",
		);

		for (const visibleClaim of [
			"svelte\\-adapter\\-uws 0.4.x works with svelte\\-realtime 0.4.x.",
			"svelte-**adapter**-uws 0.4.x works with svelte-__realtime__ 0.4.x.",
			"svelte&#45;adapter&#45;uws 0.4.x works with svelte&#45;realtime 0.4.x.",
			"<span>svelte-adapter-uws</span> 0.4.x works with <em>svelte-realtime</em> 0.4.x.",
		]) {
			expect(
				validateReadmeCompatibility(
					readme + "\n\n" + visibleClaim + "\n",
					rows,
				),
			).toContain(
				"README contains a competing compatibility presentation outside the generated block",
			);
		}

		const onePackage =
			readme +
			"\n\nsvelte-adapter-uws-extensions 0.5.x has its own plugin guide.\n";
		expect(validateReadmeCompatibility(onePackage, rows)).toEqual([]);

		const fencedExample =
			readme +
			"\n\n```text\n" +
			"| Channel | svelte-adapter-uws | svelte-realtime |\n|---|---|---|\n| stable | 0.4.x | 0.4.x |\n```\n";
		expect(validateReadmeCompatibility(fencedExample, rows)).toContain(
			"README contains a competing compatibility presentation outside the generated block",
		);
	}, 30_000);

	it("rejects install instructions outside the generated tag-and-pin tuples", () => {
		const fixtureReadme =
			"Node is `" +
			pkg.engines.node +
			"`\n\n" +
			renderCompatibility(rows) +
			"\n";
		const oldCurrentTreePair =
			fixtureReadme +
			"\n\n```bash\n" +
			"npm install svelte-adapter-uws\n" +
			"npm install " +
			nativeSpec("v20.69.0").replace(/^github:/, "") +
			"\n```\n";
		expect(validateReadmeCompatibility(oldCurrentTreePair, rows)).toContain(
			"README contains an install instruction outside the generated compatibility block",
		);

		const escapedAdapter =
			fixtureReadme + "\n\n`npm install svelte\\-adapter\\-uws@latest`\n";
		expect(validateReadmeCompatibility(escapedAdapter, rows)).toContain(
			"README contains an install instruction outside the generated compatibility block",
		);

		for (const command of [
			"npm i svelte-adapter-uws",
			"npm in svelte-adapter-uws",
			"pnpm add svelte-adapter-uws@next",
			"corepack pnpm --silent add svelte-adapter-uws@next",
			"yarn add svelte-adapter-uws@latest",
			"bun add " + nativeSpec("v20.69.0").replace(/^github:/, ""),
			"npm.cmd install alias@npm:svelte-adapter-uws@next",
			"call npm.cmd i svelte-adapter-uws@latest",
		]) {
			expect(
				validateReadmeCompatibility(
					fixtureReadme + "\n\n```sh\n" + command + "\n```\n",
					rows,
				),
			).toContain(
				"README contains an install instruction outside the generated compatibility block",
			);
		}

		for (const renderedCommand of [
			"    npm i svelte-adapter-uws",
			"Run npm i svelte-adapter-uws now.",
			"Run `npm i svelte-adapter-uws` now.",
			"```text\n<!--\nnpm i svelte-adapter-uws\n-->\n```",
			"```bat\nnpm install ^\nsvelte-adapter-uws\n```",
			"```sh\nnpm install \\\nsvelte-adapter-uws\n```",
			"```powershell\nnpm.cmd install `\nsvelte-adapter-uws\n```",
			"Run `cmd /d /s /c npm.cmd i svelte-adapter-uws@latest`.",
			"Run `pwsh -Command corepack pnpm --silent add svelte-adapter-uws@next`.",
			"`npm --prefix ./consumer install svelte-adapter-uws@next`",
			"`pnpm -C ./consumer add svelte-adapter-uws@next`",
			"`corepack yarn@4 --cwd ./consumer add svelte-adapter-uws@latest`",
		]) {
			expect(
				validateReadmeCompatibility(
					fixtureReadme + "\n\n" + renderedCommand + "\n",
					rows,
				),
			).toContain(
				"README contains an install instruction outside the generated compatibility block",
			);
		}

		const actualComment =
			fixtureReadme + "\n\n<!-- npm i svelte-adapter-uws@latest -->\n";
		expect(validateReadmeCompatibility(actualComment, rows)).toEqual([]);
		const multilineComment =
			fixtureReadme +
			"\n\n<!--\n    npm i svelte-adapter-uws@latest\n```sh\nnpm i svelte-adapter-uws@next\n```\n-->\n";
		expect(validateReadmeCompatibility(multilineComment, rows)).toEqual([]);
		expect(
			validateReadmeCompatibility(
				fixtureReadme +
					"\n\n```sh\nnpm i svelte\\-adapter\\-uws@latest\n```\n",
				rows,
			),
		).toContain(
			"README contains an install instruction outside the generated compatibility block",
		);
		expect(
			validateReadmeCompatibility(
				fixtureReadme +
					"\n\n`corepack yarn@4 global add svelte-adapter-uws@latest`\n",
				rows,
			),
		).toContain(
			"README contains an install instruction outside the generated compatibility block",
		);

		for (const nativeUrl of [
			"https://github.com/uNetworking/uWebSockets." +
				"js.git" +
				"#" +
				"v20.60.0",
			"git+https://github.com/uNetworking/uWebSockets." +
				"js.git" +
				"#" +
				"v20.60.0",
		]) {
			expect(
				validateReadmeCompatibility(
					fixtureReadme + "\n\n`npm install " + nativeUrl + "`\n",
					rows,
				),
			).toContain(
				"README contains an install instruction outside the generated compatibility block",
			);
		}
	});

	it("generates and validates every published migration compatibility claim", () => {
		const start = migration.indexOf(MIGRATION_COMPATIBILITY_START);
		const end =
			migration.indexOf(MIGRATION_COMPATIBILITY_END) +
			MIGRATION_COMPATIBILITY_END.length;
		expect(migration.slice(start, end)).toBe(
			renderMigrationCompatibility(rows),
		);
		expect(migration).toContain("archived [0.4.x to 0.5.x guide]");
		expect(migration).toContain("pin `svelte-adapter-uws@0.5.8`");
		expect(migration).toContain("active [0.5.x to 0.6.x guide]");
		expect(migration).toContain(
			"`@next` currently follows the `0.6.0-next` prerelease line",
		);
		expect(migration).not.toContain("To pin a specific 0.5 prerelease");

		const staleTuple =
			migration +
			"\n```bash\nnpm i svelte-adapter-uws\n" +
			"npm i " +
			nativeSpec("v20.69.0").replace(/^github:/, "") +
			"\n```\n";
		expect(
			validatePublishedCompatibilityDocuments(
				{ "MIGRATION.md": staleTuple },
				rows,
			),
		).toContain(
			"MIGRATION.md contains an install instruction outside an owned generated block",
		);
		expect(
			validatePublishedCompatibilityDocuments(
				{
					"MIGRATION.md":
						migration +
						"\nThe @next tag selects a 0.5 prerelease.\n",
				},
				rows,
			),
		).toContain(
			"MIGRATION.md contains a compatibility presentation outside an owned generated block",
		);
	});

	it("applies Markdown lexical ownership to every packaged document", () => {
		for (const source of [
			"    npm i svelte-adapter-uws\n",
			"Run npm i svelte-adapter-uws now.\n",
			"```text\n<!--\nnpm i svelte-adapter-uws\n-->\n```\n",
			"```bat\nnpm install ^\nsvelte-adapter-uws\n```\n",
			"`npm install https://github.com/uNetworking/uWebSockets." +
				"js.git" +
				"#" +
				"v20.60.0`\n",
			"> ```text\n> <!--\n> npm i svelte-adapter-uws\n> -->\n> ```\n",
			"- ```text\n  <!--\n  npm i svelte-adapter-uws\n  -->\n  ```\n",
			"`npm it svelte-adapter-uws`\n",
			"`npm isntall svelte-adapter-uws`\n",
		]) {
			expect(
				validatePublishedCompatibilityDocuments(
					{ "docs/public-guide.md": source },
					rows,
				),
			).toContain(
				"docs/public-guide.md contains an install instruction outside an owned generated block",
			);
		}
		expect(
			validatePublishedCompatibilityDocuments(
				{
					"docs/public-guide.md":
						"<!--\n    npm i svelte-adapter-uws\n-->\n",
				},
				rows,
			),
		).toEqual([]);
	});

	it("does not let malformed HTML comment openers hide rendered commands", () => {
		for (const invalidComment of ["<!-->", "<!--->"]) {
			const source = invalidComment + "\nnpm i svelte-adapter-uws\n";
			expect(markdown.render(source)).toContain(
				"<p>npm i svelte-adapter-uws</p>",
			);
			expect(
				validatePublishedCompatibilityDocuments(
					{ "docs/public-guide.md": source },
					rows,
				),
			).toContain(
				"docs/public-guide.md contains an install instruction outside an owned generated block",
			);
		}
		const realComment = "<!--\nnpm i svelte-adapter-uws\n-->\n";
		expect(markdown.render(realComment)).not.toContain("<p>");
		expect(
			validatePublishedCompatibilityDocuments(
				{ "docs/public-guide.md": realComment },
				rows,
			),
		).toEqual([]);
	});

	it("governs multiline CommonMark code spans and legal tilde fence info strings", () => {
		for (const delimiters of ["`", "``"]) {
			const source =
				"Run " +
				delimiters +
				"npm i\nsvelte-adapter-uws" +
				delimiters +
				" now.\n";
			const inlineCode = markdown
				.parse(source, {})
				.flatMap((token) => token.children || [])
				.find((token) => token.type === "code_inline");
			expect(inlineCode?.content).toBe("npm i svelte-adapter-uws");
			expect(
				validatePublishedCompatibilityDocuments(
					{ "docs/public-guide.md": source },
					rows,
				),
			).toContain(
				"docs/public-guide.md contains an install instruction outside an owned generated block",
			);
		}

		const tildeFence =
			"~~~text `literal info`\n<!--\nnpm i svelte-adapter-uws\n-->\n~~~\n";
		const fence = markdown
			.parse(tildeFence, {})
			.find((token) => token.type === "fence");
		expect(fence?.content).toContain("npm i svelte-adapter-uws");
		expect(
			validatePublishedCompatibilityDocuments(
				{ "docs/public-guide.md": tildeFence },
				rows,
			),
		).toContain(
			"docs/public-guide.md contains an install instruction outside an owned generated block",
		);

		const nonClosingTildeInfo =
			"~~~text\n~~~still-content\n<!--\nnpm i svelte-adapter-uws\n-->\n~~~\n";
		const longFence = markdown
			.parse(nonClosingTildeInfo, {})
			.find((token) => token.type === "fence");
		expect(longFence?.content).toContain("npm i svelte-adapter-uws");
		expect(
			validatePublishedCompatibilityDocuments(
				{
					"docs/public-guide.md": nonClosingTildeInfo,
				},
				rows,
			),
		).toContain(
			"docs/public-guide.md contains an install instruction outside an owned generated block",
		);
	});

	itNpm("normalizes npm camelCase install-test dispatch before matching packages", () => {
		const npmHelp = spawnSync(
			process.execPath,
			[npmRuntime.execpath, "installTest", "--help"],
			{
				encoding: "utf8",
				windowsHide: true,
			},
		);
		expect(npmHelp.error).toBeUndefined();
		expect(npmHelp.status).toBe(0);
		expect(npmHelp.stdout).toContain("npm install-test");
		for (const command of [
			"npm installTest svelte-adapter-uws",
			"npm InstallTest svelte-adapter-uws",
		]) {
			expect(
				validatePublishedCompatibilityDocuments(
					{
						"docs/public-guide.md": "`" + command + "`\n",
					},
					rows,
				),
			).toContain(
				"docs/public-guide.md contains an install instruction outside an owned generated block",
			);
		}
	}, 30_000);

	itNpm("follows npm unique abbreviations for install-test dispatch", () => {
		for (const action of ["install-t", "install-te", "install-tes"]) {
			const npmHelp = spawnSync(
				process.execPath,
				[npmRuntime.execpath, action, "--help"],
				{
					encoding: "utf8",
					windowsHide: true,
				},
			);
			expect(npmHelp.error).toBeUndefined();
			expect(npmHelp.status).toBe(0);
			expect(npmHelp.stdout).toContain("npm install-test");
			expect(
				validatePublishedCompatibilityDocuments(
					{
						"docs/public-guide.md":
							"`npm " + action + " svelte-adapter-uws`\n",
					},
					rows,
				),
			).toContain(
				"docs/public-guide.md contains an install instruction outside an owned generated block",
			);
		}
	}, 30_000);

	it("removes within-token shell continuations before command and native-spec recognition", () => {
		for (const continuation of ["\\", "^", "`"]) {
			for (const lineEnding of ["\n", "\r\n"]) {
				const nativeCommand =
					"npm install github:uNetworking/uWebSockets." +
					continuation +
					lineEnding +
					"js#" +
					"v20.60.0";
				const source =
					"```sh" +
					lineEnding +
					nativeCommand +
					lineEnding +
					"```" +
					lineEnding;
				expect(
					validatePublishedCompatibilityDocuments(
						{ "docs/public-guide.md": source },
						rows,
					),
				).toContain(
					"docs/public-guide.md contains an install instruction outside an owned generated block",
				);
				expect(scanTextWithOffsets(source, "v20.69.0")).toEqual([
					expect.objectContaining({ ref: "v20.60.0", stale: true }),
				]);

				const adapterCommand =
					"```sh" +
					lineEnding +
					"npm i svelte-adapter-" +
					continuation +
					lineEnding +
					"uws" +
					lineEnding +
					"```" +
					lineEnding;
				expect(
					validatePublishedCompatibilityDocuments(
						{
							"docs/public-guide.md": adapterCommand,
						},
						rows,
					),
				).toContain(
					"docs/public-guide.md contains an install instruction outside an owned generated block",
				);
			}
		}

		const nonContinuation =
			"github:uNetworking/uWebSockets.\\ \njs#" + "v20.60.0";
		expect(scanTextWithOffsets(nonContinuation, "v20.69.0")).toEqual([]);
	});

	it("requires generated compatibility blocks to render outside fenced code", () => {
		const fencedReadme = readme
			.replace(COMPATIBILITY_START, "```text\n" + COMPATIBILITY_START)
			.replace(COMPATIBILITY_END, COMPATIBILITY_END + "\n```");
		expect(validateReadmeCompatibility(fencedReadme, rows)).toContain(
			"README compatibility block must render in normal Markdown flow",
		);

		const fencedMigration = migration
			.replace(
				MIGRATION_COMPATIBILITY_START,
				"```text\n" + MIGRATION_COMPATIBILITY_START,
			)
			.replace(
				MIGRATION_COMPATIBILITY_END,
				MIGRATION_COMPATIBILITY_END + "\n```",
			);
		expect(validateMigrationCompatibility(fencedMigration)).toContain(
			"MIGRATION.md compatibility block must render in normal Markdown flow",
		);
	});

	it("requires generated compatibility blocks to render outside raw HTML pre blocks", () => {
		const renderedInPre =
			"<pre>\n" + renderCompatibility(rows) + "\n</pre>\n";
		const html = markdown.render(renderedInPre);
		expect(html).toContain("| Channel |");
		expect(html).not.toContain("<table>");

		const preReadme = readme
			.replace(
				COMPATIBILITY_START,
				'<PRE class="sample">\n' + COMPATIBILITY_START,
			)
			.replace(COMPATIBILITY_END, COMPATIBILITY_END + "\n</PRE>");
		expect(validateReadmeCompatibility(preReadme, rows)).toContain(
			"README compatibility block must render in normal Markdown flow",
		);

		const preMigration = migration
			.replace(
				MIGRATION_COMPATIBILITY_START,
				"<pre>\n" + MIGRATION_COMPATIBILITY_START,
			)
			.replace(
				MIGRATION_COMPATIBILITY_END,
				MIGRATION_COMPATIBILITY_END + "\n</pre>",
			);
		expect(validateMigrationCompatibility(preMigration)).toContain(
			"MIGRATION.md compatibility block must render in normal Markdown flow",
		);
	});

	it("requires generated compatibility blocks to be top-level rendered DOM content", () => {
		for (const [opening, closing] of [
			["<details>", "</details>"],
			["<dialog>", "</dialog>"],
			["<template>", "</template>"],
			["<div hidden>", "</div>"],
			["<section inert>", "</section>"],
			['<div aria-hidden="true">', "</div>"],
		]) {
			const nested = readme
				.replace(
					COMPATIBILITY_START,
					opening + "\n" + COMPATIBILITY_START,
				)
				.replace(COMPATIBILITY_END, COMPATIBILITY_END + "\n" + closing);
			const rendered = markdown.render(nested);
			expect(rendered).toContain(opening);
			expect(rendered).toContain(COMPATIBILITY_START);
			expect(validateReadmeCompatibility(nested, rows)).toContain(
				"README compatibility block must render in normal Markdown flow",
			);
		}

		const nestedMigration = migration
			.replace(
				MIGRATION_COMPATIBILITY_START,
				"<details>\n" + MIGRATION_COMPATIBILITY_START,
			)
			.replace(
				MIGRATION_COMPATIBILITY_END,
				MIGRATION_COMPATIBILITY_END + "\n</details>",
			);
		expect(validateMigrationCompatibility(nestedMigration)).toContain(
			"MIGRATION.md compatibility block must render in normal Markdown flow",
		);
	});

	it("owns compatibility tables structurally without rejecting unrelated protocol prose", () => {
		const aliasTable =
			readme +
			"\n\n```text\n| Package | Compatible line |\n|---|---|\n" +
			"| Svelte Adapter UWS | 0.4.x |\n| Svelte Realtime | 0.4.x |\n```\n";
		expect(validateReadmeCompatibility(aliasTable, rows)).toContain(
			"README contains a competing compatibility presentation outside the generated block",
		);

		const identityHeader =
			readme +
			"\n\n| svelte-adapter-uws | svelte-realtime |\n" +
			"|---|---|\n| 0.4.x | 0.4.x |\n";
		expect(validateReadmeCompatibility(identityHeader, rows)).toContain(
			"README contains a competing compatibility presentation outside the generated block",
		);

		const unrelatedReleaseTable =
			readme +
			"\n\n| Package | Release date |\n" +
			"|---|---|\n| Redis | 2026-07-31 |\n";
		expect(
			validateReadmeCompatibility(unrelatedReleaseTable, rows),
		).toEqual([]);
		expect(
			validatePublishedCompatibilityDocuments(
				{
					"docs/public-guide.md":
						"| svelte-adapter-uws | svelte-realtime |\n|---|---|\n| 0.4.x | 0.4.x |\n",
				},
				rows,
			),
		).toContain(
			"docs/public-guide.md contains a compatibility presentation outside an owned generated block",
		);
		expect(
			validatePublishedCompatibilityDocuments(
				{
					"docs/public-guide.md":
						"| Package | Release date |\n|---|---|\n| Redis | 2026-07-31 |\n",
				},
				rows,
			),
		).toEqual([]);
		expect(
			validatePublishedCompatibilityDocuments(
				{
					"docs/public-guide.md":
						"| Package | Version |\n|---|---|\n" +
						"| Svelte Adapter UWS | 0.4.x |\n| Svelte Realtime | 0.4.x |\n",
				},
				rows,
			),
		).toContain(
			"docs/public-guide.md contains a compatibility presentation outside an owned generated block",
		);
		expect(
			validatePublishedCompatibilityDocuments(
				{
					"docs/public-guide.md":
						"| `svelte-adapter-uws \\| adapter` | `svelte-realtime` |\n" +
						"|---|---|\n| 0.4.x | 0.4.x |\n",
				},
				rows,
			),
		).toContain(
			"docs/public-guide.md contains a compatibility presentation outside an owned generated block",
		);

		const entityPipeTable =
			"| svelte-adapter-uws &#124; adapter | svelte-realtime |\n" +
			"|---|---|\n| 0.4.x | 0.4.x |\n";
		expect(markdown.render(entityPipeTable)).toContain(
			"<th>svelte-adapter-uws | adapter</th>",
		);
		expect(
			validatePublishedCompatibilityDocuments(
				{ "docs/public-guide.md": entityPipeTable },
				rows,
			),
		).toContain(
			"docs/public-guide.md contains a compatibility presentation outside an owned generated block",
		);

		for (const blockquotedTable of [
			"> | Package | Version |\n> |---|---|\n" +
				"> | Svelte Adapter UWS | 0.4.x |\n> | Svelte Realtime | 0.4.x |\n",
			"> | svelte-adapter-uws | svelte-realtime |\n> |---|---|\n> | 0.4.x | 0.4.x |\n",
		]) {
			const rendered = markdown.render(blockquotedTable);
			expect(rendered).toContain("<blockquote>");
			expect(rendered).toContain("<table>");
			expect(
				validatePublishedCompatibilityDocuments(
					{ "docs/public-guide.md": blockquotedTable },
					rows,
				),
			).toContain(
				"docs/public-guide.md contains a compatibility presentation outside an owned generated block",
			);
		}

		const protocolControl =
			readme +
			"\n\nThe protocol v1.0.0 is implemented by svelte-adapter-uws and consumed by svelte-realtime.\n";
		expect(validateReadmeCompatibility(protocolControl, rows)).toEqual([]);
	});

	it("owns rendered list matrices and adjacent cross-sentence compatibility claims", () => {
		const listMatrix =
			"- `svelte-adapter-uws`: `0.5.8`\n" +
			"- `svelte-realtime`: `0.5.x`\n" +
			"- `svelte-adapter-uws-extensions`: `0.5.x`\n";
		expect(markdown.render(listMatrix)).toContain("<ul>");
		expect(
			validatePublishedCompatibilityDocuments(
				{ "docs/public-guide.md": listMatrix },
				rows,
			),
		).toContain(
			"docs/public-guide.md contains a compatibility presentation outside an owned generated block",
		);

		const definitionMatrix =
			"<dl>\n" +
			"<dt>svelte-adapter-uws</dt><dd>0.5.8</dd>\n" +
			"<dt>svelte-realtime</dt><dd>0.5.x</dd>\n" +
			"</dl>\n";
		expect(markdown.render(definitionMatrix)).toContain("<dl>");
		expect(
			validatePublishedCompatibilityDocuments(
				{ "docs/public-guide.md": definitionMatrix },
				rows,
			),
		).toContain(
			"docs/public-guide.md contains a compatibility presentation outside an owned generated block",
		);

		const crossSentence =
			"Svelte Adapter UWS is on 0.5.8. It works with Svelte Realtime on 0.5.x.\n";
		expect(
			validatePublishedCompatibilityDocuments(
				{ "docs/public-guide.md": crossSentence },
				rows,
			),
		).toContain(
			"docs/public-guide.md contains a compatibility presentation outside an owned generated block",
		);

		const nonVersionedList =
			"- svelte-adapter-uws: transport\n- svelte-realtime: consumer\n";
		expect(
			validatePublishedCompatibilityDocuments(
				{
					"docs/public-guide.md": nonVersionedList,
				},
				rows,
			),
		).toEqual([]);
	});

	it("owns generic rendered compatibility units and bounded adjacent paragraphs", () => {
		const presentations = [
			'<div class="compatibility"><p>svelte-adapter-uws 0.5.8</p>' +
				"<p>svelte-realtime 0.5.x</p></div>\n",
			"<menu><li>svelte-adapter-uws: 0.5.8</li>" +
				"<li>svelte-realtime: 0.5.x</li></menu>\n",
			"Svelte Adapter UWS is on 0.5.8.\n\nIt works with Svelte Realtime on 0.5.x.\n",
			"Svelte Adapter UWS is on 0.5.8.\n\n" +
				"These releases are compatible with the package below.\n\n" +
				"Svelte Realtime is on 0.5.x.\n",
			"Svelte Adapter UWS is on 0.5.8.\n\n" +
				"These releases are compatible with the package below.\n\n" +
				"This remains the supported pairing.\n\n" +
				"Svelte Realtime is on 0.5.x.\n",
			'<div class="compatibility">svelte-adapter-uws 0.5.8<br>' +
				"<span>svelte-realtime 0.5.x</span></div>\n",
			'<div class="compatibility"><span>svelte-adapter-uws 0.5.8</span> ' +
				"<span>svelte-realtime 0.5.x</span></div>\n",
			'<div class="compatibility-card"><span>svelte-adapter-uws 0.5.8</span> ' +
				"<span>svelte-realtime 0.5.x</span></div>\n",
			"<div><span>svelte-adapter-uws 0.5.8</span> " +
				"<span>svelte-realtime 0.5.x</span></div>\n",
			"<div>svelte-adapter-uws 0.5.8 <span>svelte-realtime 0.5.x</span></div>\n",
			"<div><span>svelte-adapter-uws 0.5.8</span> svelte-realtime 0.5.x</div>\n",
			"<div>svelte-adapter-uws 0.5.8 | svelte-realtime 0.5.x</div>\n",
			"<div>svelte-adapter-uws v0.5.8 | svelte-realtime v0.5.x</div>\n",
			'<div id="compatibility">svelte-adapter-uws 0.5.8 / svelte-realtime 0.5.x</div>\n',
			'<div style="display:none;display:block"><span>svelte-adapter-uws 0.5.8</span> ' +
				"<span>svelte-realtime 0.5.x</span></div>\n",
			'<div style="visibility:hidden;visibility:visible"><span>svelte-adapter-uws 0.5.8</span> ' +
				"<span>svelte-realtime 0.5.x</span></div>\n",
			'<div style="display:none!important;display:block!important"><span>svelte-adapter-uws 0.5.8</span> ' +
				"<span>svelte-realtime 0.5.x</span></div>\n",
		];
		for (const source of presentations) {
			expect(
				validatePublishedCompatibilityDocuments(
					{ "docs/public-guide.md": source },
					rows,
				),
			).toContain(
				"docs/public-guide.md contains a compatibility presentation outside an owned generated block",
			);
		}

		const separatedControl =
			"Svelte Adapter UWS implements protocol 1.0.0.\n\n" +
			"Svelte Realtime documents protocol 1.0.0.\n";
		expect(
			validatePublishedCompatibilityDocuments(
				{
					"docs/public-guide.md": separatedControl,
				},
				rows,
			),
		).toEqual([]);
		expect(
			validatePublishedCompatibilityDocuments(
				{
					"docs/public-guide.md":
						"<menu><li>svelte-adapter-uws: transport</li>" +
						"<li>svelte-realtime: consumer</li></menu>\n",
				},
				rows,
			),
		).toEqual([]);
	});

	it("owns short-label matrices and binds the migration guide tuple table to the manifest", () => {
		const guide = read(MIGRATION_GUIDE_RELATIVE_PATH);
		// The shipped guide restates manifest facts under short column labels
		// and stays green only because every version-bearing cell agrees with
		// the manifest.
		expect(
			validatePublishedCompatibilityDocuments(
				{ [MIGRATION_GUIDE_RELATIVE_PATH]: guide },
				rows,
			),
		).toEqual([]);

		// The same short-label shape anywhere else is an unowned claim.
		const shortLabelMatrix =
			"| Purpose | Adapter | Realtime | Extensions | Native addon |\n" +
			"|---|---|---|---|---|\n" +
			"| Rollback | `0.5.8` | `0.5.x` | `0.5.x` | `v20.67.0` |\n";
		expect(
			validatePublishedCompatibilityDocuments(
				{ "docs/public-guide.md": shortLabelMatrix },
				rows,
			),
		).toContain(
			"docs/public-guide.md contains a compatibility presentation outside an owned generated block",
		);
		expect(
			validateReadmeCompatibility(readme + "\n\n" + shortLabelMatrix, rows),
		).toContain(
			"README contains a competing compatibility presentation outside the generated block",
		);
		const twoLabelMatrix =
			"| Adapter | Native addon |\n|---|---|\n| `0.5.8` | `v20.67.0` |\n";
		expect(
			validatePublishedCompatibilityDocuments(
				{ "docs/public-guide.md": twoLabelMatrix },
				rows,
			),
		).toContain(
			"docs/public-guide.md contains a compatibility presentation outside an owned generated block",
		);

		// Versionless short-label tables and long-cell prose tables stay
		// unowned.
		for (const control of [
			"| Purpose | Adapter | Realtime |\n|---|---|---|\n| Roles | transport | consumer |\n",
			"| Failure | Owner |\n|---|---|\n| Unsupported binary | Adapter |\n" +
				"| Version 1.2.3 of the tool | Build 4.5.6 notes |\n",
		]) {
			expect(
				validatePublishedCompatibilityDocuments(
					{ "docs/public-guide.md": control },
					rows,
				),
				control,
			).toEqual([]);
		}

		// Guide-side drift against the manifest fails the checker.
		const driftedGuide = guide.replace("`v20.67.0`", "`v20.99.0`");
		expect(driftedGuide).not.toBe(guide);
		expect(
			validatePublishedCompatibilityDocuments(
				{ [MIGRATION_GUIDE_RELATIVE_PATH]: driftedGuide },
				rows,
			),
		).toContain(
			MIGRATION_GUIDE_RELATIVE_PATH +
				" tuple table Rollback baseline native addon cell disagrees with docs/compatibility.v1.csv (expected v20.67.0)",
		);

		// Manifest-side drift against the unchanged guide fails too.
		const driftedRows = rows.map((row) =>
			row.channel === "stable" ? { ...row, realtime: "0.4.x" } : row,
		);
		expect(
			validatePublishedCompatibilityDocuments(
				{ [MIGRATION_GUIDE_RELATIVE_PATH]: guide },
				driftedRows,
			),
		).toContain(
			MIGRATION_GUIDE_RELATIVE_PATH +
				" tuple table Rollback baseline realtime cell disagrees with docs/compatibility.v1.csv (expected 0.4.x)",
		);

		// A superstring or a second version in a bound cell is drift, not a
		// substring match.
		const superstring = guide.replace("exact `0.5.8`", "exact `0.5.80`");
		expect(
			validatePublishedCompatibilityDocuments(
				{ [MIGRATION_GUIDE_RELATIVE_PATH]: superstring },
				rows,
			),
		).toContain(
			MIGRATION_GUIDE_RELATIVE_PATH +
				" tuple table Rollback baseline adapter cell disagrees with docs/compatibility.v1.csv (expected 0.5.8)",
		);

		// Renaming a bound row away does not escape the binding.
		const unbound = guide.replace("| Rollback baseline", "| Renamed baseline");
		expect(
			validatePublishedCompatibilityDocuments(
				{ [MIGRATION_GUIDE_RELATIVE_PATH]: unbound },
				rows,
			),
		).toContain(
			MIGRATION_GUIDE_RELATIVE_PATH +
				" tuple table is missing its rollback baseline row",
		);

		// Excision is exact: the binding removes only the bound table, and the
		// remainder still flows through the generic ownership detectors.
		const bound = validateMigrationGuideTupleTable(guide, rows);
		expect(bound.errors).toEqual([]);
		expect(bound.remainder).not.toContain("| Rollback baseline");
		expect(bound.remainder).toContain("## Required source edits");
		const smuggled =
			guide +
			"\n\n| svelte-adapter-uws | svelte-realtime |\n|---|---|\n| 0.4.x | 0.4.x |\n";
		expect(
			validatePublishedCompatibilityDocuments(
				{ [MIGRATION_GUIDE_RELATIVE_PATH]: smuggled },
				rows,
			),
		).toContain(
			MIGRATION_GUIDE_RELATIVE_PATH +
				" contains a compatibility presentation outside an owned generated block",
		);
	});

	it("governs unqualified sibling ecosystem installs like adapter installs", () => {
		for (const command of [
			"npm install svelte-realtime",
			"npm i svelte-realtime",
			"pnpm add svelte-realtime@next",
			"yarn add svelte-adapter-uws-extensions",
			"npm install svelte-adapter-uws-extensions@0.6.0-next.91",
			"bun add svelte-realtime@latest",
		]) {
			expect(
				validatePublishedCompatibilityDocuments(
					{ "docs/public-guide.md": "```sh\n" + command + "\n```\n" },
					rows,
				),
				command,
			).toContain(
				"docs/public-guide.md contains an install instruction outside an owned generated block",
			);
		}
		for (const control of [
			"npm run install svelte-realtime\n",
			"npm install svelte-realtimex\n",
			"npm install some-other-package\n",
		]) {
			expect(
				validatePublishedCompatibilityDocuments(
					{ "docs/public-guide.md": control },
					rows,
				),
				control,
			).toEqual([]);
		}
	});

	it("leaves versionless, negative, script, and hidden controls unowned", () => {
		const controls = [
			"| svelte-adapter-uws | svelte-realtime |\n|---|---|\n| transport | consumer |\n",
			"npm does not install svelte-adapter-uws automatically.\n",
			"npm run install svelte-adapter-uws\n",
			"<div hidden><p>svelte-adapter-uws 0.5.8</p><p>svelte-realtime 0.5.x</p></div>\n",
			"<div hidden>svelte-adapter-uws v0.5.8 | svelte-realtime v0.5.x</div>\n",
			`npm --user-agent 'install guide' svelte-adapter-uws\n`,
			`n'p'x install svelte-adapter-uws\n`,
			`npm install svelte-adapter-'other'\n`,
			'<div style="display:none!important"><p>svelte-adapter-uws 0.5.8</p>' +
				"<p>svelte-realtime 0.5.x</p></div>\n",
			'<div style="visibility : hidden ! important ;"><p>svelte-adapter-uws 0.5.8</p>' +
				"<p>svelte-realtime 0.5.x</p></div>\n",
			'<div style="display:block;display:none"><span>svelte-adapter-uws 0.5.8</span> ' +
				"<span>svelte-realtime 0.5.x</span></div>\n",
			'<div style="display:none!important;display:block"><span>svelte-adapter-uws 0.5.8</span> ' +
				"<span>svelte-realtime 0.5.x</span></div>\n",
			'<div style="visibility:visible;visibility:hidden"><span>svelte-adapter-uws 0.5.8</span> ' +
				"<span>svelte-realtime 0.5.x</span></div>\n",
			"<div><span>svelte-adapter-uws transport</span> " +
				"<span>svelte-realtime consumer</span></div>\n",
			"<div>svelte-adapter-uws transport <span>svelte-realtime consumer</span></div>\n",
			'<div style="display:none!important">svelte-adapter-uws 0.5.8 ' +
				"<span>svelte-realtime 0.5.x</span></div>\n",
			"Svelte Adapter UWS is on 0.5.8.\n\nThese releases are compatible.\n\n" +
				"Background details remain unchanged.\n\nAnother neutral paragraph.\n\n" +
				"Svelte Realtime is on 0.5.x.\n",
		];
		for (const source of controls) {
			expect(
				validatePublishedCompatibilityDocuments(
					{ "docs/public-guide.md": source },
					rows,
				),
			).toEqual([]);
		}
	});

	it("resolves value-taking npm global options before the install subcommand", () => {
		for (const source of [
			"npm --loglevel silly install svelte-adapter-uws\n",
			"npm --registry https://registry.npmjs.org install svelte-adapter-uws\n",
			"npm --location global install svelte-adapter-uws\n",
			"npm --audit-level high install svelte-adapter-uws\n",
			"npm --auth-type web install svelte-adapter-uws\n",
			"npm --color always install svelte-adapter-uws\n",
			"npm --cpu x64 install svelte-adapter-uws\n",
			"npm --libc glibc install svelte-adapter-uws\n",
			"npm --os win32 install svelte-adapter-uws\n",
			"npm --preid beta install svelte-adapter-uws\n",
			"npm --yes true install svelte-adapter-uws\n",
			"npm --audit-level=high install svelte-adapter-uws\n",
			"npm --color install svelte-adapter-uws\n",
			"npm --yes install svelte-adapter-uws\n",
			"npm --audit-le high install svelte-adapter-uws\n",
			"npm -C ./consumer install svelte-adapter-uws\n",
			"npm -C./consumer install svelte-adapter-uws\n",
			"npm -w consumer install svelte-adapter-uws\n",
			"npm -g install svelte-adapter-uws\n",
			"npm -gC ./consumer install svelte-adapter-uws\n",
			"npm -gw consumer install svelte-adapter-uws\n",
			"npm -gC./consumer install svelte-adapter-uws\n",
			`npm --user-agent 'my agent' install svelte-adapter-uws\n`,
			"npm --user-agent " +
				String.fromCharCode(34) +
				"my agent" +
				String.fromCharCode(34) +
				" install svelte-adapter-uws\n",
			`npm --user-agent='my agent' install svelte-adapter-uws\n`,
			"npm --user-agent=" +
				String.fromCharCode(34) +
				"my agent" +
				String.fromCharCode(34) +
				" install svelte-adapter-uws\n",
			`npm --user-a 'my agent' install svelte-adapter-uws\n`,
			`npm -m 'my message' install svelte-adapter-uws\n`,
			"npm --user-agent my\\ agent install svelte-adapter-uws\n",
			`n'p'm install svelte-adapter-uws\n`,
			`npm install svelte-adapter-'uws'\n`,
			"npm '--audit-level' 'high' 'install' svelte-adapter-uws\n",
			"npm --yes 'true' install svelte-adapter-uws\n",
			"npm --color a'lways' install svelte-adapter-uws\n",
		]) {
			expect(
				validatePublishedCompatibilityDocuments(
					{ "docs/public-guide.md": source },
					rows,
				),
				source,
			).toContain(
				"docs/public-guide.md contains an install instruction outside an owned generated block",
			);
		}
		expect(
			validatePublishedCompatibilityDocuments(
				{
					"docs/public-guide.md":
						"npm --loglevel install svelte-adapter-uws\n",
				},
				rows,
			),
		).toEqual([]);
		expect(
			validatePublishedCompatibilityDocuments(
				{
					"docs/public-guide.md":
						"npm --loglevel=install svelte-adapter-uws\n",
				},
				rows,
			),
		).toEqual([]);
		expect(
			validatePublishedCompatibilityDocuments(
				{
					"docs/public-guide.md":
						"npm --audit-level install svelte-adapter-uws\n",
				},
				rows,
			),
		).toEqual([]);
		expect(
			validatePublishedCompatibilityDocuments(
				{
					"docs/public-guide.md":
						"npm -C install svelte-adapter-uws\n",
				},
				rows,
			),
		).toEqual([]);
		expect(
			validatePublishedCompatibilityDocuments(
				{
					"docs/public-guide.md":
						"npm -d true install svelte-adapter-uws\n",
				},
				rows,
			),
		).toEqual([]);
		expect(
			validatePublishedCompatibilityDocuments(
				{
					"docs/public-guide.md":
						"npm --audit-level 'install' svelte-adapter-uws\n",
				},
				rows,
			),
		).toEqual([]);
	});

	it("resolves npm Boolean global options without consuming the install subcommand", () => {
		for (const option of [
			"--fund",
			"--progress",
			"--workspaces",
			"--include-workspace-root",
			"--strict-peer-deps",
			"--legacy-peer-deps",
			"--no-fund",
			"--fund=false",
		]) {
			expect(
				validatePublishedCompatibilityDocuments(
					{
						"docs/public-guide.md":
							"npm " + option + " install svelte-adapter-uws\n",
					},
					rows,
				),
			).toContain(
				"docs/public-guide.md contains an install instruction outside an owned generated block",
			);
		}
	});

	itNpm("matches the installed npm option and shorthand arity for every snapshotted option", (ctx) => {
		// npm's definitions module is an unpublished internal path; a release
		// that moves it is an environment change, not a repository defect.
		let definitions, shorthands;
		try {
			({ definitions, shorthands } = createRequire(npmRuntime.execpath)(
				"@npmcli/config/lib/definitions/index.js",
			));
		} catch {
			ctx.skip();
			return;
		}
		// SUBSET parity: assert that every option the checker's snapshot
		// claims to know still classifies identically in the installed npm.
		// Options npm added after the snapshot are reported, not failed - a
		// routine npm upgrade must not turn this suite red with zero
		// repository change. The reported list is the maintenance signal for
		// refreshing the snapshot alongside the pinned npm version.
		const knownOptions = new Set(
			[...NPM_VALUE_OPTIONS, ...NPM_BOOLEAN_OPTIONS].map((option) =>
				option.replace(/^--/, ""),
			),
		);
		const knownShorthands = new Set([
			...NPM_VALUE_SHORTHANDS,
			...NPM_BOOLEAN_SHORTHANDS,
			...NPM_FIXED_VALUE_SHORTHANDS,
		]);
		const newerThanSnapshot = [];
		const flattenedTypes = (type) =>
			Array.isArray(type) ? type.flatMap(flattenedTypes) : [type];
		const optionUsesValue = (definition) =>
			flattenedTypes(definition.type).some(
				(type) =>
					type !== null && type !== undefined && type !== Boolean,
			);
		const exampleValue = (definition) => {
			const types = flattenedTypes(definition.type);
			return (
				types.find((type) => typeof type === "string") ||
				(types.includes(Number)
					? "1"
					: types.includes(Date)
						? "2026-08-02"
						: "value")
			);
		};
		for (const [name, definition] of Object.entries(definitions)) {
			if (!knownOptions.has(name)) {
				newerThanSnapshot.push("--" + name);
				continue;
			}
			const usesValue = optionUsesValue(definition);
			const value =
				name === "color"
					? "always "
					: usesValue
						? exampleValue(definition) + " "
						: "";
			const source =
				"npm --" + name + " " + value + "install svelte-adapter-uws\n";
			expect(
				validatePublishedCompatibilityDocuments(
					{ "docs/public-guide.md": source },
					rows,
				),
				name,
			).toContain(
				"docs/public-guide.md contains an install instruction outside an owned generated block",
			);
		}
		for (const [name, expansion] of Object.entries(shorthands)) {
			if (!knownShorthands.has(name)) {
				newerThanSnapshot.push("-" + name);
				continue;
			}
			const target = expansion[0];
			const definition = definitions[target?.replace(/^--/, "")];
			const needsFollowingValue =
				expansion.length === 1 &&
				definition &&
				optionUsesValue(definition);
			const source =
				"npm -" +
				name +
				(needsFollowingValue ? " value" : "") +
				" install svelte-adapter-uws\n";
			expect(
				validatePublishedCompatibilityDocuments(
					{ "docs/public-guide.md": source },
					rows,
				),
				name,
			).toContain(
				"docs/public-guide.md contains an install instruction outside an owned generated block",
			);
		}
		if (newerThanSnapshot.length > 0) {
			console.warn(
				"the installed npm declares options newer than the checker's grammar snapshot: " +
					newerThanSnapshot.join(", ") +
					" - refresh NPM_VALUE_OPTIONS / NPM_BOOLEAN_OPTIONS / the shorthand sets in scripts/check-compatibility.js when moving the pinned npm version",
			);
		}
	});

	it("governs npm-normalized percent-encoded native Git identities and refs", () => {
		const encodedSpecs = [
			{
				spec:
					"git+https://github.com/uNetworking/uWebSockets%2E" +
					"js.git" +
					"#" +
					"v20.60.0",
				selector: "gitCommittish",
			},
			{
				spec:
					"git+ssh://git@github.com/uNetworking/uWebSockets%2e" +
					"js.git" +
					"#" +
					"v20.60.0",
				selector: "gitCommittish",
			},
			{
				spec:
					"git+https://github.com/uNetworking/uWebSockets." +
					"js.git" +
					"#" +
					[
						"%76",
						"%32",
						"%30",
						"%2E",
						"%36",
						"%30",
						"%2E",
						"%30",
					].join(""),
				selector: "gitCommittish",
			},
			{
				spec:
					"git+https://github.com/%75Networking/uWebSockets." +
					"js.git" +
					"#" +
					"v20.60.0",
				selector: "gitCommittish",
			},
			{
				spec:
					"git+ssh://git@github.com/%75Networking/uWebSockets." +
					"js.git" +
					"#" +
					"v20.60.0",
				selector: "gitCommittish",
			},
			{
				spec:
					"git+https://github.com/uNetworking/uWebSockets." +
					"js.git?x=1" +
					"#" +
					"v20.60.0",
				selector: "gitCommittish",
			},
			{
				spec:
					"github:uNetworking/uWebSockets." +
					"js#semver:" +
					"v20.60.0",
				selector: "gitRange",
			},
			{
				spec:
					"git+https://github.com/uNetworking/uWebSockets." +
					"js.git#semver:" +
					"v20.60.0",
				selector: "gitRange",
			},
			{
				spec:
					"git+ssh://git@github.com:uNetworking/uWebSockets." +
					"js.git" +
					"#" +
					"v20.60.0",
				selector: "gitCommittish",
			},
			{
				spec:
					"ssh://git@github.com:uNetworking/uWebSockets." +
					"js.git" +
					"#" +
					"v20.60.0",
				selector: "gitCommittish",
			},
			{
				spec:
					"git+ssh://git@github.com:uNetworking/uWebSockets." +
					"js.git#semver:" +
					"v20.60.0",
				selector: "gitRange",
			},
			{
				spec:
					"git+https://www.github.com/uNetworking/uWebSockets." +
					"js.git" +
					"#" +
					"v20.60.0",
				selector: "gitCommittish",
			},
			{
				spec:
					"git+ssh://git@github.com:uNetworking/uWebSockets." +
					"js.git?x=1" +
					"#" +
					"v20.60.0",
				selector: "gitCommittish",
			},
			{
				spec:
					"ssh://git@github.com:uNetworking/uWebSockets." +
					"js.git?x=1" +
					"#" +
					"v20.60.0",
				selector: "gitCommittish",
			},
			{
				spec:
					"git+ssh://git@www.github.com:uNetworking/uWebSockets." +
					"js.git?x=1#semver:" +
					"v20.60.0",
				selector: "gitRange",
			},
			{
				spec:
					"git+ssh://git@github.com:uNetworking/x/../uWebSockets." +
					"js.git?x=1" +
					"#" +
					"v20.60.0",
				selector: "gitCommittish",
			},
			{
				spec:
					"git@github.com:uNetworking/x/../uWebSockets." +
					"js.git?x=1" +
					"#" +
					"v20.60.0",
				selector: "gitCommittish",
			},
			{
				spec:
					"git+ssh://git@www.github.com/uNetworking/x/%2e%2e/uWebSockets." +
					"js.git?x=1" +
					"#" +
					"v20.60.0",
				selector: "gitCommittish",
			},
		];
		for (const { spec: encoded, selector } of encodedSpecs) {
			npmParity(encoded, (parsed) => {
				expect(parsed.type).toBe("git");
				expect(parsed.hosted.user.toLowerCase()).toBe("unetworking");
				expect(parsed.hosted.project.toLowerCase()).toBe(
					"uwebsockets.js",
				);
				expect(parsed[selector]).toBe("v20.60.0");
			});
			expect(scanTextWithOffsets(encoded, "v20.69.0")).toEqual([
				expect.objectContaining({ ref: "v20.60.0", stale: true }),
			]);
			expect(
				validatePublishedCompatibilityDocuments(
					{
						"docs/public-guide.md":
							"`npm install " + encoded + "`\n",
					},
					rows,
				),
			).toContain(
				"docs/public-guide.md contains an install instruction outside an owned generated block",
			);
		}
	});

	it("validates the complete quoted npm Git selector", () => {
		for (const quote of ['"', "'"]) {
			const spec =
				"github:uNetworking/uWebSockets." +
				"js#semver:" +
				["v20.69.0", " || ", "v20.60.0"].join("");
			npmParity(spec, (parsed) => {
				expect(parsed.gitRange).toBe("v20.69.0 || v20.60.0");
			});
			const source = "npm install " + quote + spec + quote + "\n";
			expect(scanTextWithOffsets(source, "v20.69.0")).toEqual([
				expect.objectContaining({
					ref: "v20.69.0 || v20.60.0",
					stale: true,
				}),
			]);
			expect(
				validatePublishedCompatibilityDocuments(
					{ "docs/public-guide.md": source },
					rows,
				),
			).toContain(
				"docs/public-guide.md contains an install instruction outside an owned generated block",
			);
		}
	});

	it("uses npm selector semantics and concatenates adjacent shell quotes", () => {
		const target = "github:uNetworking/uWebSockets." + "js#";
		for (const selector of [
			"path:foo&semver:v20.69.0",
			"path:foo&v20.69.0",
			"semver:v20.69.0&path:foo",
		]) {
			const spec = target + selector;
			npmParity(spec, (parsed) => {
				expect(parsed.gitCommittish).not.toBe("v20.69.0");
				expect(parsed.gitRange).not.toBe("v20.69.0");
			});
			expect(scanTextWithOffsets(spec, "v20.69.0")).toEqual([
				expect.objectContaining({ stale: true }),
			]);
		}

		const combined = target + "semver:v20.69.0::path:/foo";
		npmParity(combined, (parsed) => {
			expect(parsed.gitRange).toBe("v20.69.0");
		});
		expect(scanTextWithOffsets(combined, "v20.69.0")).toEqual([
			expect.objectContaining({ ref: "v20.69.0", stale: false }),
		]);

		const union = target + "semver:v20.69.0 || v20.60.0";
		npmParity(union, (parsed) => {
			expect(parsed.gitRange).toBe("v20.69.0 || v20.60.0");
		});
		const adjacent =
			"npm install '" + target + "semver:v20.69.0'' || v20.60.0'\n";
		expect(scanTextWithOffsets(adjacent, "v20.69.0")).toEqual([
			expect.objectContaining({
				ref: "v20.69.0 || v20.60.0",
				stale: true,
			}),
		]);
	});

	it("reports governed Git targets that resolve the moving default HEAD", () => {
		for (const unpinned of [
			"github:uNetworking/uWebSockets." + "js",
			"github:uNetworking/uWebSockets." + "js" + "#",
			"uNetworking/uWebSockets." + "js",
			"git+https://github.com/uNetworking/uWebSockets." + "js.git",
			"git+https://github.com/uNetworking/uWebSockets." + "js.git?x=1",
			"git://github.com/uNetworking/uWebSockets." + "js.git",
			"git+ssh://git@github.com:uNetworking/uWebSockets." + "js.git?x=1",
			"git@github.com:uNetworking/uWebSockets." + "js.git",
		]) {
			npmParity(unpinned, (parsed) => {
				expect(parsed.hosted.user.toLowerCase()).toBe("unetworking");
				expect(parsed.hosted.project.toLowerCase()).toBe(
					"uwebsockets.js",
				);
				expect(parsed.gitCommittish ?? null).toBeNull();
				expect(parsed.gitRange ?? null).toBeNull();
			});
			expect(scanTextWithOffsets(unpinned, "v20.69.0")).toEqual([
				expect.objectContaining({ ref: null, stale: true }),
			]);
		}
	});

	it("concatenates an unquoted Git prefix with its quoted selector suffix", () => {
		const target = "github:uNetworking/uWebSockets." + "js#semver:v20.69.0";
		for (const prefix of [
			"npm install ",
			"sudo npm install ",
			"$ npm install ",
			"env CI=1 npm install ",
			"CI=1 sudo npm install ",
			"env CI=1 sudo npm install ",
		]) {
			for (const quote of ['"', "'"]) {
				const source =
					prefix + target + quote + " || v20.60.0" + quote + "\n";
				npmParity(target + " || v20.60.0", (parsed) => {
					expect(parsed.gitRange).toBe("v20.69.0 || v20.60.0");
				});
				expect(scanTextWithOffsets(source, "v20.69.0")).toEqual([
					expect.objectContaining({
						ref: "v20.69.0 || v20.60.0",
						stale: true,
					}),
				]);
			}
		}
		const javascriptControl =
			'const target = "' + target + '" || "v20.60.0";\n';
		expect(scanTextWithOffsets(javascriptControl, "v20.69.0")).toEqual([
			expect.objectContaining({ ref: "v20.69.0", stale: false }),
		]);
		const embeddedStringControl =
			"expect(fix).toContain('npm install " + target + "');\n";
		expect(scanTextWithOffsets(embeddedStringControl, "v20.69.0")).toEqual([
			expect.objectContaining({ ref: "v20.69.0", stale: false }),
		]);
	});

	it("requires generated markers to own complete physical lines", () => {
		const suffixed = readme.replace(
			COMPATIBILITY_END,
			COMPATIBILITY_END +
				" Current workaround: " +
				nativeSpec("v20.67.0"),
		);
		expect(validateReadmeCompatibility(suffixed, rows)).toContain(
			"README compatibility markers must be ordered and occupy complete lines",
		);
		const span = authenticatedReadmeSpan(suffixed, rows);
		const stale = scanTextWithOffsets(suffixed, "v20.69.0")
			.filter((ref) => ref.ref === "v20.67.0")
			.at(-1);
		expect(span).not.toBeNull();
		expect(stale.start).toBeGreaterThanOrEqual(span.end);
	});

	it("requires canonical Markdown-safe npm semver ranges", () => {
		for (const invalid of [
			"`>=22.0.0`",
			">=22.0.0`",
			"not-a-range",
			" >=22.0.0",
		]) {
			const invalidRows = rows.map((row) =>
				row.current === "true" ? { ...row, node: invalid } : row,
			);
			const invalidPackage = {
				...pkg,
				engines: { ...pkg.engines, node: invalid },
			};
			expect(
				validateCompatibility(invalidRows, invalidPackage),
			).toContain(
				"prerelease: node must be a canonical single-line npm semver range",
			);
		}
		const backtickRows = rows.map((row) =>
			row.current === "true" ? { ...row, node: "`>=22.0.0`" } : row,
		);
		expect(() => renderCompatibility(backtickRows)).toThrow(
			"backtick-free",
		);
	});

	it("repairs only the generated README block", () => {
		const stale = readme.replace(
			"`@next` tag may currently",
			"`@stale` tag may currently",
		);
		const repaired = replaceCompatibilityBlock(
			stale,
			renderCompatibility(rows),
		);
		expect(repaired).toBe(readme);
	});

	it("ships the manifest and gates both normal checks and publication", () => {
		expect(pkg.files).toContain("docs");
		// The checker is publisher-only tooling: prepublishOnly runs in the
		// repository, where devDependencies exist. Shipping it forced its
		// markdown-it and semver imports into production dependencies, which
		// every consumer then downloaded for a gate only the publisher runs.
		expect(pkg.files).not.toContain("scripts/check-compatibility.js");
		for (const dependency of ["markdown-it", "semver"]) {
			expect(pkg.dependencies[dependency]).toBeUndefined();
			expect(pkg.devDependencies[dependency]).toBeTruthy();
		}
		// parse5 stays a production dependency: the runtime waiting-room
		// template sanitizer imports it.
		expect(pkg.dependencies.parse5).toBeTruthy();
		expect(validateLifecycleScripts(pkg)).toEqual([]);
		// Any repository script is a legal check step - the grammar rejects
		// short-circuit shapes, not script names.
		expect(
			validateLifecycleScripts({
				...pkg,
				scripts: {
					...pkg.scripts,
					check: pkg.scripts.check + " && node scripts/lint-docs.js",
				},
			}),
		).toEqual([]);
		// Node execution/preload flags can neuter a step (--eval exits before
		// the positional script runs), and dot segments could escape the
		// scripts directory; both must stay rejected.
		for (const neutered of [
			"node --eval=process.exit(0) scripts/check-types.js",
			"node --print=1 scripts/check-types.js",
			"node --require=./x.js scripts/check-types.js",
			"node --import=./x.mjs scripts/check-types.js",
			"node scripts/../evil.js",
			"node scripts/../../outside.js",
		]) {
			expect(
				validateLifecycleScripts({
					...pkg,
					scripts: {
						...pkg.scripts,
						check: pkg.scripts.check + " && " + neutered,
					},
				}),
				neutered,
			).toContain(
				"scripts.check may contain only direct repository check commands",
			);
		}
		expect(
			validateLifecycleScripts({
				...pkg,
				scripts: {
					...pkg.scripts,
					check: pkg.scripts.check.replace(
						"node scripts/check-compatibility.js",
						"echo node scripts/check-compatibility.js",
					),
				},
			}),
		).toContain(
			"scripts.check must start with the compatibility gate and execute it exactly once",
		);
		expect(
			validateLifecycleScripts({
				...pkg,
				scripts: {
					...pkg.scripts,
					check: "exit 0 && " + pkg.scripts.check,
				},
			}),
		).toContain(
			"scripts.check must start with the compatibility gate and execute it exactly once",
		);
		expect(
			validateLifecycleScripts({
				...pkg,
				scripts: {
					...pkg.scripts,
					check: 'node -e "process.exit(0)" && ' + pkg.scripts.check,
				},
			}),
		).toContain(
			"scripts.check must start with the compatibility gate and execute it exactly once",
		);
		for (const shortCircuit of [
			"exit 0",
			"exit /b 0",
			"true",
			'node -e "process.exit(0)"',
		]) {
			expect(
				validateLifecycleScripts({
					...pkg,
					scripts: {
						...pkg.scripts,
						check: pkg.scripts.check.replace(
							" && node scripts/generate-observability.js --check",
							" && " +
								shortCircuit +
								" && node scripts/generate-observability.js --check",
						),
					},
				}),
			).toContain(
				"scripts.check may contain only direct repository check commands",
			);
		}
		// prepublishOnly runs the chain once; the chain itself begins with the
		// compatibility gate, so requiring the gate twice ran it twice.
		expect(pkg.scripts.prepublishOnly).toBe("npm run check");
		expect(
			validateLifecycleScripts({
				...pkg,
				scripts: { ...pkg.scripts, prepublishOnly: "vitest run" },
			}),
		).toContain(
			"prepublishOnly must run the fail-closed check chain, which begins with the compatibility gate",
		);
	});

	it("binds the moving prerelease row to the lockstep sibling series", () => {
		expect(validateCompatibility(rows, pkg)).toEqual([]);
		for (const field of ["realtime", "extensions"]) {
			const drifted = rows.map((row) =>
				row.current === "true" ? { ...row, [field]: "9.9.x" } : row,
			);
			expect(validateCompatibility(drifted, pkg)).toContain(
				"prerelease: " +
					field +
					" series 9.9.x does not match the lockstep adapter series 0.6.0-next",
			);
		}
	});

	it("escalates the lockstep bound to real sibling checkouts when present", () => {
		const siblings = {
			"svelte-realtime": { name: "svelte-realtime", version: "0.6.0-next.88" },
			"svelte-adapter-uws-extensions": {
				name: "svelte-adapter-uws-extensions",
				version: "0.6.0-next.42",
			},
		};
		expect(
			validateWorkspaceSiblings(rows, (name) => siblings[name] ?? null),
		).toEqual([]);
		// A checkout without siblings (CI, a consumer) is a different machine,
		// not drift.
		expect(validateWorkspaceSiblings(rows, () => null)).toEqual([]);
		// A sibling outside the declared series is exactly the divergence the
		// manifest exists to stop.
		expect(
			validateWorkspaceSiblings(rows, (name) =>
				name === "svelte-realtime"
					? { name, version: "0.7.0" }
					: (siblings[name] ?? null),
			),
		).toContain(
			"prerelease: workspace sibling svelte-realtime@0.7.0 is outside the declared realtime series 0.6.0-next",
		);
		// A directory that is not the named package must be reported, not
		// silently treated as authoritative.
		expect(
			validateWorkspaceSiblings(rows, (name) =>
				name === "svelte-realtime"
					? { name: "something-else", version: "1.0.0" }
					: (siblings[name] ?? null),
			),
		).toContain(
			"prerelease: workspace sibling directory svelte-realtime does not contain that package",
		);
		// A present-but-corrupt sibling package.json is a distinguishable
		// anomaly and must not be mapped onto absence.
		expect(
			validateWorkspaceSiblings(rows, (name) =>
				name === "svelte-realtime"
					? { unreadable: true }
					: (siblings[name] ?? null),
			),
		).toContain(
			"prerelease: workspace sibling svelte-realtime package.json is unreadable",
		);
	});

	it("runs from a package-shaped directory without Git", () => {
		const temp = mkdtempSync(join(tmpdir(), "adapter-compat-"));
		try {
			cpSync(
				fileURLToPath(new URL("../docs", import.meta.url)),
				join(temp, "docs"),
				{ recursive: true },
			);
			mkdirSync(join(temp, "scripts"));
			copyCheckerDependencies(temp);
			for (const relative of [
				"package.json",
				"README.md",
				"MIGRATION.md",
				"scripts/check-compatibility.js",
			]) {
				copyFileSync(
					fileURLToPath(new URL("../" + relative, import.meta.url)),
					join(temp, relative),
				);
			}
			expect(
				execFileSync(
					process.execPath,
					["scripts/check-compatibility.js"],
					{
						cwd: temp,
						encoding: "utf8",
						windowsHide: true,
					},
				),
			).toContain("3 channels agree");

			// A REPOSITORY checkout missing a fact source must refuse rather
			// than silently skip the train binding - a deleted workflow would
			// otherwise disarm the pin check forever. A worktree's .git is a
			// FILE, and it must count as repository-shaped too.
			writeFileSync(join(temp, ".git"), "gitdir: elsewhere\n");
			const repoShaped = spawnSync(
				process.execPath,
				["scripts/check-compatibility.js"],
				{
					cwd: temp,
					encoding: "utf8",
					windowsHide: true,
				},
			);
			expect(repoShaped.status).not.toBe(0);
			expect(repoShaped.stderr + repoShaped.stdout).toContain(
				"compatibility train fact source is missing from the repository checkout",
			);
			rmSync(join(temp, ".git"));

			const nested = readme
				.replace(
					COMPATIBILITY_START,
					"<details>\n" + COMPATIBILITY_START,
				)
				.replace(COMPATIBILITY_END, COMPATIBILITY_END + "\n</details>");
			writeFileSync(join(temp, "README.md"), nested);
			const nestedResult = spawnSync(
				process.execPath,
				["scripts/check-compatibility.js"],
				{
					cwd: temp,
					encoding: "utf8",
					windowsHide: true,
				},
			);
			expect(nestedResult.status).not.toBe(0);
			expect(nestedResult.stderr + nestedResult.stdout).toContain(
				"README compatibility block must render in normal Markdown flow",
			);

			writeFileSync(
				join(temp, "README.md"),
				readme + "\n\n<!-->\nnpm i svelte-adapter-uws\n",
			);
			const malformedCommentResult = spawnSync(
				process.execPath,
				["scripts/check-compatibility.js"],
				{
					cwd: temp,
					encoding: "utf8",
					windowsHide: true,
				},
			);
			expect(malformedCommentResult.status).not.toBe(0);
			expect(
				malformedCommentResult.stderr + malformedCommentResult.stdout,
			).toContain(
				"README contains an install instruction outside the generated compatibility block",
			);

			writeFileSync(join(temp, "README.md"), readme);
			writeFileSync(
				join(temp, "docs", "container-presentations.md"),
				[
					'<div class="compatibility"><p>svelte-adapter-uws 0.5.8</p><p>svelte-realtime 0.5.x</p></div>',
					"<menu><li>svelte-adapter-uws: 0.5.8</li><li>svelte-realtime: 0.5.x</li></menu>",
					"Svelte Adapter UWS is on 0.5.8.\n\nIt works with Svelte Realtime on 0.5.x.",
				].join("\n\n"),
			);
			const presentationResult = spawnSync(
				process.execPath,
				["scripts/check-compatibility.js"],
				{
					cwd: temp,
					encoding: "utf8",
					windowsHide: true,
				},
			);
			expect(presentationResult.status).not.toBe(0);
			expect(
				presentationResult.stderr + presentationResult.stdout,
			).toContain(
				"docs/container-presentations.md contains a compatibility presentation outside an owned generated block",
			);

			rmSync(join(temp, "docs", "container-presentations.md"));
			writeFileSync(
				join(temp, "docs", "bridged-prose-presentations.md"),
				[
					"Svelte Adapter UWS is on 0.5.8.\n\nThese releases are compatible with the package below.\n\nSvelte Realtime is on 0.5.x.",
					'<div class="compatibility">svelte-adapter-uws 0.5.8<br><span>svelte-realtime 0.5.x</span></div>',
				].join("\n\n"),
			);
			const bridgedProseResult = spawnSync(
				process.execPath,
				["scripts/check-compatibility.js"],
				{
					cwd: temp,
					encoding: "utf8",
					windowsHide: true,
				},
			);
			expect(bridgedProseResult.status).not.toBe(0);
			expect(
				bridgedProseResult.stderr +
					bridgedProseResult.stdout,
			).toContain(
				"docs/bridged-prose-presentations.md contains a compatibility presentation outside an owned generated block",
			);

			rmSync(join(temp, "docs", "bridged-prose-presentations.md"));
			writeFileSync(
				join(temp, "docs", "hidden-presentations.md"),
				'<div style="display:none!important"><p>svelte-adapter-uws 0.5.8</p>' +
					"<p>svelte-realtime 0.5.x</p></div>\n",
			);
			expect(
				execFileSync(
					process.execPath,
					["scripts/check-compatibility.js"],
					{
						cwd: temp,
						encoding: "utf8",
						windowsHide: true,
					},
				),
			).toContain("3 channels agree");

			writeFileSync(
				join(temp, "docs", "hidden-presentations.md"),
				[
					"Svelte Adapter UWS is on 0.5.8.\n\nThese releases are compatible with the package below.\n\nA neutral bridge remains.\n\nSvelte Realtime is on 0.5.x.",
					'<div class="compatibility"><span>svelte-adapter-uws 0.5.8</span> <span>svelte-realtime 0.5.x</span></div>',
					"npm --loglevel silly install svelte-adapter-uws",
				].join("\n\n"),
			);
			const hiddenVisibleResult = spawnSync(
				process.execPath,
				["scripts/check-compatibility.js"],
				{
					cwd: temp,
					encoding: "utf8",
					windowsHide: true,
				},
			);
			expect(hiddenVisibleResult.status).not.toBe(0);
			expect(hiddenVisibleResult.stderr + hiddenVisibleResult.stdout).toContain(
				"docs/hidden-presentations.md contains a compatibility presentation outside an owned generated block",
			);

			rmSync(join(temp, "docs", "hidden-presentations.md"));
			const packagedMutant = join(temp, "docs", "mutant-presentations.md");
			for (const source of [
				...[
					"--fund",
					"--progress",
					"--workspaces",
					"--include-workspace-root",
					"--strict-peer-deps",
					"--legacy-peer-deps",
				].map(
					(option) =>
						"npm " + option + " install svelte-adapter-uws\n",
				),
				'<div class="compatibility-card"><span>svelte-adapter-uws 0.5.8</span> ' +
					"<span>svelte-realtime 0.5.x</span></div>\n",
				"<div><span>svelte-adapter-uws 0.5.8</span> " +
					"<span>svelte-realtime 0.5.x</span></div>\n",
				'<div id="compatibility">svelte-adapter-uws 0.5.8 / svelte-realtime 0.5.x</div>\n',
				'<div style="display:none;display:block"><span>svelte-adapter-uws 0.5.8</span> ' +
					"<span>svelte-realtime 0.5.x</span></div>\n",
				'<div style="visibility:hidden!important;visibility:visible!important">' +
					"<span>svelte-adapter-uws 0.5.8</span> <span>svelte-realtime 0.5.x</span></div>\n",
				...[
					"--audit-level high",
					"--auth-type web",
					"--color always",
					"--cpu x64",
					"--libc glibc",
					"--os win32",
					"--preid beta",
					"--yes true",
				].map(
					(option) =>
						"npm " + option + " install svelte-adapter-uws\n",
				),
				"<div>svelte-adapter-uws 0.5.8 <span>svelte-realtime 0.5.x</span></div>\n",
				"<div><span>svelte-adapter-uws 0.5.8</span> svelte-realtime 0.5.x</div>\n",
				"<div>svelte-adapter-uws 0.5.8 | svelte-realtime 0.5.x</div>\n",
				"<div>svelte-adapter-uws v0.5.8 | svelte-realtime v0.5.x</div>\n",
				`npm --user-agent 'my agent' install svelte-adapter-uws\n`,
				`npm --user-agent='my agent' install svelte-adapter-uws\n`,
				`npm --user-a 'my agent' install svelte-adapter-uws\n`,
				`npm -m 'my message' install svelte-adapter-uws\n`,
				"npm --user-agent my\\ agent install svelte-adapter-uws\n",
				`n'p'm install svelte-adapter-uws\n`,
				`npm install svelte-adapter-'uws'\n`,
			]) {
				writeFileSync(packagedMutant, source);
				const result = spawnSync(
					process.execPath,
					["scripts/check-compatibility.js"],
					{
						cwd: temp,
						encoding: "utf8",
						windowsHide: true,
					},
				);
				expect(result.status).not.toBe(0);
				expect(result.stderr + result.stdout).toContain(
					"docs/mutant-presentations.md contains",
				);
			}

			for (const source of [
				'<div style="display:block;display:none"><span>svelte-adapter-uws 0.5.8</span> ' +
					"<span>svelte-realtime 0.5.x</span></div>\n",
				'<div style="display:none!important;display:block"><span>svelte-adapter-uws 0.5.8</span> ' +
					"<span>svelte-realtime 0.5.x</span></div>\n",
				'<div style="display:none!important">svelte-adapter-uws 0.5.8 ' +
					"<span>svelte-realtime 0.5.x</span></div>\n",
				"<div>svelte-adapter-uws transport <span>svelte-realtime consumer</span></div>\n",
				"npm --loglevel install svelte-adapter-uws\n",
				"npm --loglevel=install svelte-adapter-uws\n",
				"npm --audit-level install svelte-adapter-uws\n",
				"npm -C install svelte-adapter-uws\n",
			]) {
				writeFileSync(packagedMutant, source);
				expect(
					execFileSync(
						process.execPath,
						["scripts/check-compatibility.js"],
						{
							cwd: temp,
							encoding: "utf8",
							windowsHide: true,
						},
					),
				).toContain("3 channels agree");
			}
			rmSync(packagedMutant);
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
		// This drives the checker CLI end to end about twenty times, and each
		// spawn cold-imports markdown-it and parse5; on Windows that sits near
		// the default budget, so the ceiling is explicit.
	}, 120_000);

	itNpm("fails a drifted package through the executable publication lifecycle", () => {
		const temp = mkdtempSync(join(tmpdir(), "adapter-compat-lifecycle-"));
		try {
			cpSync(
				fileURLToPath(new URL("../docs", import.meta.url)),
				join(temp, "docs"),
				{ recursive: true },
			);
			mkdirSync(join(temp, "scripts"));
			copyCheckerDependencies(temp);
			for (const relative of [
				"README.md",
				"MIGRATION.md",
				"scripts/check-compatibility.js",
			]) {
				copyFileSync(
					fileURLToPath(new URL("../" + relative, import.meta.url)),
					join(temp, relative),
				);
			}
			const isolatedCheck = pkg.scripts.check
				.split(/\s*&&\s*/)
				.map((command) =>
					command === "node scripts/check-compatibility.js"
						? command
						: 'node -e ""',
				)
				.join(" && ");
			const drifted = {
				...pkg,
				engines: { ...pkg.engines, node: ">=99.0.0" },
				scripts: { ...pkg.scripts, check: isolatedCheck },
			};
			writeFileSync(
				join(temp, "package.json"),
				JSON.stringify(drifted, null, "\t") + "\n",
			);
			const npmCli = npmRuntime.execpath;
			const result = spawnSync(
				process.execPath,
				[npmCli, "run", "prepublishOnly"],
				{
					cwd: temp,
					encoding: "utf8",
					windowsHide: true,
				},
			);
			expect(result.error).toBeUndefined();
			expect(result.status).not.toBe(0);
			expect(result.stderr + result.stdout).toContain(
				"Node floor disagrees with package.json",
			);
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
		// Explicit, because this one recursively copies the whole docs tree and
		// then spawns a child process: it was measured at 5.8s against the
		// default 5s and so failed on timing rather than on anything it asserts.
		// A gate that reddens at random teaches people to re-run it.
	}, 60_000);

	describe("the generated install line names the addon the row's adapter declares", () => {
		// The generator used to rewrite every native spec into an archive URL.
		// For the prerelease row that is a no-op, because the manifest already
		// records the archive form - but the stable row records a git spec,
		// which is what that published version declares. npm does not dedupe
		// two DIFFERENT non-registry specs for the same name, so the rewritten
		// line acquired the addon twice and the adapter resolved the nested
		// copy, not the pinned one. Under a caption reading "do not mix rows".
		const manifest = parseCompatibility(read("docs/compatibility.v1.csv"));
		const readme = read("README.md");
		const block = readme.slice(
			readme.indexOf(COMPATIBILITY_START),
			readme.indexOf(COMPATIBILITY_END),
		);

		it("echoes each row's spec verbatim rather than rewriting its form", () => {
			const rows = manifest.filter((row) => row.uwebsockets);
			expect(rows.length).toBeGreaterThanOrEqual(2);
			for (const row of rows) {
				expect(uwsDeclaredInstallSpec(row.uwebsockets)).toBe(row.uwebsockets);
				expect(
					block.includes(row.uwebsockets),
					`the ${row.channel} install line does not name ${row.uwebsockets}`,
				).toBe(true);
			}
		});

		it("covers both spec FORMS, so a rewrite of either is caught", () => {
			// If every row ever used the same form, a rewrite to that form would
			// be invisible here. The manifest is only a real test of this while
			// it carries one git spec and one archive URL.
			const forms = new Set(
				manifest
					.filter((row) => row.uwebsockets)
					.map((row) => (row.uwebsockets.startsWith("github:") ? "git" : "archive")),
			);
			expect([...forms].sort()).toEqual(["archive", "git"]);
		});

		it("still refuses a row that does not name an exact tagged source", () => {
			// Split across the slash so the raw source never contains a bare
			// owner/repo token: the pin gate scans tracked files for exactly
			// that shape and would report these fixtures as stale install specs.
			const untagged = "github:uNetworking" + "/" + "uWebSockets.js";
			expect(() => uwsDeclaredInstallSpec("uWebSockets.js@^" + "20")).toThrow(
				/exact tagged GitHub source/,
			);
			expect(() => uwsDeclaredInstallSpec(untagged)).toThrow(
				/exact tagged GitHub source/,
			);
			expect(() => uwsDeclaredInstallSpec(untagged + "#main")).toThrow(
				/exact tagged GitHub source/,
			);
		});
	});

	describe("the migration baseline exception", () => {
		// Refs assembled from pieces so this file never carries a stale spec
		// the pin scanner would flag (the same discipline as the fixtures
		// above). "v20." + "67.0" is the era ref, "v20." + "99.0" is a tag
		// history never published.
		const eraRef = "v20." + "67.0";
		const bogusRef = "v20." + "99.0";
		const baselinePath = "test/fixtures/migration-0.5/baseline.lock";
		const refs = new Map([["0.5.8", eraRef]]);
		const text = "format=adapter-migration-baseline-v1\nadapter.version=0.5.8\n";

		it("allows only the baseline file, its own recorded era, and that era's exact ref", () => {
			expect(migrationBaselineException(baselinePath, text, eraRef, refs)).toBe(true);
			expect(migrationBaselineException("README.md", text, eraRef, refs)).toBe(false);
			expect(migrationBaselineException(baselinePath, text, bogusRef, refs)).toBe(false);
			expect(
				migrationBaselineException(baselinePath, "format=adapter-migration-baseline-v1\n", eraRef, refs),
			).toBe(false);
			expect(
				migrationBaselineException(baselinePath, text.replace("0.5.8", "0.4.0"), eraRef, refs),
			).toBe(false);
		});

		it("reads the recorded era through a CRLF working copy unchanged", () => {
			// A checkout can flip the baseline to CRLF while the index stays LF;
			// the version key must not smuggle the carriage return into the
			// lookup and fail with a misleading stale-spec verdict.
			expect(
				migrationBaselineException(baselinePath, text.replaceAll("\n", "\r\n"), eraRef, refs),
			).toBe(true);
		});
	});
});
