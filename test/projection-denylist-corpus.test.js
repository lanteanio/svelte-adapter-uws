// Scores the default projection denylist against GENERATED corpora rather than
// hand-picked names, in both directions.
//
// The sibling suite pins individual judgements and reads as prose. This one
// exists because hand-picked cases hid two whole classes of defect for several
// rounds: an entry that only matched a WHOLE name (so one qualifier defeated
// every compound in the set), and a rule that scanned every word (so one
// ordinary adjective condemned 616 canonical key-shaped identifiers). Both were
// invisible to a list of names chosen by the person who wrote the rule, and both
// showed up the moment the names were generated instead.
//
// Keep the two directions balanced. A denylist that drops everything scores
// perfectly on the first block and is useless, which is exactly how the design
// that preceded this one was measured and rejected.

import { describe, it, expect } from 'vitest';
import {
	isUnsafeProjectionFieldName,
	exceedsDepth,
	MAX_PROJECTION_DEPTH
} from '../src/plugins/_shared/sensitive.js';

// The question the projections actually ask - the memo included, since that is
// what answers at runtime.
const dropped = (name) => isUnsafeProjectionFieldName(name);

describe('credentials never ride a broadcast projection', () => {
	const CREDENTIALS = [
		'key', 'apiKey', 'api_key', 'x-api-key', 'apikey', 'APIKEY',
		'accessKey', 'privateKey', 'privkey', 'signingKey', 'licenseKey', 'masterKey',
		'streamKey', 'serverKey', 'hmacKey', 'deviceKey', 'webhookKey', 'signKey',
		'cryptoKey', 'symmetricKey', 'recoveryKey', 'pairingKey', 'seedKey', 'vapidKey',
		'idempotencyKey', 'userApiKey', 'userAccessKey', 'userPrivateKey', 'nodePrivateKey',
		'groupPrivateKey', 'recordEncryptionKey', 'itemApiKey', 'entitySigningKey',
		'serverKeyMap', 'masterKeyMap', 'recoveryKeyCode', 'licenseKeyCode',
		'keyMaterial', 'keyData', 'keyVault', 'keyPair', 'keyChain', 'keystore',
		'secretkey', 'sessionid', 'sessionkey', 'sessiontoken', 'accesstoken',
		'refreshtoken', 'idtoken', 'jwtsecret', 'clientsecret', 'webhooksecret',
		'signingsecret', 'apisecret', 'totpsecret', 'dbpassword', 'passwordhash',
		'tokenhash', 'setcookie', 'cookieheader', 'credentialid', 'passphrase',
		'bearer', 'mnemonic', 'connectionstring'
	];
	for (const name of CREDENTIALS) {
		it(`drops ${name}`, () => expect(dropped(name)).toBe(true));
	}

	// Supabase's service role key bypasses row-level security, and the GCP
	// service account key is its equivalent. Both rode the roster in every
	// spelling until `service` became a credential qualifier.
	it('drops the admin service credentials in every spelling', () => {
		for (const name of [
			'serviceRoleKey', 'service_role_key', 'servicerolekey', 'SERVICE_ROLE_KEY',
			'serviceAccountKey', 'serviceaccountkey'
		]) {
			expect(dropped(name), name).toBe(true);
		}
	});

	it('drops cloud, cipher, recovery, wallet and verifier credentials', () => {
		for (const name of [
			'accountKey', 'accountkey', 'storageAccountKey', 'storageaccountkey',
			'subscriptionKey', 'subscriptionkey', 'sharedAccessSignature', 'sharedaccesssignature',
			'aesKey', 'aeskey', 'wrappingKey', 'wrappingkey', 'preSharedKey',
			'presharedkey', 'derivedKey', 'derivedkey', 'dek', 'kek',
			'backupCodes', 'backupcodes', 'recoveryCodes', 'securityAnswer', 'passcode',
			'seedPhrase', 'recoveryPhrase', 'walletSeed', 'codeVerifier', 'oobCode'
		]) expect(dropped(name), name).toBe(true);
	});
});

