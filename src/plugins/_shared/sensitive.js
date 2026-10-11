/**
 * Sensitive field-name matching shared by presence and cursor. Their
 * zero-configuration projections are deliberately minimal: presence copies
 * only its configured identity key, and cursor copies only `id`. These
 * predicates remain defense in depth for configured identity names and for
 * dynamic presence fields, where two independent matchers would drift.
 *
 * An explicit `select` is an application-owned policy override. Its return
 * value is used as-is, so applications should make it an allowlist.
 */

/**
 * Sensitive tokens, matched against the WORDS of a field name rather than its
 * raw text.
 *
 * This is the WORD half of the rule; SENSITIVE_SUBSTRINGS is the other half,
 * and both are needed. Word matching is what stops `phone` dropping
 * `microphone`, `microphoneOn` and `headphones` - on a huddle or voice surface
 * the mic-state field is precisely what a roster carries - and what keeps `cc`
 * out of `account` and `pin` out of `spinner`. It is NOT sufficient on its own,
 * because a flat lowercase name is a single word: `apikey` and `sessionid`
 * match nothing here, which is why the substring pass exists beside it.
 *
 * A word that IS one of these makes the whole field sensitive, so `tokenCount`
 * and `sessionCount` go too. That direction is deliberate: the alternative is
 * an allowlist of benign compounds that can never be complete, and a missed
 * entry there leaks a credential while a missed entry here loses a display
 * field. The identity-only defaults do not enumerate non-identity fields
 * and do not emit drop warnings; explicit selectors own their output.
 */
const SENSITIVE_WORDS = new Set([
	'token', 'tokens', 'secret', 'secrets', 'password', 'passwords', 'passwd', 'pwd',
	'session', 'sessions', 'cookie', 'cookies', 'jwt', 'jwts',
	'credential', 'credentials', 'email', 'emails', 'phone', 'phones', 'telephone',
	'iban', 'ssn', 'dob', 'cc', 'pin', 'pins', 'otp', 'mfa', 'totp',
	// Mainstream phone identifiers. `fax` stays word-matched because Halifax is
	// an ordinary place name; the flat-owner rule below recovers `userfax`.
	'fax', 'faxes', 'msisdn', 'e164',
	// Request-signing and anti-forgery material. `sig` is word-only on purpose:
	// treating it as a substring would drop ordinary fields such as `signal`.
	'sig', 'sigs', 'csrf', 'xsrf',
	// Data-encryption and key-encryption keys. These acronyms are the names of
	// the key material itself, not merely qualifiers for a following `key`.
	'dek', 'kek',
	// Card verification values. These are single words, so the compound set below
	// is the wrong home for them: putting them there is exactly what let
	// `cardCvv` and `cvvCode` ride a roster while a bare `cvv` was dropped.
	'cvv', 'cvc'
]);

/**
 * Sensitive names that only exist as a multi-word compound, compared against
 * the name with its separators removed - `creditCard`, `credit_card` and
 * `CREDITCARD` all reduce to the same thing, while neither `credit` nor `card`
 * is sensitive on its own (`cardId` on a board is ordinary identity).
 *
 * A match starts at a word boundary and may have qualifiers before it or
 * suffixes after it: `cardNumber`, `userCardNumber` and `cardSecurityCode`
 * all carry sensitive compounds.
 *
 * A plain substring scan overcorrects, because these compounds collide inside
 * ordinary words once separators are gone: `syntaxId` contains `taxid`,
 * `internationalId` contains `nationalid`. Anchoring the match to a word start
 * of the TOKENIZED name keeps both directions - `taxIdNumber` and `tax_id` match
 * at a boundary, `syntaxId` matches only mid-word and passes.
 */
const SENSITIVE_COMPOUNDS = [
	// Payment instruments.
	'creditcard', 'creditcards', 'debitcard', 'cardnumber', 'cardnumbers',
	'securitycode', 'accountnumber', 'routingnumber', 'sortcode',
	'bankaccount', 'bankrouting', 'accountkey', 'subscriptionkey',
	'aeskey', 'wrappingkey', 'presharedkey', 'derivedkey',
	'sharedaccesssignature',
	// Authentication recovery and verifier material.
	'backupcode', 'backupcodes', 'recoverycode', 'recoverycodes',
	'invitecode', 'invitecodes', 'magiclink', 'magiclinks',
	'securityanswer', 'seedphrase', 'recoveryphrase', 'walletseed',
	'codeverifier', 'oobcode',
	// Government, tax and health identifiers.
	'taxid', 'taxpayerid', 'nationalid', 'passportnumber', 'passportno',
	'socialsecurity', 'driverslicense', 'driverlicense', 'driverslicence',
	'driverlicence', 'drivinglicense', 'drivinglicence',
	'nationalinsurance', 'aadhaarnumber', 'nhsnumber', 'medicalrecordnumber',
	'maidenname', 'placeofbirth',
	// Contact and date-of-birth PII. `phonenumber` and `mobilenumber` are the
	// same datum as the word-matched `phone`; leaving them out is what made
	// `phoneNumber` drop while `mobileNumber` and `phonenumber` rode along.
	'dateofbirth', 'birthdate', 'birthday', 'phonenumber', 'mobilenumber',
	// Postal PII, named one compound at a time ON PURPOSE.
	//
	// The obvious spelling is to word-match `address`, and that is wrong here:
	// it takes `shippingAddress` and `addressBook`, which an order surface and a
	// contacts surface legitimately put on a roster, and `walletAddress`, which
	// is a public chain identifier rather than personal data at all. Those three
	// are named in the transport guard below as the reason `address` is matched
	// whole there, and this list must not reopen from the other side what that
	// one closed deliberately. Naming the personal compounds keeps a home
	// address off the default projection without conscripting the rest.
	'homeaddress', 'billingaddress', 'postaladdress', 'streetaddress',
	'mailingaddress'
];

