// CI-only real OS query, outside the Electron-mocked unit test process. Does not capture audio.
import { sameWasapiProcess, snapshotWasapiProcesses } from "../../src/modules/native/wasapiProcesses.ts";

if (process.platform !== "win32") throw new Error("Run this smoke test on Windows");
const first = (await snapshotWasapiProcesses()).get(process.pid);
const second = (await snapshotWasapiProcesses()).get(process.pid);
if (!sameWasapiProcess(first, second)) throw new Error("Windows process query could not verify its own PID/creation/executable identity");
console.log("Windows process snapshot: own identity stable across two bounded CIM queries");