describe('personal data never rides a broadcast projection', () => {
	// Taken from mainstream auth, session and payment payload shapes rather than
	// from the rule. Measured against the previous design, 20 of these passed -
	// including a social security number, a bank account number and a card CVV.
	const PII = [
		'ssn', 'userSsn', 'ssnLast4', 'socialSecurityNumber', 'social_security_number',
		'dob', 'userDob', 'dateOfBirth', 'birthDate', 'birthdate', 'date_of_birth',
		'passportNo', 'passportNumber', 'passport_number',
		'driversLicenseNumber', 'driverLicenseNumber', 'drivingLicence',
		'nationalIdNumber', 'nationalId', 'taxIdNumber', 'taxId',
		'bankAccountNumber', 'bankRoutingNumber', 'accountNumber', 'routingNumber',
		'sortCode', 'iban', 'userIban', 'useriban', 'customeriban', 'ibanLast4',
		'cardNumber', 'userCardNumber', 'cardCvv', 'cvvCode', 'cvv', 'cvc',
		'cardSecurityCode', 'securityCode', 'creditCard', 'creditcard',
		'phoneNumber', 'telephone', 'mobileNumber', 'phone',
		'userphone', 'customerphone', 'contactphone', 'homephone', 'workphone',
		'officephone', 'usertelephone', 'faxNumber', 'userfax', 'msisdn', 'e164',
		'homeAddress', 'billingAddress', 'postalAddress', 'streetAddress',
		'mailingAddress', 'home_address', 'street_address', 'BILLING_ADDRESS',
		'homeaddress', 'billingaddress', 'userHomeAddress', 'billingAddressLine1'
	];
	for (const name of PII) {
		it(`drops ${name}`, () => expect(dropped(name)).toBe(true));
	}

	it('drops non-US government and health identifiers', () => {
		for (const name of [
			'nationalInsuranceNumber', 'nationalinsurancenumber', 'aadhaarNumber',
			'nhsNumber', 'medicalRecordNumber', 'maidenName', 'placeOfBirth'
		]) expect(dropped(name), name).toBe(true);
	});

	// A qualifier used to defeat every compound in the set, because the match was
	// against the WHOLE name. This is the property that makes the set worth having.
	it('a qualifier does not defeat a compound', () => {
		for (const base of ['cardNumber', 'accountNumber', 'routingNumber', 'securityCode', 'taxId', 'nationalId']) {
			for (const qualified of [`user${base[0].toUpperCase()}${base.slice(1)}`, `${base}Last4`, `primary${base[0].toUpperCase()}${base.slice(1)}`]) {
				expect(dropped(qualified), qualified).toBe(true);
			}
		}
	});

	// THE POSTAL BOUNDARY, asserted from both sides in one place because the
	// tempting simplification breaks it. Word-matching `address` would drop the
	// left column too, and the left column is what an order surface, a contacts
	// surface and a chain-aware surface legitimately broadcast - a wallet address
	// is a public identifier, not personal data. The personal compounds are named
	// one at a time instead, so neither direction is collateral for the other.
	// THE FLAT SPELLING OF A QUALIFIED COMPOUND, which is the shape a plain SQL
	// select produces: Postgres folds an unquoted identifier to lowercase, so
	// `select u.userTaxId` returns the key `usertaxid`. The compound pass anchors
	// to a word start, and a flat name has exactly one - offset 0 - so anything
	// in front of the compound defeated every entry in the set. Measured across
	// the set and six qualifiers, 243 of 252 families diverged, every one of them
	// in the leak direction.
	it('drops a qualified compound in its FLAT spelling too', () => {
		const cases = [
			'usertaxid', 'usercardnumber', 'customerdateofbirth', 'userpassportnumber',
			'customerbankaccount', 'usersocialsecurity', 'userhomeaddress',
			'custbillingaddress', 'temppostaladdress', 'primaryroutingnumber',
			'oldnationalid', 'encryptedaccountnumber'
		];
		for (const name of cases) {
			expect(dropped(name), name).toBe(true);
			// The camelCase twin must agree - that is the whole point.
			expect(dropped(name.replace(/^(user|customer|cust|temp|primary|old|encrypted)/, (m) => m + '_')), name).toBe(true);
		}
	});

	// A trailing ordinal made a word match nothing, because the tokenizer counts
	// digits as word characters. `phone1` and `phone2` are the standard CRM
	// column pair and both rode the roster while `phone` dropped.
	it('drops a sensitive word carrying an ordinal suffix', () => {
		for (const name of ['phone1', 'phone2', 'telephone2', 'pin1', 'cc2', 'address1', 'address2', 'ssn1']) {
			expect(dropped(name), name).toBe(true);
		}
		// The words that legitimately end in digits must still match WHOLE, which
		// is why the digits are stripped rather than split off.
		expect(dropped('ipv4'), 'ipv4').toBe(true);
		expect(dropped('ipv6'), 'ipv6').toBe(true);
		// ...and an ordinary numbered field is untouched.
		for (const name of ['line1', 'line2', 'step3', 'slot1', 'tier2']) {
			expect(dropped(name), name).toBe(false);
		}
	});

	// The memo declined to STORE a long name but still computed it, so presence -
	// which asks once per key of every update frame - recomputed it at frame rate.
	// One crafted key inside the ordinary byte cap measured 173.7 us per frame
	// against 0.4 us for an ordinary one.
	it('drops an absurdly long name outright rather than recomputing it per frame', () => {
		const long = 'a'.repeat(200);
		expect(dropped(long)).toBe(true);
		// Cheap, not merely correct: the answer must not depend on scanning it.
		const started = process.hrtime.bigint();
		for (let i = 0; i < 20000; i++) dropped('b'.repeat(4096) + i);
		const perCall = Number(process.hrtime.bigint() - started) / 20000;
		expect(perCall, `${perCall.toFixed(0)} ns/call`).toBeLessThan(20000);
	});

	it('drops personal postal names without taking the roster ones', () => {
		for (const name of ['homeAddress', 'billingAddress', 'postalAddress', 'streetAddress', 'mailingAddress']) {
			expect(dropped(name), name).toBe(true);
		}
		for (const name of ['shippingAddress', 'walletAddress', 'addressBook', 'shippingaddress', 'walletaddress', 'addressbook']) {
			expect(dropped(name), name).toBe(false);
		}
	});
});

