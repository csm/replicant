# Replicant on cljrs/WASM — browser test harness

A real Replicant `:rust` renderer, editing real DOM in a browser, via
[clojurust](https://github.com/csm/clojurust) (`cljrs`)'s browser REPL.

See [`doc/cljrs-port/STATUS.md`](../../doc/cljrs-port/STATUS.md) for the full
story of how this works and the cljrs-side quirks it took to get here
(short version below).

## How this actually works

There is no `cljrs compile --target wasm` step here, despite what earlier
notes in this repo said. Two things are true about cljrs today that changed
the plan:

- **`cljrs.dom` is real**, but it ships as part of the `cljrs-wasm` crate (a
  `wasm-bindgen`-based browser REPL: a tree-walking Clojure interpreter
  compiled to `wasm32-unknown-unknown`), not as something the `cljrs` CLI's
  AOT `compile --target wasm` backend can use. That backend is a separate,
  much less mature code path with no host-call/FFI mechanism at all --
  fine for pure computation, useless for touching the DOM.
- **`require`/`ns` can't resolve sibling source files in the browser** --
  there's no filesystem, and cljrs's `require` is a hard-wired loader (by
  file path or embedded stdlib source), not a swappable Var. So this harness
  concatenates all of Replicant's namespaces into one interpreter session,
  in dependency order, and rewrites cross-file `:require`s to `alias` calls
  at build time (`build/transform.mjs`) -- `alias` only needs the target
  namespace to already exist, which it does once its forms have been
  evaluated.

Concretely: `build/build.mjs` builds `cljrs-wasm` (which depends on
`cljrs-dom`) via `wasm-pack`, bundles Replicant's `:rust`-conditional source
into one `.cljrs` file, and copies in `harness/` (the page). At page load,
`harness/index.html` boots the wasm-bindgen `Repl`, `eval`s the bundled
Replicant source and then the test harness source into it, and runs a suite
of self-checking DOM assertions plus a live interactive demo -- all editing
the page's real DOM through `cljrs.dom`.

## Building locally

Prerequisites: a Rust toolchain with the `wasm32-unknown-unknown` target
(`rustup target add wasm32-unknown-unknown`) and `wasm-pack`
(`cargo install wasm-pack`).

```sh
node build/build.mjs --out dist --profile dev
python3 -m http.server -d dist 8000
# open http://localhost:8000/
```

`--profile dev` skips `wasm-opt` (which needs to download a binaryen release
from GitHub); pass `--profile release` for a smaller build once that's not a
problem for your network. The `cljrs-wasm` runtime build is cached under
`.cache/cljrs-wasm-runtime/` (gitignored) so repeat builds are fast.

## Layout

- `build/transform.mjs` -- rewrites one `.cljc` file's `ns` form for the
  browser (see "How this actually works" above).
- `build/replicant-namespaces.mjs` -- the dependency order to bundle
  Replicant's namespaces in.
- `build/build.mjs` -- builds the `cljrs-wasm` runtime and the bundle.
- `build/manifest.mjs` / `build/deploy.mjs` -- used by CI to deploy one
  build per open PR to a shared SFTP host, alongside an index of all of
  them; see `.github/workflows/cljrs-wasm-preview.yml`.
- `harness/index.html` -- the page: boots the REPL, loads the bundle, runs
  the checks below, then the live demo.
- `harness/test_harness.cljrs` -- ~11 self-checking DOM-editing tests
  (elements, attributes, classes, styles, forms, keyed reordering, SVG,
  lifecycle hooks) plus a small interactive demo app, all rendered with
  Replicant's real `:rust` renderer.

## cljrs quirks found along the way

A few cljrs behaviors this port had to work around, beyond the require/alias
one above (all confirmed with minimal repros; see STATUS.md for the details
and exact version):

- A solo `#?(:default ...)` reader-conditional form matches under `:rust`
  too (standard behavior -- `:default` matches whenever no other branch in
  the *same* form lists the active feature), so anything meant to be
  clj/cljs/squint-only needs `:rust` spelled out explicitly.
- `reify` doesn't resolve a namespace-qualified (aliased *or* fully
  qualified) protocol symbol -- only a bare symbol interned in the current
  namespace works.
- `set!` on a dynamic var doesn't resolve through an alias either (a plain
  read does); needs the fully qualified symbol.
- `defonce` rejects a metadata-tagged symbol ("defonce requires a symbol at
  position 0"); plain `def` doesn't have this problem.
- Calling `cljrs.dom/create-ns` directly invokes `clojure.core/create-ns`
  instead (a name-based dispatch collision, apparently keyed off something
  other than the resolved Var -- calling through `apply` avoids it).
- Attribute/style setters expect a real string (Rust's `&str` boundary),
  unlike the browser's auto-coercing `.setAttribute`; numeric hiccup values
  need an explicit `str`.
