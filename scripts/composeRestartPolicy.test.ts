/**
 * The long-running services must come back on their own after a crash or an
 * OOM kill (the API runs in 512 MB). The one-off jobs (migrate, seed) must
 * not restart, or they would re-run in a loop. Pure: reads the compose file.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const compose = readFileSync(new URL("../ops/docker-compose.yml", import.meta.url), "utf8");

/** The body of one service under `services:` (its 4-space-indented lines). */
function serviceBlock(name: string): string {
  const match = new RegExp(`^  ${name}:\\n((?:(?:    .*)?\\n)*)`, "m").exec(compose);
  assert.ok(match, `service ${name} not found in ops/docker-compose.yml`);
  return match[1]!;
}

test("long-running services restart after a crash or OOM kill", () => {
  for (const name of ["postgres", "api", "settlement", "reporting"]) {
    assert.match(serviceBlock(name), /^    restart: unless-stopped$/m, name);
  }
});

test("one-off jobs do not restart", () => {
  for (const name of ["migrate", "seed"]) {
    assert.doesNotMatch(serviceBlock(name), /^    restart:/m, name);
  }
});
