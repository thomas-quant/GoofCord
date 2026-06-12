import { describe, expect, test } from "bun:test";

import { keyCodeToChar, parseDiscordShortcut } from "./keybindShortcut.ts";

describe("keyCodeToChar", () => {
	test("OEM punctuation keyCodes resolve to their literal char", () => {
		expect(keyCodeToChar(190)).toBe(".");
		expect(keyCodeToChar(188)).toBe(",");
		expect(keyCodeToChar(221)).toBe("]");
		expect(keyCodeToChar(192)).toBe("`");
	});

	test("named/control keyCodes resolve to venbind tokens", () => {
		expect(keyCodeToChar(13)).toBe("enter");
		expect(keyCodeToChar(32)).toBe("space");
		expect(keyCodeToChar(33)).toBe("pageup");
		expect(keyCodeToChar(34)).toBe("pagedown");
		expect(keyCodeToChar(123)).toBe("f12");
		expect(keyCodeToChar(96)).toBe("numpad0");
	});

	test("alphanumeric keyCodes resolve via String.fromCharCode", () => {
		expect(keyCodeToChar(65)).toBe("A");
		expect(keyCodeToChar(49)).toBe("1");
	});
});

describe("parseDiscordShortcut", () => {
	test("punctuation ground truth (KEY-01)", () => {
		expect(parseDiscordShortcut([[0, 190, 4]]).shortcut).toBe(".");
		expect(parseDiscordShortcut([[0, 188, 4]]).shortcut).toBe(",");
		expect(parseDiscordShortcut([[0, 221, 4]]).shortcut).toBe("]");
		expect(
			parseDiscordShortcut([
				[0, 17, 4],
				[0, 192, 4],
			]).shortcut,
		).toBe("ctrl+`");
		expect(
			parseDiscordShortcut([
				[0, 18, 4],
				[0, 67, 4],
			]).shortcut,
		).toBe("alt+c");
	});

	test("named keys now resolve to real tokens", () => {
		expect(parseDiscordShortcut([[0, 33, 4]]).shortcut).toBe("pageup");
		expect(parseDiscordShortcut([[0, 123, 4]]).shortcut).toBe("f12");
		expect(parseDiscordShortcut([[0, 32, 4]]).shortcut).toBe("space");
		expect(
			parseDiscordShortcut([
				[0, 17, 4],
				[0, 34, 4],
			]).shortcut,
		).toBe("ctrl+pagedown");
	});

	test("alphanumeric", () => {
		expect(parseDiscordShortcut([[0, 65, 4]]).shortcut).toBe("a");
		expect(parseDiscordShortcut([[0, 49, 4]]).shortcut).toBe("1");
	});

	test("no main key (only modifiers)", () => {
		const result = parseDiscordShortcut([[0, 17, 4]]);
		expect(result.shortcut).toBe("");
		expect(result.mainKeyCode).toBeUndefined();
	});

	test("mainKeyCode and modifier flags are threaded through", () => {
		const result = parseDiscordShortcut([
			[0, 17, 4],
			[0, 192, 4],
		]);
		expect(result.mainKeyCode).toBe(192);
		expect(result.ctrl).toBe(true);
		expect(result.alt).toBe(false);
		expect(result.shift).toBe(false);
	});
});
