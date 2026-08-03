#!/usr/bin/env node
/**
 * Validate the packaged ecosystem compatibility manifest and the README block
 * generated from it. The same check runs before tests and before publication.
 *
 * Pass --write to replace only the bounded README compatibility block.
 */
import {
	existsSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import { parseFragment } from "parse5";
import { validRange } from "semver";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "docs", "compatibility.v1.csv");
const packagePath = join(root, "package.json");
const readmePath = join(root, "README.md");
const migrationPath = join(root, "MIGRATION.md");

export const COMPATIBILITY_START = "<!-- compatibility:start -->";
export const COMPATIBILITY_END = "<!-- compatibility:end -->";
export const MIGRATION_COMPATIBILITY_START =
	"<!-- compatibility-migration:start -->";
export const MIGRATION_COMPATIBILITY_END =
	"<!-- compatibility-migration:end -->";
const UWS_GIT_SPEC_RE =
	/^github:uNetworking\/uWebSockets\.js#(v\d+\.\d+\.\d+)$/;
const UWS_ARCHIVE_SPEC_RE =
	/^https:\/\/github\.com\/uNetworking\/uWebSockets\.js\/archive\/refs\/tags\/(v\d+\.\d+\.\d+)\.tar\.gz$/;
const EXPECTED_HEADERS = [
	"schema_version",
	"owner",
	"current",
	"channel",
	"dist_tag",
	"adapter_version",
	"provenance",
	"adapter",
	"realtime",
	"extensions",
	"node",
	"uwebsockets",
];
const REQUIRED_CHANNELS = new Map([
	["legacy", ""],
	["stable", "latest"],
	["prerelease", "next"],
]);
const PUBLISHED_BASELINE_DIGESTS = new Map([
	// Verified against npm metadata for immutable svelte-adapter-uws@0.5.8.
	[
		"npm:svelte-adapter-uws@0.5.8",
		"b1a9adc641c46d3227611e8a28f50b9275b78f170f94cc47a1da1f1a2e1581c4",
	],
]);
const COMPATIBILITY_GATE_COMMAND = "node scripts/check-compatibility.js";
// The check chain already begins with the compatibility gate, so publication
// runs `npm run check` once rather than executing the gate twice.
const PREPUBLISH_GATE_COMMAND = "npm run check";
// Any repository script qualifies as a check step. The shape this exists to
// reject is a command that can short-circuit the fail-closed chain into
// success without doing work (`exit 0`, `true`, `echo ...`, or a node
// execution/preload flag like `--eval=...` that exits before the positional
// script runs) - it does not police what the scripts are named or what they
// check. Node flags are an allowlist because most value-bearing flags can
// replace or preempt the script; extend the alternation when a check step
// genuinely needs another one. Path segments cannot be dot-only, so
// `scripts/..` cannot escape the repository scripts directory.
const CHECK_SCRIPT_COMMAND =
	/^node (?:(?:--no-warnings|--experimental-vm-modules) )*scripts\/(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\/)*[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.(?:js|mjs|cjs)(?: --?[a-z][a-z0-9-]*(?:=\S+)?)*$/;
const markdown = new MarkdownIt({ html: true });
const HTML_TEXT_BREAKS = new Set([
	"address",
	"article",
	"aside",
	"blockquote",
	"br",
	"caption",
	"dd",
	"details",
	"dialog",
	"div",
	"dl",
	"dt",
	"fieldset",
	"figcaption",
	"figure",
	"footer",
	"form",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"hr",
	"li",
	"main",
	"menu",
	"nav",
	"ol",
	"p",
	"pre",
	"section",
	"summary",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"tr",
	"ul",
]);
// Keep the npm 11 option grammar inside the shipped publication checker. The
// full definition snapshot preserves unique long abbreviations and distinguishes
// options whose following word is data from Boolean options whose following
// word can be the command. Mixed Boolean/value options are handled separately.
export const NPM_VALUE_OPTIONS = new Set(
	`
	--_auth --access --also --audit-level --auth-type --before --browser --ca --cache --cache-max --cache-min
	--cafile --call --cert --cidr --color --cpu --depth --diff --diff-dst-prefix --diff-src-prefix --diff-unified
	--editor --expect-result-count --expires --fetch-retries --fetch-retry-factor --fetch-retry-maxtimeout
	--fetch-retry-mintimeout --fetch-timeout --git --globalconfig --heading --https-proxy --include
	--init-author-email --init-author-name --init-author-url --init-license --init-module --init-type --init-version
	--init.author.email --init.author.name --init.author.url --init.license --init.module --init.version
	--install-strategy --key --libc --local-address --location --lockfile-version --loglevel --logs-dir --logs-max
	--maxsockets --message --name --node-gyp --node-options --noproxy --omit --only --orgs --orgs-permission --os
	--otp --pack-destination --package --packages --packages-and-scopes-permission --password --prefix --preid
	--provenance-file --proxy --registry --replace-registry-host --save-prefix --sbom-format --sbom-type --scope
	--scopes --script-shell --searchexclude --searchlimit --searchopts --searchstaleness --shell --tag
	--tag-version-prefix --token-description --umask --user-agent --userconfig --viewer --which --workspace
`
		.trim()
		.split(/\s+/),
);
export const NPM_BOOLEAN_OPTIONS = new Set(
	`
	--all --allow-same-version --audit --bin-links --bypass-2fa --commit-hooks --description --dev
	--diff-ignore-all-space --diff-name-only --diff-no-prefix --diff-text --dry-run --engine-strict --expect-results
	--force --foreground-scripts --format-package-lock --fund --git-tag-version --global --global-style --if-present
	--ignore-scripts --include-staged --include-workspace-root --init-private --install-links --json --legacy-bundling
	--legacy-peer-deps --link --long --offline --omit-lockfile-registry-resolved --optional --package-lock
	--package-lock-only --packages-all --parseable --prefer-dedupe --prefer-offline --prefer-online --production
	--progress --provenance --read-only --rebuild-bundle --save --save-bundle --save-dev --save-exact
	--save-optional --save-peer --save-prod --shrinkwrap --sign-git-commit --sign-git-tag --strict-peer-deps
	--strict-ssl --timing --unicode --update-notifier --usage --version --versions --workspaces --workspaces-update --yes
`
		.trim()
		.split(/\s+/),
);
const NPM_OPTIONS = new Set([...NPM_VALUE_OPTIONS, ...NPM_BOOLEAN_OPTIONS]);
export const NPM_VALUE_SHORTHANDS = new Set([
	"C",
	"L",
	"c",
	"enjoy-by",
	"m",
	"reg",
	"w",
]);
export const NPM_BOOLEAN_SHORTHANDS = new Set([
	"?",
	"B",
	"D",
	"E",
	"H",
	"O",
	"P",
	"S",
	"a",
	"desc",
	"f",
	"g",
	"h",
	"help",
	"iwr",
	"l",
	"local",
	"n",
	"no",
	"p",
	"porcelain",
	"readonly",
	"v",
	"ws",
	"y",
]);
export const NPM_FIXED_VALUE_SHORTHANDS = new Set([
	"d",
	"dd",
	"ddd",
	"q",
	"quiet",
	"s",
	"silent",
	"verbose",
]);

export function uwsRefFromSpec(spec) {
	if (typeof spec !== "string") return null;
	return (
		(spec.match(UWS_ARCHIVE_SPEC_RE) || spec.match(UWS_GIT_SPEC_RE))?.[1] ||
		null
	);
}

export function uwsArchiveInstallSpec(spec) {
	const ref = uwsRefFromSpec(spec);
	if (ref === null)
		throw new Error(
			"uWebSockets.js must name an exact tagged GitHub source",
		);
	return (
		"https://github.com/uNetworking/uWebSockets.js/archive/refs/tags/" +
		ref +
		".tar.gz"
	);
}

export function parseCompatibility(text) {
	const lines = text.trim().split(/\r?\n/);
	const headers = lines.shift()?.split(",") || [];
	if (
		headers.length !== EXPECTED_HEADERS.length ||
		headers.some((header, index) => header !== EXPECTED_HEADERS[index])
	) {
		throw new Error(
			"compatibility manifest header must be exactly: " +
				EXPECTED_HEADERS.join(","),
		);
	}
	if (new Set(headers).size !== headers.length)
		throw new Error("compatibility manifest has duplicate headers");
	return lines.map((line, index) => {
		const values = line.split(",");
		if (values.length !== headers.length) {
			throw new Error(
				"compatibility manifest row " +
					(index + 2) +
					" has " +
					values.length +
					" fields; expected " +
					headers.length,
			);
		}
		return Object.fromEntries(
			headers.map((header, column) => [header, values[column]]),
		);
	});
}

function matchesSeries(version, series) {
	if (series.endsWith(".x")) return version.startsWith(series.slice(0, -1));
	return version === series || version.startsWith(series + ".");
}

function publishedBaselineDigest(row) {
	return createHash("sha256")
		.update(EXPECTED_HEADERS.map((field) => row[field]).join("\n"))
		.digest("hex");
}

function validNodeRange(value) {
	return (
		typeof value === "string" &&
		value === value.trim() &&
		!/[\u0000-\u001f\u007f\u2028\u2029`]/.test(value) &&
		validRange(value, { loose: false }) !== null
	);
}

export function validateLifecycleScripts(pkg) {
	const errors = [];
	const check = pkg.scripts?.check;
	if (
		typeof check !== "string" ||
		/(?:\|\||[;\r\n]|(^|[^&])&([^&]|$))/.test(check)
	) {
		errors.push("scripts.check must be a fail-closed && command chain");
	} else {
		const commands = check.split(/\s*&&\s*/);
		if (
			commands[0] !== COMPATIBILITY_GATE_COMMAND ||
			commands.filter((command) => command === COMPATIBILITY_GATE_COMMAND)
				.length !== 1
		) {
			errors.push(
				"scripts.check must start with the compatibility gate and execute it exactly once",
			);
		}
		if (commands.some((command) => !CHECK_SCRIPT_COMMAND.test(command))) {
			errors.push(
				"scripts.check may contain only direct repository check commands",
			);
		}
	}
	if (pkg.scripts?.prepublishOnly !== PREPUBLISH_GATE_COMMAND) {
		errors.push(
			"prepublishOnly must run the fail-closed check chain, which begins with the compatibility gate",
		);
	}
	return errors;
}

export function validateCompatibility(rows, pkg) {
	const errors = [];
	const requiredChannels = [...REQUIRED_CHANNELS.keys()];
	if (rows.length !== requiredChannels.length)
		errors.push("channels must be exactly legacy, stable, prerelease");
	const currentRows = rows.filter((row) => row.current === "true");
	if (currentRows.length !== 1)
		errors.push("exactly one compatibility row must be current");
	const current = currentRows[0];
	const channels = new Set();
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		for (const field of EXPECTED_HEADERS) {
			if (!Object.hasOwn(row, field))
				errors.push(
					(row.channel || "row " + (index + 1)) +
						": missing compatibility field " +
						field,
				);
		}
		for (const field of Object.keys(row)) {
			if (!EXPECTED_HEADERS.includes(field))
				errors.push(
					row.channel + ": unexpected compatibility field " + field,
				);
			if (
				typeof row[field] !== "string" ||
				/[\u0000-\u001f\u007f\u2028\u2029`]/.test(row[field])
			) {
				errors.push(
					row.channel +
						": " +
						field +
						" must be a single printable line",
				);
			}
		}
		if (row.schema_version !== "1")
			errors.push(row.channel + ": unsupported schema_version");
		if (row.owner !== pkg.name)
			errors.push(row.channel + ": owner does not match package name");
		if (row.current !== "true" && row.current !== "false")
			errors.push(row.channel + ": current must be true or false");
		if (row.channel !== requiredChannels[index])
			errors.push("channels must be ordered legacy, stable, prerelease");
		if (channels.has(row.channel))
			errors.push(row.channel + ": duplicate channel");
		channels.add(row.channel);
		if (!REQUIRED_CHANNELS.has(row.channel))
			errors.push(row.channel + ": unknown channel");
		else if (row.dist_tag !== REQUIRED_CHANNELS.get(row.channel))
			errors.push(row.channel + ": invalid dist tag role");
		for (const field of ["adapter", "realtime", "extensions"]) {
			if (!/^\d+\.\d+\.(?:x|\d+(?:-[0-9A-Za-z.-]+)?)$/.test(row[field])) {
				errors.push(row.channel + ": invalid " + field + " series");
			}
		}
		if (!row.dist_tag) {
			if (
				row.node ||
				row.uwebsockets ||
				row.adapter_version ||
				row.provenance
			) {
				errors.push(
					row.channel +
						": untagged legacy channel must not claim release or runtime facts",
				);
			}
		} else {
			if (
				!row.adapter_version ||
				!matchesSeries(row.adapter_version, row.adapter)
			) {
				errors.push(
					row.channel +
						": adapter release identity is outside its series",
				);
			}
			if (!validNodeRange(row.node))
				errors.push(
					row.channel +
						": node must be a canonical single-line npm semver range",
				);
			if (uwsRefFromSpec(row.uwebsockets) === null) {
				errors.push(
					row.channel +
						": uWebSockets.js must be an exact tagged GitHub source",
				);
			}
		}
	}
	if (current) {
		if (!matchesSeries(pkg.version, current.adapter)) {
			errors.push(
				"package version " +
					pkg.version +
					" is outside current adapter series " +
					current.adapter,
			);
		}
		if (!current.dist_tag) errors.push("current channel has no dist tag");
		if (current.adapter_version !== pkg.version)
			errors.push(
				"current adapter release identity disagrees with package.json",
			);
		if (current.provenance !== "workspace")
			errors.push("current channel provenance must be workspace");
		if (current.node !== pkg.engines?.node)
			errors.push(
				current.channel + ": Node floor disagrees with package.json",
			);
		if (
			current.uwebsockets !== pkg.optionalDependencies?.["uWebSockets.js"]
		) {
			errors.push(
				current.channel +
					": uWebSockets.js pin disagrees with package.json",
			);
		}
		// The ecosystem releases svelte-adapter-uws, svelte-realtime, and
		// svelte-adapter-uws-extensions in lockstep series, and pkg.version is
		// the only sibling fact this repository can authenticate offline. The
		// digest binding authenticates the immutable published rows; this
		// binds the one row that moves, so a hand-edited sibling series can
		// no longer ride a green gate. If the lockstep release policy ever
		// changes, this rule is where the new policy gets declared.
		for (const field of ["realtime", "extensions"]) {
			if (current[field] !== current.adapter) {
				errors.push(
					current.channel +
						": " +
						field +
						" series " +
						current[field] +
						" does not match the lockstep adapter series " +
						current.adapter,
				);
			}
		}
		const expectedChannel = pkg.version.includes("-")
			? "prerelease"
			: "stable";
		if (current.channel !== expectedChannel)
			errors.push(
				"current channel does not match package version stability",
			);
		if (pkg.publishConfig?.tag !== current.dist_tag)
			errors.push("publishConfig.tag disagrees with current dist tag");
	}
	for (const row of rows.filter(
		(candidate) => candidate.dist_tag && candidate !== current,
	)) {
		const expected = PUBLISHED_BASELINE_DIGESTS.get(row.provenance);
		if (
			expected === undefined ||
			row.provenance !== `npm:${pkg.name}@${row.adapter_version}`
		) {
			errors.push(
				row.channel + ": published baseline provenance is not pinned",
			);
		} else if (publishedBaselineDigest(row) !== expected) {
			errors.push(
				row.channel +
					": published baseline facts disagree with the pinned registry identity",
			);
		}
	}
	return [...errors, ...validateLifecycleScripts(pkg)];
}