describe('ordinary product fields keep riding a roster', () => {
	const BENIGN = [
		'primaryKey', 'foreignKey', 'sortKey', 'partitionKey', 'rowKey', 'cacheKey',
		'publicKey', 'userKey', 'groupKey', 'compositeKey', 'hashKey', 'rangeKey',
		'translationKey', 'i18nKey', 'messageKey', 'routeKey', 'columnKey', 'localeKey',
		'reactKey', 'listKey', 'tabKey', 'musicKey', 'storageKey', 'lookupKey',
		'shardKey', 'bucketKey', 'indexKey', 'mapKey', 'dedupKey', 'uniqueKey',
		'naturalKey', 'surrogateKey', 'candidateKey', 'clusterKey', 'objectKey',
		'keyCode', 'keyDown', 'keyUp', 'keyPress', 'keyMap', 'keyBinding', 'keyFrame',
		'keyState', 'heldKeys', 'pressedKeys', 'arrowKeys', 'modifierKeys', 'keysDown',
		'keysHeld', 'onKeyDown', 'handleKeyDown', 'keyMapping', 'keyPresses', 'keyName',
		'monkey', 'monkeys', 'donkey', 'turnkey', 'whiskey', 'jockey', 'hockey',
		'lackey', 'malarkey', 'hotkey', 'hotkeys', 'keyboard',
		'userkey', 'primarykey', 'foreignkey', 'sortkey', 'partitionkey', 'rowkey',
		'cachekey', 'publickey', 'keycode',
		'author', 'authors', 'authored', 'authoring', 'authorId', 'authorName',
		'authoredAt', 'authorKey', 'authorid', 'authorname',
		'microphone', 'microphoneOn', 'headphones', 'account', 'spinner', 'zip', 'zipCode',
		'avatarUrl', 'imageUrl', 'profileUrl', 'columnHeader', 'sectionHeader', 'headerImage',
		'shippingAddress', 'walletAddress', 'addressBook', 'hostId', 'cardId',
		// Names that share letters with a short PII token across a word boundary.
		// A plain substring scan for `ssn`, `dob` or `otp` drops all of these.
		'classSnapshot', 'pressSnippet', 'adobeId', 'hotPatch', 'syntaxId',
		'internationalId', 'isMobile'
	];
	for (const name of BENIGN) {
		it(`passes ${name}`, () => expect(dropped(name)).toBe(false));
	}

	it('does not invent an ssn across a flat word boundary', () => {
		for (const name of ['processname', 'businessname', 'accessnode', 'addressname', 'classsnapshot']) {
			expect(dropped(name), name).toBe(false);
		}
		for (const name of ['userssn', 'ssnlast4', 'userssnlast4', 'employeessnnumber']) {
			expect(dropped(name), name).toBe(true);
		}
	});

	it('drops flat contact identifiers without taking device or place nouns', () => {
		for (const name of [
			'userphone', 'customerphone', 'contactphone', 'homephone', 'workphone',
			'officephone', 'usertelephone', 'userfax', 'faxnumber', 'msisdn', 'e164'
		]) expect(dropped(name), name).toBe(true);
		for (const name of ['microphone', 'headphone', 'headphones', 'smartphone', 'halifax']) {
			expect(dropped(name), name).toBe(false);
		}
	});

	it('still drops the real auth names the author family sits beside', () => {
		for (const name of ['authorization', 'oauth', 'oauthToken', 'authentic', 'authToken', 'reauth']) {
			expect(dropped(name), name).toBe(true);
		}
	});
});

