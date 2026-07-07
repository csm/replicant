// Pure helpers for the small JSON manifest that tracks which PR preview
// builds currently live on the remote server, and the index page listing
// them. Kept dependency-free and side-effect-free so they're easy to test
// and reuse from deploy.mjs.

/** Add or update one PR's entry in the manifest (an array, oldest first). */
export function upsertEntry(manifest, entry) {
  const without = manifest.filter((e) => e.number !== entry.number);
  return [...without, entry];
}

/** Remove one PR's entry from the manifest. */
export function removeEntry(manifest, number) {
  return manifest.filter((e) => e.number !== number);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/** Render the index page listing every currently-deployed PR preview. */
export function renderIndexHtml(manifest) {
  const sorted = [...manifest].sort((a, b) => b.number - a.number);
  const rows = sorted
    .map(
      (e) => `      <li>
        <a href="./pr-${e.number}/">#${e.number}</a> -- ${escapeHtml(e.title)}
        <span class="meta">updated ${escapeHtml(e.updatedAt)}</span>
      </li>`
    )
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Replicant cljrs/WASM PR previews</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
  li { margin-bottom: 0.75rem; }
  .meta { color: #666; font-size: 0.85em; display: block; }
  .empty { color: #666; }
</style>
</head>
<body>
<h1>Replicant on cljrs/WASM -- open PR previews</h1>
<p>Each open pull request against
   <a href="https://github.com/csm/replicant">csm/replicant</a> that touches
   the cljrs/WASM port gets its own build here, refreshed on every push and
   removed when the PR closes.</p>
<ul>
${rows || '      <li class="empty">No open PR previews right now.</li>'}
</ul>
</body>
</html>
`;
}
