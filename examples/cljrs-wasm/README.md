# Replicant on cljrs/WASM — example

A minimal Replicant app compiled to WebAssembly via
[clojurust](https://github.com/csm/clojurust) (`cljrs`), using the `:rust`
renderer backend in `src/replicant/dom.cljc`.

Requires **cljrs ≥ 0.1.195** (DOM API) / **≥ 0.1.194** (wasm packaging).

## Layout

- `src/demo/main.cljrs` — the app. Exercises element/text creation, attributes,
  a form property, event handlers, keyed-child reordering, and an SVG subtree.
- `cljrs.edn` — project/build config (template — reconcile with your cljrs
  version's schema).
- `public/index.html` — host page that loads the wasm module and calls `main`.

## Build & run

The wasm packaging CLI is new (0.1.194) and its flags are still settling, so the
commands below are the intended shape — check `cljrs help` for specifics:

```sh
# from this directory
cljrs wasm --config cljrs.edn      # emits public/demo.wasm + JS glue
# serve public/ over http and open index.html
python3 -m http.server -d public 8000
```

## Verifying before wasm (recommended first milestone)

The renderer is decoupled from the DOM via `replicant.protocols`, so the core
port can be validated with **no browser and no wasm** by running Replicant's
existing pure-data tests under the cljrs interpreter. These use the
`replicant.mutation-log` fake renderer (plain Clojure data) and assert the
sequence of DOM operations:

```sh
# point cljrs at Replicant's src + test paths and run, e.g.:
cljrs test replicant.core-test replicant.string-test replicant.hiccup-test
```

This shakes out reader-conditional, macro-expansion, stdlib, and persistent
collection issues independent of `cljrs.dom`. See
`../../doc/cljrs-port/STATUS.md` for the full verification checklist.

## Browser integration test

Once built, load `public/index.html` in headless Chromium (Playwright is
available in this repo's environment) and assert the rendered DOM — in
particular click "Reverse list" (exercises `insert-before!` / `child-at`) and
confirm the SVG `<circle>` is created in the SVG namespace.