function boundedBlockBounds(source, startMarker, endMarker, label) {
	const starts = source.split(startMarker).length - 1;
	const ends = source.split(endMarker).length - 1;
	if (starts !== 1 || ends !== 1)
		throw new Error(
			label + " must contain exactly one compatibility block",
		);
	const start = source.indexOf(startMarker);
	const endMarkerStart = source.indexOf(endMarker);
	const ownsLine = (offset, marker) =>
		(offset === 0 || source[offset - 1] === "\n") &&
		(offset + marker.length === source.length ||
			source[offset + marker.length] === "\r" ||
			source[offset + marker.length] === "\n");
	if (
		start === -1 ||
		endMarkerStart === -1 ||
		endMarkerStart < start ||
		!ownsLine(start, startMarker) ||
		!ownsLine(endMarkerStart, endMarker)
	) {
		throw new Error(
			label +
				" compatibility markers must be ordered and occupy complete lines",
		);
	}
	if (!markersRenderInNormalFlow(source, [startMarker, endMarker])) {
		throw new Error(
			label + " compatibility block must render in normal Markdown flow",
		);
	}
	return { start, end: endMarkerStart + endMarker.length };
}

function compatibilityBlockBounds(readme) {
	return boundedBlockBounds(
		readme,
		COMPATIBILITY_START,
		COMPATIBILITY_END,
		"README",
	);
}