/**
 * Authenticators that are unsafe as bare fields but also serve as ordinary
 * qualifiers for identifier keys. Keeping these exact preserves
 * `nonceSortKey`, `hmacHashKey`, and `signatureRouteKey`; their credential
 * forms (`nonceKey`, `hmacKey`, `signatureKey`) are handled by the key rule.
 */
const EXACT_SENSITIVE_NAMES = new Set([
	'hmac', 'hmacs', 'signature', 'signatures', 'nonce', 'nonces'
]);

/**
 * Tokens matched as a SUBSTRING of the separator-free name.
 *
 * A flat lowercase name is a single word, so `apikey`, `sessionid`,
 * `accesstoken`, `jwtsecret`, `dbpassword` and `setcookie` need substring
 * matching to agree with their camelCase and separator-delimited spellings.
 *
 * These are the long, unambiguous tokens only. `phone` is deliberately NOT
 * here - a substring match on it is what dropped `microphone`, `microphoneOn`
 * and `headphones` - and neither are the short ones (`cc` in `account`, `pin`
 * in `spinner`). Those stay word-matched, which is exactly the split that makes
 * both directions correct.
 */
const SENSITIVE_SUBSTRINGS = [
	'token', 'secret', 'password', 'passwd', 'passphrase', 'session', 'cookie',
	'jwt', 'credential', 'email', 'iban', 'creditcard', 'apikey', 'privatekey',
	'privkey', 'accesskey', 'signingkey', 'secretkey', 'bearer', 'mnemonic',
	'keystore', 'connectionstring', 'passcode', 'csrf', 'xsrf', 'msisdn', 'e164'
];
// `iban` and `email` both COLLIDE across word boundaries once separators are
// stripped - `wifiBandwidth`, `apiBanner`, `midiBank` for one; `voicemail`,
// `officeMail` for the other - and both are kept anyway, for the same reason.
//
// Flat names such as `useriban`, `customeriban`, `payeeiban`, `accountiban`,
// `ibannumber` and `ibanlast4` need substring matching because their tokens
// do not expose the credential word. These financial-PII matches take priority
// over benign collisions; an explicit `select` can retain an intended field.

/**
 * Qualifiers that make a `key` a CREDENTIAL.
 *
 * The qualifier decides whether a compound `key` name is sensitive.
 *
 * `key` is one of the most overloaded words in software. It is a database
 * identity (`primaryKey`, `sortKey`, `hashKey`, `rangeKey`), a lookup
 * (`cacheKey`, `columnKey`, `routeKey`), an i18n handle (`translationKey`,
 * `i18nKey`, `messageKey`, `localeKey`), a UI identity (`reactKey`, `listKey`,
 * `tabKey`), a keyboard event (`keyCode`, `heldKeys`) and a musical one
 * (`musicKey`). None of those is a secret.
 *
 * A compound `key` name is benign unless another part of the name identifies
 * a credential. This denylist cannot cover every application-specific name;
 * flat compounds and unambiguous words such as `secret`, `token`, `password`
 * and `credential` provide additional matches. Explicit selectors own their
 * output, while the default projections retain only identity fields.
 */
const CREDENTIAL_KEY_QUALIFIERS = new Set([
	// Access and authentication.
	'api', 'apis', 'access', 'secret', 'private', 'priv', 'auth', 'session',
	'bearer', 'refresh', 'pass', 'master', 'root', 'admin', 'super',
	// Signing, crypto and transport material.
	'signing', 'sign', 'signature', 'crypto', 'hmac', 'encryption', 'decryption',
	'cipher', 'symmetric', 'asymmetric', 'ssh', 'gpg', 'pgp', 'rsa', 'ecdsa',
	'ed25519', 'tls', 'ssl', 'cert', 'certificate', 'seed', 'salt', 'nonce',
	// Product-specific names for credential keys.
	'stream', 'server', 'device', 'webhook', 'recovery', 'pairing', 'vapid',
	'idempotency', 'license', 'licence', 'deploy', 'activation', 'client',
	'consumer', 'publishable', 'restricted', 'live', 'test', 'sandbox',
	// Product and role-qualified keys reproduced on a real wire path.
	'aws', 'stripe', 'host',
	// `service` covers the two most damaging real-world instances: Supabase's
	// `serviceRoleKey`, which bypasses row-level security, and GCP's
	// `serviceAccountKey`. Both were broadcast to every peer on the roster.
	'service'
]);

/**
 * Nouns that make a `key` an IDENTIFIER, and that therefore stop a credential
 * qualifier elsewhere in the name from firing.
 *
 * A compound `key` name with no credential qualifier passes by default. This
 * list applies when a qualifier describes an identifier noun, preserving
 * ordinary names such as `clientSortKey`, `serverCacheKey`, `testHashKey`
 * and `livePartitionKey`.
 *
 * So the qualifier must be the one attached to `key`: it decides only when no
 * identifier noun sits between it and the key. `apiUserKey` still drops, because
 * `user` is a subject rather than a key-noun; `clientSortKey` passes, because
 * `sort` names what kind of key it is.
 */
const BENIGN_KEY_NOUNS = new Set([
	'primary', 'foreign', 'composite', 'candidate', 'natural', 'surrogate',
	'unique', 'sort', 'hash', 'range', 'partition', 'row', 'column', 'index',
	'cache', 'lookup', 'map', 'dedup', 'shard', 'bucket', 'object', 'storage',
	'cluster', 'translation', 'i18n', 'locale', 'message', 'route', 'react',
	'list', 'tab', 'music', 'group', 'aggregate', 'sibling', 'parent', 'child'
]);

