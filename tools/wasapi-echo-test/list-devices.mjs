#!/usr/bin/env node
// Enumerate render endpoints via the addon (gives the WASAPI endpoint IDs we'd capture).
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const local = join(here, 'addon-under-test.node');
const addonPath = existsSync(local) ? local : resolve(here, '../../node_modules/wasapi-loopback/prebuilds/windows-x86_64/wasapi-loopback-win32-x64.node');
const addon = createRequire(import.meta.url)(addonPath);

console.log('=== RENDER endpoints (addon listRenderEndpoints) ===');
for (const e of addon.listRenderEndpoints()) {
  console.log(`${e.isDefault ? '* ' : '  '}${e.name}\n    id=${e.id}`);
}
