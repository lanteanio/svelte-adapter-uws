import { readFileSync } from "node:fs";
import { compile } from "svelte/compiler";
import { describe, expect, it } from "vitest";
import {
	cursorColor,
	cursorName,
	cursorShape,
	describeBoardPosition,
	hasFiniteCursorPosition,
	summarizeCursorRosterChange,
} from "../examples/cursor-accessibility.js";

const cells = [
	{ label: "Ideas", x: 0, y: 0, width: 100, height: 100 },
	{ label: "Review", x: 100, y: 0, width: 100, height: 100 },
];

describe("accessible cursor example", () => {
	it("pairs validated colors with deterministic non-color identity", () => {
		expect(cursorName({ name: " Alice " }, "worker:1")).toBe("Alice");
		expect(cursorName({}, "worker:1")).toMatch(
			/^Collaborator [0-9a-z]{7}$/,
		);
		expect(cursorShape("worker:1")).toBe(cursorShape("worker:1"));
		expect(["circle", "square", "diamond", "triangle"]).toContain(
			cursorShape("worker:1"),
		);
		expect(cursorColor({ color: "#1234ab" }, "worker:1")).toBe("#1234ab");
		expect(
			cursorColor({ color: "url(javascript:bad)" }, "worker:1"),
		).toMatch(/^#[0-9a-f]{6}$/);
	});

	it("bounds remote names without destroying ordinary Unicode text", () => {
		const umlaut = String.fromCodePoint(0xfc);
		const expected = "J" + umlaut + "rg M" + umlaut + "ller";
		const unsafe = " J" + umlaut + "rg\n\u202e  M" + umlaut + "ller ";
		expect(cursorName({ name: unsafe }, "worker:1")).toBe(expected);
		expect(
			cursorName({ name: "<img src=x onerror=alert(1)>" }, "worker:1"),
		).toBe("<img src=x onerror=alert(1)>");
		const emoji = String.fromCodePoint(0x1f642);
		const bounded = cursorName({ name: emoji.repeat(100) }, "worker:1");
		expect(Array.from(bounded)).toHaveLength(80);
		expect(bounded).toBe(emoji.repeat(80));
	});

	it("rejects non-numeric and non-finite visual coordinates", () => {
		expect(hasFiniteCursorPosition({ x: 12, y: 40 })).toBe(true);
		expect(hasFiniteCursorPosition({ x: "0; inset: 0", y: 40 })).toBe(
			false,
		);
		expect(hasFiniteCursorPosition({ x: NaN, y: 40 })).toBe(false);
		expect(hasFiniteCursorPosition({ x: 12, y: Infinity })).toBe(false);
		expect(hasFiniteCursorPosition(null)).toBe(false);
	});

	it("describes positions through application-owned board regions", () => {
		expect(describeBoardPosition({ x: 12, y: 40 }, cells)).toBe("at Ideas");
		expect(describeBoardPosition({ x: 140, y: 40 }, cells)).toBe(
			"at Review",
		);
		expect(describeBoardPosition({ x: 250, y: 40 }, cells)).toBe(
			"outside named board regions",
		);
		expect(describeBoardPosition({ x: NaN, y: 40 }, cells)).toBe(
			"position unavailable",
		);
	});

	it("announces roster changes but not high-frequency movement", () => {
		const alice = new Map([
			["a", { user: { name: "Alice" }, data: { x: 1, y: 1 } }],
		]);
		const moved = new Map([
			["a", { user: { name: "Alice" }, data: { x: 90, y: 50 } }],
		]);
		const together = new Map([
			["a", { user: { name: "Alice" }, data: { x: 90, y: 50 } }],
			["b", { user: { name: "Bob" }, data: { x: 120, y: 50 } }],
		]);

		expect(summarizeCursorRosterChange(null, alice)).toBe("");
		expect(summarizeCursorRosterChange(alice, moved)).toBe("");
		expect(summarizeCursorRosterChange(moved, together)).toBe(
			"Bob joined the board.",
		);
		expect(summarizeCursorRosterChange(together, new Map())).toBe(
			"Alice and Bob left the board.",
		);
	});

	it("bounds simultaneous roster announcements", () => {
		const current = new Map();
		for (let index = 0; index < 20; index++) {
			const name = "User " + String(index).padStart(2, "0");
			current.set(name, { user: { name }, data: { x: index, y: 0 } });
		}
		expect(summarizeCursorRosterChange(new Map(), current)).toBe(
			"User 00, User 01, User 02, and 17 others joined the board.",
		);
	});

	it("ships a runes-mode composition whose reactive features survive a runes-forced project", () => {
		const source = readFileSync(
			new URL("../examples/cursor-accessible.svelte", import.meta.url),
			"utf8",
		);
		// Compile under FORCED runes and accept no warning of any kind. The
		// previous a11y-only filter silently dropped non_reactive_update -
		// which meant the live-region announcement and the pause control, the
		// two features this composition exists to demonstrate, compiled to
		// inert code in a runes project while the gate stayed green.
		const result = compile(source, {
			filename: "examples/cursor-accessible.svelte",
			generate: "server",
			runes: true,
		});
		expect(result.warnings.map((w) => w.code + ": " + w.message)).toEqual([]);
		// The two template-driving flags must be declared reactive state.
		expect(source).toMatch(/let announcement = \$state\(/);
		expect(source).toMatch(/let cursorMotionVisible = \$state\(/);
		expect(source).not.toMatch(/\bon:[a-z]/);
		expect(result.js.code).toMatch(/escape\(\s*cursorName/);
		expect(source).not.toContain("{@html");
		expect(source).toContain("{#if hasFiniteCursorPosition(data)}");
		expect(source).toContain('aria-live="polite"');
		expect(source).toContain('aria-hidden="true"');
		expect(source).toContain('aria-controls="remote-cursor-layer"');
		expect(source).toContain("{#if cursorMotionVisible}");
		expect(source).toContain("@media (prefers-reduced-motion: reduce)");
		expect(source).toContain("onfocus={() => moveToCell(cell)}");
		expect(source).toContain("onpointermove={moveFromPointer}");
		expect(source).toContain("describeBoardPosition(data, cells)");
	});

	it("is the README cursor accessibility reference", () => {
		const readme = readFileSync(
			new URL("../README.md", import.meta.url),
			"utf8",
		);
		// The composition is repository-only (the library ships primitives,
		// reference UI stays out of the tarball), so the README reaches it
		// through the stable source route rather than a packaged-relative
		// link that would be dead in an installed copy.
		expect(readme).toContain(
			"[complete Svelte composition](https://github.com/lanteanio/svelte-adapter-uws/blob/dev/examples/cursor-accessible.svelte)",
		);
		expect(readme).toMatch(
			/Do not put continuous\s+position updates in an `aria-live` region/,
		);
		expect(readme).toContain("A cursor layer never replaces the board");
		expect(readme).toContain("prefers-reduced-motion: reduce");
		expect(readme).toContain("application-owned pause or hide control");
	});
});
