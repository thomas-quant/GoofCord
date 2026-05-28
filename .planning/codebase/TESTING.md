# Testing Patterns

**Analysis Date:** 2026-05-28

## Test Framework

**Runner:** None detected

No test runner (Jest, Vitest, Mocha, etc.) is present in `package.json` or any config file. No test files (`.test.ts`, `.spec.ts`) exist anywhere in the repository.

**Assertion Library:** None

**Run Commands:**
```bash
# No test commands defined in package.json scripts
bun run lint     # Lint with oxlint (type-aware)
bun run fmt      # Format with oxfmt
bun run check    # Type-check with tsgo
```

## Test File Organization

**Location:** No test files exist in the codebase.

**Naming:** No established convention (no examples to reference).

**Structure:** Not applicable.

## Test Structure

No test suites, describe blocks, or test cases exist.

The build script at `build/genIpcHandlers.ts` explicitly defines patterns it would skip if tests existed:
```typescript
skipPatterns: [".d.ts", ".test.ts", ".spec.ts"],
```

This shows the team is aware of test file conventions but has not yet written any tests.

## Mocking

**Framework:** None configured.

## Fixtures and Factories

**Test Data:** None.

## Coverage

**Requirements:** None enforced.

**Coverage tooling:** Not configured.

## Test Types

**Unit Tests:** Not present.

**Integration Tests:** Not present.

**E2E Tests:** Not present.

## Quality Checks (Substitutes for Tests)

The project uses static analysis as its only automated quality gate:

**Type checking:**
- `bun run check` runs `tsgo` (TypeScript native preview)
- Strict mode: `"strict": true`, `"noImplicitReturns": true`
- Run as step 2 in the build pipeline (`build/build.ts`) — build aborts on type errors

**Linting:**
- `bun run lint` runs `oxlint --type-aware`
- Config: `.oxlintrc.json`
- Plugins: `eslint`, `typescript`, `react`, `unicorn`, `oxc`, `promise`, `node`
- Assets directory excluded from linting

**Formatting:**
- `bun run fmt` runs `oxfmt`
- Config: `.oxfmtrc.json`
- Tabs, 320-char print width, auto import sorting

**IPC code generation validation:**
- `build/genIpcHandlers.ts` validates IPC channel names at build time (no empty names, no whitespace)
- Errors are surfaced to the console during build: `⚠️  Found N error(s)`

## Adding Tests (Guidance for Future Work)

If tests are introduced, these patterns should be followed given the existing stack:

**Recommended runner:** Bun's built-in test runner (`bun:test`) — already in the dependency chain as `@types/bun` is a dev dependency.

**File naming convention to use** (inferred from build system's `skipPatterns`):
- `*.test.ts` for TypeScript test files
- `*.spec.ts` as an alternative

**Expected location:** Co-located with source files or a top-level `tests/` directory.

**Example Bun test structure:**
```typescript
import { describe, expect, test } from "bun:test";

describe("isSemverLower", () => {
    test("returns true when version1 is lower", () => {
        // test body
    });
});
```

**Testable pure functions** (no Electron dependency, good candidates for unit tests):
- `isSemverLower` in `src/modules/updateCheck.ts`
- `parseVersion` in `src/migration.ts`
- `getErrorMessage` in `src/utils.ts`
- `isEncrypted`, `getDefaults`, `getDefinition` in `src/settingsSchema.ts`
- `expandRegex`, `linkHelpers`, `processPatch` in `src/windows/main/renderer/preVencord/patchManager.ts`
- `encryptSafeStorage`, `decryptSafeStorage` in `src/stores/config/config.main.ts`
- `makeUniqueAlias`, `validateChannelName` in `build/genIpcHandlers.ts`

---

*Testing analysis: 2026-05-28*
