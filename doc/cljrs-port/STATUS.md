# Replicant `:rust` (cljrs/WASM) backend — implementation status

This tracks the in-progress port of Replicant to compile to WebAssembly via
[clojurust](https://github.com/csm/clojurust) (`cljrs`). Background and the DOM
API mapping are in [`cljrs-dom-requirements.md`](./cljrs-dom-requirements.md).

The upstream blockers are resolved: every `cljrs.dom` operation Replicant needs
shipped in **cljrs 0.1.195**, and the library→WASM packaging CLI landed in
**0.1.194**.

## What this branch implements

A `:rust` reader-conditional target across the cljc sources, leaving every
existing `:clj` / `:cljs` / `:squint` branch byte-for-byte unchanged.

- **`src/replicant/dom.cljc`** — a `#?(:rust ...)` `IRender`/`IMemory` renderer
  built on `cljrs.dom`, parallel to the browser `reify`. Public API
  (`render`, `unmount`, `set-dispatch!`, `recall`) is shared; only the
  host-specific bits (`requestAnimationFrame`, clearing the root, error
  reporting, computed-style transitions, dev-key skip) branch on `:rust`. The
  `replicant.env` require is now `:default`-only (env ships as `.clj`/`.cljs`
  with no `.cljc`, so cljrs cannot load it; the `:rust` path skips dev-key
  injection like `:squint` does).
- **`src/replicant/core.cljc`** — `:rust` branches for the host string interop in
  the hot parse path (`.indexOf`/`.substring`/`.split`/`.trim` →
  `clojure.string`/`subs`/`clojure.core`), the event target (`(:target e)` —
  cljrs.dom delivers events as maps), the alias-exception message
  (`ex-message`), and the data-literal/`catch` reader conditionals that
  previously had only `:clj`/`:cljs` arms. `[clojure.string :as str]` was added
  to the ns.
- **`src/replicant/string.cljc`** — a `:rust` `create-renderer` arm (a
  `volatile!` vector accumulator in place of `StringBuilder`/JS array).
- **`src/replicant/{vdom,hiccup_headers,assert,console_logger}.cljc`** — no
  changes needed: their macros expand to the persistent-collection branch when
  `(:ns &env)` is falsey (which it is under cljrs), and `assert` self-disables
  under `:rust` (its `assert?` returns nil).

## Mapping: `IRender`/`IMemory` → `cljrs.dom`

| Protocol method | cljrs.dom call |
|---|---|
| `attached?` | `connected?` |
| `create-text-node` | `create-text` |
| `create-element` (+`:ns`) | `create` / `create-ns` |
| `set-style` / `remove-style` | `set-style!` / `remove-style!` |
| `add-class` / `remove-class` | `add-class!` / `remove-class!` |
| `set-attribute` (+`:ns`, form props) | `set-attr!` / `set-attr-ns!` / `set-value!` / `set-checked!` / `set-selected!` / `set-html!` |
| `remove-attribute` | `remove-attr!` / `set-prop!` / `set-html!` |
| `set-event-handler` / `remove-event-handler` | `listen!` (+opts) / `unlisten!` |
| `append-child` / `insert-before` | `append!` / `insert-before!` |
| `remove-child` / `replace-child` | `remove!` / `replace!` |
| `remove-all-children` | `set-text!` el "" |
| `get-child` | `child-at` |
| `next-frame` | `request-animation-frame` (double) |
| `on-transition-end` | `computed-style` + `listen!`/`unlisten!` |
| `remember` / `recall` | `remember!` / `recall` |

## Verification checklist (needs the cljrs toolchain)

The cljrs compiler is **not installable in this container** (the proxy blocks the
Clojure/crates download hosts), so the `:rust` path has not been compiled here.
The existing `:clj`/`:cljs` branches are unchanged, so the current JVM/CLJS test
suites remain the regression baseline. When running under cljrs ≥ 0.1.195,
confirm:

1. **cljrs stdlib coverage** — `clojure.string` (used by `core`),
   `clojure.walk` (required by `console-logger`), and the unchecked int ops
   (`unchecked-inc-int`/`unchecked-add-int`/`unchecked-dec-int`, used throughout
   `core`'s reconcile loop) are available. If `clojure.walk` is missing, guard
   its require in `console_logger.cljc` (`report`/`scrub-sexp` are never called
   under `:rust`).
2. **Macro `&env`** — cljrs `defmacro` exposes `&env`, and `(:ns &env)` is
   falsey, so `hiccup_headers`/`vdom`/`assert` expand to their persistent-vector
   branches.
3. **`(catch :default e ...)`** — cljrs accepts the cljs-style `:default` catch
   class used in `dom/render` and `core` alias handling.
4. **Transients** — `transient`/`conj!`/`persistent!` (used in `update-children`)
   behave as in Clojure.
5. **`set-prop!`/`get-prop` round-trip** — storing a Clojure map of listener
   handles under the `"replicantHandlers"` node property and reading it back
   yields the same value. If cljrs marshals it lossily, switch the renderer's
   handler bookkeeping to a renderer-local map keyed by node identity (see the
   comment in `dom.cljc`).
6. **Event maps** — `cljrs.dom` events expose `:target` (used by
   `core/build-event-map`).

Then run the no-DOM milestone (pure-data tests via `mutation_log`) before the
browser/wasm integration test. See `examples/cljrs-wasm/README.md`.

## CI

`.github/workflows/cljrs.yml` automates the no-DOM milestone: it installs
`cljrs` (pinned via the `CLJRS_VERSION` env) and runs the headless suites
(`replicant.{hiccup,transition,alias,string,core}-test`) with
`cljrs test --src-path src --src-path test ...`. This is the cheapest gate for
the `:rust` target — it shakes out the verification items above without a
browser. The exact `--src-path` form / namespace-selection flags may need to be
reconciled with the installed cljrs version's CLI.
