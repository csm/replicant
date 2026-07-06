# cljrs-dom requirements for a Replicant `:rust` backend

This document specifies the additions needed in **clojurust**'s
[`cljrs-dom`](https://github.com/csm/clojurust) crate (the `cljrs.dom` namespace)
before Replicant can be ported to compile to WebAssembly via `cljrs`.

Replicant's renderer contract (`replicant.protocols/IRender` + `IMemory`) needs a
handful of DOM operations beyond `cljrs.dom`'s original surface. This document
flagged them for upstream implementation rather than working around them inside
Replicant.

**Status: confirmed working, as actually verified against cljrs 0.1.219**
(installed via `cargo install cljrs`, and `cljrs-dom`/`cljrs-wasm` built via
`wasm-pack` -- see `examples/cljrs-wasm/` and
`doc/cljrs-port/STATUS.md`'s "cljrs-wasm browser integration" section). Every
operation listed below exists in `cljrs.dom` and is exercised by Replicant's
real `:rust` renderer in a real browser (Playwright/headless Chromium) via
that example. The version numbers in the table below are carried over from
an earlier draft of this document and were not independently re-verified per
row; treat them as approximate. The "library → WASM packaging" row was wrong
and is corrected further down (see "Toolchain").

### Resolution summary

| Requirement | `cljrs.dom` fn | Landed |
|---|---|---|
| insert with reference node | `insert-before!` | 0.1.195 |
| O(1) indexed child access | `child-at`, `child-count` | 0.1.195 |
| SVG element creation | `create-ns` | 0.1.195 |
| namespaced attributes | `set-attr-ns!`, `remove-attr-ns!` | 0.1.195 |
| single-property style removal | `remove-style!` | 0.1.195 |
| form DOM properties | `set-checked!`, `set-selected!`, `set-prop!`, `get-prop` | 0.1.195 |
| listener options + removal | `listen!`/`unlisten!` with `{:capture :passive :once}` (capture-aware) | 0.1.195 |
| attachment check | `connected?` | 0.1.195 |
| frame scheduling | `request-animation-frame` | 0.1.195 |
| computed style | `computed-style` | 0.1.195 |
| node memory | `remember!`, `recall` | 0.1.195 |
| library → WASM packaging | *(see "Toolchain" below -- this row was wrong)* | -- |

## Background

Replicant performs **all** DOM mutation through a single protocol,
`src/replicant/protocols.cljc`:

```clojure
(defprotocol IRender
  :extend-via-metadata true
  (attached? [this el])
  (create-text-node [this text])
  (create-element [this tag-name options])      ; options may carry :ns (SVG)
  (set-style [this el k v])
  (remove-style [this el k])
  (add-class [this el cn])
  (remove-class [this el cn])
  (set-attribute [this el a v opt])             ; opt may carry :ns
  (remove-attribute [this el a])
  (set-event-handler [this el event handler opt])
  (remove-event-handler [this el event opt])
  (insert-before [this el child-node reference-node])
  (append-child [this el child-node])
  (remove-child [this el child-node])
  (on-transition-end [this el f])
  (replace-child [this el insert-child replace-child])
  (remove-all-children [this el])
  (get-child [this el idx])
  (next-frame [this f]))

(defprotocol IMemory
  :extend-via-metadata true
  (remember [this node memory])
  (recall [this node]))
```

The browser implementation of this protocol lives in
`src/replicant/dom.cljc` (the `reify` at lines 53–191). The `:rust` backend will
be a parallel `reify` calling `cljrs.dom`. `replicant.core` (the reconciliation
engine) only ever calls the protocol via its `r/` alias
(`[replicant.protocols :as r]`) and never touches the host DOM directly, so the
DOM surface area Replicant needs is exactly the protocol above.

## What `cljrs.dom` already provides (sufficient as-is)

Verified against the crate source (`crates/cljrs-dom/src/fns.rs`,
`events.rs`, `node.rs`):

| Replicant `IRender` method | `cljrs.dom` function | Notes |
|---|---|---|
| `create-element` (plain tag) | `create` | non-namespaced only |
| `create-text-node` | `create-text` | |
| `append-child` | `append!` | |
| `remove-child` | `remove!` | removes a node from its parent |
| `replace-child` | `replace!` | replaces old with new |
| `set-style` | `set-style!` | single property set |
| `add-class` / `remove-class` | `add-class!` / `remove-class!` | |
| `set-attribute` (plain) | `set-attr!` | non-namespaced only |
| `remove-attribute` (plain) | `remove-attr!` | non-namespaced only |
| `remove-all-children` | `set-text!` with `""` | sets textContent |
| `set-attribute` `"value"` | `set-value!` | form value property |
| `set-attribute` `"innerHTML"` | `set-html!` | |

These map cleanly and need no upstream change.

## Operations added upstream (all available as of cljrs 0.1.195)

Each item lists the `cljrs.dom` function, the `IRender`/`IMemory` method it
implements, and the exact call site in `src/replicant/dom.cljc` that consumes it.
All of these are now present in `cljrs.dom`; the signatures below match what
shipped.

### 1. `insert-before!` — **critical**

```clojure
(insert-before! parent child reference-node)   ; parent.insertBefore(child, reference)
```

- **Unblocks:** `IRender/insert-before` (`dom.cljc:160`).
- **Why critical:** keyed-child reordering during reconciliation is implemented
  by moving existing nodes to a new position with `insert-before`
  (`core.cljc` uses it together with `get-child` to relocate nodes —
  e.g. around `core.cljc:749`, `:774`, `:789`). Today only `append!` (end) and
  `prepend!` (start) exist, so arbitrary-position moves are impossible. Without
  this, the diffing algorithm cannot run.

### 2. `child-at` (and `child-count`) — **critical for performance**

```clojure
(child-at parent idx)     ; parent.childNodes[idx]
(child-count parent)      ; parent.childNodes.length   (optional but useful)
```

- **Unblocks:** `IRender/get-child` (`dom.cljc:180`).
- **Why:** `get-child` is called in the hot reconciliation loops (many call sites
  in `core.cljc`: `:699`, `:713`, `:747`, `:772`, `:882`, `:921`, `:934`, …). The
  only current accessor, `children`, returns a freshly-allocated vector of *all*
  children on every call — O(n) allocation per indexed access inside an O(n) loop,
  i.e. O(n²). An O(1) indexed accessor is needed.

### 3. `create-ns` — SVG element creation

```clojure
(create-ns ns tag)        ; document.createElementNS(ns, tag)
```

- **Unblocks:** `IRender/create-element` when `options` carries `:ns`
  (`dom.cljc:62-65`).
- **Why:** SVG (and MathML/foreignObject) require namespaced element creation.
  `create` is plain-HTML only.

### 4. `set-attr-ns!` / `remove-attr-ns!` — namespaced attributes

```clojure
(set-attr-ns! node ns name val)   ; element.setAttributeNS(ns, name, val)
(remove-attr-ns! node ns name)    ; element.removeAttributeNS(ns, name)
```

- **Unblocks:** `IRender/set-attribute` / `remove-attribute` when `opt` carries
  `:ns` (`dom.cljc:107-108`).
- **Why:** SVG attributes such as `xlink:href` are namespaced.

### 5. `remove-style!` — single-property style removal

```clojure
(remove-style! node prop)   ; element.style.removeProperty(prop)
```

- **Unblocks:** `IRender/remove-style` (`dom.cljc:71-73`).
- **Why:** `set-style!` exists but there is no way to remove one declared property
  during an update; clearing the whole `style` attribute is not equivalent.

### 6. Form DOM-*property* setters

```clojure
(set-checked! node bool)    ; element.checked  = bool
(set-selected! node bool)   ; element.selected = bool
;; (optional generic escape hatch)
(set-prop! node name v)
(get-prop node name)
```

- **Unblocks:** `IRender/set-attribute` and `remove-attribute` for the special
  cases at `dom.cljc:89-105` and `:119-135`.
- **Why:** Replicant deliberately distinguishes DOM *properties* from *attributes*
  for form controls — `value`, `checked`, `selected` are set as live properties
  (the attribute only seeds the default). Today only `set-value!` exists; `checked`
  and `selected` have no property setter. A generic `set-prop!`/`get-prop`
  would also future-proof other property/attribute mismatches.

### 7. Event-listener options + handle-based removal

```clojure
(listen! node event-type handler opts)   ; opts: {:capture .. :passive .. :once ..}
;; removal expressible per (node event opts), or listen! returns a handle
;; that unlisten! accepts:
(unlisten! node event-type opts)         ; or (unlisten! handle)
```

- **Unblocks:** `IRender/set-event-handler` / `remove-event-handler`
  (`dom.cljc:141-154`), which receive an `opt` map and must add/remove with the
  same options (capture phase in particular).
- **Resolved (0.1.195):** `listen!` accepts `{:capture :passive :once}` and
  returns a `DomListener` handle that stores the `capture` flag; `unlisten!`
  removes via that handle (`removeEventListener` with the matching capture flag),
  so capture-phase listeners remove correctly. The `:rust` backend stores the
  returned handle per `(node, event)` — analogous to how the browser impl stashes
  handlers in `replicantHandlers` (`dom.cljc:142-147`) — and passes it to
  `unlisten!` when re-binding.

### 8. `connected?` — attachment check

```clojure
(connected? node)   ; element.isConnected  -> boolean
```

- **Unblocks:** `IRender/attached?` (`dom.cljc:56-57`).
- **Why:** lifecycle/unmount handling checks whether a node is still in the
  document.

### 9. `request-animation-frame` (+ double-rAF helper)

```clojure
(request-animation-frame f)   ; window.requestAnimationFrame(f)
```

- **Unblocks:** `IRender/next-frame` (`dom.cljc:14-16, 183-184`).
- **Why:** Replicant batches re-renders and schedules post-render work on the next
  frame; its browser impl uses a *double* `requestAnimationFrame`
  (`on-next-frame`, `dom.cljc:14`). A single primitive is sufficient (Replicant
  can compose the double-rAF itself), but a ready-made double-rAF helper would be
  convenient.

### 10. `computed-style` — for transition durations

```clojure
(computed-style node prop)   ; getComputedStyle(node).getPropertyValue(prop)
```

- **Unblocks:** `IRender/on-transition-end` (`dom.cljc:18-46, 168-170`).
- **Why:** unmount transitions read `transition-duration` from the computed style
  to know how many `transitionend` events to await. The `transitionend`
  subscription itself can already be built from `listen!`; only the computed-style
  read is missing. A higher-level `on-transition-end`-style helper in cljrs.dom
  would be a nice-to-have but is not required.

### 11. Node memory (`IMemory`)

```clojure
(remember! node value)   ; associate arbitrary value with a node (WeakMap-like)
(recall node)            ; retrieve it (nil if absent)
```

- **Unblocks:** `IMemory/remember` and `recall` (`dom.cljc:48, 186-191`), plus the
  public `replicant.dom/recall` (`dom.cljc:50-51`).
- **Why:** Replicant stores per-node state (e.g. for `replicant.dom/recall` and
  internal bookkeeping) in a `js/WeakMap` keyed by the DOM node. The `:rust`
  backend needs an equivalent. Two acceptable shapes:
  - **(a)** cljrs.dom exposes `remember!`/`recall` backed by a host-side weak map
    keyed by node identity (preferred — mirrors the browser semantics and avoids
    leaks); **or**
  - **(b)** cljrs nodes are guaranteed identity-hashable/equal-by-identity so
    Replicant can keep a Clojure-side map itself. This is weaker (no weak
    references → potential retention), so (a) is preferred. Please confirm which
    guarantee cljrs provides.

## Toolchain: how Replicant actually gets into the browser

**Correction (see `doc/cljrs-port/STATUS.md`'s "cljrs-wasm browser
integration" section for the full account): there is no `cljrs wasm` CLI
subcommand, in 0.1.219 or any other released version checked.** An earlier
draft of this document claimed one landed in 0.1.194 packaging a cljrs
*library* plus an app entry point into a wasm-bindgen module; that turned out
not to exist -- `cljrs compile --target wasm` is real, but it's a separate,
much less mature AOT backend with no host-call/FFI mechanism of any kind
(confirmed: the emitted module's only imports are ~9-165 fixed internal `rt_*`
runtime primitives, nothing for calling into arbitrary host/browser APIs).

What was correct in the original (pre-correction) version of this paragraph:
`cljrs-wasm` compiles a tree-walking-interpreter **REPL** to
`wasm32-unknown-unknown` via `wasm-bindgen`/`wasm-pack`, and that -- not the
AOT compiler -- is the real path. `cljrs.dom` is a real, separate crate
(`cljrs-dom`, published alongside the rest of the 0.1.x release train) that
`cljrs-wasm` depends on and registers into the interpreter's globals before
any eval. The harness in `examples/cljrs-wasm/` drives this REPL directly:
it `eval`s Replicant's own `.cljc` source (concatenated, with cross-file
`:require`s rewritten to `alias` calls -- there's no filesystem in the
browser for `require` to resolve sibling files against) and then the
application/test code, all in the same interpreter session.

## Notes for the eventual Replicant `:rust` backend

(Context only — no Replicant changes are made until the above land.)

- The renderer is a new `#?(:rust ...)` `reify` of `IRender`/`IMemory` mirroring
  `dom.cljc:53-191`, calling the `cljrs.dom` functions above.
- cljrs.dom delivers events as Clojure maps (`:type`, `:target`, `:key`, …), so
  Replicant's event interop (`core.cljc:298` `(.-target e)`) becomes `(:target e)`
  under `:rust`.
- Replicant's native-array fast path (`hiccup_headers.cljc`, `vdom.cljc`) is gated
  on the cljs analyzer env and falls back to persistent vectors/maps for non-cljs
  targets, which a `:rust` target inherits automatically — so no native
  collection primitives are required from cljrs for correctness.
- The pure-data test oracle `mutation_log.cljc` needs no DOM and is the cheapest
  way to validate the port under the cljrs interpreter before wasm integration.