/**
 * Suffixes that keep a FLAT `author...` name in the display-identity family.
 *
 * `auth` is matched per word, and a flat lowercase name is one word, so
 * `authorid` was tested as a single token, failed the exact `AUTHOR_WORDS`
 * lookup and was dropped - while `authorId`, `author_id` and `AUTHOR_ID` all
 * passed. Same value, opposite verdicts, in the family this file works hardest
 * to keep on a roster. Matching an author word plus one of these identity
 * suffixes restores the flat spelling without admitting `authorization`, whose
 * remainder (`ization`) is not one of them.
 */
const AUTHOR_FLAT_SUFFIXES = new Set([
	'id', 'ids', 'uid', 'uuid', 'name', 'names', 'slug', 'handle', 'label',
	'title', 'at', 'by', 'on', 'avatar', 'initials', 'email', 'key', 'ref'
]);

/**
 * Words that, following `key`, name key MATERIAL rather than a key-shaped
 * identifier: `keyPair`, `keyVault`, `keyChain`, `keyMaterial`, `keyStore`.
 *
 * The mirror of the qualifier list, for the spelling where `key` leads. Both
 * are also used to generate the FLAT compounds, so `keypair` and `keyvault`
 * are caught in the spelling a database column hands you.
 */
const KEY_SECRET_SUFFIXES = new Set([
	'pair', 'pairs', 'vault', 'chain', 'ring', 'material', 'store', 'file',
	'seed', 'phrase', 'passphrase', 'backup', 'export', 'archive', 'bytes',
	'blob', 'share', 'shares', 'slot', 'handle', 'dump', 'secret', 'data'
]);

/**
 * Short credential and PII tokens that must also match inside a FLAT name.
 *
 * These are all in {@link SENSITIVE_WORDS}, so spellings with separators or
 * camelCase boundaries match whole words. Flat lowercase names need this
 * additional check: `userpwd` must be sensitive just like `userPwd`. The
 * substring pass beside SENSITIVE_WORDS handles the longer tokens.
 *
 * They are listed here rather than added to SENSITIVE_SUBSTRINGS because a
 * substring scan of the whole name would fire mid-word. Most tokens can still
 * take that trade in the flat case; `ssn` cannot, because flattening ordinary
 * word pairs such as `processName` and `accessNode` manufactures the acronym.
 * It therefore has the narrower boundary-recovery rule below.
 *
 * `cc` and `pin` are deliberately absent: flat `account` and `spinner` contain
 * them, and those are ordinary roster fields.
 */
const FLAT_SENSITIVE_TOKENS = ['pwd', 'dob', 'otp', 'mfa', 'totp', 'cvv', 'cvc'];

/**
 * Common owners and descriptors around a flat `ssn` token.
 *
 * An unconditional substring check confuses a word ending in `ss` followed by
 * one beginning in `n` with the acronym: `processName`, `businessName`,
 * `accessNode`, `addressName` and `classSnapshot` all contain `ssn` once flat.
 * Boundary-free input cannot distinguish every pair, so accept only the
 * high-signal shapes: an edge, a common data subject, or an SSN descriptor.
 */
const FLAT_SSN_PREFIXES = [
	'user', 'customer', 'client', 'employee', 'member', 'person', 'patient',
	'taxpayer', 'account', 'profile', 'owner'
];
const FLAT_SSN_SUFFIXES = [
	'last4', 'number', 'hash', 'id', 'value', 'masked', 'suffix', 'digits'
];

/**
 * High-signal owners for contact numbers in a FLAT database/profile field.
 *
 * `phone` cannot be a raw substring rule: it would drop `microphone`,
 * `headphone` and `smartphone`, all ordinary product/device fields. But a flat
 * name has no recoverable word boundary, so the common owner is the boundary:
 * `userphone`, `workphone`, `usertelephone` and `officefax` are the same values
 * as their camelCase twins and must receive the same verdict.
 */
const FLAT_CONTACT_PREFIXES = [
	'user', 'customer', 'client', 'employee', 'member', 'person', 'patient',
	'contact', 'home', 'work', 'office', 'mobile', 'cell', 'primary', 'secondary',
	'emergency', 'guardian', 'parent', 'billing', 'shipping', 'profile', 'account',
	'owner'
];
const FLAT_CONTACT_SUFFIXES = [
	's', 'number', 'numbers', 'no', 'value', 'values', 'last4', 'digits', 'hash',
	'hashed', 'masked', 'verified', 'verification', 'countrycode', 'extension', 'ext'
];

/** @param {string} flat @returns {boolean} */
function flatContactIsSensitive(flat) {
	for (const token of ['telephone', 'phone', 'fax']) {
		let at = flat.indexOf(token);
		while (at !== -1) {
			const head = flat.slice(0, at);
			const tail = flat.slice(at + token.length);
			let owned = head === '';
			if (!owned) {
				for (let i = 0; i < FLAT_CONTACT_PREFIXES.length; i++) {
					if (head.endsWith(FLAT_CONTACT_PREFIXES[i])) { owned = true; break; }
				}
			}
			let described = tail === '';
			if (!described) {
				for (let i = 0; i < FLAT_CONTACT_SUFFIXES.length; i++) {
					if (tail.startsWith(FLAT_CONTACT_SUFFIXES[i])) { described = true; break; }
				}
			}
			if (owned && described) return true;
			at = flat.indexOf(token, at + 1);
		}
	}
	return false;
}

/** @param {string} flat @returns {boolean} */
function flatSsnIsSensitive(flat) {
	let at = flat.indexOf('ssn');
	while (at !== -1) {
		const end = at + 3;
		if (at === 0 || end === flat.length) return true;
		const head = flat.slice(0, at);
		const tail = flat.slice(end);
		for (let i = 0; i < FLAT_SSN_PREFIXES.length; i++) {
			if (head.endsWith(FLAT_SSN_PREFIXES[i])) return true;
		}
		for (let i = 0; i < FLAT_SSN_SUFFIXES.length; i++) {
			if (tail.startsWith(FLAT_SSN_SUFFIXES[i])) return true;
		}
		at = flat.indexOf('ssn', at + 1);
	}
	return false;
}

