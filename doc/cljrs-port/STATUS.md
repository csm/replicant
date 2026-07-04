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

## cljrs reader deficiencies blocking the port (flag upstream)

The CI feature probes (`examples/cljrs-wasm/probes/`, run by the workflow) give a
precise capability matrix on **cljrs 0.1.195**. Two standard-Clojure reader
features are missing; both must be fixed in cljrs before the macro-heavy
namespaces can load. These are upstream cljrs bugs, not replicant issues.

### 1. Reader metadata on `ns` / `def` / `defmacro` names — FIXED (0.1.196 + 0.1.198)

```clojure
(ns ^:no-doc cljrs-probe.ns-meta)          ; FIXED 0.1.196
(def ^:no-doc x 1)                         ; FIXED 0.1.196
(defmacro ^{:indent 2} m [x] `(inc ~x))    ; FIXED 0.1.198 (defmacro was missed in 0.1.196)
```

### 1b. Map-literal reader bug — FIXED in 0.1.198

`core.cljc` failed to read with "map literal must have an even number of forms"
(unrelated to auto-gensym). Resolved upstream in 0.1.198.

### 1c. `declare` unbound — OPEN (0.1.198)

```clojure
(declare later)  ; → "unbound symbol: declare"
```

cljrs core does not provide the `declare` macro. Replicant uses it for forward
references in `core.cljc:694` (`(declare reconcile*)`) and `mutation_log.cljc:5`.
Now the sole blocker for `alias-test`/`string-test`/`core-test`, which otherwise
read and begin evaluating. Standard `clojure.core` macro; needs adding upstream.

### 2. Auto-gensym `symbol#` in syntax-quote — FIXED in cljrs 0.1.197

