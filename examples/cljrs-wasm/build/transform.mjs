// Rewrites a Replicant .cljc file's leading `(ns ...)` form so cross-file
// `:require` entries -- other `replicant.*` namespaces, plus `cljrs.dom` --
// become `alias` calls instead.
//
// Why this is needed: `cljrs-wasm`'s embedded REPL (see build.mjs) has no
// filesystem, so `require`/the `ns` macro can never resolve a sibling source
// file the way `cljrs run --src-path` does natively -- `require` is a
// hard-wired loader lookup (by-file or by embedded-stdlib-source), not a
// swappable Var, so it fails with "Could not find namespace ... on source
// path" even when the target namespace already has real vars defined (see
// doc/cljrs-port/STATUS.md, "cljrs-wasm browser integration" section, for the
// full investigation trail). Since this harness concatenates all of
// Replicant's namespaces into the same interpreter session in dependency
// order, the target namespace object already exists by the time each file's
// `ns` form runs, and `alias` -- unlike `require` -- only needs the namespace
// to exist; it doesn't try to load a source file for it.
//
// This never touches the actual .cljc sources; it runs only at browser-bundle
// build time, so the native (`cljrs run`/`cljrs test`) and clj/cljs/squint
// paths are completely unaffected.

function isWhitespace(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',';
}

// Return the index just past the form starting at `start` (a non-whitespace
// character). Handles (), [], {}, strings, char literals, ;-comments, and
// #_ / reader-macro / quote prefixes -- enough for Replicant's own sources.
function formEnd(text, start) {
  let i = start;
  const n = text.length;
  function skipWs() {
    while (i < n) {
      if (isWhitespace(text[i])) { i++; continue; }
      if (text[i] === ';') { while (i < n && text[i] !== '\n') i++; continue; }
      break;
    }
  }
  skipWs();
  if (i >= n) throw new Error('unexpected end of input');
  const c = text[i];
  if (c === '"') {
    i++;
    while (i < n) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === '"') { i++; break; }
      i++;
    }
    return i;
  }
  if (c === '(' || c === '[' || c === '{') {
    const close = c === '(' ? ')' : c === '[' ? ']' : '}';
    i++;
    for (;;) {
      skipWs();
      if (i >= n) throw new Error('unbalanced ' + c);
      if (text[i] === close) { i++; break; }
      i = formEnd(text, i);
    }
    return i;
  }
  if (c === '#') {
    // #_ discard, #? / #?@ reader conditional, #{...} set, #"regex", or a
    // dispatch prefix immediately followed by another form (e.g. #'sym).
    if (text[i + 1] === '_') { i += 2; i = formEnd(text, i); return formEnd(text, i); }
    if (text[i + 1] === '?') { i += 2; if (text[i] === '@') i++; return formEnd(text, i); }
    i++;
    return formEnd(text, i);
  }
  if (c === "'" || c === '`' || c === '~' || c === '^') {
    i++;
    if (text[i] === '@') i++;
    return formEnd(text, i);
  }
  if (c === '\\') {
    // char literal: \x, \newline, \A, ...
    i += 2;
    while (i < n && /[A-Za-z0-9]/.test(text[i])) i++;
    return i;
  }
  // symbol/keyword/number: consume until whitespace or a delimiter
  while (i < n && !isWhitespace(text[i]) && !')]}'.includes(text[i])) i++;
  return i;
}

// Split the content of a list/vector (with its outer delimiters already
// stripped) into top-level forms.
function splitTopLevel(text) {
  const forms = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && (isWhitespace(text[i]) || text[i] === ';')) {
      if (text[i] === ';') { while (i < n && text[i] !== '\n') i++; }
      else i++;
    }
    if (i >= n) break;
    const start = i;
    i = formEnd(text, i);
    forms.push(text.slice(start, i));
  }
  return forms;
}

/**
 * Rewrite one Replicant .cljc source file's `ns` form for the browser
 * bundle. Returns the original text unchanged if there was nothing to do.
 */
export function rewriteForBrowser(source) {
  if (!source.trimStart().startsWith('(ns')) {
    throw new Error('expected file to start with (ns ...)');
  }
  const nsStart = source.indexOf('(ns');
  const nsEnd = formEnd(source, nsStart);
  const nsForm = source.slice(nsStart, nsEnd);
  const rest = source.slice(nsEnd);

  const inner = nsForm.slice(1, nsForm.length - 1); // strip outer ( )
  const clauses = splitTopLevel(inner);
  const aliasCalls = [];
  let changed = false;
  const rebuilt = clauses
    .map((clause) => {
      if (!clause.startsWith('(:require')) return clause;
      const clauseInner = clause.slice('(:require'.length, clause.length - 1);
      const entries = splitTopLevel(clauseInner);
      const kept = [];
      for (const entry of entries) {
        const m = entry.match(/^\[\s*([^\s\])]+)\s*(?::as\s+([^\s\])]+))?/);
        const nsSym = m ? m[1] : (entry.startsWith('#') ? null : entry.trim());
        const isInternal = nsSym === 'cljrs.dom' || /^replicant\./.test(nsSym || '');
        if (m && isInternal) {
          changed = true;
          if (m[2]) aliasCalls.push(`(alias '${m[2]} '${nsSym})`);
        } else if (!m && isInternal) {
          // bare symbol require of an internal ns -- nothing to alias, just drop
          changed = true;
        } else {
          kept.push(entry);
        }
      }
      if (kept.length === 0) return null; // drop the whole clause
      return `(:require ${kept.join('\n            ')})`;
    })
    .filter((c) => c !== null);

  if (!changed) return source;

  const newNsForm = `(${rebuilt.join('\n  ')})`;
  const aliasBlock = aliasCalls.length ? '\n' + aliasCalls.join('\n') + '\n' : '';
  return newNsForm + aliasBlock + rest;
}