/**
 * Subject words that establish a real boundary before a credential qualifier
 * in a flat spelling. Without this boundary, `live` in `delivery`, `test` in
 * `latest`, `sign` in `design`, and `pass` in `bypass` all become credentials.
 */
const FLAT_KEY_SUBJECTS = [
	'user', 'node', 'group', 'record', 'item', 'entity', 'service', 'storage',
	'account', 'client', 'customer', 'tenant', 'project', 'workspace', 'app',
	'application', 'role', 'grid',
	// Owners reproduced in three-part flat names. `deviceStreamKey` is split
	// into words and dropped, but its SQL/JSON twin `devicestreamkey` has no
	// boundary before `stream`; without these ordinary owners the exact same
	// credential rides the roster under its flat spelling.
	'device', 'team', 'organization', 'organisation', 'org', 'member', 'owner',
	'author', 'bot', 'peer', 'host', 'server', 'vendor', 'provider',
	'integration', 'environment', 'env', 'deployment', 'worker', 'agent'
];

/** @param {string} head @returns {boolean} */
function flatHeadHasCredentialQualifier(head) {
	for (const qualifier of CREDENTIAL_KEY_QUALIFIERS) {
		if (head === qualifier) return true;
		if (head.endsWith(qualifier)) {
			const prefix = head.slice(0, -qualifier.length);
			// A prior key-looking segment recovers the boundary even when it is
			// embedded in an ordinary word: `monkeyStreamKey` tokenizes and
			// drops, so its flat twin `monkeystreamkey` must do the same.
			if (prefix.includes('key')) return true;
		}
		for (let i = 0; i < FLAT_KEY_SUBJECTS.length; i++) {
			const subject = FLAT_KEY_SUBJECTS[i];
			if (head.startsWith(qualifier) && head.slice(qualifier.length).startsWith(subject)) {
				return true;
			}
			if (head.startsWith(subject) && head.slice(subject.length).startsWith(qualifier)) {
				return true;
			}
			if (head.endsWith(qualifier) && head.slice(0, -qualifier.length).endsWith(subject)) {
				return true;
			}
		}
	}
	return false;
}

/**
 * The `author` family, which is ordinary display identity on any collaborative
 * surface and must keep riding a roster.
 *
 * Match `auth` within each word, except the author words listed here. Word
 * boundaries preserve `authorId`, `authorName` and `authoredAt` while still
 * rejecting `authorization`, `oauth` and `authentic`. Tokenizing camelCase
 * first distinguishes the author word from a following qualifier.
 */
const AUTHOR_WORDS = new Set(['author', 'authors', 'authored', 'authoring']);

/**
 * Split a field name into lowercase words, on separators AND camelCase humps,
 * so `cc_last4`, `ccNumber` and `CCNumber` all yield a `cc` word while
 * `account` yields only `account`.
 *
 * A tokenizer rather than a cleverer regex: the boundary this needs is "a word
 * ended here", and a case-insensitive character class cannot see a camelCase
 * hump such as the boundary between `cc` and `Number`.
 *
 * @param {string} name
 * @returns {string[]}
 */
function fieldNameWords(name) {
	return name
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((word) => word.toLowerCase());
}

/**
 * The name with every separator removed, lowercased: `credit_card`,
 * `creditCard` and `CREDIT-CARD` all reduce to `creditcard`.
 *
 * @param {string} name
 * @returns {string}
 */
