#!/usr/bin/env node
// Entry point for the magic-resume CLI.
// The command implementations live in ../src/cli/index.ts (TypeScript), loaded
// through tsx's ESM loader so `node bin/magic-resume.mjs` works without a build
// step. TSX_TSCONFIG_PATH pins the repo tsconfig, which is what makes the `@/*`
// path aliases resolve no matter which directory the CLI is invoked from.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
process.env.TSX_TSCONFIG_PATH = join(packageRoot, "tsconfig.json");

register();
await import("../src/cli/index.ts");
