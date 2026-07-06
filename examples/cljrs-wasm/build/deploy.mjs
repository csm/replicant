#!/usr/bin/env node
// Deploys (or tears down) one PR's built preview to a shared SFTP host,
// alongside every other currently-open PR's preview, plus a manifest.json +
// index.html listing them all. Used by .github/workflows/cljrs-wasm-preview.yml.
//
// Requires `lftp` on PATH (the workflow installs it via apt).
//
// Environment variables (see the workflow for the corresponding secrets):
//   PREVIEW_SFTP_HOST          -- required
//   PREVIEW_SFTP_PORT          -- optional, default 22
//   PREVIEW_SFTP_USERNAME      -- required
//   PREVIEW_SFTP_SSH_KEY       -- required, PEM-encoded private key
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

function writeKeyFile() {
  const key = env('PREVIEW_SFTP_SSH_KEY');
  const keyPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-key-')), 'id');
  fs.writeFileSync(keyPath, key.endsWith('\n') ? key : key + '\n', { mode: 0o600 });
  return keyPath;
}

function lftp(script) {
  const keyPath = writeKeyFile();
  const host = env('PREVIEW_SFTP_HOST');
  const port = process.env.PREVIEW_SFTP_PORT || '22';
  const user = env('PREVIEW_SFTP_USERNAME');
  // Host key checking is intentionally relaxed here: this deploys to a
  // preview/staging path most setups treat as low-stakes, and pinning a host
  // key adds a secret most users won't bother rotating if the host changes.
  // Harden by setting sftp:connect-program yourself if that matters for you.
  const preamble = `set sftp:auto-confirm yes
set sftp:connect-program "ssh -a -x -i ${keyPath} -o StrictHostKeyChecking=accept-new"
open -p ${port} -u ${user}, sftp://${host}
`;
  execFileSync('lftp', ['-c', preamble + script], { stdio: 'inherit' });
}

function tryDownload(remotePath, localPath) {
  const keyPath = writeKeyFile();
  const host = env('PREVIEW_SFTP_HOST');
  const port = process.env.PREVIEW_SFTP_PORT || '22';
  const user = env('PREVIEW_SFTP_USERNAME');
  const preamble = `set sftp:auto-confirm yes
set sftp:connect-program "ssh -a -x -i ${keyPath} -o StrictHostKeyChecking=accept-new"
open -p ${port} -u ${user}, sftp://${host}
`;
  try {
    execFileSync('lftp', ['-c', `${preamble}get ${remotePath} -o ${localPath}`], { stdio: 'pipe' });
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
