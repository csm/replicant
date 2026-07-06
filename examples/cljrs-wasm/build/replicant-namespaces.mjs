// Replicant's `:rust`-relevant namespaces, in dependency order. Each entry is
// a basename under src/replicant/ (without extension). This mirrors the
// require graph across the .cljc sources; when adding a new namespace to
// Replicant, add it here too, after everything it requires.
export const REPLICANT_NAMESPACES = [
  'protocols',
  'hiccup',
  'hiccup_headers',
  'vdom',
  'console_logger',
  'assert',
  'asserts',
  'errors',
  'transition',
  'core',
  'alias',
  'string',
  'dom',
];
