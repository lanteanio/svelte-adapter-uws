import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	assert,
	fatal,
	setFatalSink,
	resetFatalSink,
	readAssertionCounts,
	_resetAssertionCountsForTest
} from '../files/utils.js';

describe('fatal', () => {
	beforeEach(() => {
		_resetAssertionCountsForTest();
	});

	it('passes silently on truthy condition', () => {
		expect(() => fatal(true, 'test.passes')).not.toThrow();
		expect(readAssertionCounts().size).toBe(0);
	});

	it('throws in test mode on falsy condition and attaches context', () => {
		try {
			fatal(false, 'test.fatal-context', { topic: 'chat' });
			expect.fail('should have thrown');
		} catch (err) {
			expect(err.message).toBe('adapter-uws fatal: test.fatal-context');
			expect(err.context).toEqual({ topic: 'chat' });
		}
	});

	it('increments the SAME assertion counter map as assert (one namespace)', () => {
		expect(() => assert(false, 'test.shared')).toThrow();
		expect(() => fatal(false, 'test.shared')).toThrow();
		expect(readAssertionCounts().get('test.shared')).toBe(2);
	});

	it('logs a structured line with severity: fatal', () => {
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(() => fatal(false, 'test.fatal-log', { a: 1 })).toThrow();
		const [tag, json] = errSpy.mock.calls[0];
		expect(tag).toBe('[adapter-uws/fatal]');
		expect(JSON.parse(json)).toEqual({ category: 'test.fatal-log', context: { a: 1 }, severity: 'fatal' });
		errSpy.mockRestore();
	});

	it('setFatalSink rejects a sink without an exit function', () => {
		expect(() => setFatalSink(null)).toThrow(/exit/);
		expect(() => setFatalSink({})).toThrow(/exit/);
	});

	it('in production mode, defers exit(78) through the injectable sink without killing the process', async () => {
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const exit = vi.fn();
		const originalVitest = process.env.VITEST;
		const originalNodeEnv = process.env.NODE_ENV;
		try {
			// Exit the test-mode branch so fatal takes the production deferred path.
			delete process.env.VITEST;
			process.env.NODE_ENV = 'production';
			setFatalSink({ exit });

			// Does NOT throw and does NOT exit synchronously.
			expect(() => fatal(false, 'test.fatal-defer', { topic: 'room' })).not.toThrow();
			expect(exit).not.toHaveBeenCalled();
			// The metric + log have already flushed before the deferred exit.
			expect(readAssertionCounts().get('test.fatal-defer')).toBe(1);
			expect(errSpy).toHaveBeenCalledTimes(1);

			// The exit is scheduled on a microtask: it fires after the current frame.
			await Promise.resolve();
			expect(exit).toHaveBeenCalledTimes(1);
			expect(exit).toHaveBeenCalledWith(78);
		} finally {
			if (originalVitest === undefined) delete process.env.VITEST;
			else process.env.VITEST = originalVitest;
			if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = originalNodeEnv;
			resetFatalSink();
			errSpy.mockRestore();
		}
	});
});
