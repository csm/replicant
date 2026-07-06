#!/usr/bin/env node
// Builds the static, deployable bundle for Replicant's cljrs/WASM browser
// harness: the cljrs-wasm interpreter runtime (built via wasm-pack from the
// published cljrs-wasm + cljrs-dom crates) plus Replicant's own source
// (rewritten for the browser's require-free environment) plus the test
// harness page.
//
// See ../README.md for the architecture this implements, and
// doc/cljrs-port/STATUS.md for how it was arrived at.
//
// Prerequisites (not installed by this script -- see .github/workflows for
// the CI setup, or install locally):
//   - a Rust toolchain with the wasm32-unknown-unknown target
//       rustup target add wasm32-unknown-unknown
//   - wasm-pack
//       cargo install wasm-pack
//
// Usage:
//   node build.mjs --out DIST_DIR [--cljrs-version X.Y.Z] [--profile dev|release]
//
// --profile dev (default) skips wasm-opt, which needs to download a
// binaryen release from GitHub; use --profile release for a smaller
// artifact when that download isn't blocked (e.g. in ordinary CI runners).

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewriteForBrowser } from './transform.mjs';
import { REPLICANT_NAMESPACES } from './replicant-namespaces.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(EXAMPLE_ROOT, '../..');

function parseArgs(argv) {
  const args = { profile: 'dev', cljrsVersion: '0.1.219', out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--cljrs-version') args.cljrsVersion = argv[++i];
    else if (a === '--profile') args.profile = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.out) throw new Error('--out DIST_DIR is required');
  return args;
}

function sh(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function fetchCrate(name, version, destDir) {
  const url = `https://static.crates.io/crates/${name}/${name}-${version}.crate`;
  fs.mkdirSync(destDir, { recursive: true });
  const tarPath = path.join(destDir, `${name}-${version}.crate`);
  console.log(`+ curl -sSL -o ${tarPath} ${url}`);
  execSync(`curl -sSL -o "${tarPath}" "${url}"`, { stdio: 'inherit' });
  sh('tar', ['xzf', tarPath], { cwd: destDir });
  return path.join(destDir, `${name}-${version}`);
}

// Builds the cljrs-wasm crate (which depends on cljrs-dom) via wasm-pack,
// producing the wasm-bindgen JS glue + .wasm module that the harness loads.
// Cached by version + profile under `cacheDir` so repeated builds (e.g.
// across PRs in CI, when the cache dir is restored) are close to instant.
function buildRuntime(cljrsVersion, profile, cacheDir) {
  const runtimeOut = path.join(cacheDir, `cljrs-wasm-${cljrsVersion}-${profile}`);
  const jsOut = path.join(runtimeOut, 'cljrs_wasm.js');
  const wasmOut = path.join(runtimeOut, 'cljrs_wasm_bg.wasm');
  if (fs.existsSync(jsOut) && fs.existsSync(wasmOut)) {
    console.log(`runtime cache hit: ${runtimeOut}`);
    return runtimeOut;
  }

  const workDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cljrs-wasm-build-'));
  const crateDir = fetchCrate('cljrs-wasm', cljrsVersion, workDir);

  const profileFlag = profile === 'release' ? '--release' : '--dev';
  try {
    sh('wasm-pack', ['build', '--target', 'web', profileFlag, crateDir]);
  } catch (e) {
    if (profile !== 'release') throw e;
    // --release runs wasm-opt, which downloads a binaryen release from
    // GitHub on first use; if that's blocked (proxy/network policy), fall
    // back to an unoptimized build rather than failing the whole job.
    console.warn(`wasm-pack --release failed (${e.message}); retrying --dev`);
    sh('wasm-pack', ['build', '--target', 'web', '--dev', crateDir]);
  }

  fs.mkdirSync(runtimeOut, { recursive: true });
  for (const f of ['cljrs_wasm.js', 'cljrs_wasm_bg.wasm']) {
    fs.copyFileSync(path.join(crateDir, 'pkg', f), path.join(runtimeOut, f));
  }
  return runtimeOut;
}

function bundleReplicantSource() {
  const parts = REPLICANT_NAMESPACES.map((name) => {
    const p = path.join(REPO_ROOT, 'src', 'replicant', `${name}.cljc`);
    const src = fs.readFileSync(p, 'utf8');
    return `;; ---- replicant/${name}.cljc ----\n` + rewriteForBrowser(src);
  });
  return parts.join('\n\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.out);
  const cacheDir = process.env.CLJRS_WASM_CACHE_DIR
    || path.join(REPO_ROOT, '.cache', 'cljrs-wasm-runtime');

  fs.mkdirSync(outDir, { recursive: true });

  console.log('== building cljrs-wasm runtime ==');
  const runtimeDir = buildRuntime(args.cljrsVersion, args.profile, cacheDir);
  for (const f of ['cljrs_wasm.js', 'cljrs_wasm_bg.wasm']) {
    fs.copyFileSync(path.join(runtimeDir, f), path.join(outDir, f));
  }

  console.log('== bundling Replicant source ==');
  const bundle = bundleReplicantSource();
  fs.writeFileSync(path.join(outDir, 'replicant.cljrs'), bundle);

  console.log('== copying harness ==');
  const harnessDir = path.join(EXAMPLE_ROOT, 'harness');
  for (const f of fs.readdirSync(harnessDir)) {
    if (f.endsWith('.html') || f.endsWith('.cljrs') || f.endsWith('.css')) {
      fs.copyFileSync(path.join(harnessDir, f), path.join(outDir, f));
    }
  }

  console.log(`\nBuild complete: ${outDir}`);
}

main();
