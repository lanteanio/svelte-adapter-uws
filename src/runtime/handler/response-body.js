import { isArrayBuffer, isUint8Array } from 'node:util/types';

const encoder = new TextEncoder();

/** Convert an application stream chunk to its exact wire bytes. @param {unknown} value */
export function responseChunkBytes(value) {
	if (isUint8Array(value)) return value;
	if (typeof value === 'string') return encoder.encode(value);
	if (isArrayBuffer(value)) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	throw new TypeError('Response body chunks must be strings, ArrayBuffers or ArrayBuffer views');
}
