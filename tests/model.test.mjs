import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createContext, runInContext } from "node:vm"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, "../Model.js"), "utf8").replace(/^\.pragma library\s*/, "")
const context = createContext({ Math, Number, String, isFinite, Infinity })
runInContext(source, context)
const { buildTape, signatureOf } = context

const monitor = { x: 0, width: 2560, scale: 2 }

function client(overrides) {
  overrides = overrides || {}
  return {
    activated: overrides.activated === true,
    lastIpcObject: Object.assign({
      at: [0, 38],
      size: [640, 750],
      floating: false,
      hidden: false,
      mapped: true,
      pinned: false,
      workspace: { id: 2 },
      focusHistoryID: 0,
      title: "window",
      class: "app"
    }, overrides.ipc || {})
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function closeTo(actual, expected, label) {
  assert(Math.abs(actual - expected) < 1e-9, label + ": " + actual + " != " + expected)
}

// Workspace 2 as observed on eDP-2 @ scale 2: one column parked left with a
// 16px peek, the focused column on screen.
const live = buildTape([
  client({ ipc: { at: [-1223, 38], size: [1239, 750], focusHistoryID: 1, title: "left" } }),
  client({ activated: true, ipc: { at: [30, 38], size: [1238, 750], focusHistoryID: 0, title: "right" } })
], 2, monitor)

assert(live.valid && live.count === 2, "live tape should have two columns")
assert(live.focusedIndex === 1, "activated window owns the focused column")
assert(live.columns[0].peeking === true && live.columns[0].onScreen === false, "left column peeks")
assert(live.columns[1].onScreen === true && live.columns[1].focused === true, "right column is on screen and focused")
closeTo(live.columns[0].position, 0, "left position")
closeTo(live.columns[0].length, 1239 / 2503, "left length")
closeTo(live.columns[1].position, 1253 / 2503, "right position")
closeTo(live.viewport.position, 1223 / 2503, "viewport position")
closeTo(live.viewport.length, 1280 / 2503, "viewport length")

// One column almost filling the logical screen, cold start (no activated flag).
const single = buildTape([
  client({ ipc: { at: [12, 38], size: [1256, 750], workspace: { id: 1 }, focusHistoryID: 3, title: "only" } })
], 1, monitor)

assert(single.count === 1 && single.focusedIndex === 0, "single column is focused via focusHistoryID")
assert(single.columns[0].onScreen === true, "single column is on screen")
closeTo(single.columns[0].position, 12 / 1280, "single position")
closeTo(single.columns[0].length, 1256 / 1280, "single length")
closeTo(single.viewport.length, 1, "single viewport fills the span")

// String workspace ids from a hand-built snapshot still match.
const coerced = buildTape([
  client({ ipc: { workspace: { id: "2" }, at: [30, 38], size: [400, 700] } })
], "2", monitor)
assert(coerced.count === 1, "workspace id is compared numerically")

// Floating, hidden, unmapped, and pinned windows are not columns.
const filtered = buildTape([
  client({ ipc: { floating: true, at: [10, 38], size: [400, 700], title: "float" } }),
  client({ ipc: { hidden: true, at: [500, 38], size: [400, 700], title: "hidden" } }),
  client({ ipc: { mapped: false, at: [900, 38], size: [400, 700], title: "unmapped" } }),
  client({ ipc: { pinned: true, at: [20, 38], size: [400, 700], title: "pinned" } }),
  client({ ipc: { at: [40, 38], size: [500, 700], workspace: { id: 9 }, title: "other workspace" } }),
  client({ ipc: { at: [30, 38], size: [600, 700], title: "real" } })
], 2, monitor)
assert(filtered.count === 1 && filtered.columns[0].windows === 1, "only the real tiled window remains")
assert(filtered.columns[0].titles[0] === "real", "kept the tiled window")

// Widths a pixel apart at the same x are one stacked column.
const stacked = buildTape([
  client({ ipc: { at: [100, 38], size: [500, 300], focusHistoryID: 1, title: "top" } }),
  client({ activated: true, ipc: { at: [101, 360], size: [501, 300], focusHistoryID: 0, title: "bottom" } })
], 2, monitor)
assert(stacked.count === 1 && stacked.columns[0].windows === 2, "stacked windows share a column")
assert(stacked.columns[0].focused === true, "activated stack member focuses the column")
assert(stacked.columns[0].titles.length === 2, "both titles are kept")

// A real neighbour, one gap away, stays its own column.
const neighbours = buildTape([
  client({ ipc: { at: [0, 38], size: [400, 700], title: "a" } }),
  client({ ipc: { at: [414, 38], size: [400, 700], focusHistoryID: 1, title: "b" } })
], 2, monitor)
assert(neighbours.count === 2, "columns a gap apart stay separate")

// Cold start: neither window is activated, so the lowest focusHistoryID wins.
const cold = buildTape([
  client({ ipc: { at: [-400, 38], size: [300, 700], focusHistoryID: 2, title: "older" } }),
  client({ ipc: { at: [20, 38], size: [300, 700], focusHistoryID: 0, title: "newest" } })
], 2, monitor)
assert(cold.focusedIndex === 1, "focusHistoryID 0 is the cold-start focus")

assert(signatureOf(live) === signatureOf(live), "signature is stable")
const refocused = buildTape([
  client({ activated: true, ipc: { at: [-1223, 38], size: [1239, 750], focusHistoryID: 0, title: "left" } }),
  client({ ipc: { at: [30, 38], size: [1238, 750], focusHistoryID: 1, title: "right" } })
], 2, monitor)
assert(signatureOf(live) !== signatureOf(refocused), "moving focus changes the signature")
assert(signatureOf({ valid: false }) === "invalid", "invalid tape has a fixed signature")

console.log("model.test.mjs: ok")
