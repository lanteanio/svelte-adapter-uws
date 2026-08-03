import { parse } from 'parse5';

export const WAITING_ROOM_TEMPLATE_TOKENS = Object.freeze([
	'queueDepth',
	'estimatedSeconds',
	'pollIntervalMs',
	'retryAfterSeconds',
	'admitCheckPath',
	'appName',
	'statusUrl',
	'supportUrl',
	'incidentId'
]);
const TOKEN_SET = new Set(WAITING_ROOM_TEMPLATE_TOKENS);
const SUPPORTED = WAITING_ROOM_TEMPLATE_TOKENS.map((token) => `{{${token}}}`).join(', ');

/**
 * Enforce the document baseline shared by built-in, templated, localized, and
 * opt-out HTML capacity responses. Custom waiting-room markup remains trusted
 * application HTML rather than sanitized HTML, but comments, parser-inserted
 * elements, and hidden/inert subtrees cannot impersonate the accessible tree.
 *
 * @param {unknown} document
 * @param {string} [source]
 * @returns {{ lang: string, dir: 'ltr' | 'rtl' | 'auto' }}
 */
export function assertAccessibleWaitingDocument(document, source = 'waiting-room document') {
	if (typeof document !== 'string') {
		throw new TypeError(source + ' must be an HTML string satisfying AccessibleWaitingDocument.');
	}

	const parsed = parse(document, { sourceCodeLocationInfo: true });
	const children = parsed.childNodes || [];
	const doctype = children.find((node) => node.nodeName === '#documentType' && node.name === 'html');
	const html = children.find((node) => node.tagName === 'html');
	const head = html?.childNodes?.find((node) => node.tagName === 'head');
	const body = html?.childNodes?.find((node) => node.tagName === 'body');
	const missing = [];
	if (!doctype?.sourceCodeLocation) missing.push('<!doctype html>');
	if (!html?.sourceCodeLocation?.startTag) missing.push('an explicit <html> root');

	const htmlAttributes = attributesOf(html);
	let lang = '';
	const candidateLang = String(htmlAttributes.get('lang') || '').trim();
	try {
		const canonical = Intl.getCanonicalLocales(candidateLang);
		if (canonical.length !== 1) throw new RangeError('missing language');
		lang = canonical[0];
	} catch {
		missing.push('a valid html[lang] BCP 47 tag');
	}

	const dirCandidate = String(htmlAttributes.get('dir') || '').trim().toLowerCase();
	/** @type {'ltr' | 'rtl' | 'auto'} */
	let dir = 'ltr';
	if (dirCandidate === 'ltr' || dirCandidate === 'rtl' || dirCandidate === 'auto') {
		dir = dirCandidate;
	} else {
		missing.push('html[dir="ltr"|"rtl"|"auto"]');
	}

	const title = head?.childNodes?.find((node) => node.tagName === 'title');
	if (!title?.sourceCodeLocation?.startTag || renderedText(title) === '') {
		missing.push('a non-empty <title>');
	}
	if (!body?.sourceCodeLocation?.startTag || renderedText(body) === '') missing.push('a non-empty <body>');

	let hasMain = false;
	let hasLiveStatus = false;
	let hasRecovery = false;
	walkExposed(body, (node, ancestors) => {
		const attributes = attributesOf(node);
		const roles = String(attributes.get('role') || '').toLowerCase().split(/\s+/).filter(Boolean);
		const primaryRole = roles[0] || '';
		const ariaLive = String(attributes.get('aria-live') || '').trim().toLowerCase();
		const text = renderedText(node);
		if ((node.tagName === 'main' && primaryRole === '') || primaryRole === 'main') hasMain = true;
		if (
			((primaryRole === 'status' && ariaLive !== 'off') || ['polite', 'assertive'].includes(ariaLive)) &&
			text !== ''
		) {
			hasLiveStatus = true;
		}
		const disabledByAncestor = ancestors.some((ancestor) => {
			const ancestorAttributes = attributesOf(ancestor);
			return (ancestor.tagName === 'fieldset' && ancestorAttributes.has('disabled')) ||
				String(ancestorAttributes.get('aria-disabled') || '').trim().toLowerCase() === 'true';
		});
		if (isActionableRecovery(node, attributes, text, disabledByAncestor)) hasRecovery = true;
	});
	if (!hasMain) missing.push('an exposed main landmark');
	if (!hasLiveStatus) missing.push('an exposed non-empty status live region');
	if (!hasRecovery) missing.push('an exposed enabled named recovery control or non-empty safe link');

	if (missing.length > 0) {
		throw new TypeError(
			source + ' must satisfy AccessibleWaitingDocument; missing ' + missing.join(', ') + '.'
		);
	}
	return { lang, dir };
}

/** @param {any} node */
function attributesOf(node) {
	return new Map((node?.attrs || []).map((attribute) => [
		String(attribute.name).toLowerCase(),
		String(attribute.value)
	]));
}

