import { readFileSync } from 'node:fs';
import MarkdownIt from 'markdown-it';
import { parse, parseFragment } from 'parse5';
import { describe, expect, it } from 'vitest';

const read = (relative) => readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
const README = read('README.md');
const MIGRATION = read('MIGRATION.md');
const PROTOCOL = read('PROTOCOL.md');
const VECTORS = read('test-vectors/README.md');
const PACKAGE = JSON.parse(read('package.json'));
const PACKAGED_RELEASE_HISTORY = './CHANGELOG.md';
const VECTORS_RELEASE_HISTORY = '../CHANGELOG.md';
// Derived from the newest CHANGELOG heading so a version bump cannot leave a
// stale hardcoded route in this suite.
const NEWEST_RELEASE = /^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}$/m.exec(read('CHANGELOG.md'))[1];
const CURRENT_RELEASE = './docs/releases/' + NEWEST_RELEASE + '.md';
const DOCS_SITE = 'https://svelte-realtime.dev/';
const OFFICIAL_LINKS = '**Official links:** [GitHub owner](https://github.com/lanteanio) | [Documentation](' + DOCS_SITE + ') | [Live demo](https://svelte-realtime-demo.lantean.io/) | `svti.me` is the ecosystem-owned runtime-help redirect domain.';
const EXPECTED_MAP_SOURCE = [
	'**Documentation:** [documentation site](' + DOCS_SITE + ') |',
	'[migration guide](./MIGRATION.md) | [wire protocol](./PROTOCOL.md) |',
	'[observability contract](./docs/observability.md) |',
	'[privacy integration contract](./docs/privacy-integration.md) |',
	'[operations pack v1](./docs/operations/v1/README.md) |',
	'[capacity kit v1](./docs/capacity/v1/README.md) |',
	'[translation contract](./docs/translating.md) |',
	'[compatibility manifest](./docs/compatibility.v1.csv) |',
	'[claim register](./docs/claim-register.md) |',
	'[protocol conformance](./docs/protocol-conformance.md) |',
	'[protocol schema](./protocol.schema.json) | [test vectors](./test-vectors/README.md) |',
	'[current release](' + CURRENT_RELEASE + ') |',
	'[release history](' + PACKAGED_RELEASE_HISTORY + ')'
].join('\n');
const OWNERSHIP_HEADING = '**Documentation ownership (`docs-ownership-v1`):**';
const OWNERSHIP_HEADER_CELLS = ['Ownership key', 'Documentation surface', 'Canonical owner'];
const EXPECTED_TOP_CONTRACT = EXPECTED_MAP_SOURCE + '\n\n' + OWNERSHIP_HEADING;
const EXPECTED_MAP_TEXT = 'Documentation: documentation site | migration guide | wire protocol | observability contract | privacy integration contract | operations pack v1 | capacity kit v1 | translation contract | compatibility manifest | claim register | protocol conformance | protocol schema | test vectors | current release | release history';
const EXPECTED_RELATED_MARKDOWN = '- [svelte-realtime.dev](' + DOCS_SITE + ') - Canonical long-form ecosystem guides, searchable reference, and hosted deployment walkthroughs.';
const EXPECTED_RELATED_TEXT = 'svelte-realtime.dev - Canonical long-form ecosystem guides, searchable reference, and hosted deployment walkthroughs.';
// All six declared owners. The local operations pack owns the versioned
// incident material; the documentation site owns hosted long-form
// walkthroughs. Padding inside the README table is normalized before
// comparison, so this models content, not column widths.
const EXPECTED_OWNERSHIP_ROWS = [
	['adapter-package', 'Identity, installation, support status, and versioned-companion routes', 'README.md'],
	['ecosystem-contract', 'Versioned package boundaries and accepted architecture decisions', 'docs/architecture.md'],
	['ecosystem-privacy', 'Processing inventory, retention/erasure defaults, and host compliance worksheet', 'docs/privacy-integration.md'],
	['ecosystem-operations', 'Versioned incident failure map, decision runbooks, drills, and handoffs', 'docs/operations/v1'],
	['ecosystem-capacity', 'Peak/SLO/topology worksheet, open-arrival runner, result schema, and launch gate', 'docs/capacity/v1'],
	['ecosystem-long-form', 'Long-form ecosystem guides, searchable reference, and hosted deployment walkthroughs', 'svelte-realtime.dev']
];

const markdown = new MarkdownIt({ html: true, linkify: true, typographer: false });
const NON_RENDERED_ELEMENTS = new Set(['code', 'head', 'noscript', 'pre', 'script', 'style', 'template']);
const BLOCK_ELEMENTS = new Set([
	'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'div', 'dl', 'dt',
	'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
	'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table',
	'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul'
]);
const LOCAL_DOCUMENT_OWNER = '(?:this readme|the readme|readme|adapter handbook|adapter manual|adapter documentation|package handbook|package manual|package docs|package documentation|these package docs|this package|this repository|this file|here|locally)';
const SITE_DOCUMENT_OWNER = '(?:the documentation site|documentation site|svelte realtime dev)';
const JOINT_CONNECTOR = '(?:and|plus|alongside|along with|together with|in tandem with|in partnership with|in concert with|in alliance with|jointly with|in collaboration with)';
const JOINT_DOCUMENT_OWNER = '(?:(?:both )?' + LOCAL_DOCUMENT_OWNER + ' ' + JOINT_CONNECTOR + ' ' + SITE_DOCUMENT_OWNER + '|(?:both )?' + SITE_DOCUMENT_OWNER + ' ' + JOINT_CONNECTOR + ' ' + LOCAL_DOCUMENT_OWNER + '|the two owners|both owners|the declared owners|these owners)';
const OWNER_AUTHORITY_ROLE = '(?:(?:canonical|authoritative|definitive|official|primary)(?: sources?| homes?| records?)?|(?:sole|exclusive) (?:authority|home|source|record)|authority|home|editorial authority|permanent home|system of record|source of truth|decision maker|(?:ultimate )?arbiter|(?:designated|governing) authority|(?:co[- ]?)?owners?|(?:co[- ]?)?maintainers?|custodians?|stewards?)';
const OWNER_ACTION = '(?:own(?:s|ing)?|co[- ]?owns?|(?:has|have|holds?) (?:joint )?ownership(?: of| over)?|shares? ownership|maintain(?:s|ing)?|manages?|administers?|authors?|curates?|publishes?|houses?|hosts?|stewards?|supervis(?:es|ing)?|leads?(?! (?:readers?|users?|visitors?|people)\\b)|keeps?(?= (?:[a-z0-9-]+ ){0,24}(?:current|up to date)\\b)|directs?(?! (?:readers?|users?|visitors?|people)\\b)|controls?|governs?|oversees?|defines?|shares? custody|has custody|assumes? custody(?: of| over)?|shares? (?:the )?mandate(?: for| over)?|has (?:the )?final say(?: over| for)?|(?:has|have) veto power(?: over| for)?|makes? (?:the )?final decisions?(?: about| over| for)?|(?:is|are|remains?) tasked(?: with| to)?|(?:has|have|holds?) (?:joint )?oversight(?: of| over)?|exercises? (?:joint )?oversight(?: of| over)?|shares? maintenance responsibility|shares? responsibility|splits? responsibility|divides? responsibility|bears? responsibility(?: for)?|assumes? responsibility(?: for)?|accepts? responsibility(?: for)?|(?:has|have|holds?) (?:editorial )?control(?: over| of)?|has jurisdiction(?: over)?|exercises jurisdiction(?: over)?|holds? (?:the )?remit(?: for| over)?|(?:has|holds?|retains?) authority(?: over| for)?|wields? authority(?: over| for)?|has editorial authority|exercises authority(?: over| for)?|takes? charge(?: of| over)?|(?:is|are|remains?) in charge(?: of| over)?|is charged(?: with| to)?|is entrusted(?: with| to)?|(?:is|are|remains?) responsible(?: for)?|(?:is|are|remains?) accountable(?: for)?|takes responsibility|accepts accountability(?: for)?|exercises editorial control|routes readers through its own)';
const PACKAGE_DOCUMENT_SCOPE = /\b(?:identity|install(?:ation|ing)?|setup|support status|version(?:ed)? companion rout(?:e|es|ing)|compatibility manifests?|test vectors?)\b/i;
const ECOSYSTEM_DOCUMENT_SCOPE = /\b(?:long form|ecosystem|guides?|tutorials?|articles?|documentation|how to|recipes?|manuals?|references?|api|endpoints?|functions?|symbols?|lookup|catalog(?:ue|og)s?|encyclop(?:aedia|edia)s?|operations?|walkthroughs?|playbooks?|runbooks?|deploy(?:ment|ing)|incidents?|production|operators?|administrators?|procedures?|search(?:able)?|deep dive)\b/i;
const PACKAGE_SCOPE_TERM = '(?:identity|install(?:ation|ing)?|setup|support(?: status)?|version(?:ed)? companion rout(?:e|es|ing)|compatibility manifests?|test vectors?)';
const DOCUMENTATION_NOUN = '(?:documentation|docs|guides?|manuals?|references?(?: material)?)';
const PACKAGE_SCOPE_QUALIFIER = '(?:(?:specifically|solely|only|exclusively|particularly) )?';
const PACKAGE_QUALIFIED_DOCUMENTATION = new RegExp(
	'\\b(?:' + PACKAGE_SCOPE_TERM + '(?: (?:(?:and|or) )?' + PACKAGE_SCOPE_TERM + '){0,2} ' + DOCUMENTATION_NOUN + '|' +
	PACKAGE_SCOPE_TERM + ' only ' + DOCUMENTATION_NOUN + '|' +
	DOCUMENTATION_NOUN + ' ' + PACKAGE_SCOPE_QUALIFIER + '(?:for|about|on|to|covering|concerning|pertaining to|regarding|devoted to|related to|dedicated to|intended for|limited to|focused on|supporting) ' + PACKAGE_SCOPE_TERM + '(?: (?:(?:and|or) )?' + PACKAGE_SCOPE_TERM + '){0,2}|' +
	PACKAGE_SCOPE_TERM + ' (?:focused|specific|related|oriented) ' + DOCUMENTATION_NOUN + ')\\b',
	'gi'
);
const STRUCTURAL_AUTHORITY_CUE = /\b(?:canonical owners?|owners?|ownership|responsibility|responsible|accountability|accountable|arbiter|authority|authoritative|assigned|assignment|charge|charged|control|custody|custodian|decision maker|final decisions?|final say|granted|home|leads?|mandate|oversight|resident|residency|stewardship|steward|tasked|veto|maintainers?|maintenance|maintained|managed|administered|authored|curated|published|housed|hosted|supervised|governed|controlled)\b/i;

