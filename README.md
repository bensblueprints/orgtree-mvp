# 🌳 Orgtree

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**The desktop org chart builder you buy once and own forever.** Auto-layout tree, department color-coding, drill-down views, search, and CSV import/export — 100% local, zero subscription, zero cloud, zero telemetry.

Pingboard charges **$99/month** to draw boxes and lines. Orgtree is **$19 once**. Your reporting lines are not a subscription.

![Orgtree screenshot](docs/screenshot.png)

## ☕ Skip the setup — get the 1-click installer

Don't want to touch a terminal? Grab the packaged Windows installer (and support development):

**→ [Get Orgtree on Whop](https://whop.com/benjisaiempire/orgtree)** — pay once, own it forever.

## Features

- 🧑‍💼 **Add, edit, and delete people** — name, title, department, email, manager (dropdown of existing people). Deleting someone reassigns their direct reports up to their own manager instead of orphaning the team.
- 🌳 **Auto-layout tree, built from scratch** — a recursive layout engine (subtree widths computed bottom-up, children positioned left-to-right, connectors drawn) rendered on Canvas2D. No d3-hierarchy, no black box.
- 🖱️ **Collapsible branches** — click the +/− badge under any manager to fold their team away; state persists between sessions.
- 🎨 **Stable department color-coding** — every department gets a consistent color derived from its name, plus a legend sidebar.
- 🔎 **Views** — full tree, a department filter that prunes the chart down to a department and its reporting line, and single-branch drill-down (click "Drill down" on any node to make it the new root).
- 🔍 **Search** — type a name, hit Enter, and Orgtree expands the path to them, clears any filter hiding them, highlights the node, and smooth-scrolls it into view.
- 🖼️ **PNG export** — one click exports exactly what's on screen (current filter/drill-down included) as a PNG.
- 📄 **CSV import/export** — bulk-load a roster from `name, title, department, email, manager_name` (or `manager_id`) columns. Unresolved manager references are reported as errors, not silently dropped. Export writes the current roster back out the same way.
- 🛡️ **Cycle-safe** — a pure `detectCycles` pass catches broken manager chains (A reports to B reports to A) without ever hanging the app; affected people fall back to being chart roots instead of vanishing.
- 💾 **Your data is a JSON file** in your user folder — atomic writes, corrupt-file recovery.
- 🌑 Premium dark UI, keyboard-friendly, fast.

## Quick start

```bash
git clone https://github.com/bensblueprints/orgtree
cd orgtree
npm i
npm start
```

Run the tests (tree engine + CSV round-trip + store round-trip, all against real fixtures):

```bash
npm test
```

Build the Windows installer:

```bash
npm run dist
```

## Orgtree vs Pingboard

| | **Orgtree** | Pingboard |
|---|---|---|
| Price | **$19 once** | $99/mo (billed per team) |
| Cost after 1 year | **$19** | $1,188+ |
| Cost after 3 years | **$19** | $3,564+ |
| Your data lives | **On your machine** | Their cloud |
| Works offline | **Always** | No |
| Account required | **No** | Yes |
| Telemetry | **None** | Analytics SDKs |
| Department color-coding | **Yes** | Yes |
| Collapsible branches | **Yes** | Yes |
| CSV import/export | **Yes, with error reporting** | Limited |
| PNG export | **Yes, one click** | Paid tier only |
| Source code | **MIT, right here** | Closed |

## Tech stack

- **Electron** — main + preload (context-isolated, sandboxed) + plain HTML/CSS/JS renderer. No framework, no build step.
- **Pure tree engine** (`src/tree.js`) — `buildTree`, `detectCycles`, `depthOf`, `findPath`, `filterByDepartment`; zero dependencies, runs identically in the renderer and under Node for tests.
- **Pure CSV engine** (`src/csv.js`) — hand-rolled RFC4180-ish parser/serializer (quoted fields, embedded commas/quotes/newlines), manager-name resolution with ambiguity/unresolved-reference reporting.
- **Recursive layout engine** (`renderer/layout.js`) — bottom-up subtree-width computation and left-to-right child placement, rendered on a plain `<canvas>`. No d3-hierarchy.
- **JSON store** (`src/store.js`) — atomic writes, corrupt-file recovery, schema normalization. Data lives in Electron `userData` as `orgtree-data.json`.
- **electron-builder** — Windows NSIS one-click installer.

## Data & privacy

Everything stays on your machine. Orgtree makes **no network calls at all**. Your entire roster is one human-readable JSON file — export it, version it, back it up, own it.

## Known limitations / future items

- Drag-to-reparent in the tree view is not in this release — reassign a manager via the dropdown in the person editor instead.
- PDF export is not in this release — PNG export covers the "share a chart" use case for now.

## License

[MIT](LICENSE) © 2026 Ben (bensblueprints)
