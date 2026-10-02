import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../../src/windows/screenshare/preload/preload.mts", import.meta.url), "utf8");
const script = new Bun.Transpiler({ loader: "ts" }).transformSync(source.replace(/^import .*;\n/gm, "").replaceAll("export ", ""));

async function picker(windows: boolean, advanced = true) {
	const elements = new Map<string, any>();
	const element = (id: string) => {
		if (!elements.has(id)) elements.set(id, { style: {}, innerHTML: "", checked: false, classList: { add() {}, remove() {} }, addEventListener() {}, querySelectorAll: () => [] });
		return elements.get(id);
	};
	let generation = 1;
	let release: (() => void) | undefined;
	const selections: any[][] = [];
	const payload = () => ({ sources: [], audioNodes: [{ processId: 5000, displayName: "app" }], hasAdvancedAudio: advanced, supportsAudioExclude: !windows, resetAudioSelection: windows, audioSelectionId: generation++ });
	const context = vm.createContext({
		document: {
			getElementById: element,
			addEventListener() {},
			querySelector: (query: string) => (query.includes("contentHint") ? { value: "motion" } : query.includes("resolution") ? { value: "720" } : query.includes("framerate") ? { value: "30" } : query.includes("audioMode") ? { value: "app" } : null),
			querySelectorAll: () => [{ value: "5000" }],
		},
		window: { addEventListener() {} },
		console,
		i: (key: string) => key,
		whenLocalizationReady: async () => {},
		whenConfigReady: async () => {},
		getConfig: () => ({ audioConfig: { mode: "app", pids: [5000] }, contentHint: "motion", resolution: 720, framerate: 30 }),
		getDefaultValue: () => ({}),
		setConfig: async () => {},
		invoke: () =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		ipcRenderer: {
			invoke: async (channel: string, ...args: any[]) => {
				if (channel === "refreshScreenshareSources") return payload();
				if (channel === "selectScreenshareSource") selections.push(args);
			},
		},
	});
	vm.runInContext(script, context);
	await vm.runInContext("init()", context);
	return { elements, context, selections, release: () => release!() };
}

describe("screenshare preload Windows identity conventions", () => {
	test("Windows never prechecks saved PIDs; Linux still does", async () => {
		const windows = await picker(true);
		const linux = await picker(false);
		expect(windows.elements.get("audio-apps-list").innerHTML).not.toContain("checked");
		expect(linux.elements.get("audio-apps-list").innerHTML).toContain("checked");
		await vm.runInContext("refreshData()", windows.context);
		expect(windows.elements.get("audio-apps-list").innerHTML).not.toContain("checked");
	});

	test("unsupported Windows UI does not convert remembered app-only mode to system", async () => {
		const windows = await picker(true, false);
		expect(windows.elements.get("audio-share-checkbox").checked).toBe(false);
	});

	test("selection freezes its enumeration generation before config IPC awaits", async () => {
		const p = await picker(true);
		const selecting = vm.runInContext('selectSource("screen:0", "screen")', p.context);
		await vm.runInContext("refreshData()", p.context);
		p.release();
		await selecting;
		expect(p.selections[0].at(-1)).toBe(1); // refreshed generation is 2, not permission for old PIDs
	});
});
