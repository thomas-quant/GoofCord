import { execFile } from "node:child_process";
import path from "node:path";

export interface WasapiProcess {
	pid: number;
	parentPid: number;
	// UTC ticks as text: Windows creation times exceed JS's safe integer range.
	created: string;
	executable: string;
}

export type WasapiProcessSnapshot = Map<number, WasapiProcess>;

const SNAPSHOT_SCRIPT = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
@(Get-CimInstance Win32_Process | ForEach-Object {
 [PSCustomObject]@{
  pid = $_.ProcessId
  parentPid = $_.ParentProcessId
  created = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().Ticks.ToString() } else { '' }
  executable = [string]$_.ExecutablePath
 }
}) | ConvertTo-Json -Compress`;

export function parseWasapiProcesses(json: string): WasapiProcessSnapshot {
	const rows: unknown = JSON.parse(json);
	if (!Array.isArray(rows)) throw new Error("Invalid Windows process snapshot");
	const snapshot: WasapiProcessSnapshot = new Map();
	for (const row of rows) {
		if (!row || !Number.isInteger(row.pid) || row.pid < 0 || row.pid > 0xffffffff || !Number.isInteger(row.parentPid) || row.parentPid < 0 || row.parentPid > 0xffffffff || typeof row.created !== "string" || typeof row.executable !== "string" || snapshot.has(row.pid)) throw new Error("Invalid Windows process identity");
		snapshot.set(row.pid, row);
	}
	return snapshot;
}

/** One bounded, noninteractive OS query; no picker input is interpolated into the command. */
export function snapshotWasapiProcesses(): Promise<WasapiProcessSnapshot> {
	const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	return new Promise((resolve, reject) => {
		execFile(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(SNAPSHOT_SCRIPT, "utf16le").toString("base64")], { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (err, stdout) => {
			if (err) return reject(new Error(`Windows process lookup failed: ${err.message}`));
			try {
				resolve(parseWasapiProcesses(stdout.replace(/^\uFEFF/, "")));
			} catch (error) {
				reject(error);
			}
		});
	});
}

function hasCreation(p: WasapiProcess): boolean {
	return /^[1-9]\d*$/.test(p.created);
}

export function sameWasapiProcess(a: WasapiProcess | undefined, b: WasapiProcess | undefined): boolean {
	return !!a && !!b && hasCreation(a) && a.pid === b.pid && a.created === b.created && !!a.executable && a.executable.toLowerCase() === b.executable.toLowerCase();
}

/** Only observable live ancestry: absent/reused parents terminate the chain. Windows
 * retains an exited parent's PID, not its identity/history. This cannot prove overlap
 * through a vanished intermediate; selected identity is still checked independently. */
function ancestors(pid: number, snapshot: WasapiProcessSnapshot): Set<number> {
	const chain = new Set<number>();
	let p = snapshot.get(pid);
	if (!p) throw new Error(`Process ${pid} disappeared`);
	while (p) {
		if (!hasCreation(p) || chain.has(p.pid)) throw new Error(`Cannot verify ancestry of process ${pid}`);
		chain.add(p.pid);
		if (p.parentPid === 0) break;
		const parent = snapshot.get(p.parentPid);
		if (!parent) break;
		if (!hasCreation(parent)) throw new Error(`Cannot verify parent of process ${pid}`);
		if (BigInt(parent.created) > BigInt(p.created)) break;
		p = parent;
	}
	return chain;
}

/** Never add an unselected ancestor. Selecting both parent and child captures just the parent. */
export function resolveWasapiTrees(pids: unknown, trusted: WasapiProcessSnapshot | undefined, current: WasapiProcessSnapshot, listed: Set<number>, ownPids: Set<number>): number[] {
	if (!Array.isArray(pids) || pids.length === 0 || !trusted) throw new Error("Re-pick the apps in the Audio list");
	const selected = [...new Set<number>(pids)];
	const ownAncestors = new Set<number>();
	for (const pid of ownPids) {
		for (const ancestor of ancestors(pid, current)) ownAncestors.add(ancestor);
	}
	const chains = new Map<number, Set<number>>();
	for (const pid of selected) {
		if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff || !listed.has(pid) || !sameWasapiProcess(trusted.get(pid), current.get(pid))) throw new Error(`Selected process ${pid} changed or cannot be verified`);
		const chain = ancestors(pid, current);
		if (ownAncestors.has(pid) || [...ownPids].some((own) => chain.has(own))) throw new Error(`Cannot share GoofCord's own process tree (${pid})`);
		chains.set(pid, chain);
	}
	return selected.filter((pid) => !selected.some((other) => other !== pid && chains.get(pid)!.has(other)));
}