function normalizeSource(source) {
	return source.replace(/\r\n/g, '\n');
}

function occurrences(source, needle) {
	let count = 0;
	let offset = 0;
	while ((offset = source.indexOf(needle, offset)) !== -1) {
		count++;
		offset += needle.length;
	}
	return count;
}

function attribute(node, name) {
	return node.attrs?.find((candidate) => candidate.name.toLowerCase() === name)?.value ?? null;
}

function hasAttribute(node, name) {
	return node.attrs?.some((candidate) => candidate.name.toLowerCase() === name) ?? false;
}

function browserEffectiveUrlAttribute(value) {
	return value
		.replace(/[\t\n\r]/g, '')
		.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '')
		.toLowerCase();
}

function isInAttributeSubtree(node, name) {
	for (let cursor = node; cursor; cursor = cursor.parentNode) {
		if (hasAttribute(cursor, name)) return true;
	}
	return false;
}

function isInInactiveSubtree(node) {
	return isInAttributeSubtree(node, 'hidden') || isInAttributeSubtree(node, 'inert');
}

function elementIsHidden(node) {
	if (!node.tagName) return false;
	const tag = node.tagName.toLowerCase();
	if (NON_RENDERED_ELEMENTS.has(tag) || hasAttribute(node, 'hidden')) return true;
	if (tag === 'dialog' && !hasAttribute(node, 'open')) return true;
	if (tag === 'input' && attribute(node, 'type')?.trim().toLowerCase() === 'hidden') return true;
	const style = (attribute(node, 'style') ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
	const declarations = new Map(style.split(';').map((declaration) => {
		const separator = declaration.indexOf(':');
		if (separator < 0) return ['', ''];
		return [
			declaration.slice(0, separator).trim().toLowerCase(),
			declaration.slice(separator + 1).replace(/\s*!important\s*$/i, '').trim().toLowerCase()
		];
	}));
	return declarations.get('display') === 'none' ||
		['hidden', 'collapse'].includes(declarations.get('visibility'));
}

function renderedDocument(source) {
	const root = parseFragment(markdown.render(source));
	const visible = new WeakSet([root]);
	const elements = [];

	function visit(node) {
		if (node.nodeName === '#comment' || elementIsHidden(node)) return;
		visible.add(node);
		if (node.tagName) elements.push(node);
		const closedDetails = node.tagName === 'details' && !hasAttribute(node, 'open');
		let sawSummary = false;
		for (const child of node.childNodes ?? []) {
			if (closedDetails) {
				if (child.tagName === 'summary' && !sawSummary) {
					sawSummary = true;
					visit(child);
				}
				continue;
			}
			visit(child);
		}
	}

	for (const child of root.childNodes ?? []) visit(child);

	function text(node, skipped = new Set()) {
		if (!visible.has(node) || skipped.has(node)) return '';
		if (node.nodeName === '#text') return node.value;
		const block = BLOCK_ELEMENTS.has(node.tagName);
		const value = (node.childNodes ?? []).map((child) => text(child, skipped)).join('');
		return block ? ' ' + value + ' ' : value;
	}

	return {
		root,
		elements,
		text: (node, skipped) => text(node, skipped).replace(/\s+/g, ' ').trim()
	};
}

function strictRenderedShapes(source) {
	const rendered = markdown.render(source);
	const root = parseFragment(rendered);
	const fullDocument = parse(rendered);
	const elements = [];

	function visit(node) {
		if (node.tagName) elements.push(node);
		for (const child of node.childNodes ?? []) visit(child);
	}
	visit(root);
	const documentElements = [];
	function visitDocument(node) {
		if (node.tagName) documentElements.push(node);
		for (const child of node.childNodes ?? []) visitDocument(child);
	}
	visitDocument(fullDocument);

	function text(node) {
		if (node.nodeName === '#text') return node.value;
		return (node.childNodes ?? []).map(text).join('').replace(/\s+/g, ' ').trim();
	}

	function path(node) {
		const tags = [];
		for (let cursor = node; cursor?.tagName; cursor = cursor.parentNode) tags.push(cursor.tagName);
		return tags.join('>');
	}

	function link(label, expectedPath, parentText) {
		const matches = elements.filter((node) => node.tagName === 'a' &&
			text(node).toLowerCase() === label && attribute(node, 'href') === DOCS_SITE &&
			node.attrs?.length === 1 && path(node) === expectedPath &&
			text(node.parentNode) === parentText);
		return matches.length === 1;
	}

	const tables = elements.filter((node) => node.tagName === 'table' &&
		text(node).startsWith('Ownership key Documentation surface Canonical owner') &&
		path(node) === 'table');
	const styleInterference = elements.some((node) =>
		node.tagName === 'style' || attribute(node, 'style') !== null ||
		(node.tagName === 'link' && (attribute(node, 'rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet'))
	);
	const documentInterference = documentElements.some((node) =>
		['html', 'body'].includes(node.tagName) && (
			hasAttribute(node, 'hidden') || hasAttribute(node, 'inert') ||
			(hasAttribute(node, 'aria-hidden') && attribute(node, 'aria-hidden')?.trim().toLowerCase() !== 'false') ||
			(hasAttribute(node, 'aria-disabled') && attribute(node, 'aria-disabled')?.trim().toLowerCase() !== 'false') ||
			hasAttribute(node, 'popover') || attribute(node, 'style') !== null ||
			['background', 'bgcolor', 'text', 'link', 'vlink', 'alink'].some((name) => hasAttribute(node, name))
		)
	);
	const executableOrNavigationInterference = documentElements.some((node) => {
		const tag = node.tagName?.toLowerCase();
		if (tag === 'script' || node.attrs?.some((candidate) => candidate.name.toLowerCase().startsWith('on'))) {
			return true;
		}
		if (node.attrs?.some((candidate) =>
			['href', 'src', 'action', 'formaction'].includes(candidate.name.toLowerCase()) &&
			browserEffectiveUrlAttribute(candidate.value).startsWith('javascript:')
		)) return true;
		if (tag === 'object') {
			const data = browserEffectiveUrlAttribute(attribute(node, 'data') ?? '');
			if (/^data:text\/html(?:[;,]|$)/.test(data) && !isInAttributeSubtree(node, 'hidden')) return true;
			if (data.startsWith('javascript:') && !isInInactiveSubtree(node)) return true;
		}
		if (tag === 'iframe' && hasAttribute(node, 'srcdoc')) return true;
		if (tag === 'meta' && attribute(node, 'http-equiv')?.trim().toLowerCase() === 'refresh') return true;
		return tag === 'base';
	});
	return {
		topRoute: link('documentation site', 'a>p', EXPECTED_MAP_TEXT),
		relatedRoute: link('svelte-realtime.dev', 'a>li>ul', EXPECTED_RELATED_TEXT),
		relatedHeading: elements.filter((node) => node.tagName === 'h2' &&
			text(node) === 'Related projects' && path(node) === 'h2').length === 1,
		ownershipTable: tables.length === 1,
		styleInterference: styleInterference || documentInterference,
		executableOrNavigationInterference
	};
}

function sectionSource(source, heading, nextHeading) {
	const startMarker = '\n## ' + heading + '\n';
	const endMarker = '\n## ' + nextHeading + '\n';
	const start = source.indexOf(startMarker);
	if (start === -1) return null;
	const bodyStart = start + startMarker.length;
	const end = source.indexOf(endMarker, bodyStart);
	return end === -1 ? null : source.slice(bodyStart, end);
}

// Reads the ownership table that actually follows the ownership heading and
// normalizes cell padding, so the assertion models table content for all
// declared owners rather than one historical column-width rendering.
function parseOwnershipTable(source) {
	const headingAt = source.indexOf(OWNERSHIP_HEADING);
	if (headingAt === -1) return null;
	const lines = source.slice(headingAt + OWNERSHIP_HEADING.length).split('\n');
	let index = 0;
	while (index < lines.length && lines[index].trim() === '') index++;
	const tableLines = [];
	while (index < lines.length && lines[index].trim().startsWith('|')) {
		tableLines.push(lines[index].trim());
		index++;
	}
	if (tableLines.length < 3) return null;
	const parseRow = (line) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) =>
		cell.trim().replace(/^`|`$/g, '')
	);
	return {
		header: parseRow(tableLines[0]),
		rows: tableLines.slice(2).map(parseRow)
	};
}

function ownershipTableMatches(source) {
	const table = parseOwnershipTable(source);
	return table !== null &&
		JSON.stringify(table.header) === JSON.stringify(OWNERSHIP_HEADER_CELLS) &&
		JSON.stringify(table.rows) === JSON.stringify(EXPECTED_OWNERSHIP_ROWS);
}

function isInside(node, ancestors) {
	for (let cursor = node; cursor; cursor = cursor.parentNode) {
		if (ancestors.has(cursor)) return true;
	}
	return false;
}