function joinedFieldName(name) {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Whether a name ends in an ASCII digit - the cheap test that decides whether
 * {@link stripTrailingDigits} is worth calling at all.
 *
 * @param {string} word
 * @returns {boolean}
 */
function endsWithDigit(word) {
	const code = word.charCodeAt(word.length - 1);
	return code >= 48 && code <= 57;
}

/**
 * A word without a trailing ordinal - `phone2` becomes `phone`.
 *
 * Form fields and CRM columns number their repeats (`phone1`, `phone2`,
 * `address1`, `address2`), and the tokenizer counts digits as word characters,
 * so the matcher also checks the base word without its ordinal. It retains
 * the original word check because names such as `ipv4` and `ipv6` must also
 * match whole.
 *
 * @param {string} word
 * @returns {string}
 */
function stripTrailingDigits(word) {
	let end = word.length;
	while (end > 0 && word.charCodeAt(end - 1) >= 48 && word.charCodeAt(end - 1) <= 57) end--;
	return end === word.length ? word : word.slice(0, end);
}

/** A token with an optional trailing numeric version or ordinal removed. */
function stripWordOrdinal(word) {
	return endsWithDigit(word) ? stripTrailingDigits(word) : word;
}

/**
 * Split a FLAT author name into the words its camelCase twin would have.
 *
 * Returns `null` when the word is not an author-family compound, which leaves
 * `authorization` and `oauth` to the sensitive branch. Decomposing rather than
 * exempting is what keeps the flat spelling on exactly the path the separated
 * one takes: `authoremail` becomes `['author', 'email']` and is then dropped by
 * the word rule, the same as `authorEmail`.
 *
 * @param {string} flat
 * @returns {string[] | null}
 */
function flatAuthorWords(flat) {
	for (const stem of AUTHOR_WORDS) {
		if (flat.length > stem.length && flat.startsWith(stem)) {
			const rest = flat.slice(stem.length);
			if (AUTHOR_FLAT_SUFFIXES.has(rest)) return [stem, rest];
		}
	}
	return null;
}

/**
 * Whether one of `needles` occurs in `joined` starting at a word boundary.
 *
 * `starts` are the offsets in the separator-free name where each tokenized word
 * begins, which is the only way to tell `taxIdNumber` from `syntaxId` once the
 * separators are gone: both contain `taxid`, one at a word start and one inside
 * `syntax`.
 *
 * @param {string} joined
 * @param {number[]} starts
 * @param {string[]} needles
 * @returns {boolean}
 */
function matchesAtWordStart(joined, starts, needles) {
	for (let i = 0; i < needles.length; i++) {
		const needle = needles[i];
		let at = joined.indexOf(needle);
		while (at !== -1) {
			for (let s = 0; s < starts.length; s++) {
				if (starts[s] === at) return true;
				if (starts[s] > at) break;
			}
			at = joined.indexOf(needle, at + 1);
		}
	}
	return false;
}

/**
 * Whether a `key` inside `words` at `index` is a CREDENTIAL key.
 *
 * The qualifier attached to the key decides. An identifier noun sitting between
 * a qualifier and the key means the qualifier is describing something else -
 * `clientSortKey` is a sort key belonging to the client, not a client key.
 * Matching the adjacent noun preserves that distinction.
 *
 * @param {string[]} words
 * @param {number} index
 * @returns {boolean}
 */
function keyIsCredential(words, index) {
	// A bare `key` / `keys` has no qualifier to distinguish a credential,
	// so the conservative verdict is sensitive.
	if (words.length === 1) return true;

	// `key` LEADING key material - `keyPair`, `keyVault`, `keyMaterial`.
	if (index + 1 < words.length && KEY_SECRET_SUFFIXES.has(stripWordOrdinal(words[index + 1]))) return true;

	const before = index > 0 ? stripWordOrdinal(words[index - 1]) : null;
	if (before !== null && CREDENTIAL_KEY_QUALIFIERS.has(before)) return true;
	// The narrow override: an identifier noun owns the key, so a qualifier
	// further away is qualifying that noun instead. `apiUserKey` still drops,
	// because `user` is a subject and not a kind of key.
	if (before !== null && BENIGN_KEY_NOUNS.has(before)) return false;

	for (let j = 0; j < words.length; j++) {
		if (j === index) continue;
		if (CREDENTIAL_KEY_QUALIFIERS.has(stripWordOrdinal(words[j]))) return true;
	}
	return false;
}

/**
 * Whether a field name is credential-shaped and should be dropped from a
 * default broadcast projection.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isSensitiveFieldName(name) {
	const joined = joinedFieldName(name);
	if (EXACT_SENSITIVE_NAMES.has(joined)) return true;
	// The flat spellings, which have no word boundary to find.
	for (let i = 0; i < SENSITIVE_SUBSTRINGS.length; i++) {
		if (joined.includes(SENSITIVE_SUBSTRINGS[i])) return true;
	}

	let words = fieldNameWords(name);

	// A FLAT lowercase name is one word, so every rule below that reads words
	// sees nothing inside it. Give it the words its separated twin would have
	// had, so the two spellings cannot disagree: first the author family, then
	// the short tokens, then `key` (handled where the word rule handles it).
	if (words.length === 1) {
		const flat = words[0];
		const authorWords = flatAuthorWords(flat);
		if (authorWords !== null) {
			words = authorWords;
		} else {
			for (let i = 0; i < FLAT_SENSITIVE_TOKENS.length; i++) {
				if (flat.includes(FLAT_SENSITIVE_TOKENS[i])) return true;
			}
			if (flatSsnIsSensitive(flat)) return true;
			if (flatContactIsSensitive(flat)) return true;
			const ordinalFlat = stripWordOrdinal(flat);
			if (ordinalFlat === 'key' || ordinalFlat === 'keys') return true;
			// Inspect the FINAL key-looking segment. Taking the first stopped
			// inside an owner such as `monkey` / `keyboard` and never reached the
			// credential suffix in `monkeystreamkey`.
			const keyAt = flat.lastIndexOf('key');
			if (keyAt !== -1) {
				// Read the tokens either side of `key` and hand them to the same
				// decision the word rule uses, so `clientsortkey` passes exactly as
				// `clientSortKey` does and `servicerolekey` drops exactly as
				// `serviceRoleKey` does. Looking only for adjacent qualifier-key
				// pairs would miss the qualifier in a flat owner-qualified name.
				const head = flat.slice(0, keyAt);
				const tail = flat.slice(keyAt + 3);
				const ordinalHead = stripWordOrdinal(head);
				/** @type {string[]} */
				const parts = [];
				for (const q of CREDENTIAL_KEY_QUALIFIERS) {
					if (ordinalHead === q) parts.push(q);
					for (let i = 0; i < FLAT_KEY_SUBJECTS.length; i++) {
						const subject = FLAT_KEY_SUBJECTS[i];
						if (ordinalHead.endsWith(q) && ordinalHead.slice(0, -q.length).endsWith(subject)) {
							parts.push(q);
							break;
						}
					}
				}
				for (const n of BENIGN_KEY_NOUNS) if (ordinalHead.endsWith(n)) parts.push(n);
				const before = parts.length > 0
					? parts.reduce((a, b) => (b.length > a.length ? b : a))
					: ordinalHead;
				// Only a flat name that is EXACTLY `key` is the bare case. Collapsing
				// an unknown remainder into it instead made `keyboard` and `keycode`
				// read as a bare key and drop, while their humped twins passed.
				/** @type {string[]} */
				const segmented = [];
				if (before !== '') segmented.push(before);
				const keyIndex = segmented.length;
				segmented.push('key');
				if (tail !== '') segmented.push(tail);
				if (keyIsCredential(segmented, keyIndex)) return true;
				// Nothing attached to the key says credential; a qualifier elsewhere
				// in the flat name still does, matching the word rule's fallback.
				if (!BENIGN_KEY_NOUNS.has(before)) {
					if (flatHeadHasCredentialQualifier(ordinalHead)) return true;
				}
			}
		}
	}

	// The multi-word compounds, anchored to a word start.
	//
	// Flat lowercase names have no internal word starts, so compounds must
	// match without an anchor: `usertaxid` and `userTaxId` describe the same
	// field. Postgres folds unquoted identifiers to this lowercase spelling.
	// The unanchored scan accepts benign collisions such as `syntaxid` with
	// `taxid`; avoiding personal-data exposure takes priority here.
	if (words.length === 1) {
		for (let i = 0; i < SENSITIVE_COMPOUNDS.length; i++) {
			if (joined.includes(SENSITIVE_COMPOUNDS[i])) return true;
		}
	} else {
		const starts = [];
		let offset = 0;
		for (let i = 0; i < words.length; i++) {
			starts.push(offset);
			offset += words[i].length;
		}
		if (matchesAtWordStart(joined, starts, SENSITIVE_COMPOUNDS)) return true;
	}

	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		if (SENSITIVE_WORDS.has(word)) return true;
		// ...and the same word carrying an ordinal suffix. The tokenizer treats
		// digits as word characters, so `phone2` is one word. Strip the ordinal
		// to match names such as `phone1`, `phone2`, `pin1` and `cc2`.
		// Stripping instead of splitting preserves the words that
		// legitimately END in digits (`ipv4`, `ipv6`).
		//
		// Gated on the last character rather than stripping unconditionally: almost
		// no word ends in a digit, and paying a call plus a second Set lookup on
		// every word of every name to serve that minority measured as a 2.6%
		// regression on the uncached path.
		if (endsWithDigit(word) && SENSITIVE_WORDS.has(stripTrailingDigits(word))) return true;
		// Any word containing `auth` is sensitive unless it is the author
		// family - `authorization`, `oauth` and `authentic` are caught while
		// `author`, `authorId` and `authoredAt` keep riding a roster.
		if (word.includes('auth') && !AUTHOR_WORDS.has(word)) return true;
		const ordinalWord = stripWordOrdinal(word);
		if (ordinalWord === 'key' || ordinalWord === 'keys') {
			// THE QUALIFIER ATTACHED TO THE KEY DECIDES - see keyIsCredential.
			// `apiKey`, `streamKey` and `masterKeyMap` drop while `hashKey`,
			// `rangeKey`, `translationKey`, `keyCode`, `heldKeys` and
			// `clientSortKey` ride the roster.
			if (keyIsCredential(words, i)) return true;
		}
	}
	return false;
}