```clojure
(defmacro m [] `(let [x# 1 y# 2] [x# y#]))  ; was: "unknown # dispatch character"
```

cljrs's reader did not tokenize the auto-gensym `x#` suffix; it treated the `#`
as a dispatch macro, which blocked every syntax-quoting macro (`alias.cljc`,
`asserts.cljc`, `hiccup_headers.cljc`, `assert.cljc`, `errors.cljc`).
**Resolved upstream in cljrs 0.1.197.** This lets the macro-heavy namespaces
*read*; the remaining work for `core-test`/`string-test`/`alias-test` is runtime
adaptation of the `mutation_log` fake renderer (the `:rust` arms for `atom?` and
the vector `.indexOf` in `mutation_log.cljc`).

### Runtime gaps found once suites execute (cljrs 0.1.200)

0.1.200 gets all three remaining suites *running* (230 assertions execute across
alias/string/core-test; 3 pass). The failures now split into two runtime gaps,
both with isolating probes:

1. **`:extend-via-metadata` protocol dispatch (probe 18) — STILL OPEN at 0.1.201.**
   A protocol declared `:extend-via-metadata true` and implemented via
   `(with-meta obj {\`method (fn …)})` is not dispatched to the metadata impl:
   0.1.200 reported "not callable"; 0.1.201 now reports **"No implementation of
   protocol P for type Object"** (24× "No implementation of protocol IRender" in
   `core-test`). This is exactly how the `mutation_log` fake renderer provides
   `IRender`, so it blocks the reconcile suite. **Highest priority; not fixed in
   0.1.201.**
2. **Dynamic vars via `binding` / qualified cross-ns access (probe 19) — FIXED in
   0.1.201.** `(binding [replicant.core/*dispatch* f] …)` now works.

### Additional missing `clojure.core` (surfaced at 0.1.201)

3. **`run!` — unbound (32×, probe 21).** Called in ~10 hot paths in `core.cljc`
   (attribute/class/style updates, post-mount), lines 449–1085.
4. **`some->>` — unbound (20×, probe 22).** Used in `core.cljc:303`
   (`get-children`).
5. **"not callable: <fn>" — OPEN at 0.1.203, root cause still elusive.** cljrs
   0.1.203 fixed `:extend-via-metadata` (probe 18 PASS), `run!` (21), `some->>`
   (22), and every callable pattern in probe 20 — yet `core-test` is unchanged at
   0 failures / **185 errors, all "not callable: <fn>"**. So the isolated
   mechanisms work but replicant's real code still trips it, on both the
   reconcile path and the renderer-free `get-hiccup-headers` path. Probes 23
   (reconcile via `mutation_log`) and 24 (`get-hiccup-headers`, no renderer)
   bisect where it originates. This is now *the* remaining blocker for the whole
   `core-test` suite.

   Progress: 0.1.201 → 3 passed/214 errors; 0.1.203 → **21 passed/195 errors**
   (alias/string cleared by the run!/some->> fixes).

   **Bisected (0.1.203):** probe 24 (`get-hiccup-headers`, no renderer) PASSES —
   core parsing is fine; probe 23 (reconcile via `mutation_log`) FAILS with **"No
   implementation of protocol IRender for type Object."** So all 185 `core-test`
   errors are the renderer's `IRender`-via-metadata dispatch, not the parse path.

   **Cross-namespace `:extend-via-metadata` — FIXED in 0.1.204** (probes 23 + 25
   pass; the "No implementation of protocol IRender" and `unbound symbol` errors
   are gone). But `core-test` is *still* 0 passed / 185 errors, now uniformly
   **"not callable: <fn>"**. Bisection refined:
   - probe 23 (single, attribute-free mount `[:h1 "hi"]`) — PASSES.
   - 77 of 141 `core-test` errors are hookless plain renders — but they carry
     **attributes** (`:style`/`:class`/`:innerHTML`/`:replicant/key`) and/or are
     **re-renders** (`(-> (h/render A) (h/render B) …)`).
   **SOLVED (local interactive bisection on cljrs 0.1.204).** With cljrs
   installed locally (only the crates.io *API* is proxy-blocked; `cargo install
   cljrs` works), the remaining failures were traced to **three concrete cljrs
   bugs**, each with a one-line repro (probe `35_upstream_repros.cljrs`,
   verified locally):

   1. **`map-entry?` returns true for plain 2-element vectors.**
      `(map-entry? [:a 1])` → `true` (Clojure/CLJS: `false`; only real MapEntry
      instances qualify). Consequence: `replicant.hiccup/hiccup?` returns false
      for 2-element hiccup, so `[:h1 "hi"]` / `[:h1 {:title "t"}]` silently
      render as *text nodes* containing the stringified form. This is why probes
      23/24/34 "passed" with wrong output shapes.
   2. **`(empty m)` on a map carrying metadata returns `nil`.**
      `(empty (with-meta {:a 1} {:p 1}))` → `nil` (Clojure: `{}` with meta
      preserved; plain `(empty {:a 1})` is correct). Consequence: `clojure.walk`
      does `(into (empty form) …)` → `(into nil …)` → **"wrong type: expected
      collection, got nil"**. Mutation-log node maps carry `{:parent …}`
      metadata (`set-parent`), so `test-helper/get-mutation-log-events`
      (`walk/postwalk` over the log) throws for any render that appended a node
      — the entire WrongType wave. Replicant's engine itself is fine:
      `create-node`, `update-children`, `reconcile`, and `ml/render` all succeed
      when called directly (verified locally; 5 correct log events for an
      attributed node).
   3. **`%` under deref sugar `@%` is not counted by the `#()` arg scanner.**
      `(#(:x @%) (atom {:x 1}))` → "arity error: expected 0, got 1"; `#(:x %)`
      and `#(deref %)` are fine — any `#(… @% …)` compiles as a 0-arity fn.
      Consequence: `mutation_log.cljc:32`'s `#(::id @%)` in `-replace-child`
      breaks, which is precisely the text-node update path (probe 27; a local
      bisect showed *only* "text change" fails among identical/attr-change/
      attr-add/child-add/child-remove/tag-change updates).

   Also confirmed working locally: `update` at all arities, `walk/postwalk` over
   plain and lazy structures, keyword lookup on meta-maps, nil-punning (probe
   30), map-entry iteration (probe 31), `get-attrs`/`set-attributes` (32/33).

   Notes to flag upstream (secondary): (a) under `cljrs test` these same errors
   surface as "not callable: <fn>" while `cljrs run` gives the true
   WrongType/arity errors — an execution-tier discrepancy that misled diagnosis;
   (b) failing probes print error blobs with exponentially nested
   backslash-escaping — an error-formatting bug (cosmetic).

Once these land, re-run: remaining assertion *failures* (semantic diffs, e.g. in
`string-test`) can then be triaged.

### Status at cljrs 0.1.207 — the big one: Tier-1 IR lowering miscompiles

0.1.207 confirmed fixing bugs 1–3 (`map-entry?`, meta-map `empty`, `#() @%` —
probes 35a/b/d pass). Local bisection then found the dominant remaining bug plus
two smaller ones:

4. **`into` rejects metadata-carrying targets** (successor to the `empty` fix,
   which now correctly preserves meta):
   `(into (with-meta [] {:p 1}) [1 2])` → "wrong type: expected collection, got
   vector" — while `conj`/`assoc`/`reduce conj`/`transient` on the same values
   work. Breaks `clojure.walk` (`(into (empty form) …)`) → this is what CI
   probes 23/26–29 show as "expected collection, got map". Repro in probe 35
   (35c-equivalent) and `t29`/`t30` bisection.
5. **Tier-1 IR-interpreter lowering breaks functions — THE dominant bug.**
   An identical call succeeds for its first ~49 invocations and fails from
   the ~50th call onward, **permanently, process-wide, for that function** —
   with "not callable" (`cljrs test`) or "Not a function: `<fn>` is not
   callable" (`cljrs run`). It is the IR tier, not the Cranelift JIT:
   `--jit-threshold` changes nothing (Cranelift isn't engaged at defaults),
   while **`--ir-threshold 100000000` eliminates it completely**. This also
   explains the historical `cljrs test` vs `cljrs run` discrepancy (the test
   runner executes enough calls to cross the promotion threshold; cold
   one-shot probes never did).

   **Minimal reproduction** (`examples/cljrs-wasm/probes/37_ir_lowering_minimal.cljrs`,
   verified 100% deterministic across repeated runs):
   ```clojure
   (ns repro (:require [replicant.core :as core]))
   (def headers [:h1 nil nil nil {:title "t"} [] nil nil nil])
   (dotimes [i 55] (core/get-attrs headers))
   (println "55 calls succeeded, no error")
   ```
   Run with `cljrs run --src-path src <file>`. Expected: the println. Actual
   (cljrs ≤ 0.1.210, default settings): throws around the 50th call and never
   recovers. A single function (`replicant.core/get-attrs`), no protocol
   dispatch, no renderer, no rendering pipeline at all — purely a cumulative
   per-function call-count threshold (~50 for this function). Argument
   identity doesn't matter (same object every call, or a fresh literal each
   call — both fail at exactly the same count).

   Notably, **the bug could not be reproduced by re-implementing `get-attrs`'s
   exact logic** (`parse-tag`/`get-hiccup-headers`/`get-attrs`/`prep-attrs`/
   `get-classes`, byte-for-byte, including the real `hget` accessor macros from
   `hiccup_headers.cljc`) in a small standalone namespace that doesn't require
   `replicant.core` — even at 100+ calls. So the trigger isn't in the
   function's business logic; it's specific to how *this particular
   already-compiled function, loaded from the actual (larger) `replicant.core`
   namespace*, gets re-lowered by the IR tier around its Nth invocation. This
   is a strong hint for whoever debugs it upstream, but black-box probing
   couldn't narrow it further without cljrs-internal visibility into the IR
   promotion/lowering pass itself.
6. **Namespaced-keyword `:keys` destructuring doesn't bind** (probe 36b/c):
   `(let [{:keys [ui/dest]} {:ui/dest 2}] dest)` → "unbound symbol: dest";
   `{:ui/keys [dest]}` → "unsupported binding pattern". Used by core-test's
   alias tests (`(fn [{:keys [ui/dest]} children] …)`).

**With the IR tier disabled** (`--ir-threshold 100000000`, diagnostic step in
CI), remaining core-test tally is 11 failures + 18 errors: the errors are bugs
4 and 6 above plus a tail to triage; the failures are semantic diffs to examine
once those clear. Port-side fix included: `test_helper.cljc`'s `format-element`
had no `:rust` arm for its `instance?` Atom check (same fix as
`mutation-log/atom?`).

### Status at cljrs 0.1.210 — bugs 4 and 6 confirmed fixed; bug 5 (IR lowering) NOT fixed

Verified locally (`cargo install cljrs --version =0.1.210`):

- **Bug 6 (namespaced `:keys` destructuring) — FIXED.** Probes 36b/36c now
  return the correct bound values.
- **Bug 4 (`into` with metadata) — FIXED** (inferred from the error-count drop
  below; no more "expected collection, got …" errors under the IR-disabled run).
- **Bug 5 (Tier-1 IR lowering) — still broken at default settings.** Probe 36a
  is unchanged: the identical-expression loop still fails from iteration ~10
  onward. Consequently the three suites at **default settings** are still
  **19 passed / 0 failed / 211 errors** — essentially unmoved from 0.1.207. The
  cljrs 0.1.210 changelog says it "fixes IR mis-lowering"; that is not borne out
  by this repro. **This remains the top-priority upstream fix** — it is what
  blocks the real (non-diagnostic) CI gate.
- **With `--ir-threshold 100000000`** (bypassing the buggy tier), the suites
  jump from 0.1.207's 206 passed/11 failed/18 errors to **221 passed / 13 failed
  / 1 error** — i.e. once bugs 4 and 6 are factored out, only genuine
  assertion-level issues remain:
  - The single error is `regression-tests`: "runtime error: cannot deref nil".
  - Most of the 13 failures are in `unmounting-test` and share one shape: a
    node that should be fully removed from the rendered tree instead shows up
    as a stray `nil` child (e.g. `[:div [:span "d"] [:span "c"] nil [:span
    "b"]]` where `[:span "b"]` alone was expected). Several of the affected
    tests pass a **quoted list literal** as a hiccup children collection
    (`` '([:span {...}] ) ``) — a construct not covered by any existing probe.
    Whether this is a genuine `:rust`-port issue or another cljrs gap (e.g.
    `seq?`/`proper-seq?` behavior on quoted lists) has not yet been isolated;
    flagging for a follow-up probe rather than guessing.
  - One failure is in `event-handler-test` ("Changes handler") and one in
    `render-test` ("Ignores nil style") — not yet triaged.

### Minor: `unchecked-int` not bound (cljrs 0.1.196)

`unchecked-inc-int` / `unchecked-add-int` / `unchecked-dec-int` are bound, but the
plain cast `unchecked-int` is not ("unbound symbol: unchecked-int"). Replicant
uses it in `transition.cljc`; the `:rust` branch there uses `int` instead (the
`:clj`/`:cljs` branches keep `unchecked-int`). Low priority to add upstream.

### Confirmed working on cljrs 0.1.195 (no action needed)

`#js` tagged literals skipped in non-selected reader-conditional branches;
nested reader conditionals; `clojure.string` (`subs`, `index-of`, `split`,
`trim`, `starts-with?`); `unchecked-inc-int`/`unchecked-add-int`/`unchecked-dec-int`;
transients (`transient`/`conj!`/`persistent!`); `clojure.walk`; regex literals
with `#`/`[]` character classes. This validates the `:rust` renderer and the
`:rust` reader-conditional branches added to `core.cljc`/`string.cljc` — they
load and run; the blockers are purely the two reader gaps above.

### Result

`replicant.hiccup-test` passes under cljrs. With cljrs 0.1.196 (reader gap #1
fixed) plus the `:rust` branch in `transition.cljc`, `replicant.transition-test`
is promoted to the gate. `alias-test`, `string-test`, and `core-test` remain
blocked solely by reader gap #2 (auto-gensym), since they require macro-heavy
files (`alias.cljc`, `asserts.cljc`, `hiccup_headers.cljc`). Promote them once
auto-gensym lands.

## CI

`.github/workflows/cljrs.yml` automates the no-DOM milestone: it installs
`cljrs` (pinned via the `CLJRS_VERSION` env) and runs the headless suites
(`replicant.{hiccup,transition,alias,string,core}-test`) with
`cljrs test --src-path src --src-path test ...`. This is the cheapest gate for
the `:rust` target — it shakes out the verification items above without a
browser. The exact `--src-path` form / namespace-selection flags may need to be
reconciled with the installed cljrs version's CLI.
