#!/usr/bin/env node
/**
 * L16 post-patch validation launcher (payment-link reservation ownership).
 *
 * Usage (argv only, no shell):
 *   node {plan_dir}/checks/ppv.mjs --checkout {checkout} --scratch {scratch} \
 *     --plan-dir {plan_dir} --script <name>.ts [--db | --db-empty] [--ttl <seconds>]
 *
 * Steps:
 *   1. Locates the source repository's installed node_modules through the
 *      checkout's Git common dir (the runner's checkout is a linked worktree of
 *      the source repository; node_modules is untracked and only exists there).
 *      No host path is hardcoded and no environment variable is needed.
 *   2. Copies the revision under test (apps/api, packages, db/migrate.ts,
 *      db/migrations, scripts, root tsconfig/package files) from {checkout}
 *      into {scratch}/tree. The checkout itself is never written.
 *   3. Builds {scratch}/tree/node_modules: one symlink per third-party package
 *      of the source repository, and @filspay/{money,events,api} pointing INTO
 *      the copied tree, so the code under test is always this revision's bytes.
 *   4. Copies {plan_dir}/checks/tests/* to {scratch}/tree/apps/api/__ppv__/
 *      (outside src/, so neither tsc nor the project's test glob sees them).
 *   5. --db: starts a throwaway postgres:16-alpine container (local image,
 *      --pull never, trust auth, random 127.0.0.1 port, tmpfs data dir,
 *      self-terminating after --ttl seconds even if this process is killed)
 *      and runs this revision's own db/migrate.ts against it. --db-empty starts
 *      the same container but leaves migrations to the script. The user's
 *      ops-postgres-1 / filspay database is never touched; no credential is used.
 *   6. Runs `node --import tsx <tree>/apps/api/__ppv__/<script>` with cwd
 *      <tree>/apps/api. The script's fd 1/2 go to this process's stderr (the
 *      Fastify app logs timestamped JSON to fd 1); the script writes its
 *      deliberate output (observations, PPV_REACHED) to fd 3 = our stdout.
 *   7. Removes the container and the copied tree; leaves
 *      {scratch}/provenance.json with hashes of the code that ran.
 *
 * Exit code: the script's exit code, or 4 when the harness could not be set up.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const HARNESS_ERROR = 4;
const IMAGE = "postgres:16-alpine";
const STARTED = Date.now();

function log(message) {
  const elapsed = ((Date.now() - STARTED) / 1000).toFixed(1);
  fs.writeSync(2, `[ppv-l16 +${elapsed}s] ${message}\n`);
}

class HarnessError extends Error {}

function fail(message) {
  throw new HarnessError(message);
}

function parseArgs(argv) {
  const opts = { db: false, dbEmpty: false, ttl: 1500 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") opts.db = true;
    else if (a === "--db-empty") opts.dbEmpty = true;
    else if (a === "--checkout") opts.checkout = argv[++i];
    else if (a === "--scratch") opts.scratch = argv[++i];
    else if (a === "--plan-dir") opts.planDir = argv[++i];
    else if (a === "--script") opts.script = argv[++i];
    else if (a === "--ttl") opts.ttl = Number.parseInt(argv[++i], 10);
    else fail(`unknown argument ${JSON.stringify(a)}`);
  }
  for (const key of ["checkout", "scratch", "planDir", "script"]) {
    if (!opts[key]) fail(`missing --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  if (opts.db && opts.dbEmpty) fail("--db and --db-empty are mutually exclusive");
  if (!/^[a-z0-9_]+\.ts$/.test(opts.script)) fail(`bad --script ${opts.script}`);
  if (!Number.isInteger(opts.ttl) || opts.ttl < 60 || opts.ttl > 7200) fail("bad --ttl");
  return opts;
}

function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) fail(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function locateNodeModules(checkout) {
  const commonDir = git(checkout, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const sourceRoot = path.dirname(commonDir);
  const nm = path.join(sourceRoot, "node_modules");
  const tsxCli = path.join(nm, "tsx", "dist", "cli.mjs");
  if (!fs.existsSync(tsxCli)) {
    fail(`source repository ${sourceRoot} has no installed node_modules (missing ${tsxCli}); run npm ci there first`);
  }
  return fs.realpathSync(nm);
}

const TREE_ENTRIES = [
  "package.json",
  "tsconfig.base.json",
  "tsconfig.json",
  "apps/api",
  "packages",
  "db/migrate.ts",
  "db/migrations",
  "db/tsconfig.json",
  "scripts",
];

function materializeTree(checkout, tree) {
  for (const entry of TREE_ENTRIES) {
    const src = path.join(checkout, entry);
    if (!fs.existsSync(src)) fail(`checkout is missing ${entry}`);
    fs.cpSync(src, path.join(tree, entry), {
      recursive: true,
      filter: (p) => path.basename(p) !== "node_modules",
    });
  }
}

function linkNodeModules(nm, tree) {
  const dest = path.join(tree, "node_modules");
  fs.mkdirSync(dest);
  for (const name of fs.readdirSync(nm)) {
    if (name === "@filspay" || name === ".bin" || name === ".package-lock.json") continue;
    fs.symlinkSync(path.join(nm, name), path.join(dest, name));
  }
  const scope = path.join(dest, "@filspay");
  fs.mkdirSync(scope);
  fs.symlinkSync(path.join(tree, "packages", "money"), path.join(scope, "money"));
  fs.symlinkSync(path.join(tree, "packages", "events"), path.join(scope, "events"));
  fs.symlinkSync(path.join(tree, "apps", "api"), path.join(scope, "api"));
}

function copyChecks(planDir, tree) {
  const src = path.join(planDir, "checks", "tests");
  const dest = path.join(tree, "apps", "api", "__ppv__");
  fs.cpSync(src, dest, { recursive: true });
  return dest;
}

const PROVENANCE_FILES = [
  "apps/api/src/paymentLinks/pay.ts",
  "apps/api/src/paymentLinks/read.ts",
  "apps/api/src/paymentLinks/status.ts",
  "apps/api/src/paymentLinks/cancel.ts",
  "apps/api/src/payments/authorize.ts",
  "apps/api/src/payments/capture.ts",
  "apps/api/src/routes/paymentLinks.ts",
  "apps/api/src/paymentLinks/payReservation.test.ts",
  "db/migrations/0073_payment_links_reservation_owner.sql",
];

function provenance(tree, nm) {
  const record = { node: process.version, nodeModules: nm, files: {} };
  for (const f of PROVENANCE_FILES) {
    const p = path.join(tree, f);
    record.files[f] = fs.existsSync(p) ? sha256File(p) : null;
  }
  try {
    record.tsx = JSON.parse(fs.readFileSync(path.join(nm, "tsx", "package.json"), "utf8")).version;
    record.pg = JSON.parse(fs.readFileSync(path.join(nm, "pg", "package.json"), "utf8")).version;
  } catch {
    record.tsx = record.tsx ?? null;
  }
  return record;
}

function docker(...args) {
  return spawnSync("docker", args, { encoding: "utf8" });
}

async function startPostgres(nm, ttl) {
  const name = `ppv-l16-${randomBytes(6).toString("hex")}`;
  const run = docker(
    "run", "-d", "--rm", "--pull", "never",
    "--name", name,
    "--label", "ppv.case=L16",
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
    "-e", "POSTGRES_DB=ppv",
    "--tmpfs", "/var/lib/postgresql/data",
    "-p", "127.0.0.1::5432",
    "--entrypoint", "timeout",
    IMAGE,
    String(ttl), "docker-entrypoint.sh", "postgres",
    "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off",
    "-c", "max_connections=100",
  );
  if (run.status !== 0) fail(`docker run failed: ${run.stderr.trim()}`);
  const id = run.stdout.trim();
  const container = { id, name };
  try {
    const port = docker("port", id, "5432/tcp");
    const m = /127\.0\.0\.1:(\d+)/.exec(port.stdout);
    if (port.status !== 0 || !m) throw new Error(`docker port failed: ${port.stderr} ${port.stdout}`);
    const url = `postgres://postgres@127.0.0.1:${m[1]}/ppv?sslmode=disable`;
    const pg = createRequire(path.join(nm, "noop.js"))("pg");
    const deadline = Date.now() + 120_000;
    let lastError = null;
    while (Date.now() < deadline) {
      const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
      try {
        await client.connect();
        await client.query("SELECT 1");
        await client.end();
        log(`postgres ready in container ${name}`);
        return { ...container, url };
      } catch (err) {
        lastError = err;
        await client.end().catch(() => {});
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error(`postgres did not become ready: ${lastError?.message}`);
  } catch (err) {
    stopPostgres(container);
    throw new HarnessError(err.message);
  }
}

function stopPostgres(container) {
  if (!container) return;
  const r = docker("rm", "-f", container.id);
  log(r.status === 0 ? `removed container ${container.name}` : `could not remove ${container.name}: ${r.stderr.trim()}`);
}

function runChild(argv, opts) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, opts);
    child.on("error", (err) => {
      log(`spawn failed: ${err.message}`);
      resolve(HARNESS_ERROR);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : HARNESS_ERROR)));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const checkout = path.resolve(opts.checkout);
  const scratch = path.resolve(opts.scratch);
  const tree = path.join(scratch, "tree");
  const nm = locateNodeModules(checkout);
  const tsxCli = path.join(nm, "tsx", "dist", "cli.mjs");

  fs.mkdirSync(tree);
  materializeTree(checkout, tree);
  linkNodeModules(nm, tree);
  const ppvDir = copyChecks(path.resolve(opts.planDir), tree);
  const scriptPath = path.join(ppvDir, opts.script);
  if (!fs.existsSync(scriptPath)) fail(`no such check script ${opts.script}`);

  const record = provenance(tree, nm);
  fs.writeFileSync(path.join(scratch, "provenance.json"), JSON.stringify(record, null, 2) + "\n");
  log(`provenance ${JSON.stringify(record.files)}`);

  const apiDir = path.join(tree, "apps", "api");
  const env = {
    ...process.env,
    L16_TREE: tree,
    L16_NODE_MODULES: nm,
    L16_TSX_CLI: tsxCli,
  };
  delete env.DATABASE_URL;

  let container = null;
  let code = HARNESS_ERROR;
  const cleanup = () => {
    stopPostgres(container);
    container = null;
  };
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      cleanup();
      process.exit(128);
    });
  }
  try {
    if (opts.db || opts.dbEmpty) {
      container = await startPostgres(nm, opts.ttl);
      env.DATABASE_URL = container.url;
    }
    if (opts.db) {
      const migrateCode = await runChild([tsxCli, "--no-cache", path.join(tree, "db", "migrate.ts")], {
        cwd: tree,
        env,
        stdio: ["ignore", 2, 2],
      });
      if (migrateCode !== 0) fail(`db/migrate.ts exited ${migrateCode}`);
      log("migrations applied");
    }
    log(`running ${opts.script}`);
    code = await runChild(["--import", "tsx", scriptPath], {
      cwd: apiDir,
      env: { ...env, L16_OUT_FD: "3", TSX_DISABLE_CACHE: "1" },
      stdio: ["ignore", 2, 2, 1],
    });
  } finally {
    cleanup();
    fs.rmSync(tree, { recursive: true, force: true });
  }
  log(`script ${opts.script} exited ${code}`);
  process.exit(code);
}

main().catch((err) => {
  log(`HARNESS ERROR: ${err instanceof HarnessError ? err.message : (err?.stack ?? String(err))}`);
  process.exit(HARNESS_ERROR);
});