function ownerAuthorityClaim(text, owner, localOwner) {
	const subjectAuthority = new RegExp('\\b' + owner + '\\b(?: is| are| serves? as| acts? as| remains?| becomes?)?(?: now)?(?: the| an?| its)?(?: complete| full)? ' + OWNER_AUTHORITY_ROLE + '\\b', 'i');
	const subjectAction = new RegExp('\\b' + owner + '\\b (?:(?:directly|also|now|officially|explicitly|fully|locally|jointly|collectively|both|each|alone|itself|we|continues?(?: to)?) ){0,3}' + OWNER_ACTION + '\\b', 'i');
	const possessiveAuthority = new RegExp('\\b' + owner + '\\b s (?:jurisdiction|custody|remit|responsibility|ownership|authority)\\b', 'i');
	const passiveAction = new RegExp('\\b(?:maintained|managed|administered|authored|curated|published|housed|stewarded|kept current|directed|assigned|wielded|resident|lives?|resides?|(?:co )?owned|responsibility|editorial (?:control|authority))\\b(?: [a-z0-9-]+){0,6} (?:by|in|within|of|to) (?:the )?' + owner + '\\b', 'i');
	const destination = new RegExp('\\b(?:belongs? to ' + owner + '|falls? under (?:the )?' + owner + '|come(?:s)? under (?:local )?editorial (?:control|authority) in ' + owner + '|falls? within (?:the )?remit of ' + owner + '|(?:(?:is|are) )?(?:under|within|in) (?:the )?(?:jurisdiction|custody|remit|authority|responsibility) of (?:the )?' + owner + ')\\b', 'i');
	const restingAuthority = new RegExp('\\b(?:responsibility|ownership|custody|authority|stewardship|charge)\\b(?: [a-z0-9-]+){0,24} (?:rests?|lies?) with (?:the )?' + owner + '\\b', 'i');
	const assignedAuthority = new RegExp('\\b(?:ownership|responsibility|custody|authority)\\b(?: [a-z0-9-]+){0,24} (?:(?:is|are|was|were) )?(?:assigned|granted) to (?:the )?' + owner + '\\b', 'i');
	const assignedOwner = new RegExp('\\b' + owner + '\\b (?:was|were|is|are|has been|have been) assigned\\b', 'i');
	const homeDestination = new RegExp('\\b(?:has|have) (?:its|their|a) home (?:in|within|at) (?:the )?' + owner + '\\b', 'i');
	const localDestination = localOwner && /\b(?:(?:lives?|resides?|belongs?) (?:here|locally)|(?:has|have) (?:its|their|a) home here|here we (?:house|maintain|author|curate|publish|control|govern))\b/i.test(text);
	return subjectAuthority.test(text) || subjectAction.test(text) || possessiveAuthority.test(text) || passiveAction.test(text) ||
		destination.test(text) || restingAuthority.test(text) || assignedAuthority.test(text) || assignedOwner.test(text) ||
		homeDestination.test(text) || localDestination;
}

function jointOwnershipClaim(text) {
	const normalized = text.toLowerCase().replace(/\+/g, ' plus ').replace(/[^a-z0-9]+/g, ' ').trim();
	if (ownerAuthorityClaim(normalized, JOINT_DOCUMENT_OWNER, false)) return true;
	if (/\bthey (?:have|hold) joint (?:ownership|responsibility|custody|authority)\b/i.test(normalized)) return true;
	if (/\b(?:ownership|responsibility|custody|authority)\b(?: [a-z0-9-]+){0,24} (?:is |are )?held jointly\b/i.test(normalized)) return true;
	const sharedResponsibility = new RegExp(
		'\\b(?:responsibility|ownership|custody|authority)\\b(?: [a-z0-9-]+){0,24} ' +
		'(?:is |are )?(?:shared|split|divided)(?: (?:between|across|among))? (?:the )?' + JOINT_DOCUMENT_OWNER + '\\b',
		'i'
	);
	return sharedResponsibility.test(normalized);
}

function ownershipAssignment(text) {
	const normalized = text.toLowerCase().replace(/\+/g, ' plus ').replace(/[^a-z0-9]+/g, ' ').trim();
	return jointOwnershipClaim(normalized) ||
		ownerAuthorityClaim(normalized, LOCAL_DOCUMENT_OWNER, true) ||
		ownerAuthorityClaim(normalized, SITE_DOCUMENT_OWNER, false);
}

function ownershipClauses(sentence) {
	const connector = '(?:and|but|while|whereas|although|as|with|yet|because|since|for|even though|given that)';
	const separator = new RegExp('(?:,\\s*(?:' + connector + '\\s+)?|\\s*(?::|\\u2014|/)\\s*|\\s*-{2}\\s*|\\s+-\\s+|\\s*\\(\\s*|<br\\s*/?>|\\b' + connector + '\\s+)', 'gi');
	const matches = [...sentence.matchAll(separator)];
	const nextOwner = new RegExp('^(?:' + LOCAL_DOCUMENT_OWNER + '|' + SITE_DOCUMENT_OWNER + ')\\b', 'i');
	function separatorRank(match) {
		const token = match[0].trim().toLowerCase();
		if (token.startsWith(',') && token !== ',') return 4;
		if (/^(?:but|while|whereas|although|yet|because|since|even though|given that)\b/.test(token)) return 3;
		const right = sentence.slice(match.index + match[0].length).trim();
		if (nextOwner.test(right)) return 2;
		return token === ',' || token === '/' || token === '(' ? 1 : 0;
	}
	matches.sort((left, right) => separatorRank(right) - separatorRank(left) || right.index - left.index);
	for (const match of matches) {
		if (separatorRank(match) === 0) continue;
		const left = sentence.slice(0, match.index).trim();
		const right = sentence.slice(match.index + match[0].length).trim();
		if (ownershipAssignment(left) && ownershipAssignment(right)) {
			return [...ownershipClauses(left), ...ownershipClauses(right)];
		}
	}
	return [sentence];
}

function boundedOwnershipClause(text) {
	const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
	const localClaim = ownerAuthorityClaim(normalized, LOCAL_DOCUMENT_OWNER, true);
	const siteClaim = ownerAuthorityClaim(normalized, SITE_DOCUMENT_OWNER, false);
	if (!localClaim && !siteClaim) return false;

	const scopeText = normalized
		.replace(new RegExp('\\b' + LOCAL_DOCUMENT_OWNER + '\\b', 'gi'), ' ')
		.replace(new RegExp('\\b' + SITE_DOCUMENT_OWNER + '\\b', 'gi'), ' ');
	const packageScope = PACKAGE_DOCUMENT_SCOPE.test(scopeText);
	const ecosystemScope = ECOSYSTEM_DOCUMENT_SCOPE.test(
		scopeText.replace(PACKAGE_QUALIFIED_DOCUMENTATION, ' ')
	);
	const consistentPackageClaim = localClaim && !siteClaim && packageScope && !ecosystemScope;
	const consistentSiteClaim = siteClaim && !localClaim && ecosystemScope && !packageScope;
	return !consistentPackageClaim && !consistentSiteClaim;
}

function boundedOwnershipClaim(text) {
	const sentences = text.split(/[.!?;]+/).map((sentence) => sentence.trim()).filter(Boolean);
	return sentences.some((sentence) => {
		if (jointOwnershipClaim(sentence)) return true;
		return ownershipClauses(sentence).some((clause) => boundedOwnershipClause(clause));
	});
}

function documentScopes(text) {
	const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
	const scopeText = normalized
		.replace(new RegExp('\\b' + LOCAL_DOCUMENT_OWNER + '\\b', 'gi'), ' ')
		.replace(new RegExp('\\b' + SITE_DOCUMENT_OWNER + '\\b', 'gi'), ' ');
	return {
		packageScope: PACKAGE_DOCUMENT_SCOPE.test(scopeText),
		ecosystemScope: ECOSYSTEM_DOCUMENT_SCOPE.test(scopeText.replace(PACKAGE_QUALIFIED_DOCUMENTATION, ' '))
	};
}

function ownerPresence(text, owner) {
	return new RegExp('\\b' + owner + '\\b', 'i').test(text);
}

function completeOwnershipFragment(text) {
	const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
	const { packageScope, ecosystemScope } = documentScopes(normalized);
	if (!packageScope && !ecosystemScope) return false;
	return ownershipAssignment(normalized) || (
		STRUCTURAL_AUTHORITY_CUE.test(normalized) &&
		(ownerPresence(normalized, LOCAL_DOCUMENT_OWNER) || ownerPresence(normalized, SITE_DOCUMENT_OWNER))
	);
}

function structuralBoundedOwnershipClaim(text) {
	const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
	if (!STRUCTURAL_AUTHORITY_CUE.test(normalized)) return false;
	const localOwner = ownerPresence(normalized, LOCAL_DOCUMENT_OWNER);
	const siteOwner = ownerPresence(normalized, SITE_DOCUMENT_OWNER);
	if (!localOwner && !siteOwner) return false;
	const { packageScope, ecosystemScope } = documentScopes(normalized);
	return (localOwner && ecosystemScope) || (siteOwner && packageScope);
}

function tableHeadingText(node, rendered, approved) {
	if (node.tagName !== 'tr') return '';
	let table = node.parentNode;
	while (table && table.tagName !== 'table') table = table.parentNode;
	if (!table) return '';
	const heading = rendered.elements.find((candidate) =>
		candidate.tagName === 'tr' && isInside(candidate, new Set([table])) &&
		(candidate.childNodes ?? []).some((child) =>
			['th', 'td'].includes(child.tagName) && STRUCTURAL_AUTHORITY_CUE.test(rendered.text(child, approved))
		)
	);
	if (!heading) return '';
	return (heading.childNodes ?? [])
		.filter((child) => ['th', 'td'].includes(child.tagName))
		.map((child) => rendered.text(child, approved))
		.filter((cell) => STRUCTURAL_AUTHORITY_CUE.test(cell))
		.join(' ');
}

function ownershipFragmentContradiction(text) {
	const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
	if (ownershipAssignment(normalized)) return boundedOwnershipClaim(text);
	return structuralBoundedOwnershipClaim(text);
}

