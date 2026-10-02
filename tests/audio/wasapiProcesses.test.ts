import { describe, expect, test } from "bun:test";

import { parseWasapiProcesses, resolveWasapiTrees, type WasapiProcess, type WasapiProcessSnapshot } from "../../src/modules/native/wasapiProcesses.ts";

const proc = (pid: number, parentPid = 0, created = "100", executable = "C:\\test.exe"): WasapiProcess => ({ pid, parentPid, created, executable });
const snapshot = (...rows: WasapiProcess[]): WasapiProcessSnapshot => new Map(rows.map((p) => [p.pid, p]));
const base = () => snapshot(proc(10), proc(11, 10, "200"), proc(12, 11, "300"), proc(20), proc(21, 20, "200"), proc(22, 20, "200"), proc(1));
const resolve = (pids: unknown, current = base(), trusted: WasapiProcessSnapshot | undefined = base(), listed = new Set([10, 11, 12, 20, 21, 22, 1]), own = new Set([1])) => resolveWasapiTrees(pids, trusted, current, listed, own);

describe("resolveWasapiTrees", () => {
	test("deduplicates same PID and deep descendant roots in either order, retains siblings", () => {
		expect(resolve([10, 12, 10, 11, 21, 22])).toEqual([10, 21, 22]);
		expect(resolve([12, 11, 10])).toEqual([10]);
		expect(resolve([21, 22])).toEqual([21, 22]); // never substitute their unselected parent 20
	});
	for (const pids of [[], [0], [-1], [1.5], [NaN], [0x100000000], ["10"], [10, 99], null]) {
		test(`rejects malformed/missing selection ${JSON.stringify(pids)}`, () => expect(() => resolve(pids)).toThrow());
	}
	test("rejects recycled PID even with the same executable", () => {
		const current = base();
		current.set(10, proc(10, 0, "500"));
		expect(() => resolve([10], current)).toThrow(/changed/);
	});
	test("rejects executable changes, inaccessible identity, forged selection and absent sessions", () => {
		for (const executable of ["C:\\other.exe", ""]) {
			const current = base();
			current.set(10, proc(10, 0, "100", executable));
			expect(() => resolve([10], current)).toThrow();
		}
		expect(() => resolveWasapiTrees([10], undefined, base(), new Set([10]), new Set([1]))).toThrow();
		expect(() => resolve([10], base(), new Map())).toThrow();
		expect(() => resolve([10], base(), base(), new Set())).toThrow();
	});
	test("rejects main, own descendants, and all ancestors containing GoofCord", () => {
		const current = base();
		current.set(1, proc(1, 12, "400"));
		current.set(2, proc(2, 1, "500"));
		for (const pid of [1, 2, 10, 11, 12]) expect(() => resolve([pid], current, current, new Set([pid]))).toThrow(/own process tree/);
	});
	test("orphaned Explorer/GoofCord and selected orphan remain usable", () => {
		const current = base();
		current.set(1, proc(1, 30, "400"));
		current.set(30, proc(30, 99, "300")); // explorer: userinit (99) exited
		current.set(10, proc(10, 98)); // selected app's parent also exited
		expect(resolve([10], current, current)).toEqual([10]);
		expect(() => resolve([30], current, current, new Set([30]))).toThrow(/own process tree/);
	});

	test("a newer process at parent PID is not an ancestor", () => {
		const current = base();
		current.set(10, proc(10, 0, "500"));
		expect(resolve([10, 11], current, current)).toEqual([10, 11]);
	});
	test("rejects unknown-time or cyclic live ancestry including own ancestry", () => {
		for (const p of [proc(10, 11, "200"), proc(10, 0, ""), proc(1, 1, "100")]) {
			const current = base();
			current.set(p.pid, p);
			expect(() => resolve([10], current, current)).toThrow();
		}
	});
});

describe("parseWasapiProcesses", () => {
	test("keeps creation ticks losslessly as strings", () => {
		const p = proc(10, 0, "639265000000000001");
		expect(parseWasapiProcesses(JSON.stringify([p])).get(10)).toEqual(p);
	});
	test("rejects invalid snapshots and duplicate PIDs", () => {
		for (const value of [{}, [proc(10), proc(10)], [{ ...proc(10), created: 123 }], [{ ...proc(10), parentPid: -1 }]]) expect(() => parseWasapiProcesses(JSON.stringify(value))).toThrow();
	});
});
