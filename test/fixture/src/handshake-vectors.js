// One source of truth for 101-handshake header vectors.
//
// This lives inside the fixture app because the fixture's WS handler must import
// it (it is bundled by Vite from this root) and the test suites import it too, so
// there is exactly ONE definition of both the names and the BYTES. It used to be
// duplicated: the tests owned the bytes and the fixture hand-copied them, which
// meant adding a vector failed loudly but EDITING one passed vacuously - the
// production surface would keep testing the stale bytes under the new name.
//
// Every surface that can write a handshake header is held to this table: the
// upgradeResponse() helper, the in-process test server, and the built production
// runtime. Adding a vector here extends all of them at once, which is the point -
// those surfaces each used to carry their own copy of the guard, kept in step by
// a comment asking a human to remember, and the test server ended up with no
// guard at all.
//
// Control bytes are written as ESCAPES, never as literal bytes, so the vectors
// stay visible in a diff and cannot be mangled by an editor or by a tool that
// decides the file is binary.

/** Header values that are safe to write, so every surface must accept them. */
export const SAFE_VECTORS = [
	{ name: 'clean', value: 'plain=1', why: 'ordinary printable ASCII' },
	{ name: 'tab', value: 'left\tright', why: 'TAB is legal header whitespace' },
	{ name: 'obs-text-low', value: '\x80', why: 'the Latin-1 high range begins at 0x80' },
	{ name: 'obs-text-high', value: '\xff', why: 'the Latin-1 high range ends at 0xFF' }
];

/** Ordinary safe value used by the mutation/array-shape vectors below. */
export const SAFE_VECTOR = SAFE_VECTORS[0];

/**
 * Header values that cannot be written onto the handshake safely. Every surface
 * must refuse ALL of these, and refuse them the same way.
 */
export const UNSAFE_VECTORS = [
	{ name: 'lf', value: 'a=1\nInjected: yes', why: 'bare LF splits the header line' },
	{ name: 'crlf', value: 'a=1\r\nInjected: yes', why: 'CRLF begins a new header' },
	{ name: 'cr', value: 'a=1\rInjected: yes', why: 'bare CR terminates the line' },
	{ name: 'obsfold', value: 'a=1\r\n Injected: yes', why: 'obs-fold continuation line' },
	{ name: 'nul', value: 'a=1\x00b', why: 'NUL truncates in C and is refused by strict parsers' },
	{ name: 'trailing', value: 'a=1\r\n', why: 'trailing CRLF terminates the header early' },
	{ name: 'vt', value: 'a=1\x0bInjected: yes', why: 'VT is refused by Node-compatible header policy' },
	{ name: 'ff', value: 'a=1\x0cInjected: yes', why: 'FF is refused by Node-compatible header policy' },
	{ name: 'esc', value: 'a=1\x1bInjected: yes', why: 'ESC is refused by Node-compatible header policy' },
	{ name: 'del', value: 'a=1\x7fInjected: yes', why: 'DEL is refused by Node-compatible header policy' }
];

/** Vector name -> bytes, so a request header can select one without carrying it. */
export const VECTORS_BY_NAME = new Map([
	...SAFE_VECTORS.map((v) => [v.name, v.value]),
	...UNSAFE_VECTORS.map((v) => [v.name, v.value])
]);

/**
 * Vectors whose SHAPE is the point rather than a single value: they need a whole
 * headers object built a particular way, so a surface constructs them instead of
 * looking a value up. Named here so every surface builds the identical shape.
 */
export const SHAPE_VECTORS = {
	/** A getter on a LATER key rewrites an EARLIER key after it has been read. */
	mutateAfterRead: 'mutate-after-read',
	/** A later getter pushes into an EARLIER array value after it has been read. */
	mutateArrayAfterRead: 'mutate-array-after-read',
	/** An array whose slice result changes between validation and wire iteration. */
	arraySliceIterator: 'array-slice-iterator',
	/** An array whose slice/iterator hooks throw if validation executes them. */
	arrayHooksThrow: 'array-hooks-throw',
	/** An Array subclass whose Symbol.species getter throws if slice honours it. */
	arraySpeciesThrow: 'array-species-throw',
	/** An own enumerable `__proto__` key carrying a splitting value. */
	protoKey: 'proto-key',
	/** A duck-typed result whose `headers` member is a string, not a header bag. */
	stringBag: 'string-bag',
	/** A duck-typed result whose `headers` member is an array, not a header bag. */
	arrayBag: 'array-bag',
	/** A header NAME carrying CRLF and a second line. */
	invalidName: 'invalid-name',
	/** A numeric value uWS would reject only after the 101 status was corked. */
	numberValue: 'number-value',
	/** A non-string whose coercion produces CRLF; coercion must never run. */
	coercionValue: 'coercion-value'
};

