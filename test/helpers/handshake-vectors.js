// Re-export of the handshake vector table, which lives inside the fixture app so
// the fixture's WS handler and the test suites share ONE definition of both the
// names and the bytes. See test/fixture/src/handshake-vectors.js for why.
//
// Suites import from here so they do not need to know where the fixture keeps it.

export {
	SAFE_VECTOR,
	SAFE_VECTORS,
	UNSAFE_VECTORS,
	VECTORS_BY_NAME,
	SHAPE_VECTORS,
	POISON_VALUE,
	buildShapeHeaders
} from '../fixture/src/handshake-vectors.js';