describe('a key-shaped identifier survives an environment qualifier', () => {
	// THE CROSS PRODUCT, and the measurement that killed the any-word scan. A
	// canonical key-noun qualified by an ordinary environment, tier or role
	// adjective is a real product field: `clientSortKey` is the client's sort key,
	// not a client key. Scanning every word dropped 616 of these 616.
	const KEY_NOUNS = [
		'sort', 'hash', 'range', 'partition', 'cache', 'translation', 'primary',
		'foreign', 'row', 'column', 'locale', 'message', 'route', 'list', 'tab',
		'index', 'map', 'lookup', 'shard', 'bucket', 'object', 'composite'
	];
	// `session`, `auth` and `bearer` are deliberately absent: each is sensitive on
	// its own account, so `sessionSortKey` drops for the same documented reason
	// `sessionCount` does and tells us nothing about the key rule.
	const QUALIFIERS = [
		'client', 'server', 'device', 'stream', 'test', 'live', 'sandbox', 'root',
		'master', 'admin', 'super', 'access', 'sign', 'seed', 'salt', 'nonce', 'cert',
		'api', 'private', 'refresh', 'pass', 'crypto', 'hmac', 'cipher', 'ssh',
		'gpg', 'rsa', 'tls'
	];

	it(`passes all ${KEY_NOUNS.length * QUALIFIERS.length} qualified key-nouns`, () => {
		const wrong = [];
		for (const q of QUALIFIERS) {
			for (const noun of KEY_NOUNS) {
				const name = `${q}${noun[0].toUpperCase()}${noun.slice(1)}Key`;
				if (dropped(name)) wrong.push(name);
			}
		}
		expect(wrong).toEqual([]);
	});

	it('does not find flat credential qualifiers inside ordinary words', () => {
		for (const [flat, camel] of [
			['deliverykey', 'deliveryKey'], ['latestkey', 'latestKey'],
			['designkey', 'designKey'], ['bypasskey', 'bypassKey'],
			['compasskey', 'compassKey'], ['apiarykey', 'apiaryKey'],
			['livelykey', 'livelyKey'], ['masterykey', 'masteryKey']
		]) {
			expect(dropped(flat), flat).toBe(false);
			expect(dropped(flat), flat).toBe(dropped(camel));
		}
		for (const name of ['apigridkey', 'apiuserkey', 'userapikey', 'servicerolekey']) {
			expect(dropped(name), name).toBe(true);
		}
	});

	it('drops owner-qualified credential keys in their flat spelling', () => {
		// The two-word case was covered (`streamkey`), but adding any owner
		// reopened the flat-only leak: `deviceStreamKey` was tokenized and
		// dropped while the SQL/JSON spelling `devicestreamkey` rode.
		const owners = [
			'device', 'team', 'organization', 'org', 'member', 'owner', 'author',
			'bot', 'peer', 'vendor', 'provider', 'integration', 'environment',
			'deployment', 'worker', 'agent'
		];
		const qualifiers = [
			'stream', 'server', 'hmac', 'crypto', 'symmetric', 'recovery',
			'pairing', 'vapid', 'idempotency', 'license', 'service'
		];
		for (const owner of owners) {
			for (const qualifier of qualifiers) {
				const camel = `${owner}${qualifier[0].toUpperCase()}${qualifier.slice(1)}Key`;
				const flat = `${owner}${qualifier}key`;
				const snake = `${owner}_${qualifier}_key`;
				expect(dropped(flat), flat).toBe(true);
				expect(dropped(flat), flat).toBe(dropped(camel));
				expect(dropped(flat), flat).toBe(dropped(snake));
			}
		}
	});

	it('does not stop at key letters inside an owner before a credential key', () => {
		// The flat parser used the first `key`, so it stopped inside `monkey`
		// or `keyboard` and never inspected the real credential suffix.
		for (const owner of ['monkey', 'keyboard', 'turnkey', 'hotkey']) {
			for (const qualifier of ['stream', 'hmac', 'vapid', 'server']) {
				const camel = `${owner}${qualifier[0].toUpperCase()}${qualifier.slice(1)}Key`;
				const flat = `${owner}${qualifier}key`;
				expect(dropped(camel), camel).toBe(true);
				expect(dropped(flat), flat).toBe(true);
			}
		}
		// The owner words and ordinary repeated-key identifiers stay ordinary.
		for (const name of ['monkey', 'keyboard', 'turnkey', 'hotkey', 'monkeyKey', 'monkeykey']) {
			expect(dropped(name), name).toBe(false);
		}
	});

	// The other direction, and the reason this is an adjacency rule rather than an
	// allowlist: the qualifier attached to the key still decides.
	it('still drops the credential when the qualifier owns the key', () => {
		for (const q of ['api', 'access', 'private', 'signing', 'stream', 'master', 'license', 'service']) {
			for (const name of [`${q}Key`, `user${q[0].toUpperCase()}${q.slice(1)}Key`, `${q}KeyMap`]) {
				expect(dropped(name), name).toBe(true);
			}
		}
	});

	// `user` is a subject rather than a kind of key, so it does not shield a
	// qualifier standing further off.
	it('a subject noun does not shield a credential qualifier', () => {
		for (const name of ['apiUserKey', 'accessUserKey', 'privateUserKey', 'streamUserKey']) {
			expect(dropped(name), name).toBe(true);
		}
	});
});