/** @param {any} node */
function hidesAccessibleTree(node) {
	if (!node?.tagName) return false;
	if (node.tagName === 'template' || node.tagName === 'script' || node.tagName === 'style') return true;
	const attributes = attributesOf(node);
	if (attributes.has('hidden') || attributes.has('inert')) return true;
	if (String(attributes.get('aria-hidden') || '').trim().toLowerCase() === 'true') return true;
	if (node.tagName === 'input' && String(attributes.get('type') || '').toLowerCase() === 'hidden') return true;
	const style = String(attributes.get('style') || '').replace(/\/\*[\s\S]*?\*\//g, '').toLowerCase();
	return /(?:^|;)\s*display\s*:\s*none(?:\s*!\s*important)?\s*(?:;|$)/.test(style) ||
		/(?:^|;)\s*visibility\s*:\s*(?:hidden|collapse)(?:\s*!\s*important)?\s*(?:;|$)/.test(style);
}

/** @param {any} node */
function renderedText(node) {
	if (!node || node.nodeName === '#comment' || hidesAccessibleTree(node)) return '';
	if (node.nodeName === '#text') return String(node.value || '').replace(/\s+/g, ' ').trim();
	return (node.childNodes || []).map(renderedText).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * @param {any} root
 * @param {(node: any, ancestors: any[]) => void} visit
 * @param {any[]} [ancestors]
 */
function walkExposed(root, visit, ancestors = []) {
	if (!root || root.nodeName === '#comment' || hidesAccessibleTree(root)) return;
	if (root.tagName) visit(root, ancestors);
	const childAncestors = root.tagName ? [...ancestors, root] : ancestors;
	for (const child of root.childNodes || []) walkExposed(child, visit, childAncestors);
}

/** @param {string} value */
function isSafeRecoveryHref(value) {
	const href = value.trim();
	if (href === '' || /[\u0000-\u001f\u007f]/.test(href)) return false;
	const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
	return scheme === undefined || scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel';
}

/**
 * @param {any} node
 * @param {Map<string, string>} attributes
 * @param {string} text
 * @param {boolean} disabledByAncestor
 */
function isActionableRecovery(node, attributes, text, disabledByAncestor) {
	const named = text !== '' || String(attributes.get('aria-label') || '').trim() !== '' ||
		String(attributes.get('title') || '').trim() !== '';
	if (
		disabledByAncestor ||
		attributes.has('disabled') ||
		String(attributes.get('aria-disabled') || '').trim().toLowerCase() === 'true'
	) {
		return false;
	}
	if (node.tagName === 'a') {
		return named && attributes.has('href') && isSafeRecoveryHref(String(attributes.get('href')));
	}
	if (node.tagName === 'button') return named;
	if (node.tagName !== 'input') return false;
	const type = String(attributes.get('type') || 'text').toLowerCase();
	if (type === 'submit') return true;
	if (type !== 'button') return false;
	return named || String(attributes.get('value') || '').trim() !== '';
}

/**
 * Compile and structurally validate a production waiting-room template once,
 * before it can become an overload response. Optional identity tokens are
 * empty in the probe on purpose: title and recovery semantics must not vanish
 * merely because an operator omitted branding.
 *
 * @param {string} template
 * @returns {(values: Record<string, string>) => string}
 */
export function compileAccessibleWaitingRoomTemplate(template) {
	const render = compileWaitingRoomTemplate(template);
	assertAccessibleWaitingDocument(render({
		queueDepth: '0',
		estimatedSeconds: '0',
		pollIntervalMs: '2000',
		retryAfterSeconds: '2',
		admitCheckPath: '/__admit-check',
		appName: '',
		statusUrl: '',
		supportUrl: '',
		incidentId: ''
	}), 'waitingRoom.template');
	return render;
}

/**
 * Compile and validate an operator-supplied waiting-room template. Supported
 * tokens become lookup segments. `{{{{token}}}}` emits literal
 * `{{token}}`; the returned renderer performs no parsing and can be reused for
 * every page.
 *
 * @param {string} template
 * @returns {(values: Record<string, string>) => string}
 */
export function compileWaitingRoomTemplate(template) {
	if (typeof template !== 'string') {
		throw new TypeError('waiting-room template must be a string.');
	}

	/** @type {Array<{ literal: string } | { token: string }>} */
	const segments = [];
	let literal = '';
	let cursor = 0;
	const flush = () => {
		if (!literal) return;
		segments.push({ literal });
		literal = '';
	};

	while (cursor < template.length) {
		if (template.startsWith('{{{{', cursor)) {
			literal += '{{';
			cursor += 4;
			continue;
		}
		if (template.startsWith('}}}}', cursor)) {
			literal += '}}';
			cursor += 4;
			continue;
		}
		if (template.startsWith('{{', cursor)) {
			const end = template.indexOf('}}', cursor + 2);
			if (end < 0) {
				throw new Error(
					`Unclosed waiting-room template token at character ${cursor}. ` +
					`Supported tokens: ${SUPPORTED}.`
				);
			}
			const token = template.slice(cursor + 2, end);
			if (!TOKEN_SET.has(token)) {
				throw new Error(
					`Unknown waiting-room template token "{{${token}}}" at character ${cursor}. ` +
					`Supported tokens: ${SUPPORTED}. Use "{{{{" and "}}}}" for literal braces.`
				);
			}
			flush();
			segments.push({ token });
			cursor = end + 2;
			continue;
		}
		// A closing pair does not begin template syntax, so preserve it. This
		// keeps ordinary CSS and JavaScript blocks valid; only `{{` must either
		// begin a supported token or use the literal-brace escape.
		if (template.startsWith('}}', cursor)) {
			literal += '}}';
			cursor += 2;
			continue;
		}
		literal += template[cursor];
		cursor++;
	}
	flush();

	return (values) => {
		let output = '';
		for (let index = 0; index < segments.length; index++) {
			const segment = segments[index];
			output += 'literal' in segment ? segment.literal : values[segment.token];
		}
		return output;
	};
}