/** What a shape vector poisons with. Must be refused if it reaches validation. */
export const POISON_VALUE = 'a=1\r\nInjected: yes';

/**
 * Build the headers object for a shape vector, or null when the name is not one.
 *
 * @param {string | undefined} name
 * @returns {any}
 */
export function buildShapeHeaders(name) {
	if (name === SHAPE_VECTORS.mutateAfterRead) {
		// Own-key order is insertion order and Object.entries reads values in that
		// order, so 'set-cookie' is captured clean and then rewritten within the
		// same pass. A surface that validates the app's live object and reads it
		// again at write time puts POISON_VALUE on the wire; one that validates
		// and writes a single snapshot cannot.
		/** @type {Record<string, any>} */
		const headers = {
			'set-cookie': SAFE_VECTOR.value,
			get 'x-trigger'() {
				headers['set-cookie'] = POISON_VALUE;
				return '1';
			}
		};
		return headers;
	}
	if (name === SHAPE_VECTORS.mutateArrayAfterRead) {
		const values = [SAFE_VECTOR.value];
		/** @type {Record<string, any>} */
		const headers = {
			'set-cookie': values,
			get 'x-trigger'() {
				values.push(POISON_VALUE);
				return '1';
			}
		};
		return headers;
	}
	if (name === SHAPE_VECTORS.arraySliceIterator) {
		let iterations = 0;
		const staged = ['ignored'];
		staged[Symbol.iterator] = function* () {
			iterations++;
			yield iterations === 1 ? SAFE_VECTOR.value : POISON_VALUE;
		};
		const values = [SAFE_VECTOR.value];
		// The old snapshot called this app-controlled method, validated the first
		// iteration of its result, then the wire loop consumed the poisoned second
		// iteration. A trusted index copy must ignore both hooks and write the
		// actual value at index zero.
		values.slice = () => staged;
		return { 'set-cookie': values };
	}
	if (name === SHAPE_VECTORS.arrayHooksThrow) {
		const values = [SAFE_VECTOR.value];
		values.slice = () => { throw new Error('app-controlled slice executed'); };
		values[Symbol.iterator] = () => { throw new Error('app-controlled iterator executed'); };
		return { 'set-cookie': values };
	}
	if (name === SHAPE_VECTORS.arraySpeciesThrow) {
		class HostileArray extends Array {
			static get [Symbol.species]() {
				throw new Error('app-controlled Symbol.species executed');
			}
		}
		const values = new HostileArray();
		values.push(SAFE_VECTOR.value);
		// The runtime must copy indices into a native array. `value.slice()` and
		// `Array.prototype.slice.call(value)` both consult this subclass's
		// Symbol.species and execute app code before validation.
		return { 'set-cookie': values };
	}
	if (name === SHAPE_VECTORS.protoKey) {
		// defineProperty, not assignment: assigning would hit Object.prototype's
		// __proto__ setter and set the prototype instead of creating an own key,
		// which is the whole distinction under test.
		/** @type {Record<string, any>} */
		const headers = {};
		Object.defineProperty(headers, '__proto__', {
			value: POISON_VALUE,
			enumerable: true,
			writable: true,
			configurable: true
		});
		return headers;
	}
	if (name === SHAPE_VECTORS.stringBag) return 'set-cookie=plain';
	if (name === SHAPE_VECTORS.arrayBag) return ['set-cookie=plain'];
	if (name === SHAPE_VECTORS.invalidName) {
		return { 'x-safe: yes\r\nInjected': SAFE_VECTOR.value };
	}
	if (name === SHAPE_VECTORS.numberValue) return { 'x-count': 3 };
	if (name === SHAPE_VECTORS.coercionValue) {
		return {
			'set-cookie': {
				toString() { return POISON_VALUE; }
			}
		};
	}
	return null;
}