/**
 * Memoised verdicts for {@link isUnsafeProjectionFieldName}.
 *
 * The projection runs once per connection, not once per broadcast: `select` is
 * called from `presence.join()` and from the cursor's ws-state creation, and
 * measuring the object walk shows 200 joins produce 200 walks while updates,
 * flushes and `list()` produce none. So this memo serves a per-connection path.
 * It still earns its place - word matching answers a name with two
 * tokenizations, a joined normalization and several set lookups, which is
 * roughly 900ns against 4ns for a hit - but it is not sitting on a fan-out hot
 * path, and it must not be tuned as though a miss were catastrophic.
 *
 * THE HIT PATH DOES NOTHING BUT READ, and that is the policy decision. Three
 * eviction schemes were measured against a client that can influence the names
 * on a projected object (an upgrade hook spreading the request context puts
 * header names there):
 *
 *   - Filling and then freezing forever assumed the app connects before an
 *     attacker. It does not: a hostile client filling all 1024 slots first
 *     meant the app's own names were never cached again for the life of the
 *     process, and unlike every other policy it never recovered.
 *   - Least-recently-used, implemented the only way a `Map` allows - delete
 *     and re-set the key on every HIT - was far worse. Touching a live key in
 *     a full table thrashes V8's shrink/grow: 754ns per hit at the cap against
 *     ~4ns for a plain read, which is what recomputing the verdict costs
 *     anyway, and 120ns even after the flood stopped. It also did not prevent
 *     starvation, since a flood wider than the table evicts the app's names
 *     regardless. A cache whose hit path costs as much as a miss is not one.
 *   - Oldest-inserted, evicting only on a MISS, leaves the hit path a single
 *     `Map.get`. Under a flood it degrades to roughly the cost of no cache,
 *     and it returns to full speed the moment the flood stops.
 *
 * The last is what ships. The table also refuses to store a long name at all,
 * so the entry cap doubles as a byte cap rather than retaining up to
 * `1024 * maxNameLength` of client-influenced strings.
 */
const VERDICT_CACHE = new Map();
const VERDICT_CACHE_MAX = 1024;

/**
 * Rotating position for {@link evictOneVerdict}, held ACROSS calls.
 *
 * `VERDICT_CACHE.keys().next()` looks like an O(1) way to find the oldest
 * entry and is not: V8 leaves a tombstone on delete and only compacts on
 * rehash, so a FRESH iterator re-walks every tombstone the previous evictions
 * left. Fresh-iterator eviction scales with the tombstone prefix: 106ns at 64
 * entries, 212ns at the shipped 1024, 2201ns at 16384, and a flooded path
 * 1.26x slower than no cache. A persistent iterator avoids that repeated
 * traversal; `runtime/utils/rate-limiter.js` uses the same eviction strategy.
 *
 * @type {Iterator<string> | null}
 */
let verdictCursor = null;

/** Reclaim one slot without re-walking the table. */
function evictOneVerdict() {
	for (let wrapped = 0; wrapped < 2; wrapped++) {
		if (verdictCursor === null) verdictCursor = VERDICT_CACHE.keys();
		const step = verdictCursor.next();
		if (step.done) { verdictCursor = null; continue; }
		VERDICT_CACHE.delete(step.value);
		return;
	}
}
/**
 * Longest name the memo will store. Real field names are far shorter; a long
 * one is either junk or unique, and neither is worth retaining.
 */