function migrationCompatibilityBlockBounds(migration) {
	return boundedBlockBounds(
		migration,
		MIGRATION_COMPATIBILITY_START,
		MIGRATION_COMPATIBILITY_END,
		"MIGRATION.md",
	);
}

function htmlChildren(node) {
	const children = [...(node.childNodes || [])];
	if (node.tagName === "template" && node.content)
		children.push(...(node.content.childNodes || []));
	return children;
}

function walkHtml(node, visit, ancestors = []) {
	visit(node, ancestors);
	const childAncestors = node.tagName ? [...ancestors, node] : ancestors;
	for (const child of htmlChildren(node))
		walkHtml(child, visit, childAncestors);
}

function parseRenderedMarkdown(source) {
	const environment = {};
	const tokens = markdown.parse(source, environment);
	const html = markdown.renderer.render(
		tokens,
		markdown.options,
		environment,
	);
	return { tokens, document: parseFragment(html) };
}

function renderedMarkdownDocument(source) {
	return parseRenderedMarkdown(source).document;
}

function hiddenRenderedElement(node) {
	if (!node.tagName) return false;
	if (
		node.tagName === "template" ||
		node.tagName === "script" ||
		node.tagName === "style"
	)
		return true;
	const attributes = new Map(
		(node.attrs || []).map((attribute) => [
			attribute.name.toLowerCase(),
			attribute.value.toLowerCase(),
		]),
	);
	if (attributes.has("hidden") || attributes.has("inert")) return true;
	if (attributes.get("aria-hidden") === "true") return true;
	const style = attributes.get("style") || "";
	const winners = new Map();
	for (const declaration of style.split(";")) {
		const colon = declaration.indexOf(":");
		if (colon === -1) continue;
		const property = declaration
			.slice(0, colon)
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.trim()
			.toLowerCase();
		if (property !== "display" && property !== "visibility") continue;
		let value = declaration
			.slice(colon + 1)
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.trim()
			.toLowerCase();
		const important = /!\s*important\s*$/i.test(value);
		value = value
			.replace(/!\s*important\s*$/i, "")
			.replace(/\s+/g, "")
			.trim();
		const previous = winners.get(property);
		if (!previous || important || !previous.important)
			winners.set(property, { value, important });
	}
	return (
		winners.get("display")?.value === "none" ||
		["hidden", "collapse"].includes(winners.get("visibility")?.value)
	);
}

function hiddenRenderedContext(node, ancestors = []) {
	return hiddenRenderedElement(node) || ancestors.some(hiddenRenderedElement);
}

function renderedNodeText(node) {
	if (node.nodeName === "#text") return node.value;
	if (node.nodeName === "#comment") return "";
	if (hiddenRenderedElement(node)) return "";
	const text = htmlChildren(node).map(renderedNodeText).join("");
	return node.tagName && HTML_TEXT_BREAKS.has(node.tagName)
		? "\n" + text + "\n"
		: text;
}

function markersRenderInNormalFlow(source, markers) {
	const matches = new Map(
		markers.map((marker) => [marker.slice(4, -3).trim(), []]),
	);
	walkHtml(renderedMarkdownDocument(source), (node, ancestors) => {
		if (node.nodeName !== "#comment") return;
		const markerMatches = matches.get(node.data.trim());
		if (markerMatches) markerMatches.push(ancestors);
	});
	return [...matches.values()].every(
		(markerMatches) =>
			markerMatches.length === 1 && markerMatches[0].length === 0,
	);
}

function sourceOutsideCompatibilityBlock(readme) {
	const { start, end } = compatibilityBlockBounds(readme);
	return readme.slice(0, start) + "\n" + readme.slice(end);
}

function sourceOutsideMigrationCompatibilityBlock(migration) {
	const { start, end } = migrationCompatibilityBlockBounds(migration);
	return migration.slice(0, start) + "\n" + migration.slice(end);
}