function fragmentSpansAlignedRecords(text) {
	const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
	const { packageScope, ecosystemScope } = documentScopes(normalized);
	return packageScope && ecosystemScope &&
		ownerPresence(normalized, LOCAL_DOCUMENT_OWNER) &&
		ownerPresence(normalized, SITE_DOCUMENT_OWNER);
}

function ownershipFragmentRecords(fragments) {
	const records = [];
	let partial = [];
	for (const fragment of fragments) {
		if (completeOwnershipFragment(fragment)) {
			records.push(fragment);
			continue;
		}
		partial.push(fragment);
		const combined = partial.join(' ');
		if (completeOwnershipFragment(combined)) {
			records.push(combined);
			partial = [];
		}
	}
	return { records, partial };
}

function aggregateOwnershipClaim(node, rendered, approved) {
	if (isInside(node, approved)) return false;
	const fragments = (node.childNodes ?? [])
		.map((child) => ({ child, text: rendered.text(child, approved) }))
		.filter(({ child, text }) => !child.tagName || !fragmentSpansAlignedRecords(text))
		.map(({ text }) => text)
		.filter(Boolean);
	const { records, partial } = ownershipFragmentRecords(fragments);
	if (records.some(ownershipFragmentContradiction)) return true;
	if (partial.length === 0) return false;
	const context = tableHeadingText(node, rendered, approved);
	return ownershipFragmentContradiction([context, ...partial].filter(Boolean).join(' '));
}

function ownershipFailures(document) {
	const failures = [];
	const source = normalizeSource(document);
	const shapes = strictRenderedShapes(source);
	if (shapes.styleInterference) {
		failures.push('README contains rendered styling that can interfere with canonical routes');
	}
	if (shapes.executableOrNavigationInterference) {
		failures.push('README contains rendered executable or navigation interference with canonical routes');
	}
	const divider = source.indexOf('\n\n---\n');
	const preface = divider === -1 ? '' : source.slice(0, divider);
	const exactTopContract = occurrences(preface, EXPECTED_TOP_CONTRACT) === 1;
	if (occurrences(preface, OFFICIAL_LINKS) !== 1 ||
		occurrences(preface, EXPECTED_MAP_SOURCE) !== 1 ||
		occurrences(source, EXPECTED_MAP_SOURCE) !== 1 ||
		occurrences(preface.toLowerCase(), 'https://svelte-realtime.dev') !== 2 ||
		!exactTopContract || !shapes.topRoute) {
		failures.push('top documentation-site route drifted');
	}
	if (occurrences(source, OWNERSHIP_HEADING) !== 1 ||
		!ownershipTableMatches(preface) || !exactTopContract ||
		!shapes.ownershipTable) {
		failures.push('bounded ownership table drifted');
	}

	const related = sectionSource(source, 'Related projects', 'License');
	if (related === null || occurrences(source, '\n## Related projects\n') !== 1 ||
		occurrences(source, EXPECTED_RELATED_MARKDOWN) !== 1 ||
		!related.startsWith('\n' + EXPECTED_RELATED_MARKDOWN + '\n') ||
		occurrences(related.toLowerCase(), 'https://svelte-realtime.dev') !== 1 ||
		!shapes.relatedRoute || !shapes.relatedHeading) {
		failures.push('related-projects documentation-site route drifted');
	}

	const rendered = renderedDocument(source);
	const ownershipTable = rendered.elements.find((node) =>
		node.tagName === 'table' && rendered.text(node).startsWith('Ownership key Documentation surface Canonical owner')
	);
	const relatedItems = rendered.elements.filter((node) =>
		node.tagName === 'li' && rendered.text(node) === EXPECTED_RELATED_TEXT
	);
	const approved = new Set([ownershipTable, ...relatedItems].filter(Boolean));
	const competingClaim = rendered.elements.some((node) =>
		aggregateOwnershipClaim(node, rendered, approved)
	);
	if (competingClaim) {
		failures.push('README contains an additional bounded ownership claim');
	}
	return failures;
}