const VERDICT_CACHE_MAX_NAME_LENGTH = 64;

/**
 * Whether a default projection must drop this field - the single question both
 * projections ask, answered once per distinct name.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isUnsafeProjectionFieldName(name) {
	const cached = VERDICT_CACHE.get(name);
	if (cached !== undefined) return cached;
	// Names beyond the length cap are sensitive without running the compound
	// scan. They cannot enter the cache, so computing them on every frame would
	// otherwise leave repeated client-influenced names with unbounded work.
	//
	// Tested AFTER the cache read, not before: an over-long name is never stored,
	// so it reaches this line on every call regardless, while a normal name would
	// otherwise pay the comparison on every cache HIT - the one path that has to
	// stay at a single lookup.
	if (name.length > VERDICT_CACHE_MAX_NAME_LENGTH) return true;
	const verdict = isStructurallyUnsafeFieldName(name) || isSensitiveFieldName(name);
	if (name.length <= VERDICT_CACHE_MAX_NAME_LENGTH) {
		if (VERDICT_CACHE.size >= VERDICT_CACHE_MAX) evictOneVerdict();
		VERDICT_CACHE.set(name, verdict);
	}
	return verdict;
}

/**
 * Recursion budget for the default `select` projections. userData is
 * server-authored (it is whatever the app's upgrade hook returned), so this is
 * a backstop rather than a client-reachable limit - but a projection that
 * recurses without one turns a single pathological object into a RangeError
 * thrown out of `join()` / `update()`, which is a worse failure than a
 * truncated field. Presence and cursor payloads are a handful of levels deep
 * in practice; past the cap the subtree is dropped (`undefined`, omitted by
 * JSON) exactly as a detected cycle is.
 */
export const MAX_PROJECTION_DEPTH = 64;

/**
 * Whether `value` nests deeper than `maxDepth`.
 *
 * A byte cap does not bound depth. A deeply nested value sits far under 8 KB
 * and is still fatal downstream: the cluster relay serializes with
 * `structuredClone` (worker `postMessage`), which overflows around depth 1834 -
 * roughly four times shallower than what the byte cap admits - and that
 * overflow TERMINATES THE WORKER rather than dropping one frame. So a
 * client-supplied blob has to be bounded on both axes.
 *
 * ITERATIVE ON PURPOSE. A recursive depth check would blow its own stack on
 * precisely the input it exists to reject, turning the guard into a second copy
 * of the bug.
 *
 * @param {unknown} value
 * @param {number} maxDepth
 * @returns {boolean}
 */
export function exceedsDepth(value, maxDepth) {
	/** @type {Array<{ node: unknown, depth: number }>} */
	const stack = [{ node: value, depth: 1 }];
	/**
	 * Greatest depth at which a node has already been expanded. A WeakSet is not
	 * enough: a shallow visit must not hide a later over-depth path to that node.
	 * @type {WeakMap<object, number>}
	 */
	const expandedAtDepth = new WeakMap();
	while (stack.length > 0) {
		const { node, depth } = /** @type {{ node: any, depth: number }} */ (stack.pop());
		if (node === null || typeof node !== 'object') continue;
		if (depth > maxDepth) return true;
		const previousDepth = expandedAtDepth.get(node);
		if (previousDepth !== undefined && previousDepth >= depth) continue;
		expandedAtDepth.set(node, depth);
		// Reads are guarded for the same reason both projections guard theirs: a
		// getter on userData runs OUR code on the app's terms, and one that
		// throws here would surface out of `presence.join()` / `cursor.update()`
		// - fire-and-forget calls with no caller to catch it. The sibling
		// `JSON.stringify` on this same value is already wrapped; this walk was
		// the one unguarded read left, and a getter that throws only on its
		// SECOND call passes the stringify and then escapes from here.
		try {
			if (Array.isArray(node)) {
				for (let i = 0; i < node.length; i++) stack.push({ node: node[i], depth: depth + 1 });
			} else {
				for (const key of Object.keys(node)) stack.push({ node: node[key], depth: depth + 1 });
			}
		} catch {
			// An unreadable subtree cannot be measured, so treat it as over
			// budget: the projection drops it, which is the same outcome as a
			// value that really is too deep and the safe direction here.
			return true;
		}
	}
	return false;
}