describe('every spelling of one datum gets one verdict', () => {
	// The defect this catches is DISAGREEMENT, not a particular answer. Three
	// separate rounds shipped a rule where the same value dropped in camelCase and
	// rode the roster flat - `apiKey` against `apikey`, `userPwd` against
	// `userpwd`, `authorId` against `authorid`. A flat lowercase name is a single
	// word, so any rule that reads words is blind to it unless it is told.
	const BASES = [
		['user', 'pwd'], ['user', 'ssn'], ['user', 'dob'], ['otp', 'code'],
		['totp', 'hash'], ['mfa', 'secret'], ['api', 'key'], ['stream', 'key'],
		['sort', 'key'], ['hash', 'key'], ['credit', 'card'], ['card', 'number'],
		['account', 'number'], ['routing', 'number'], ['tax', 'id'],
		['national', 'id'], ['passport', 'number'], ['date', 'of', 'birth'],
		['phone', 'number'], ['social', 'security', 'number'], ['session', 'id'],
		['access', 'token'], ['client', 'secret'], ['primary', 'key'],
		['translation', 'key'], ['held', 'keys'], ['key', 'code'], ['author', 'id'],
		['avatar', 'url'], ['shipping', 'address'], ['bank', 'account', 'number'],
		['drivers', 'license', 'number'], ['security', 'code'], ['card', 'cvv'],
		['service', 'role', 'key'], ['client', 'sort', 'key']
	];
	const cap = (word) => word[0].toUpperCase() + word.slice(1);

	for (const parts of BASES) {
		it(`agrees across every spelling of ${parts.join(' ')}`, () => {
			const spellings = [
				parts.join(''),
				parts[0] + parts.slice(1).map(cap).join(''),
				parts.join('_'),
				parts.join('-'),
				parts.join('_').toUpperCase(),
				parts.map(cap).join('')
			];
			const verdicts = new Set(spellings.map(dropped));
			expect(
				verdicts.size,
				`split verdicts: dropped ${JSON.stringify(spellings.filter(dropped))}, passed ${JSON.stringify(spellings.filter((s) => !dropped(s)))}`
			).toBe(1);
		});
	}

	// The one deliberate split, pinned so it stays deliberate. `microphone` is a
	// mic-state field on a huddle roster and must pass; `phone` is PII and must
	// drop. Nothing spells a microphone `microPhone`, so the divergence has no
	// real subject - but it is a divergence, and an unpinned one reads as an
	// oversight to whoever meets it next.
	it('splits microphone from phone on purpose', () => {
		expect(dropped('microphone')).toBe(false);
		expect(dropped('microphoneOn')).toBe(false);
		expect(dropped('microPhone')).toBe(true);
		expect(dropped('phone')).toBe(true);
	});
});

describe('depth checks stay linear on shared object graphs', () => {
	it('expands a same-depth alias once', () => {
		let reads = 0;
		let dag = { leaf: true };
		for (let i = 0; i < 20; i++) {
			const child = dag;
			dag = {};
			Object.defineProperties(dag, {
				left: { enumerable: true, get() { reads++; return child; } },
				right: { enumerable: true, get() { reads++; return child; } }
			});
		}
		expect(exceedsDepth(dag, MAX_PROJECTION_DEPTH)).toBe(false);
		expect(reads).toBe(40);
	});

	it('still detects an over-depth path after a shallow visit to the same node', () => {
		const shared = {};
		let deep = shared;
		for (let i = 0; i < MAX_PROJECTION_DEPTH; i++) deep = { next: deep };
		const root = { deep, shallow: shared };
		expect(exceedsDepth(root, MAX_PROJECTION_DEPTH)).toBe(true);
	});
});
