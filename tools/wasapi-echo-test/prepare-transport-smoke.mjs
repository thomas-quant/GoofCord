// Transpile one pure TypeScript function for the real-Electron DOM smoke test.
// This does not build or bundle the application or compile the native addon.
// Usage: node prepare-transport-smoke.mjs <output.js>
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const output = process.argv[2];
if (!output) throw new Error("Expected output.js path");
const sourcePath = fileURLToPath(new URL("../../src/windows/main/preload/wasapiTransport.ts", import.meta.url));
const { outputText } = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
	compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});
const context = { exports: {} };
vm.runInNewContext(outputText, context);
if (typeof context.exports.wasapiTransportMainWorldSource !== "string") throw new Error("Missing serialized transport");
writeFileSync(output, context.exports.wasapiTransportMainWorldSource);
console.log(output);