/**
 * Names that are never identity and must not ride a broadcast frame: prototype
 * gadgets (they would become properties of a wire object) and transport
 * metadata.
 *
 * The transport set is wider than the one name the runtime injects. Matching
 * only `remoteAddress` left the client IP crossing the boundary under two other
 * spellings this project's own documentation endorses: the ratelimit plugin
 * reads `ud.remoteAddress || ud.ip || ud.address` and documents `ip` and
 * `address` as client-IP slots, so an app following that convention published
 * every peer's IP on the roster.
 *
 * `headers`, `url` and `requestId` are here for the same reason. The case this
 * denylist exists for is an upgrade hook that spreads its whole context
 * (`(ctx) => ({ ...ctx, userId })`), which puts the request headers on the wire
 * verbatim - `x-forwarded-for`, `x-real-ip`, `user-agent`, `host` - and the URL
 * with its query string, which is where a one-time token lives when a client
 * cannot set a header. Dropping the credential-shaped keys INSIDE `headers` is
 * not enough, because the IP is not credential-shaped.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isStructurallyUnsafeFieldName(name) {
	if (name.startsWith('__') || name === 'constructor' || name === 'prototype') return true;

	// Exact-match names, compared with separators removed. These are matched
	// whole rather than per word because their words are ordinary on their own:
	// `url` as a WORD would eat `avatarUrl`, `imageUrl` and `profileUrl`, which
	// are exactly what a roster is for, and `host` as a word would eat `hostId`
	// on any meeting surface.
	// The ordinal spellings too - `address1` and `address2` are the canonical
	// form-field pair and both passed while the bare `address` dropped. Gated on
	// the last character for the same reason as the word rule: the strip is for a
	// minority of names and must not cost the majority a second lookup.
	const joined = joinedFieldName(name);
	if (TRANSPORT_EXACT_NAMES.has(joined)) return true;
	if (endsWithDigit(joined) && TRANSPORT_EXACT_NAMES.has(stripTrailingDigits(joined))) return true;

	// Word-matched names. Matching only the bare spellings left the client IP
	// crossing under every qualified one - `clientIp`, `ipAddress`, `remoteIp`,
	// `peerIp`, `remoteAddr` - while the unqualified `ip` was correctly dropped.
	// `zip` and `zipCode` are unaffected: `zip` is its own word, not `ip`.
	const words = fieldNameWords(name);
	// A flat lowercase database/JSON spelling is one word, so the word rule
	// above has the same third-spelling hole the credential rules had:
	// `remoteIp` and `remote_ip` drop while `remoteip` rides. Recover only
	// high-signal transport boundaries; a raw `includes('ip')` would take
	// ordinary roster fields such as `zip`, `shipping`, `relationship`,
	// `snippet`, `iphone` and `ipad`.
	if (words.length === 1 && flatTransportIsUnsafe(words[0])) return true;
	for (const word of words) {
		if (TRANSPORT_WORDS.has(word)) return true;
	}
	return false;
}

/**
 * Owners that recover the missing boundary before `ip` / `addr` in a flat
 * transport field. Match at the end of the head so vendor or routing prefixes
 * can precede them (`originalclientip`, `xclusterclientip`) without turning
 * `ip` into an unsafe substring everywhere.
 */
const FLAT_TRANSPORT_OWNERS = [
	'remote', 'client', 'peer', 'socket', 'source', 'origin', 'request',
	'local', 'public', 'private', 'server', 'host', 'proxy', 'upstream',
	'downstream', 'destination', 'dest', 'forwarded', 'real', 'external',
	'connecting', 'cfconnecting', 'trueclient', 'fastlyclient', 'flyclient',
	'azureclient', 'envoyexternal', 'xclient', 'xclusterclient'
];

/**
 * Descriptors that may follow a flat IP/address token. Requiring one prevents
 * the token-at-start case from swallowing product names (`iphone`, `ipad`,
 * `ipod`, `ipfs`) while keeping `iphash`, `iplast4`, `addrfamily`, etc. in
 * parity with their camelCase twins.
 */
const FLAT_TRANSPORT_SUFFIXES = [
	'address', 'addr', 'hash', 'hashed', 'mask', 'masked', 'last4', 'value',
	'string', 'bytes', 'version', 'family', 'country', 'city', 'geo',
	'geolocation', 'asn', 'range', 'prefix', 'network', 'subnet', 'v4', 'v6'
];

/** @param {string} flat @returns {boolean} */
function flatTransportIsUnsafe(flat) {
	for (const token of ['ip', 'addr']) {
		let at = flat.indexOf(token);
		while (at !== -1) {
			const head = flat.slice(0, at);
			const tail = flat.slice(at + token.length);
			let owned = head === '';
			if (!owned) {
				for (let i = 0; i < FLAT_TRANSPORT_OWNERS.length; i++) {
					if (head.endsWith(FLAT_TRANSPORT_OWNERS[i])) {
						owned = true;
						break;
					}
				}
			}
			if (owned) {
				if (tail === '') return true;
				for (let i = 0; i < FLAT_TRANSPORT_SUFFIXES.length; i++) {
					if (tail.startsWith(FLAT_TRANSPORT_SUFFIXES[i])) return true;
				}
			}
			at = flat.indexOf(token, at + 1);
		}
	}
	return false;
}

/**
 * Transport names matched WHOLE. See isStructurallyUnsafeFieldName for why
 * these cannot be word-matched.
 */
const TRANSPORT_EXACT_NAMES = new Set([
	'url', 'requesturl', 'originalurl', 'fullurl',
	'requestid', 'useragent',
	'xforwardedfor', 'forwardedfor', 'forwarded', 'xrealip', 'xforwardedproto',
	// Vendor forwarding headers reached by the same context spread this guard
	// exists to contain.
	'xoriginalforwardedfor', 'xvercelforwardedfor', 'xenvoyexternaladdress',
	'xazureclientip', 'xforwardedhost',
	'remoteport', 'localport',
	// `headers` and `address` live here rather than in the word set. As WORDS
	// they ate ordinary display fields: `header` took `columnHeader`,
	// `sectionHeader` and `headerImage`, and `address` took `shippingAddress`,
	// `walletAddress` and `addressBook`. Only the bare and transport-qualified
	// spellings are the request metadata this guard is for.
	'headers', 'header', 'httpheaders', 'requestheaders',
	'rawheaders', 'rawheader', 'requestrawheaders', 'httprawheaders',
	'address', 'addresses', 'remoteaddress', 'clientaddress', 'peeraddress',
	'socketaddress', 'ipaddress', 'ipaddr'
]);

/**
 * Transport names matched per WORD, so every qualified spelling is covered.
 *
 * The case this exists for is an upgrade hook that spreads its whole context
 * (`(ctx) => ({ ...ctx, userId })`), which puts the request headers on the wire
 * verbatim and the URL with its query string, where a one-time token lives when
 * a client cannot set a header. Dropping the credential-shaped keys INSIDE
 * `headers` is not enough, because an IP is not credential-shaped.
 */
const TRANSPORT_WORDS = new Set([
	'ip', 'ips', 'ipv4', 'ipv6',
	'addr',
	'referer', 'referrer'
]);