describe('documentation map', () => {
	it('links every companion from the package README', () => {
		for (const target of [
			DOCS_SITE,
			'./MIGRATION.md',
			'./PROTOCOL.md',
			'./docs/observability.md',
			'./docs/privacy-integration.md',
			'./docs/operations/v1/README.md',
			'./docs/capacity/v1/README.md',
			'./docs/translating.md',
			'./docs/compatibility.v1.csv',
			'./protocol.schema.json',
			'./test-vectors/README.md',
			CURRENT_RELEASE,
			PACKAGED_RELEASE_HISTORY
		]) {
			expect(README).toContain(`](${target})`);
		}
	});

	it('publishes one exact machine-readable ownership table modeling every declared owner', () => {
		const table = parseOwnershipTable(normalizeSource(README));
		expect(table).not.toBeNull();
		expect(table.header).toEqual(OWNERSHIP_HEADER_CELLS);
		expect(table.rows).toEqual(EXPECTED_OWNERSHIP_ROWS);
		expect(table.rows).toHaveLength(6);
		expect(new Set(table.rows.map((row) => row[0])).size).toBe(6);
		expect(ownershipFailures(README)).toEqual([]);
	});

	it('keeps operations ownership split without overlap between the local pack and the site', () => {
		const surfaces = new Map(EXPECTED_OWNERSHIP_ROWS.map((row) => [row[0], row[1].toLowerCase()]));
		expect(surfaces.get('ecosystem-operations')).toContain('incident');
		expect(surfaces.get('ecosystem-operations')).toContain('runbooks');
		expect(surfaces.get('ecosystem-long-form')).not.toContain('operations');
		expect(surfaces.get('ecosystem-long-form')).not.toContain('runbook');
	});

	it('rejects route replacements, duplicates, and ownership-table drift', () => {
		const deadTopRoute = README.replace(DOCS_SITE, 'https://svelte-realtime.dev/confirmed-404');
		expect(ownershipFailures(deadTopRoute)).toContain('top documentation-site route drifted');

		const duplicateTopRoute = README.replace(
			'[documentation site](' + DOCS_SITE + ')',
			'[documentation site](' + DOCS_SITE + ') | [backup site](https://svelte-realtime.dev/confirmed-404)'
		);
		expect(ownershipFailures(duplicateTopRoute)).toContain('top documentation-site route drifted');

		const deadRelatedRoute = README.replace(
			EXPECTED_RELATED_MARKDOWN,
			EXPECTED_RELATED_MARKDOWN.replace(DOCS_SITE, 'https://svelte-realtime.dev/confirmed-404')
		);
		expect(ownershipFailures(deadRelatedRoute)).toContain('related-projects documentation-site route drifted');

		const tableDrift = README.replace('`ecosystem-long-form`', '`adapter-long-form`');
		expect(ownershipFailures(tableDrift)).toContain('bounded ownership table drifted');
	}, 15_000);

	it('requires the top canonical route to use the exact accessible Markdown shape', () => {
		for (const replacement of [
			'<span inert>[documentation site](' + DOCS_SITE + ')</span>',
			'<span style=pointer-events:none>[documentation site](' + DOCS_SITE + ')</span>',
			'<span style=display:/**/none>[documentation site](' + DOCS_SITE + ')</span>',
			'<span style=display:var(--docs);--docs:none>[documentation site](' + DOCS_SITE + ')</span>',
			'<span style=visibility:/**/hidden>[documentation site](' + DOCS_SITE + ')</span>',
			'<span aria-hidden=true>[documentation site](' + DOCS_SITE + ')</span>'
		]) {
			const mutant = README.replace('[documentation site](' + DOCS_SITE + ')', replacement);
			expect.soft(ownershipFailures(mutant), replacement).toContain('top documentation-site route drifted');
			const relatedReplacement = replacement.replace(/documentation site/g, 'svelte-realtime.dev');
			const relatedMutant = README.replace(
				EXPECTED_RELATED_MARKDOWN,
				EXPECTED_RELATED_MARKDOWN.replace('[svelte-realtime.dev](' + DOCS_SITE + ')', relatedReplacement)
			);
			expect.soft(ownershipFailures(relatedMutant), relatedReplacement).toContain(
				'related-projects documentation-site route drifted'
			);
		}
	}, 15_000);

	it('rejects inaccessible ancestors around otherwise exact route source', () => {
		const topAncestor = README
			.replace('**Documentation:**', '<div inert>\n\n**Documentation:**')
			.replace('\n\n---\n', '\n\n---\n\n</div>\n');
		expect(ownershipFailures(topAncestor)).toContain('top documentation-site route drifted');

		const relatedAncestor = README
			.replace('## Related projects', '<div aria-hidden=true>\n\n## Related projects')
			.replace('## License', '</div>\n\n## License');
		expect(ownershipFailures(relatedAncestor)).toContain(
			'related-projects documentation-site route drifted'
		);
	});

	it('rejects rendered styles that can globally interfere with canonical routes', () => {
		for (const stylesheet of [
			'<style>a { display: none !important; }</style>',
			'<style>a { visibility: hidden !important; }</style>',
			'<style>a { pointer-events: none !important; }</style>',
			'<link rel="stylesheet" href="https://example.invalid/readme.css">',
			'<div style="position: fixed; inset: 0">route-blocking overlay</div>'
		]) {
			expect.soft(ownershipFailures(README + '\n\n' + stylesheet), stylesheet).toContain(
				'README contains rendered styling that can interfere with canonical routes'
			);
		}

		for (const nonRenderedExample of [
			'<!-- <style>a { display: none }</style> -->',
			'```html\n<style>a { display: none }</style>\n```',
			'Inline code: `<style>a { display: none }</style>`.'
		]) {
			expect.soft(ownershipFailures(README + '\n\n' + nonRenderedExample), nonRenderedExample).toEqual([]);
		}
	}, 15_000);

	it('rejects document-root attributes that disable canonical routes', () => {
		for (const documentRoot of [
			'<body hidden>',
			'<body inert>',
			'<body aria-hidden="true">',
			'<body style="pointer-events:none">',
			'<html hidden>',
			'<html inert>',
			'<html aria-hidden="true">',
			'<html style="pointer-events:none">',
			'<BODY HIDDEN>',
			'<html inert="">',
			'<body aria-hidden="TRUE">',
			'<html style = "visibility: hidden">',
			'<body popover>',
			'<body popover="manual">',
			'<html popover>',
			'<BODY POPOVER="AUTO">',
			'<html popover="">',
			'<body aria-disabled="true">',
			'<html aria-disabled="true">',
			'<BODY ARIA-DISABLED="TRUE">',
			'<html aria-disabled = "true">',
			'<body bgcolor="#ffffff" text="#ffffff" link="#ffffff" vlink="#ffffff" alink="#ffffff">',
			'<html background="route-obscuring-image.png">'
		]) {
			expect.soft(ownershipFailures(README + '\n\n' + documentRoot), documentRoot).toContain(
				'README contains rendered styling that can interfere with canonical routes'
			);
		}

		for (const nonRenderedExample of [
			'<!-- <body hidden> -->',
			'```html\n<html inert>\n```',
			'Inline code: `<body aria-hidden="true">`.',
			'<!-- <body popover> -->',
			'```html\n<body aria-disabled="true">\n```'
		]) {
			expect.soft(ownershipFailures(README + '\n\n' + nonRenderedExample), nonRenderedExample).toEqual([]);
		}
		expect(ownershipFailures(README + '\n\n<body aria-disabled="false">')).toEqual([]);
	}, 30_000);

	it('rejects executable document-root and navigation interference', () => {
		for (const executableRouteMutation of [
			'<body onload="document.documentElement.hidden=true">',
			'<body onclick="return false">',
			'<html ONCLICK="return false">',
			'<input autofocus onfocus="document.documentElement.hidden=true">',
			'<img src="confirmed-missing" onerror="document.documentElement.hidden=true">',
			'<svg onload="document.documentElement.hidden=true"></svg>',
			'<iframe onload="document.documentElement.hidden=true"></iframe>',
			'<details open ontoggle="document.documentElement.hidden=true"></details>',
			'<INPUT AUTOFOCUS ONFOCUS="document.documentElement.hidden=true">',
			'<script>document.documentElement.hidden=true</script>',
			'<iframe srcdoc="active-document"></iframe>',
			'<a href="javascript:document.documentElement.hidden=true">hide docs</a>',
			'<iframe src="java&#x09;script:parent.document.documentElement.hidden=true"></iframe>',
			'<iframe src="java&#x0a;script:parent.document.documentElement.hidden=true"></iframe>',
			'<iframe src="java&#x0d;script:parent.document.documentElement.hidden=true"></iframe>',
			'<iframe src="java&Tab;script:parent.document.documentElement.hidden=true"></iframe>',
			'<object data="javascript:parent.document.documentElement.hidden=true"></object>',
			'<OBJECT DATA="  JaVaScRiPt:parent.document.documentElement.hidden=true"></OBJECT>',
			'<object data="java&#x09;script:parent.document.documentElement.hidden=true"></object>',
			'<object data="java&NewLine;script:parent.document.documentElement.hidden=true"></object>',
			'<object data="data:text/html,<script>parent.postMessage(\'object-hit\',\'*\')</script>"></object>',
			'<div inert><object data="data:text/html,<script>parent.postMessage(\'object-hit\',\'*\')</script>"></object></div>',
			'<meta http-equiv="refresh" content="0;url=https://example.invalid/route-replaced">',
			'<META HTTP-EQUIV="REFRESH" CONTENT="0;url=https://example.invalid/route-replaced">',
			'<base target="docs-sink"><iframe name="docs-sink" hidden></iframe>',
			'<BASE TARGET="DOCS-SINK"><IFRAME NAME="docs-sink" hidden></IFRAME>',
			'<base href="https://example.invalid/dead/">',
			'<BASE HREF="https://example.invalid/dead/">',
			'<base>'
		]) {
			expect.soft(ownershipFailures(README + '\n\n' + executableRouteMutation), executableRouteMutation).toContain(
				'README contains rendered executable or navigation interference with canonical routes'
			);
		}

		for (const nonRenderedExample of [
			'<!-- <body onclick="return false"> -->',
			'<!-- <input autofocus onfocus="document.documentElement.hidden=true"> -->',
			'```html\n<img src="missing" onerror="document.documentElement.hidden=true">\n```',
			'Inline code: `<svg onload="document.documentElement.hidden=true"></svg>`.',
			'<template><iframe onload="document.documentElement.hidden=true"></iframe></template>',
			'<!-- <script>document.documentElement.hidden=true</script> -->',
			'```html\n<iframe srcdoc="active-document"></iframe>\n```',
			'Inline code: `<a href="javascript:void(0)">example</a>`.',
			'<!-- <iframe src="java&#x09;script:parent.document.documentElement.hidden=true"></iframe> -->',
			'```html\n<iframe src="java&#x0a;script:parent.document.documentElement.hidden=true"></iframe>\n```',
			'Inline code: `<iframe src="java&#x0d;script:parent.document.documentElement.hidden=true"></iframe>`.',
			'<!-- <object data="javascript:parent.document.documentElement.hidden=true"></object> -->',
			'```html\n<object data="java&#x09;script:parent.document.documentElement.hidden=true"></object>\n```',
			'Inline code: `<object data="javascript:parent.document.documentElement.hidden=true"></object>`.',
			'```html\n<meta http-equiv="refresh" content="0;url=https://example.invalid/">\n```',
			'Inline code: `<base target="docs-sink">`.',
			'<!-- <base href="https://example.invalid/dead/"> -->',
			'```html\n<base href="https://example.invalid/dead/">\n```',
			'Inline code: `<base href="https://example.invalid/dead/">`.'
		]) {
			expect.soft(ownershipFailures(README + '\n\n' + nonRenderedExample), nonRenderedExample).toEqual([]);
		}
		for (const inactiveObject of [
			'<object hidden data="javascript:parent.document.documentElement.hidden=true"></object>',
			'<div inert><object data="java&#x09;script:parent.document.documentElement.hidden=true"></object></div>',
			'<object hidden data="data:text/html,<script>parent.postMessage(\'object-hit\',\'*\')</script>"></object>',
			'<object data="data:text/plain,ordinary documentation"></object>'
		]) {
			expect.soft(ownershipFailures(README + '\n\n' + inactiveObject), inactiveObject).toEqual([]);
		}
	}, 60_000);

	it('classifies stewardship variants and aligned passive clauses', () => {
		const contradictions = [
			'This README is the editorial authority for tutorials, API reference, and operations playbooks.',
			'This README serves as steward for tutorials, API reference, and operations playbooks.',
			'Responsibility for tutorials, API reference, and operations playbooks rests with this README.',
			'This README is entrusted with tutorials, API reference, and operations playbooks.',
			'This README keeps tutorials, API reference, and operations playbooks current.',
			'Tutorials, API reference, and operations playbooks are administered by this README.',
			'This README directs tutorials, API reference, and operations playbooks.',
			'This README is the permanent home for tutorials, API reference, and operations playbooks.',
			'This README owns setup and tutorials, while the documentation site owns API reference.'
		];
		for (const contradiction of contradictions) {
			expect.soft(boundedOwnershipClaim(contradiction), contradiction).toBe(true);
		}
		expect(ownershipFailures(README + '\n\n' + contradictions.join('\n\n'))).toContain(
			'README contains an additional bounded ownership claim'
		);

		const pairedControls = [
			'This README is the editorial authority for installation and support status.',
			'The documentation site is the editorial authority for tutorials and API reference.',
			'This README serves as steward for identity and setup.',
			'The documentation site serves as steward for tutorials and operations playbooks.',
			'Responsibility for installation and support status rests with this README.',
			'Responsibility for tutorials and API reference rests with the documentation site.',
			'This README is entrusted with the compatibility manifest and test vectors.',
			'The documentation site is entrusted with tutorials and operations playbooks.',
			'This README keeps the compatibility manifest and test vectors current.',
			'The documentation site keeps tutorials and API reference current.',
			'Installation and support status are administered by this README.',
			'Tutorials and API reference are administered by the documentation site.',
			'This README directs versioned-companion routes.',
			'The documentation site directs tutorials and operations playbooks.',
			'This README is the permanent home for identity and setup.',
			'The documentation site is the permanent home for tutorials and API reference.'
		];
		for (const control of pairedControls) {
			expect.soft(boundedOwnershipClaim(control), control).toBe(false);
		}
		expect(ownershipFailures(README + '\n\n' + pairedControls.join('\n\n'))).toEqual([]);

		for (const aligned of [
			'Tutorials and API reference are owned by the documentation site, while setup is owned by this README.',
			'Because tutorials and API reference are owned by the documentation site, setup is owned by this README.',
			'Setup is owned by this README, while tutorials and API reference are owned by the documentation site.',
			'Given that tutorials and API reference are managed by the documentation site, installation and support status are managed by this README.',
			'Tutorials and API reference are owned by the documentation site while setup is owned by this README.',
			'Setup is owned by this README whereas tutorials and API reference are owned by the documentation site.'
		]) {
			expect.soft(boundedOwnershipClaim(aligned), aligned).toBe(false);
			expect.soft(ownershipFailures(README + '\n\n' + aligned), aligned).toEqual([]);
		}
		for (const ordinaryDirection of [
			'This README directs readers to tutorials on the documentation site.',
			'The documentation site directs users to installation in this README.'
		]) {
			expect.soft(boundedOwnershipClaim(ordinaryDirection), ordinaryDirection).toBe(false);
		}
	}, 30_000);

	it('classifies bare authority, home, custody, residency, and joint-owner wording', () => {
		const contradictions = [
			'This README is the authority for tutorials, API reference, and operations playbooks.',
			'This README is home to tutorials, API reference, and operations playbooks.',
			'This README is charged with tutorials, API reference, and operations playbooks.',
			'Tutorials, API reference, and operations playbooks live in this README.',
			'This README, along with the documentation site, owns tutorials, API reference, and operations playbooks.',
			'This README in tandem with the documentation site owns tutorials, API reference, and operations playbooks.'
		];
		for (const contradiction of contradictions) {
			expect.soft(boundedOwnershipClaim(contradiction), contradiction).toBe(true);
		}
		expect(ownershipFailures(README + '\n\n' + contradictions.join('\n\n'))).toContain(
			'README contains an additional bounded ownership claim'
		);

		const pairedControls = [
			'This README is the authority for installation and support status.',
			'The documentation site is the authority for tutorials and API reference.',
			'This README is home to identity and setup.',
			'The documentation site is home to tutorials and operations playbooks.',
			'This README is charged with installation documentation.',
			'The documentation site is charged with tutorials and API reference.',
			'Installation documentation lives in this README.',
			'Tutorials and API reference live in the documentation site.',
			'This README maintains installation documentation.',
			'This README publishes installation guides.'
		];
		for (const control of pairedControls) {
			expect.soft(boundedOwnershipClaim(control), control).toBe(false);
		}
		expect(ownershipFailures(README + '\n\n' + pairedControls.join('\n\n'))).toEqual([]);

		for (const ordinaryCollaboration of [
			'This README, along with the documentation site, routes readers to the appropriate owner.',
			'This README works in tandem with the documentation site to explain the ownership map.'
		]) {
			expect.soft(boundedOwnershipClaim(ordinaryCollaboration), ordinaryCollaboration).toBe(false);
		}
	}, 30_000);

	it('splits aligned gerund and ASCII-dash ownership assignments', () => {
		for (const aligned of [
			'This README owns setup, with the documentation site owning tutorials and API reference.',
			'The documentation site owns tutorials and API reference, with this README owning setup.',
			'This README owns setup - the documentation site owns tutorials and API reference.',
			'The documentation site owns tutorials and API reference - this README owns setup.'
		]) {
			expect.soft(boundedOwnershipClaim(aligned), aligned).toBe(false);
			expect.soft(ownershipFailures(README + '\n\n' + aligned), aligned).toEqual([]);
		}

		for (const contradiction of [
			'This README owns setup, with the documentation site owning setup.',
			'The documentation site owns tutorials - this README owns API reference.'
		]) {
			expect.soft(boundedOwnershipClaim(contradiction), contradiction).toBe(true);
		}
	}, 30_000);

	it('classifies authority possession, charge, residency, joint ownership, and assignment', () => {
		const contradictions = [
			'This README has authority over tutorials, API reference, and operations playbooks.',
			'This README holds authority over tutorials, API reference, and operations playbooks.',
			'This README takes charge of tutorials, API reference, and operations playbooks.',
			'Tutorials, API reference, and operations playbooks reside in this README.',
			'Tutorials, API reference, and operations playbooks belong here.',
			'This README and the documentation site share ownership of tutorials, API reference, and operations playbooks.',
			'They have joint ownership of tutorials, API reference, and operations playbooks.',
			'Tutorial ownership and API-reference responsibility are assigned to this README.'
		];
		for (const contradiction of contradictions) {
			expect.soft(boundedOwnershipClaim(contradiction), contradiction).toBe(true);
		}
		expect(ownershipFailures(README + '\n\n' + contradictions.join('\n\n'))).toContain(
			'README contains an additional bounded ownership claim'
		);

		const pairedControls = [
			'This README has authority over installation and support status.',
			'The documentation site has authority over tutorials and API reference.',
			'This README takes charge of the compatibility manifest and test vectors.',
			'The documentation site takes charge of tutorials and operations playbooks.',
			'Installation and support status reside in this README.',
			'Tutorials and API reference reside in the documentation site.',
			'Installation and support status belong here.',
			'Tutorial ownership and API reference responsibility are assigned to the documentation site.',
			'Installation ownership and support-status responsibility are assigned to this README.'
		];
		for (const control of pairedControls) {
			expect.soft(boundedOwnershipClaim(control), control).toBe(false);
		}
		expect(ownershipFailures(README + '\n\n' + pairedControls.join('\n\n'))).toEqual([]);
		for (const ordinaryPronoun of [
			'They maintain their application cache.',
			'They have ownership of their application data.'
		]) {
			expect.soft(boundedOwnershipClaim(ordinaryPronoun), ordinaryPronoun).toBe(false);
		}
	}, 30_000);

	it('splits colon and em-dash assignments and recognizes prepositional package scope', () => {
		const emDash = String.fromCodePoint(0x2014);
		for (const aligned of [
			'This README owns setup: the documentation site owns tutorials and API reference.',
			'This README owns setup ' + emDash + ' the documentation site owns tutorials and API reference.',
			'The documentation site owns tutorials and API reference: this README owns setup.',
			'The documentation site owns tutorials and API reference ' + emDash + ' this README owns setup.'
		]) {
			expect.soft(boundedOwnershipClaim(aligned), aligned).toBe(false);
			expect.soft(ownershipFailures(README + '\n\n' + aligned), aligned).toEqual([]);
		}

		for (const packageClaim of [
			'This README maintains documentation for installation.',
			'This README publishes reference material about support status.',
			'This README curates guides on setup.'
		]) {
			expect.soft(boundedOwnershipClaim(packageClaim), packageClaim).toBe(false);
			expect.soft(ownershipFailures(README + '\n\n' + packageClaim), packageClaim).toEqual([]);
		}

		for (const contradiction of [
			'This README owns setup: the documentation site owns setup.',
			'This README publishes reference material about support status and API endpoints.'
		]) {
			expect.soft(boundedOwnershipClaim(contradiction), contradiction).toBe(true);
		}
	}, 30_000);

	it('aggregates ownership declarations across semantic rendered containers', () => {
		const contradictions = [
			[
				'| Documentation surface | Canonical owner |',
				'| --- | --- |',
				'| Tutorials, API reference, and operations playbooks | This README |'
			].join('\n'),
			'<div class="ownership-card"><span>Tutorials, API reference, and operations playbooks</span><span>Canonical owner: This README</span></div>',
			'<div class="ownership-grid"><div>Tutorials, API reference, and operations playbooks</div><div>Responsibility</div><div>This README</div></div>'
		];
		for (const contradiction of contradictions) {
			expect.soft(ownershipFailures(README + '\n\n' + contradiction), contradiction).toContain(
				'README contains an additional bounded ownership claim'
			);
		}

		const alignedTable = [
			'| Documentation surface | Canonical owner |',
			'| --- | --- |',
			'| Installation and support status | This README |',
			'| Tutorials, API reference, and operations playbooks | The documentation site |'
		].join('\n');
		const alignedCards = [
			'<div class="ownership-grid">',
			'<div><span>Installation and support status</span><span>Canonical owner: This README</span></div>',
			'<div><span>Tutorials, API reference, and operations playbooks</span><span>Canonical owner: The documentation site</span></div>',
			'</div>'
		].join('\n');
		for (const aligned of [alignedTable, alignedCards]) {
			expect.soft(ownershipFailures(README + '\n\n' + aligned), aligned).toEqual([]);
		}
	}, 30_000);

	it('evaluates complete child records and partial semantic-container records independently', () => {
		const contradictions = [
			'<div>Tutorials, API reference, and operations playbooks - Canonical owner: This README</div>',
			'<dl><dt>Tutorials, API reference, and operations playbooks</dt><dd>Canonical owner: This README</dd></dl>',
			[
				'<table>',
				'<tr><td>Documentation surface</td><td>Canonical owner</td></tr>',
				'<tr><td>Tutorials, API reference, and operations playbooks</td><td>This README</td></tr>',
				'</table>'
			].join('\n'),
			'<main class="ownership-grid"><div>Tutorials, API reference, and operations playbooks</div><div>Responsibility</div><div>This README</div></main>',
			'<div><span>This README owns installation and support status.</span><span>This README owns tutorials, API reference, and operations playbooks.</span></div>',
			'<p>This README owns installation and support status.</p><span>This README owns tutorials, API reference, and operations playbooks.</span>',
			'<div>This README owns installation and support status.<br>This README owns tutorials, API reference, and operations playbooks.</div>'
		];
		for (const contradiction of contradictions) {
			expect.soft(ownershipFailures(README + '\n\n' + contradiction), contradiction).toContain(
				'README contains an additional bounded ownership claim'
			);
		}

		const aligned = [
			'<dl>',
			'<dt>Installation and support status</dt><dd>Canonical owner: This README</dd>',
			'<dt>Tutorials, API reference, and operations playbooks</dt><dd>Canonical owner: The documentation site</dd>',
			'</dl>',
			'<div class="ownership-grid">',
			'<div><span>Installation and support status</span><span>Canonical owner: This README</span></div>',
			'<div><span>Tutorials, API reference, and operations playbooks</span><span>Canonical owner: The documentation site</span></div>',
			'</div>'
		].join('\n');
		expect(ownershipFailures(README + '\n\n' + aligned)).toEqual([]);
	}, 30_000);

	it('finds ownership declarations across visible semantic elements without merging aligned records', () => {
		const contradictions = [
			'<nav><span>Tutorials, API reference, and operations playbooks</span><span>Canonical owner: This README</span></nav>',
			'<ul><li>Tutorials, API reference, and operations playbooks</li><li>Canonical owner: This README</li></ul>',
			'<header><div>Tutorials, API reference, and operations playbooks</div><div>Canonical owner: This README</div></header>',
			'<table><caption>This README owns tutorials, API reference, and operations playbooks.</caption></table>',
			'<details open><summary>This README owns tutorials, API reference, and operations playbooks.</summary></details>',
			'<address>This README owns tutorials, API reference, and operations playbooks.</address>'
		];
		for (const contradiction of contradictions) {
			expect.soft(ownershipFailures(README + '\n\n' + contradiction), contradiction).toContain(
				'README contains an additional bounded ownership claim'
			);
		}

		const aligned = [
			'<div>',
			'<span>Installation and support status</span>',
			'<span>Canonical owner: This README</span>',
			'<span>Tutorials, API reference, and operations playbooks</span>',
			'<span>Canonical owner: The documentation site</span>',
			'</div>'
		].join('');
		expect(ownershipFailures(README + '\n\n' + aligned)).toEqual([]);
	}, 30_000);

	it('classifies retained authority, continuing ownership, and granted variants', () => {
		const contradictions = [
			'This README retains authority over tutorials, API reference, and operations playbooks.',
			'This README remains responsible for tutorials, API reference, and operations playbooks.',
			'This README is in charge of tutorials, API reference, and operations playbooks.',
			'This README hosts tutorials, API reference, and operations playbooks.',
			'Ownership of tutorials, API reference, and operations playbooks was granted to this README.',
			'The documentation site and this README both maintain tutorials, API reference, and operations playbooks.',
			'The documentation site and this README collectively maintain tutorials, API reference, and operations playbooks.',
			'This README alone maintains tutorials, API reference, and operations playbooks.',
			'This README continues to maintain tutorials, API reference, and operations playbooks.'
		];
		for (const contradiction of contradictions) {
			expect.soft(boundedOwnershipClaim(contradiction), contradiction).toBe(true);
			expect.soft(ownershipFailures(README + '\n\n' + contradiction), contradiction).toContain(
				'README contains an additional bounded ownership claim'
			);
		}
	}, 30_000);

	it('classifies accountability, control, continuing maintenance, and joint-maintainer variants', () => {
		const contradictions = [
			'This README remains accountable for tutorials, API reference, and operations playbooks.',
			'This README assumes responsibility for tutorials, API reference, and operations playbooks.',
			'This README accepts responsibility for tutorials, API reference, and operations playbooks.',
			'This README has control over tutorials, API reference, and operations playbooks.',
			'This README continues maintaining tutorials, API reference, and operations playbooks.',
			'This README shares maintenance responsibility with the documentation site for tutorials, API reference, and operations playbooks.',
			'This README and the documentation site are co-maintainers of tutorials, API reference, and operations playbooks.',
			'This README plus the documentation site jointly maintain tutorials, API reference, and operations playbooks.'
		];
		for (const contradiction of contradictions) {
			expect.soft(boundedOwnershipClaim(contradiction), contradiction).toBe(true);
			expect.soft(ownershipFailures(README + '\n\n' + contradiction), contradiction).toContain(
				'README contains an additional bounded ownership claim'
			);
		}
	}, 30_000);

	it('classifies final authority, supervision, decision-maker, and shared-mandate variants', () => {
		const contradictions = [
			'This README has the final say over tutorials and API reference.',
			'Tutorials and API reference fall under this README.',
			'This README supervises tutorials and API reference.',
			'This README remains the decision maker for tutorials and API reference.',
			'This README and the documentation site share the mandate for tutorials and API reference.'
		];
		for (const contradiction of contradictions) {
			expect.soft(boundedOwnershipClaim(contradiction), contradiction).toBe(true);
			expect.soft(ownershipFailures(README + '\n\n' + contradiction), contradiction).toContain(
				'README contains an additional bounded ownership claim'
			);
		}

		const pairedControls = [
			'This README has the final say over installation and support status.',
			'Tutorials and API reference fall under the documentation site.',
			'The documentation site supervises tutorials and API reference.',
			'This README remains the decision maker for identity and setup.'
		];
		for (const control of pairedControls) {
			expect.soft(boundedOwnershipClaim(control), control).toBe(false);
			expect.soft(ownershipFailures(README + '\n\n' + control), control).toEqual([]);
		}
	}, 30_000);

	it('classifies arbiter, veto, final-decision, task, oversight, and lead variants', () => {
		const contradictions = [
			'This README is the ultimate arbiter for tutorials and API reference.',
			'This README has veto power over tutorials and API reference.',
			'This README makes the final decisions about tutorials and API reference.',
			'This README is tasked with tutorials and API reference.',
			'This README has oversight of tutorials and API reference.',
			'This README leads the tutorials and API reference.',
			'This README and the documentation site exercise joint oversight of tutorials and API reference.'
		];
		for (const contradiction of contradictions) {
			expect.soft(boundedOwnershipClaim(contradiction), contradiction).toBe(true);
			expect.soft(ownershipFailures(README + '\n\n' + contradiction), contradiction).toContain(
				'README contains an additional bounded ownership claim'
			);
		}

		const pairedControls = [
			'The documentation site is the ultimate arbiter for tutorials and API reference.',
			'This README has veto power over installation and support status.',
			'This README makes the final decisions about setup and identity.',
			'This README is tasked with installation and support status.',
			'This README has oversight of identity and setup.',
			'This README leads installation and versioned-companion routing.'
		];
		for (const control of pairedControls) {
			expect.soft(boundedOwnershipClaim(control), control).toBe(false);
			expect.soft(ownershipFailures(README + '\n\n' + control), control).toEqual([]);
		}
	}, 30_000);

	it('preserves package-qualified compounds and double-hyphen aligned assignments', () => {
		const controls = [
			'This README owns setup -- the documentation site owns tutorials and API reference.',
			'This README owns setup--the documentation site owns tutorials and API reference.',
			'This README maintains documentation covering installation and support status.',
			'This README publishes installation-focused guides.',
			'This README owns documentation concerning setup.',
			'This README maintains documentation pertaining to support status.',
			'This README maintains documentation regarding installation and support status.',
			'This README maintains documentation devoted to installation and support status.',
			'This README publishes installation-oriented guides.',
			'This README owns reference material related to support status.',
			'This README maintains documentation specifically for installation and support status.',
			'This README publishes guides solely for installation.',
			'This README owns reference material specifically related to support status.',
			'This README maintains documentation dedicated to installation.',
			'This README curates documentation only about setup.',
			'This README maintains documentation intended for installation and support status.',
			'This README owns reference material limited to support status.',
			'This README curates setup-only documentation.',
			'This README maintains documentation focused on installation.',
			'This README owns reference material supporting setup.',
			'<p>This README owns setup<br>The documentation site owns tutorials and API reference</p>'
		];
		for (const control of controls) {
			expect.soft(boundedOwnershipClaim(control), control).toBe(false);
			expect.soft(ownershipFailures(README + '\n\n' + control), control).toEqual([]);
		}

		const contradictory = 'This README owns setup -- the documentation site owns setup.';
		expect(boundedOwnershipClaim(contradictory)).toBe(true);
		expect(ownershipFailures(README + '\n\n' + contradictory)).toContain(
			'README contains an additional bounded ownership claim'
		);
	}, 30_000);

	it('classifies assigned, joint-responsibility, authority, charge, and home variants', () => {
		const contradictions = [
			'Tutorials, API reference, and operations playbooks are assigned to this README.',
			'This README was assigned tutorials, API reference, and operations playbooks.',
			'Both owners are responsible for tutorials, API reference, and operations playbooks.',
			'They hold joint responsibility for tutorials, API reference, and operations playbooks.',
			'Ownership of tutorials, API reference, and operations playbooks is held jointly.',
			'Authority over tutorials, API reference, and operations playbooks is wielded by this README.',
			'This README wields authority over tutorials, API reference, and operations playbooks.',
			'Charge for tutorials, API reference, and operations playbooks lies with this README.',
			'Tutorials, API reference, and operations playbooks are resident in this README.',
			'Tutorials, API reference, and operations playbooks have their home in this README.'
		];
		for (const contradiction of contradictions) {
			expect.soft(boundedOwnershipClaim(contradiction), contradiction).toBe(true);
		}
		expect(ownershipFailures(README + '\n\n' + contradictions.join('\n\n'))).toContain(
			'README contains an additional bounded ownership claim'
		);

		const pairedControls = [
			'Installation and support status are assigned to this README.',
			'Tutorials and API reference are assigned to the documentation site.',
			'This README was assigned identity, installation, and support status.',
			'The documentation site was assigned tutorials, API reference, and operations playbooks.',
			'Authority over installation and support status is wielded by this README.',
			'Authority over tutorials and API reference is wielded by the documentation site.',
			'Charge for installation and support status lies with this README.',
			'Charge for tutorials and operations playbooks lies with the documentation site.',
			'Installation and support status are resident in this README.',
			'Tutorials and API reference have their home in the documentation site.'
		];
		for (const control of pairedControls) {
			expect.soft(boundedOwnershipClaim(control), control).toBe(false);
		}
		expect(ownershipFailures(README + '\n\n' + pairedControls.join('\n\n'))).toEqual([]);
	}, 30_000);

	it('splits slash and parenthetical mappings and preserves package-qualified references', () => {
		for (const aligned of [
			'This README owns setup / the documentation site owns tutorials and API reference.',
			'The documentation site owns tutorials and API reference / this README owns setup.',
			'This README owns setup (the documentation site owns tutorials and API reference).',
			'The documentation site owns tutorials and API reference (this README owns setup).'
		]) {
			expect.soft(boundedOwnershipClaim(aligned), aligned).toBe(false);
			expect.soft(ownershipFailures(README + '\n\n' + aligned), aligned).toEqual([]);
		}

		for (const packageClaim of [
			'This README publishes guides to installation.',
			'This README maintains reference for support status.',
			'This README owns setup/support reference.'
		]) {
			expect.soft(boundedOwnershipClaim(packageClaim), packageClaim).toBe(false);
			expect.soft(ownershipFailures(README + '\n\n' + packageClaim), packageClaim).toEqual([]);
		}

		for (const contradiction of [
			'This README owns setup / the documentation site owns setup.',
			'The documentation site owns tutorials (this README owns API reference).',
			'This README publishes guides to API endpoints.',
			'This README maintains reference for operations playbooks.',
			'This README owns tutorials/operations reference.'
		]) {
			expect.soft(boundedOwnershipClaim(contradiction), contradiction).toBe(true);
		}
	}, 30_000);

	it('rejects the exact local-owner claims through the bounded authority grammar', () => {
		for (const contradiction of [
			'This README is the definitive home for implementation articles and callable API documentation.',
			'The adapter handbook maintains every tutorial, endpoint reference page, and deployment playbook.',
			'All usage recipes, command reference material, and incident procedures live here as their authoritative record.',
			'This package is responsible for the complete guide collection, function reference, and operational playbooks.',
			'Deep technical articles, symbol lookup pages, and administrator procedures are authored in this README.',
			'The README curates full ecosystem tutorials, API documentation, and production playbooks.'
		]) {
			expect.soft(ownershipFailures(README + '\n\n' + contradiction), contradiction).toContain(
				'README contains an additional bounded ownership claim'
			);
		}
	});

	it('rejects competing claims covered by the declared grammar without scope synonyms', () => {
		for (const contradiction of [
			'This README is now the authoritative source of truth.',
			'The documentation site is the official home.',
			'These package docs maintain their own reference.',
			'The long-form guides officially belong to this repository.',
			'The searchable reference lives locally.',
			'Here we house the operational material.',
			'The package manual exercises editorial control over the reference.',
			'The guide collection is the responsibility of the adapter documentation.',
			'This README controls all tutorials, API lookup pages, and operator playbooks.',
			'The adapter manual governs the complete guide set and API catalogue.',
			'Package documentation has editorial authority over deployment runbooks and endpoint documentation.',
			'Both this README and the documentation site are canonical sources for all tutorials and API reference.',
			'The two owners share custody.',
			'README is the designated authority for the guide collection.',
			'Package documentation oversees the ecosystem tutorials.',
			'README defines the API reference.',
			'The adapter manual is accountable for operations walkthroughs.',
			'Both the documentation site and this README are official homes for searchable reference.',
			'The declared owners jointly maintain the long-form guide collection.',
			'This README has jurisdiction over all tutorials, API reference pages, and operations runbooks.',
			'This README is the custodian of long-form guides, API documentation, and deployment playbooks.',
			'All ecosystem tutorials, API reference, and operator runbooks fall within the remit of this README.',
			'Responsibility for tutorials, API references, and operations playbooks is shared between this README and the documentation site.',
			'This README and the documentation site split responsibility for tutorials, API reference, and operations playbooks.',
			'This README exercises jurisdiction over ecosystem tutorials and API documentation.',
			'The adapter manual holds the remit for operations runbooks.',
			'Editorial custody of tutorials and API references is divided between this README and the documentation site.',
			'The documentation site and this README share responsibility for searchable reference.',
			'The two owners divide responsibility for deployment playbooks.',
			'This README is the sole authority for tutorials, API reference, and operations playbooks.',
			'This README is the exclusive home for tutorials, API reference, and operations playbooks.',
			'This README manages tutorials, API reference, and operations playbooks.',
			'Tutorials, API reference, and operations playbooks are managed by this README.',
			'This README in alliance with the documentation site owns tutorials, API reference, and operations playbooks.',
			'This README in partnership with the documentation site owns tutorials, API reference, and operations playbooks.',
			'This README in concert with the documentation site owns tutorials, API reference, and operations playbooks.',
			'Tutorials, API reference, and operations playbooks are co-owned by this README and the documentation site.',
			'This README has ownership of tutorials, API reference, and operations playbooks.',
			'This README holds ownership over tutorials, API reference, and operations playbooks.',
			'This README bears responsibility for tutorials, API reference, and operations playbooks.',
			'This README assumes custody of tutorials, API reference, and operations playbooks.',
			'This README exercises authority over tutorials, API reference, and operations playbooks.',
			'This README and the documentation site each own tutorials, API reference, and operations playbooks.',
			'This README, together with the documentation site, owns tutorials, API reference, and operations playbooks.',
			'This README alongside the documentation site owns tutorials, API reference, and operations playbooks.',
			"This README's jurisdiction includes tutorials, API reference, and operations playbooks.",
			'Tutorials, API reference, and operations playbooks are under the jurisdiction of this README.',
			'Tutorials, API reference, and operations playbooks are in the custody of this README.',
			'Responsibility for tutorials, API reference, and operations playbooks is divided across this README and the documentation site.'
		]) {
			expect.soft(ownershipFailures(README + '\n\n' + contradiction), contradiction).toContain(
				'README contains an additional bounded ownership claim'
			);
		}
	}, 60_000);

	it('does not mistake ordinary explanations or non-rendered examples for declarations', () => {
		for (const allowed of [
			'This README explains how applications maintain their own cache.',
			'Applications are responsible for authorization; the README documents the hook.',
			'The documentation site is reachable from this README.',
			'For installation and support status, this README is the canonical source.',
			'The documentation site is the official home for long-form ecosystem guides.',
			'This repository maintains the compatibility manifest and test vectors.',
			'For identity and setup, package documentation is the designated authority.',
			'The documentation site oversees long-form ecosystem guides.',
			'The documentation site is accountable for operations walkthroughs.',
			'This README defines installation and support status.',
			'This README defines installation and support status. The documentation site oversees long-form ecosystem guides.',
			'This README owns identity and setup, while the documentation site owns tutorials and API reference.',
			'Package documentation maintains the compatibility manifest, and the documentation site curates deployment runbooks.',
			'The documentation site owns API reference; this README owns installation.',
			'This README maintains setup while svelte-realtime.dev houses ecosystem tutorials.',
			'This README owns identity and setup and the documentation site owns tutorials and API reference.',
			'Although this README maintains installation and support status, the documentation site curates long-form ecosystem guides.',
			'This README owns setup as the documentation site owns tutorials and API reference.',
			'This README maintains installation yet the documentation site maintains long-form guides.',
			'This README owns identity and setup because the documentation site owns tutorials and API reference.',
			'This README owns setup, even though the documentation site owns tutorials and API reference.',
			'This README owns setup since the documentation site owns tutorials and API reference.',
			'This README owns setup, given that the documentation site owns tutorials and API reference.',
			'This README owns setup, for the documentation site owns tutorials and API reference.',
			'This README has ownership of identity, setup, and support status.',
			'This README bears responsibility for installation and versioned-companion routes.',
			'This README assumes custody of the compatibility manifest and test vectors.',
			'The documentation site has ownership of tutorials and API reference.',
			'The documentation site bears responsibility for operations playbooks.',
			'The documentation site exercises authority over long-form ecosystem guides.',
			'This README is the sole authority for installation and support status.',
			'This README is the exclusive home for identity and setup.',
			'This README manages installation and support status.',
			'Installation and support status are managed by this README.',
			'The documentation site is the sole authority for tutorials and API reference.',
			'The documentation site is the exclusive home for operations playbooks.',
			'The documentation site manages tutorials and API reference.',
			'Tutorials and API reference are managed by the documentation site.',
			"This README's jurisdiction includes installation and support status.",
			'Installation and support status are in the custody of this README.',
			"The documentation site's jurisdiction includes tutorials, API reference, and operations playbooks.",
			'Tutorials and API reference are under the jurisdiction of the documentation site.',
			'    This README owns the guide collection.',
			'<!-- This README maintains the guide collection. -->',
			'<span hidden>This README curates the guide collection.</span>',
			'<template>This README is the canonical home.</template>',
			'```md\nThis README owns the guide collection.\n```',
			'This is code: `This README maintains the guide collection.`'
		]) {
			expect.soft(ownershipFailures(README + '\n\n' + allowed), allowed).toEqual([]);
		}
	}, 60_000);

	it('rejects non-canonical route syntax and destinations', () => {
		for (const replacement of [
			'[documentation site][canonical-docs]',
			'<a href=https://svelte-realtime.dev/>documentation site</a>',
			'[documentation site](https://SVELTE-REALTIME.DEV/)',
			'[documentation site](https://svelte-realtime.dev/docs)',
			'[documentation site](https://svelte-realtime.dev/?source=readme)',
			'[documentation site](https://svelte-realtime.dev/#guides)',
			'[documentation site](https://user@svelte-realtime.dev/)',
			'[documentation site](https://svelte-realtime.dev:444/)'
		]) {
			const mutant = README.replace('[documentation site](' + DOCS_SITE + ')', replacement);
			expect.soft(ownershipFailures(mutant), replacement).toContain('top documentation-site route drifted');
		}
	}, 15_000);

	it('ships a stable release history and current versioned release route', () => {
		expect(PACKAGE.files).toContain('CHANGELOG.md');
		expect(README).toContain('](' + PACKAGED_RELEASE_HISTORY + ')');
		expect(README).toContain('](' + CURRENT_RELEASE + ')');
	});

	it('gives companion docs a route back to their parent and release history', () => {
		for (const document of [MIGRATION, PROTOCOL]) {
			expect(document).toContain('](./README.md)');
		}
		expect(MIGRATION).toContain('](' + PACKAGED_RELEASE_HISTORY + ')');
		expect(MIGRATION).toContain('](' + CURRENT_RELEASE + ')');
		expect(PROTOCOL).toContain('](' + PACKAGED_RELEASE_HISTORY + ')');
		expect(VECTORS).toContain('](../README.md)');
		expect(VECTORS).toContain('](../PROTOCOL.md)');
		expect(VECTORS).toContain('](' + VECTORS_RELEASE_HISTORY + ')');
	});

	it('makes the schema, vectors, client, and server implementation paths clickable', () => {
		for (const target of [
			'./protocol.schema.json',
			'./test-vectors/README.md',
			'./src/client.js',
			'./src/runtime/wire.js',
			'./src/runtime/handler.js',
			'./src/vite.js',
			'./src/testing.js'
		]) {
			expect(PROTOCOL).toContain('](' + target + ')');
		}
	});
});
