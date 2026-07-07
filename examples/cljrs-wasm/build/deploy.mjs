#!/usr/bin/env node
// Deploys (or tears down) one PR's built preview to a shared SFTP host,
// alongside every other currently-open PR's preview, plus a manifest.json +
// index.html listing them all. Used by .github/workflows/cljrs-wasm-preview.yml.
//
// Requires `lftp` and `sshpass` on PATH (the workflow installs both via apt).
//
// Environment variables (see the workflow for the corresponding secrets):
//   PREVIEW_SFTP_HOST          -- required
//   PREVIEW_SFTP_PORT          -- optional, default 22
//   PREVIEW_SFTP_USERNAME      -- required
//   PREVIEW_SFTP_PASSWORD      -- required
//   PREVIEW_SFTP_REMOTE_PATH   -- required, base directory on the server
//   PREVIEW_SITE_BASE_URL      -- required, public URL prefix for the base
//                                  directory above (used in the PR comment)
//
// Usage:
//   node deploy.mjs deploy --pr 123 --title "PR title" --dist-dir dist
//   node deploy.mjs cleanup --pr 123

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { upsertEntry, removeEntry, renderIndexHtml } from './manifest.mjs';

function env(name, required = true) {
  const v = process.env[name];
  if (required && !v) throw new Error(`missing required environment variable ${name}`);
  return v;
}

function parseArgs(argv) {
  const action = argv[0];
  if (action !== 'deploy' && action !== 'cleanup') {
    throw new Error('usage: deploy.mjs <deploy|cleanup> --pr N [--title T] [--dist-dir DIR]');
  }
  const args = { action, pr: null, title: '(no title)', distDir: null };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--pr') args.pr = Number(argv[++i]);
    else if (argv[i] === '--title') args.title = argv[++i];
    else if (argv[i] === '--dist-dir') args.distDir = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!args.pr) throw new Error('--pr N is required');
  if (action === 'deploy' && !args.distDir) throw new Error('--dist-dir DIR is required for deploy');
  return args;
}

// Connects with a password rather than a key. lftp's own `-u user,password`
// only works when lftp was built with its internal SSH2 support, which
// isn't guaranteed on a given runner image; routing the password through
// `sshpass -e` (reading it from the SSHPASS environment variable, so it
// never appears in the script text, argv, or on disk) instead makes lftp
// shell out to the system `ssh` binary in sftp-subsystem mode, which is the
// reliable path regardless of how lftp was built.
function connectPreamble() {
  const host = env('PREVIEW_SFTP_HOST');
  const port = process.env.PREVIEW_SFTP_PORT || '22';
  const user = env('PREVIEW_SFTP_USERNAME');
  // Host key checking is intentionally relaxed here: this deploys to a
  // preview/staging path most setups treat as low-stakes, and pinning a host
  // key adds a secret most users won't bother rotating if the host changes.
  // Harden by setting sftp:connect-program yourself if that matters for you.
  return `set sftp:auto-confirm yes
set sftp:connect-program "sshpass -e ssh -a -x -o StrictHostKeyChecking=accept-new"
open -p ${port} -u ${user}, sftp://${host}
`;
}

function lftpEnv() {
  return { ...process.env, SSHPASS: env('PREVIEW_SFTP_PASSWORD') };
}

function lftp(script) {
  execFileSync('lftp', ['-c', connectPreamble() + script], { stdio: 'inherit', env: lftpEnv() });
}

function tryDownload(remotePath, localPath) {
  try {
    execFileSync('lftp', ['-c', `${connectPreamble()}get ${remotePath} -o ${localPath}`], {
      stdio: 'pipe',
      env: lftpEnv(),
    });
    return true;
  } catch {
    return false; // remote file doesn't exist yet -- fine on first deploy
  }
}

function loadManifest(basePath, workDir) {
  const local = path.join(workDir, 'manifest.json');
  const ok = tryDownload(`${basePath}/manifest.json`, local);
  if (!ok) return [];
  try {
    return JSON.parse(fs.readFileSync(local, 'utf8'));
  } catch {
    return [];
  }
}

function publishManifestAndIndex(basePath, manifest, workDir) {
  const manifestPath = path.join(workDir, 'manifest.json');
  const indexPath = path.join(workDir, 'index.html');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(indexPath, renderIndexHtml(manifest));
  // `mkdir -p` on a directory that already exists logs "Access failed:
  // Failure" to stderr on at least some lftp versions -- harmless (verified:
  // the directory is left alone and the subsequent puts still land), just
  // noisy; lftp doesn't abort the script over it (no `set cmd:fail-exit`).
  lftp(`mkdir -p ${basePath}
put ${manifestPath} -o ${basePath}/manifest.json
put ${indexPath} -o ${basePath}/index.html
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const basePath = env('PREVIEW_SFTP_REMOTE_PATH').replace(/\/+$/, '');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cljrs-wasm-deploy-'));

  const manifest = loadManifest(basePath, workDir);

  if (args.action === 'deploy') {
    const remoteDir = `${basePath}/pr-${args.pr}`;
    lftp(`mkdir -p ${remoteDir}
mirror -R --delete ${args.distDir} ${remoteDir}
`);
    const updated = upsertEntry(manifest, {
      number: args.pr,
      title: args.title,
      updatedAt: new Date().toISOString(),
    });
    publishManifestAndIndex(basePath, updated, workDir);
    const siteBaseUrl = env('PREVIEW_SITE_BASE_URL').replace(/\/+$/, '');
    console.log(`Deployed: ${siteBaseUrl}/pr-${args.pr}/`);
  } else {
    lftp(`rm -rf ${basePath}/pr-${args.pr}
`);
    const updated = removeEntry(manifest, args.pr);
    publishManifestAndIndex(basePath, updated, workDir);
    console.log(`Cleaned up pr-${args.pr}`);
  }
}

main();