function renderedTableMatrices(document) {
	const matrices = [];
	walkHtml(document, (node, ancestors) => {
		if (node.tagName !== "table" || hiddenRenderedContext(node, ancestors))
			return;
		const rows = [];
		walkHtml(node, (row, ancestors) => {
			if (
				row.tagName !== "tr" ||
				hiddenRenderedContext(row, ancestors) ||
				ancestors.some(
					(ancestor) =>
						ancestor !== node && ancestor.tagName === "table",
				)
			)
				return;
			const cells = htmlChildren(row)
				.filter(
					(child) => child.tagName === "th" || child.tagName === "td",
				)
				.map((cell) =>
					renderedNodeText(cell)
						.replace(/\s+/g, " ")
						.trim()
						.toLowerCase(),
				);
			if (cells.length) rows.push(cells);
		});
		if (rows.length) matrices.push(rows);
	});
	return matrices;
}

// Hand-written matrices can restate manifest rows under short column labels
// (Adapter | Realtime | Extensions | Native addon) instead of full package
// names, which the full-identity counter cannot see. Those short labels only
// identify the ecosystem when they appear as whole cells, so exact-cell
// matching keeps prose tables that merely mention the word adapter somewhere
// inside a longer cell out of scope.
const SHORT_ECOSYSTEM_CELL_LABELS = [
	"adapter",
	"realtime",
	"extensions",
	"native addon",
	"uwebsockets.js",
	"uws",
];

