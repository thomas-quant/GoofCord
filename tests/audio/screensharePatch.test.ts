import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../../src/windows/main/renderer/postVencord/screensharePatch.ts", import.meta.url), "utf8");
const script = new Bun.Transpiler({ loader: "ts" }).transformSync(source.replace("export function patchScreenshare", "function patchScreenshare"));

function install(getDisplayMedia: () => Promise<unknown>) {
	const mediaDevices = { getDisplayMedia };
	vm.runInNewContext(`${script}\npatchScreenshare();`, {
		navigator: { mediaDevices },
		window: {},
		console: { log() {} },
		Common: { FluxDispatcher: { subscribe() {} } },
	});
	return mediaDevices;
}

describe("postVencord screensharePatch reconciliation", () => {
	test("returns the original stream if the picker supplied no settings", async () => {
		const stream = {};
		const mediaDevices = install(async () => stream);
		expect(await mediaDevices.getDisplayMedia()).toBe(stream);
	});

	test("does not disguise capture failures as user cancellation", async () => {
		const failure = new Error("capture device unavailable");
		const mediaDevices = install(async () => {
			throw failure;
		});
		await expect(mediaDevices.getDisplayMedia()).rejects.toBe(failure);
	});
});
