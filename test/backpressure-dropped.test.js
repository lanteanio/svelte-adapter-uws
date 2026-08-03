import { readFileSync } from 'node:fs';
import * as acorn from 'acorn';
import { describe, expect, it } from 'vitest';
import {
	recordBackpressureDrop,
	takeBackpressureDropWindow
} from '../src/runtime/utils/backpressure.js';
import { SIGNALS_BY_NAME } from '../src/observability.js';

function walk(node, visit) {
	if (node === null || typeof node !== 'object') return;
	visit(node);
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) {
			for (const child of value) walk(child, visit);
		} else {
			walk(value, visit);
		}
	}
}

function propertyName(property) {
	if (property.type !== 'Property') return null;
	if (property.computed) return null;
	if (property.key.type === 'Identifier') return property.key.name;
	if (property.key.type === 'Literal') return property.key.value;
	return null;
}

describe('exact native backpressure drop telemetry', () => {
	it('counts every callback and payload byte, then resets the window atomically', () => {
		const window = { droppedFramesWindow: 0, droppedBytesWindow: 0 };
		recordBackpressureDrop(window, new ArrayBuffer(7));
		recordBackpressureDrop(window, new ArrayBuffer(19));
		recordBackpressureDrop(window, new ArrayBuffer(0));

		expect(takeBackpressureDropWindow(window)).toEqual({
			droppedFrames: 3,
			droppedBytes: 26
		});
		expect(window).toEqual({ droppedFramesWindow: 0, droppedBytesWindow: 0 });
		expect(takeBackpressureDropWindow(window)).toEqual({
			droppedFrames: 0,
			droppedBytes: 0
		});
	});

	it('wires the uWS behavior callback directly to the exact counter', () => {
		const source = readFileSync(new URL('../src/runtime/handler.js', import.meta.url), 'utf8');
		const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
		const behaviorObjects = [];
		walk(ast, (node) => {
			if (node.type !== 'ObjectExpression') return;
			const names = new Set(node.properties.map(propertyName));
			if (names.has('open') && names.has('message') && names.has('drain') && names.has('close')) {
				behaviorObjects.push(node);
			}
		});
		expect(behaviorObjects).toHaveLength(1);
		const dropped = behaviorObjects[0].properties.find((property) => propertyName(property) === 'dropped');
		expect(dropped).toBeDefined();
		expect(dropped.value.type).toBe('ArrowFunctionExpression');
		expect(dropped.value.params.map((param) => param.name)).toEqual(['_ws', 'message']);

		const calls = [];
		walk(dropped.value.body, (node) => {
			if (node.type === 'CallExpression') calls.push(node);
		});
		expect(calls.some((call) =>
			call.callee.type === 'Identifier' &&
			call.callee.name === 'recordBackpressureDrop' &&
			call.arguments[0]?.type === 'Identifier' && call.arguments[0].name === 'counters' &&
			call.arguments[1]?.type === 'Identifier' && call.arguments[1].name === 'message'
		)).toBe(true);

		const sampler = readFileSync(new URL('../src/runtime/handler/pressure-metrics.js', import.meta.url), 'utf8');
		expect(sampler).toContain('takeBackpressureDropWindow(counters)');
		expect(sampler).toContain('pressureSnapshot.droppedFrames = droppedFrames');
		expect(sampler).toContain('pressureSnapshot.droppedBytes = droppedBytes');
		expect(source).toContain('mDroppedFrames?.inc({}, counters.lastDroppedFrames)');
		expect(source).toContain('mDroppedBytes?.inc({}, counters.lastDroppedBytes)');
	});

	it('declares cumulative worker-summed frame and byte counters', () => {
		expect(SIGNALS_BY_NAME.get('ws_dropped_frames_total')).toMatchObject({
			type: 'counter', labels: [], unit: null, scope: 'worker', aggregate: 'sum'
		});
		expect(SIGNALS_BY_NAME.get('ws_dropped_bytes_total')).toMatchObject({
			type: 'counter', labels: [], unit: 'bytes', scope: 'worker', aggregate: 'sum'
		});
	});
});