function shortLabelIdentityCount(table) {
	const labels = new Set();
	for (const row of table) {
		for (const cell of row) {
			const normalized = cell
				.replace(/`/g, "")
				.replace(/\s+/g, " ")
				.trim()
				.toLowerCase();
			if (SHORT_ECOSYSTEM_CELL_LABELS.includes(normalized))
				labels.add(normalized);
		}
	}
	return labels.size;
}

function tableClaimsCompatibility(table) {
	const contents = table.flat().join(" ");
	if (compatibilityFactCount(contents) < 2) return false;
	return (
		ecosystemIdentityCount(contents) >= 2 ||
		shortLabelIdentityCount(table) >= 2
	);
}

function renderedClaimDocuments(parsed) {
	const documents = [parsed.document];
	for (const token of parsed.tokens) {
		if (token.type === "fence" || token.type === "code_block") {
			documents.push(renderedMarkdownDocument(token.content));
		}
	}
	return documents;
}

function directHtmlChildren(node, tagName) {
	return htmlChildren(node).filter((child) => child.tagName === tagName);
}

function structuredCompatibilityUnits(node) {
	if (
		node.tagName === "ul" ||
		node.tagName === "ol" ||
		node.tagName === "menu"
	) {
		return directHtmlChildren(node, "li").map(renderedNodeText);
	}
	if (node.tagName === "dl") {
		const units = [];
		let term = "";
		for (const child of htmlChildren(node)) {
			if (child.tagName === "dt") term = renderedNodeText(child);
			else if (child.tagName === "dd" && term)
				units.push(term + " " + renderedNodeText(child));
		}
		return units;
	}
	const classes =
		(node.attrs || [])
			.find((attribute) => attribute.name.toLowerCase() === "class")
			?.value.toLowerCase()
			.split(/\s+/) || [];
	if (classes.includes("compatibility")) {
		const childUnits = htmlChildren(node)
			.filter((child) => child.tagName && !hiddenRenderedElement(child))
			.map(renderedNodeText)
			.map((unit) => unit.replace(/\s+/g, " ").trim())
			.filter(Boolean);
		if (childUnits.length >= 2) return childUnits;
	}
	// Raw HTML and component-authored Markdown commonly render version cards as
	// mixed text, line breaks and nested inline elements. Render the container,
	// then use its visible line boundaries as units.
	if (!node.tagName || node.tagName === "table") return [];
	return renderedNodeText(node)
		.split(/\n+/)
		.map((unit) => unit.trim())
		.filter(Boolean);
}

function compatibilityFactCount(source) {
	return [
		...source.matchAll(
			/@(?:latest|next)\b|\bv?\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\.x)?\b/gi,
		),
	].length;
}

function hasStructuredCompatibilityMatrix(document) {
	let found = false;
	walkHtml(document, (node, ancestors) => {
		if (found || hiddenRenderedContext(node, ancestors)) return;
		const factualUnits = structuredCompatibilityUnits(node).filter(
			(unit) =>
				ecosystemIdentityCount(unit) > 0 &&
				compatibilityFactCount(unit) > 0,
		);
		if (
			factualUnits.length >= 2 &&
			ecosystemIdentityCount(factualUnits.join(" ")) >= 2
		) {
			found = true;
			return;
		}
		// Inline cards do not need a particular author-chosen class name. Two
		// visible sibling elements that each pair an ecosystem identity with a
		// version are the same public matrix whether the container is named
		// compatibility, compatibility-card, or nothing at all.
		const inlineFacts = htmlChildren(node)
			.filter(
				(child) =>
					child.tagName &&
					!HTML_TEXT_BREAKS.has(child.tagName) &&
					!hiddenRenderedElement(child),
			)
			.map(renderedNodeText)
			.filter(
				(unit) =>
					ecosystemIdentityCount(unit) > 0 &&
					compatibilityFactCount(unit) > 0,
			);
		if (
			inlineFacts.length >= 2 &&
			ecosystemIdentityCount(inlineFacts.join(" ")) >= 2
		) {
			found = true;
			return;
		}
		// A visible same-line matrix can mix text nodes with inline elements, or
		// use plain text with a pipe separator. Its ownership does not depend on
		// author-chosen wrappers, so classify the rendered line as a whole.
		const colocatedLine = renderedNodeText(node)
			.split(/\n+/)
			.map((line) => line.replace(/\s+/g, " ").trim())
			.find(
				(line) =>
					compatibilityFactCount(line) >= 2 &&
					ecosystemIdentityCount(line) >= 2,
			);
		if (colocatedLine) {
			found = true;
			return;
		}
		const attributes = new Map(
			(node.attrs || []).map((attribute) => [
				attribute.name.toLowerCase(),
				attribute.value.toLowerCase(),
			]),
		);
		const semanticName =
			(attributes.get("class") || "") +
			" " +
			(attributes.get("id") || "");
		const visible = renderedNodeText(node);
		if (
			/\bcompatibility(?:[-_]\w+)?\b/i.test(semanticName) &&
			compatibilityFactCount(visible) >= 2 &&
			ecosystemIdentityCount(visible) >= 2
		)
			found = true;
	});
	return found;
}

function hasAdjacentCompatibilityProse(document) {
	let found = false;
	walkHtml(document, (node, ancestors) => {
		if (found || hiddenRenderedContext(node, ancestors)) return;
		const children = htmlChildren(node).filter((child) => child.tagName);
		for (let index = 0; index < children.length; index++) {
			for (
				let length = 2;
				length <= 4 && index + length <= children.length;
				length++
			) {
				const window = children.slice(index, index + length);
				if (
					window.some(
						(child) =>
							child.tagName !== "p" ||
							hiddenRenderedElement(child),
					)
				)
					break;
				const units = window.map(renderedNodeText);
				if (
					ecosystemIdentityCount(units[0]) === 0 ||
					compatibilityFactCount(units[0]) === 0 ||
					ecosystemIdentityCount(units.at(-1)) === 0 ||
					compatibilityFactCount(units.at(-1)) === 0
				) {
					continue;
				}
				const adjacent = units.join(" ");
				if (
					/\b(?:compatible with|works with|pairs with|requires|supports)\b/i.test(
						adjacent,
					) &&
					compatibilityFactCount(adjacent) >= 2 &&
					ecosystemIdentityCount(adjacent) >= 2
				) {
					found = true;
					return;
				}
			}
		}
	});
	return found;
}

function hasOwnedCompatibilityPresentation(
	source,
	parsed = parseRenderedMarkdown(source),
) {
	return renderedClaimDocuments(parsed).some(
		(document) =>
			renderedTableMatrices(document).some(tableClaimsCompatibility) ||
			hasStructuredCompatibilityMatrix(document) ||
			hasAdjacentCompatibilityProse(document),
	);
}

function ecosystemIdentityCount(source) {
	let normalized =
		" " +
		source
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, " ")
			.trim() +
		" ";
	let count = 0;
	for (const identity of [
		" svelte adapter uws extensions ",
		" svelte adapter uws ",
		" svelte realtime ",
	]) {
		if (!normalized.includes(identity)) continue;
		count++;
		normalized = normalized.replaceAll(identity, " ");
	}
	return count;
}

function hasCompatibilityProse(visible) {
	const sentences = visible
		.split(/(?:[.!?](?:\s|$)|\r?\n)/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
	for (let index = 0; index < sentences.length; index++) {
		const sentence = sentences[index];
		if (
			!/\b(?:compatible with|works with|pairs with|requires|supports)\b/i.test(
				sentence,
			)
		)
			continue;
		if (compatibilityFactCount(sentence) === 0) continue;
		if (ecosystemIdentityCount(sentence) >= 2) return true;
	}
	for (const paragraph of visible.split(/\r?\n\s*\r?\n/)) {
		if (
			!/\b(?:compatible with|works with|pairs with|requires|supports)\b/i.test(
				paragraph,
			)
		)
			continue;
		if (compatibilityFactCount(paragraph) < 2) continue;
		if (ecosystemIdentityCount(paragraph) >= 2) return true;
	}
	return false;
}

export function normalizeShellContinuations(source) {
	return source.replace(/(?:\\|\^|`)\r?\n/g, "");
}

function hasInstallInstruction(visibleSource) {
	const visible = normalizeShellContinuations(visibleSource).replace(
		/\\([-.])/g,
		"$1",
	);
	// Commands are recognized wherever Markdown renders them, including prose,
	// inline code, indented code, fenced examples and shell wrappers. Options may
	// appear before the install verb, but the governed package must occur in the
	// same logical command after platform continuation lines are joined.
	const manager =
		/\b(?:npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?(?:@[^\s;&|"']+)?\b/gi;
	const installAliases = new Set([
		"install",
		"install-test",
		"add",
		"i",
		"in",
		"ins",
		"inst",
		"insta",
		"instal",
		"it",
		"isnt",
		"isnta",
		"isntal",
		"isntall",
	]);
	const npmInstallCommands = ["install", "install-ci-test", "install-test"];
	const otherManagerOptionValues = new Set([
		"--access",
		"--before",
		"--cache",
		"--cafile",
		"--cert",
		"--cidr",
		"--depth",
		"--diff-dst-prefix",
		"--diff-src-prefix",
		"--diff-unified",
		"--editor",
		"--fetch-retries",
		"--fetch-retry-factor",
		"--fetch-retry-maxtimeout",
		"--fetch-retry-mintimeout",
		"--fetch-timeout",
		"--git",
		"--globalconfig",
		"--heading",
		"--https-proxy",
		"--init-author-email",
		"--init-author-name",
		"--init-author-url",
		"--init-license",
		"--init-module",
		"--init-version",
		"--install-strategy",
		"--key",
		"--local-address",
		"--location",
		"--lockfile-version",
		"--loglevel",
		"--logs-dir",
		"--logs-max",
		"--maxsockets",
		"--message",
		"--node-options",
		"--noproxy",
		"--omit",
		"--otp",
		"--pack-destination",
		"--prefix",
		"--proxy",
		"--registry",
		"--replace-registry-host",
		"--save-prefix",
		"--scope",
		"--script-shell",
		"--shell",
		"--tag",
		"--tag-version-prefix",
		"--umask",
		"--user-agent",
		"--userconfig",
		"--viewer",
		"--workspace",
		"--cwd",
		"--dir",
		"--global-dir",
		"-C",
		"-w",
	]);
	const shellTokenValue = (token) => {
		let value = "";
		let quote = null;
		for (let index = 0; index < token.length; index++) {
			const character = token[index];
			if (quote !== null) {
				if (character === quote) quote = null;
				else if (
					quote === '"' &&
					character === "\\" &&
					index + 1 < token.length
				)
					value += token[++index];
				else value += character;
				continue;
			}
			if (character === '"' || character === "'") quote = character;
			else if (character === "\\" && index + 1 < token.length)
				value += token[++index];
			else value += character;
		}
		return quote === null ? value : token;
	};
	// Tokenize complete shell words before interpreting the npm grammar. This
	// joins adjacent quote fragments and keeps escaped whitespace inside one
	// option value, manager name, or package identity.
	const shellCommands = (source) => {
		const commands = [];
		let tokens = [];
		let value = "";
		let raw = "";
		let started = false;
		let quote = null;
		const finishToken = () => {
			if (!started) return;
			tokens.push({ value: quote === null ? value : raw });
			value = "";
			raw = "";
			started = false;
		};
		const finishCommand = () => {
			finishToken();
			if (tokens.length > 0) commands.push(tokens);
			tokens = [];
		};
		for (let index = 0; index < source.length; index++) {
			const character = source[index];
			if (quote !== null) {
				// Rendered block boundaries are command boundaries. Do not let an
				// apostrophe in prose consume every later paragraph as a shell quote.
				if (character === "\n" && source[index + 1] === "\n") {
					quote = null;
					finishCommand();
					continue;
				}
				raw += character;
				if (character.charCodeAt(0) === quote) quote = null;
				else if (
					quote === 34 &&
					character === "\\" &&
					index + 1 < source.length
				) {
					raw += source[++index];
					value += source[index];
				} else value += character;
				continue;
			}
			const code = character.charCodeAt(0);
			if (code === 34 || code === 39) {
				started = true;
				quote = code;
				raw += character;
			} else if (character === "\\" && index + 1 < source.length) {
				started = true;
				raw += character + source[++index];
				value += source[index];
			} else if (/\s/.test(character)) {
				finishToken();
				if (character === "\n" || character === "\r") finishCommand();
			} else if (/[;&|]/.test(character)) {
				finishCommand();
			} else {
				started = true;
				raw += character;
				value += character;
			}
		}
		finishCommand();
		return commands;
	};
	const canonicalNpmOption = (token) => {
		const lowered = token.toLowerCase();
		if (NPM_OPTIONS.has(lowered)) return lowered;
		const matches = [...NPM_OPTIONS].filter((option) =>
			option.startsWith(lowered),
		);
		return matches.length === 1 ? matches[0] : null;
	};
	const npmOptionConsumesNext = (token, next) => {
		if (!next || token.includes("=")) return false;
		if (token.startsWith("--")) {
			if (/^--no-/i.test(token)) return false;
			const option = canonicalNpmOption(token);
			if (option === "--color")
				return /^(?:always|true|false)$/i.test(next);
			if (option && NPM_VALUE_OPTIONS.has(option)) return true;
			return /^(?:true|false)$/i.test(next);
		}
		const shorthand = token.slice(1);
		if (NPM_VALUE_SHORTHANDS.has(shorthand)) return true;
		if (NPM_BOOLEAN_SHORTHANDS.has(shorthand))
			return /^(?:true|false)$/i.test(next);
		if (NPM_FIXED_VALUE_SHORTHANDS.has(shorthand)) return false;
		// Nopt also expands clusters of one-character shorthands. A value-taking
		// member consumes the following word only when it is the final character;
		// otherwise the remaining characters are its attached value.
		for (let index = 0; index < shorthand.length; index++) {
			const member = shorthand[index];
			if (NPM_VALUE_SHORTHANDS.has(member))
				return index === shorthand.length - 1;
			if (
				!NPM_BOOLEAN_SHORTHANDS.has(member) &&
				!NPM_FIXED_VALUE_SHORTHANDS.has(member)
			)
				return false;
		}
		return false;
	};
	const normalizeCommand = (command) =>
		command
			.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
			.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
			.toLowerCase();
	const isInstallAction = (managerName, command) => {
		const normalized = normalizeCommand(command);
		if (installAliases.has(normalized)) return true;
		if (
			!/^npm(?:\.cmd|\.exe)?(?:@|$)/i.test(managerName) ||
			!normalized.includes("-")
		)
			return false;
		const candidates = npmInstallCommands.filter((candidate) =>
			candidate.startsWith(normalized),
		);
		return candidates.length === 1 && candidates[0] === "install-test";
	};
	const hasGovernedPackage = (command) => {
		// The three ecosystem packages release in lockstep series, so an
		// unqualified `npm install svelte-realtime` in packaged docs resolves
		// the wrong dist-tag line exactly like an unqualified adapter install
		// would. All three identities are governed, with or without a
		// @tag/@version suffix.
		if (
			/\b(?:svelte-adapter-uws(?:-extensions)?|svelte-realtime)(?:@|\b)/i.test(
				command,
			)
		)
			return true;
		for (const token of command.match(/[^\s;&|"'`<>]+/g) || []) {
			let decoded;
			try {
				decoded = decodeURIComponent(token);
			} catch {
				decoded = token;
			}
			if (/uNetworking\/uWebSockets\.js(?:\.git)?(?:#|\b)/i.test(decoded))
				return true;
			const gitPath = decoded
				.replace(/^.*?(?:github:|(?:www\.)?github\.com[:/])/i, "")
				.split(/[?#]/, 1)[0];
			const parts = [];
			for (const part of gitPath.replace(/\\/g, "/").split("/")) {
				if (!part || part === ".") continue;
				if (part === "..") parts.pop();
				else parts.push(part);
			}
			if (
				parts.length === 2 &&
				parts[0].toLowerCase() === "unetworking" &&
				parts[1].replace(/\.git$/i, "").toLowerCase() ===
					"uwebsockets.js"
			)
				return true;
		}
		return false;
	};
	const trimPunctuation = (token) => token.replace(/^[,:(]+|[),.:]+$/g, "");
	for (const command of shellCommands(visible)) {
		for (
			let managerIndex = 0;
			managerIndex < command.length;
			managerIndex++
		) {
			const managerName = trimPunctuation(command[managerIndex].value);
			manager.lastIndex = 0;
			if (!manager.test(managerName)) continue;
			const npmManager = /^npm(?:\.cmd|\.exe)?(?:@|$)/i.test(managerName);
			const args = command.slice(managerIndex + 1);
			let action = null;
			for (let index = 0; index < args.length; index++) {
				const token = trimPunctuation(args[index].value);
				if (token === "--") {
					action = args[index + 1] || null;
					break;
				}
				if (token.startsWith("-")) {
					const next = args[index + 1]?.value || null;
					if (
						npmManager
							? npmOptionConsumesNext(token, next)
							: !token.includes("=") &&
								otherManagerOptionValues.has(token)
					)
						index++;
					continue;
				}
				action = args[index];
				break;
			}
			if (action === null) continue;
			let actionWord = action.value.match(/[A-Za-z][A-Za-z-]*/)?.[0];
			if (
				/^yarn(?:\.cmd|\.exe)?(?:@|$)/i.test(managerName) &&
				actionWord?.toLowerCase() === "global"
			) {
				const next = args[args.indexOf(action) + 1];
				action = next || action;
				actionWord = next?.value.match(/[A-Za-z][A-Za-z-]*/)?.[0];
			}
			if (!actionWord || !isInstallAction(managerName, actionWord))
				continue;
			if (
				hasGovernedPackage(
					args
						.slice(args.indexOf(action) + 1)
						.map((token) => token.value)
						.join(" "),
				)
			)
				return true;
		}
	}
	return false;
}

function validateUnownedPublishedSource(relative, source) {
	const errors = [];
	const parsed = parseRenderedMarkdown(source);
	const visible = renderedNodeText(parsed.document);
	if (
		hasOwnedCompatibilityPresentation(source, parsed) ||
		hasCompatibilityProse(visible) ||
		/@(?:latest|next)\b/i.test(visible)
	) {
		errors.push(
			relative +
				" contains a compatibility presentation outside an owned generated block",
		);
	}
	if (hasInstallInstruction(visible)) {
		errors.push(
			relative +
				" contains an install instruction outside an owned generated block",
		);
	}
	return errors;
}

export function validateReadmeCompatibility(readme, rows) {
	const errors = [];
	const current = rows.find((row) => row.current === "true");
	const nodeFacts = [...readme.matchAll(/Node is `([^`]+)`/g)].map(
		(match) => match[1],
	);
	if (nodeFacts.length !== 1 || !current || nodeFacts[0] !== current.node) {
		errors.push(
			"README Node prerequisite disagrees with current compatibility row",
		);
	}
	try {
		for (const error of validateUnownedPublishedSource(
			"README",
			sourceOutsideCompatibilityBlock(readme),
		)) {
			errors.push(
				error.includes("compatibility presentation")
					? "README contains a competing compatibility presentation outside the generated block"
					: "README contains an install instruction outside the generated compatibility block",
			);
		}
	} catch (error) {
		errors.push(error.message);
	}
	return errors;
}

function cell(value) {
	if (/[\r\n\u2028\u2029`]/.test(value))
		throw new Error(
			"compatibility table cells must be single-line and backtick-free",
		);
	return value ? "`" + value.replaceAll("|", "\\|") + "`" : "n/a";
}

export function renderCompatibility(rows) {
	const current = rows.find((row) => row.current === "true");
	const stable = rows.find((row) => row.channel === "stable");
	if (!current || !stable)
		throw new Error(
			"current and stable channels are required to render compatibility",
		);
	const currentIsStaged = current.provenance === "workspace";
	const channelNotice = currentIsStaged
		? "> **Prerelease channel:** This branch documents the staged, unpublished `" +
			current.adapter_version +
			"` candidate. Maintainers publish all three ecosystem packages together before the exact candidate is installable. The moving `@" +
			current.dist_tag +
			"` tag may currently resolve an earlier published candidate; `@" +
			stable.dist_tag +
			"` remains the stable `" +
			stable.adapter +
			"` line."
		: "> **Prerelease channel:** This branch documents the `" +
			current.adapter +
			"` line. Install all three ecosystem packages from `@" +
			current.dist_tag +
			"`; `@" +
			stable.dist_tag +
			"` remains the stable `" +
			stable.adapter +
			"` line.";
	const lines = [
		COMPATIBILITY_START,
		channelNotice,
		"",
		"| Channel | `svelte-adapter-uws` | `svelte-realtime` | `svelte-adapter-uws-extensions` | Install tag | Runtime |",
		"|---|---|---|---|---|---|",
	];
	for (const row of rows) {
		const runtime = row.node
			? "Node " +
				cell(row.node) +
				"; uWS " +
				cell(uwsRefFromSpec(row.uwebsockets))
			: "n/a";
		const installTag = row.dist_tag
			? row === current && currentIsStaged
				? "`@" +
					row.dist_tag +
					"` after publish; may currently be older"
				: "`@" + row.dist_tag + "`"
			: "n/a";
		lines.push(
			"| " +
				row.channel +
				" | " +
				cell(row.adapter_version || row.adapter) +
				" | " +
				cell(row.realtime) +
				" | " +
				cell(row.extensions) +
				" | " +
				installTag +
				" | " +
				runtime +
				" |",
		);
	}
	lines.push(
		"",
		"Choose one complete adapter/native-addon tuple; do not mix rows:",
		"",
		"```bash",
	);
	for (const row of rows.filter((candidate) => candidate.dist_tag)) {
		const staged = row === current && currentIsStaged;
		lines.push(
			staged
				? "# " +
						row.channel +
						" " +
						row.adapter_version +
						" (staged; run only after coordinated publication)"
				: "# " +
						row.channel +
						" " +
						row.adapter_version +
						" (@" +
						row.dist_tag +
						")",
			"npm install " +
				row.owner +
				"@" +
				(staged ? row.adapter_version : row.dist_tag) +
				" " +
				uwsArchiveInstallSpec(row.uwebsockets),
		);
		if (staged)
			lines.push(
				"# @" +
					row.dist_tag +
					" is moving and may still resolve an earlier published candidate.",
			);
	}
	lines.push("```");
	lines.push(COMPATIBILITY_END);
	return lines.join("\n");
}

export function replaceCompatibilityBlock(readme, rendered) {
	const claims = validateUnownedPublishedSource(
		"README",
		sourceOutsideCompatibilityBlock(readme),
	);
	if (claims.some((claim) => claim.includes("compatibility presentation"))) {
		throw new Error(
			"README contains a competing compatibility presentation outside the generated block",
		);
	}
	if (claims.length)
		throw new Error(
			"README contains an install instruction outside the generated compatibility block",
		);
	const { start, end } = compatibilityBlockBounds(readme);
	return readme.slice(0, start) + rendered + readme.slice(end);
}

export function renderMigrationCompatibility(rows) {
	const current = rows.find((row) => row.current === "true");
	const stable = rows.find((row) => row.channel === "stable");
	if (!current || !stable)
		throw new Error(
			"current and stable channels are required to render migration guidance",
		);
	return [
		MIGRATION_COMPATIBILITY_START,
		"For the archived [0.4.x to 0.5.x guide](./docs/migrations/0.4-to-0.5.md), pin `" +
			stable.owner +
			"@" +
			stable.adapter_version +
			"`. " +
			"The `@latest` and `@next` dist-tags move as releases are promoted; `@next` currently follows the `" +
			current.adapter +
			"` prerelease line. The active [0.5.x to 0.6.x guide](./docs/migrations/0.5-to-0.6.md) follows that prerelease line. See the generated compatibility table in the " +
			"[README](./README.md#version-compatibility) before choosing a dist-tag.",
		MIGRATION_COMPATIBILITY_END,
	].join("\n");
}

export function replaceMigrationCompatibilityBlock(migration, rendered) {
	const claims = validateUnownedPublishedSource(
		"MIGRATION.md",
		sourceOutsideMigrationCompatibilityBlock(migration),
	);
	if (claims.length) throw new Error(claims[0]);
	const { start, end } = migrationCompatibilityBlockBounds(migration);
	return migration.slice(0, start) + rendered + migration.slice(end);
}

export function validateMigrationCompatibility(migration) {
	try {
		return validateUnownedPublishedSource(
			"MIGRATION.md",
			sourceOutsideMigrationCompatibilityBlock(migration),
		);
	} catch (error) {
		return [error.message];
	}
}

export const MIGRATION_GUIDE_RELATIVE_PATH = "docs/migrations/0.5-to-0.6.md";
const MIGRATION_GUIDE_TUPLE_HEADER = [
	"purpose",
	"adapter",
	"realtime",
	"extensions",
	"native addon",
];

function markdownTableRowCells(line) {
	const trimmed = line.trim();
	if (
		trimmed.length < 2 ||
		!trimmed.startsWith("|") ||
		!trimmed.endsWith("|")
	)
		return null;
	return trimmed
		.slice(1, -1)
		.split("|")
		.map((cell) => cell.replace(/`/g, "").replace(/\s+/g, " ").trim());
}

function cellVersionTokens(cell) {
	return [
		...cell.matchAll(/\bv?\d+\.\d+(?:\.(?:x|\d+))?(?:-[0-9A-Za-z.*]+)?/g),
	].map((match) => match[0]);
}

/**
 * The 0.5-to-0.6 guide restates manifest facts in a short-label tuple table
 * so the guide stays readable offline. That restatement is only allowed
 * because this binding drift-checks every version-bearing cell of both bound
 * rows against docs/compatibility.v1.csv, then excises the bound table so the
 * generic ownership detectors govern the rest of the guide. Any other
 * short-label matrix in packaged docs is an unowned compatibility claim.
 */
export function validateMigrationGuideTupleTable(source, rows) {
	const stable = rows.find((row) => row.channel === "stable");
	const current = rows.find((row) => row.current === "true");
	if (!stable || !current) return { errors: [], remainder: source };
	const lines = source.split(/\r?\n/);
	const headerIndex = lines.findIndex((line) => {
		const cells = markdownTableRowCells(line);
		return (
			cells !== null &&
			cells.map((cell) => cell.toLowerCase()).join("|") ===
				MIGRATION_GUIDE_TUPLE_HEADER.join("|")
		);
	});
	if (headerIndex === -1) return { errors: [], remainder: source };
	let end = headerIndex + 1;
	while (end < lines.length && lines[end].trim().startsWith("|")) end++;
	const errors = [];
	const label = MIGRATION_GUIDE_RELATIVE_PATH + " tuple table";
	const expectations = new Map([
		[
			"rollback baseline",
			[
				stable.adapter_version,
				stable.realtime,
				stable.extensions,
				uwsRefFromSpec(stable.uwebsockets),
			],
		],
		[
			"upgrade candidate",
			[
				current.adapter,
				current.realtime,
				current.extensions,
				uwsRefFromSpec(current.uwebsockets),
			],
		],
	]);
	const seen = new Set();
	for (const line of lines.slice(headerIndex + 1, end)) {
		const cells = markdownTableRowCells(line);
		if (cells === null) {
			errors.push(label + " contains a malformed row: " + line.trim());
			continue;
		}
		if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
		const rowName = cells[0].toLowerCase();
		const expected = expectations.get(rowName);
		if (!expected) {
			errors.push(
				label +
					" row " +
					(cells[0] || line.trim()) +
					" is not bound to a compatibility channel",
			);
			continue;
		}
		seen.add(rowName);
		if (cells.length !== MIGRATION_GUIDE_TUPLE_HEADER.length) {
			errors.push(
				label +
					" " +
					cells[0] +
					" row must have exactly the bound columns",
			);
			continue;
		}
		for (let column = 0; column < expected.length; column++) {
			// A wildcard suffix (0.6.0-next.*) restates a series; strip it
			// before the exact comparison so a superstring like 0.5.80 cannot
			// ride a substring check.
			const tokens = cellVersionTokens(cells[column + 1]);
			if (
				tokens.length === 0 ||
				tokens.some(
					(token) =>
						token.replace(/\.\*$/, "") !== expected[column],
				)
			) {
				errors.push(
					label +
						" " +
						cells[0] +
						" " +
						MIGRATION_GUIDE_TUPLE_HEADER[column + 1] +
						" cell disagrees with docs/compatibility.v1.csv (expected " +
						expected[column] +
						")",
				);
			}
		}
	}
	for (const rowName of expectations.keys()) {
		if (!seen.has(rowName))
			errors.push(label + " is missing its " + rowName + " row");
	}
	return {
		errors,
		remainder: [
			...lines.slice(0, headerIndex),
			"",
			...lines.slice(end),
		].join("\n"),
	};
}

export function validatePublishedCompatibilityDocuments(documents, rows) {
	const errors = [];
	for (const [relative, source] of Object.entries(documents)) {
		if (relative === "README.md") {
			errors.push(...validateReadmeCompatibility(source, rows));
			continue;
		}
		if (relative === "MIGRATION.md") {
			errors.push(...validateMigrationCompatibility(source));
			continue;
		}
		if (relative === MIGRATION_GUIDE_RELATIVE_PATH) {
			const bound = validateMigrationGuideTupleTable(source, rows);
			errors.push(
				...bound.errors,
				...validateUnownedPublishedSource(relative, bound.remainder),
			);
			continue;
		}
		errors.push(...validateUnownedPublishedSource(relative, source));
	}
	return errors;
}

function publishedMarkdownDocuments(pkg) {
	const paths = new Set();
	const visit = (absolute, relativePath) => {
		if (!existsSync(absolute)) return;
		const stat = statSync(absolute);
		if (stat.isDirectory()) {
			for (const entry of readdirSync(absolute))
				visit(join(absolute, entry), join(relativePath, entry));
			return;
		}
		if (stat.isFile() && relativePath.toLowerCase().endsWith(".md")) {
			paths.add(relativePath.split("\\").join("/"));
		}
	};
	for (const entry of pkg.files || []) visit(join(root, entry), entry);
	for (const npmIncluded of ["README.md", "MIGRATION.md"])
		visit(join(root, npmIncluded), npmIncluded);
	return Object.fromEntries(
		[...paths]
			.sort()
			.map((relativePath) => [
				relativePath,
				readFileSync(join(root, relativePath), "utf8"),
			]),
	);
}

/**
 * Cross-check the current workspace row against the sibling checkouts that
 * are actually present next to this repository. The lockstep rule inside
 * validateCompatibility is the hermetic bound; this escalates it to the real
 * sibling package.json whenever the workspace the row's provenance names is
 * reachable, and stays silent on a checkout (CI, a consumer) that has no
 * siblings - absence is not drift, it is a different machine.
 */
export function validateWorkspaceSiblings(rows, readSibling) {
	const errors = [];
	const current = rows.find((row) => row.current === "true");
	if (!current || current.provenance !== "workspace") return errors;
	for (const [field, name] of [
		["realtime", "svelte-realtime"],
		["extensions", "svelte-adapter-uws-extensions"],
	]) {
		const sibling = readSibling(name);
		if (sibling === null) continue;
		if (sibling.unreadable === true) {
			// The directory is present, so this is a distinguishable anomaly,
			// not a machine without the workspace - report it rather than
			// mapping a corrupt file onto absence.
			errors.push(
				current.channel +
					": workspace sibling " +
					name +
					" package.json is unreadable",
			);
			continue;
		}
		if (sibling.name !== name || typeof sibling.version !== "string") {
			errors.push(
				current.channel +
					": workspace sibling directory " +
					name +
					" does not contain that package",
			);
			continue;
		}
		if (!matchesSeries(sibling.version, current[field])) {
			errors.push(
				current.channel +
					": workspace sibling " +
					name +
					"@" +
					sibling.version +
					" is outside the declared " +
					field +
					" series " +
					current[field],
			);
		}
	}
	return errors;
}

function readWorkspaceSibling(name) {
	const siblingPath = resolve(root, "..", name, "package.json");
	if (!existsSync(siblingPath)) return null;
	try {
		return JSON.parse(readFileSync(siblingPath, "utf8"));
	} catch {
		return { unreadable: true };
	}
}

function main() {
	const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
	const rows = parseCompatibility(readFileSync(manifestPath, "utf8"));
	const readme = readFileSync(readmePath, "utf8");
	const migration = readFileSync(migrationPath, "utf8");
	const publishedDocuments = publishedMarkdownDocuments(pkg);
	const errors = [
		...validateCompatibility(rows, pkg),
		...validateWorkspaceSiblings(rows, readWorkspaceSibling),
		...validatePublishedCompatibilityDocuments(publishedDocuments, rows),
	];
	if (errors.length) {
		console.error("check-compatibility FAILED:");
		for (const error of errors) console.error("  x " + error);
		process.exit(1);
	}

	const rendered = renderCompatibility(rows);
	const updated = replaceCompatibilityBlock(readme, rendered);
	const renderedMigration = renderMigrationCompatibility(rows);
	const updatedMigration = replaceMigrationCompatibilityBlock(
		migration,
		renderedMigration,
	);
	if (process.argv.includes("--write")) {
		writeFileSync(readmePath, updated);
		writeFileSync(migrationPath, updatedMigration);
		console.log(
			"check-compatibility: README and MIGRATION.md blocks regenerated.",
		);
		return;
	}
	if (updated !== readme || updatedMigration !== migration) {
		console.error(
			"check-compatibility FAILED: generated documentation is stale; run node scripts/check-compatibility.js --write",
		);
		process.exit(1);
	}
	console.log(
		"check-compatibility: " +
			rows.length +
			" channels agree with " +
			pkg.name +
			"@" +
			pkg.version +
			" and published docs.",
	);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	main();
