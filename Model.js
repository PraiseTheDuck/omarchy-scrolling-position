.pragma library

// Rebuilds the scrolling layout's "tape" from Hyprland's client geometry.
//
// The native scrolling layout keeps off-screen columns in `hyprctl clients`
// with their real coordinates -- a column parked to the left of the viewport
// reports a negative x, one parked to the right reports an x past the monitor
// width. So the whole tape, not just the visible slice, is reconstructible
// from geometry alone; nothing else needs to be tracked.
//
// Windows stacked in one column (consume_or_expel) share an identical x/width
// pair, which is what groups them here: a column is a distinct x:width, not a
// distinct window.

// Fraction of a column that has to be inside the viewport before it counts as
// "on screen" rather than "peeking". Only drives opacity, never layout.
var VISIBLE_FRACTION = 0.35

function columnsFor(toplevels, workspaceId) {
  var buckets = {}
  var order = []

  for (var i = 0; i < toplevels.length; i++) {
    var toplevel = toplevels[i]
    if (!toplevel) continue

    var ipc = toplevel.lastIpcObject
    if (!ipc || !ipc.at || !ipc.size) continue
    if (ipc.floating === true) continue
    if (!ipc.workspace || ipc.workspace.id !== workspaceId) continue

    var x = Math.round(ipc.at[0])
    var width = Math.round(ipc.size[0])
    if (width <= 0) continue

    var key = x + ":" + width
    if (!buckets[key]) {
      buckets[key] = { x: x, width: width, windows: 0, focused: false, recency: Infinity, titles: [] }
      order.push(key)
    }

    var column = buckets[key]
    column.windows++
    column.titles.push(String(ipc.title || ipc.class || ""))

    // Two ways to find the focused column, because neither is sufficient alone.
    //
    // `activated` is a live Quickshell property, so it beats the geometry
    // snapshot by a frame -- but Quickshell only learns the active window from
    // an activewindowv2 event and never seeds it at startup, so it is false
    // for every toplevel until the first focus change after a shell restart.
    //
    // focusHistoryID comes from the same snapshot as the geometry and is
    // always populated (0 = most recently focused), so it carries the cold
    // start. Lowest id on the workspace wins.
    if (toplevel.activated === true) column.focused = true

    var recency = Number(ipc.focusHistoryID)
    if (isFinite(recency)) column.recency = Math.min(column.recency, recency)
  }

  var columns = []
  for (var j = 0; j < order.length; j++) columns.push(buckets[order[j]])
  columns.sort(function(left, right) { return left.x - right.x })
  return columns
}

function viewportFor(monitor) {
  if (!monitor) return null

  // Monitor width is in physical pixels while window coordinates are logical,
  // hence the divide by scale: 3840 @1.6 is a 2400-wide viewport.
  var scale = monitor.scale > 0 ? monitor.scale : 1
  var start = monitor.x
  var length = monitor.width / scale
  if (!(length > 0)) return null

  return { start: start, end: start + length, length: length }
}

function overlap(column, viewport) {
  var left = Math.max(column.x, viewport.start)
  var right = Math.min(column.x + column.width, viewport.end)
  return Math.max(0, right - left)
}

// Returns everything the widget draws, in normalized 0..1 tape coordinates so
// the QML side only ever multiplies by its own pixel length.
function buildTape(toplevels, workspaceId, monitor) {
  var empty = { columns: [], count: 0, focusedIndex: -1, viewport: null, valid: false }

  var viewport = viewportFor(monitor)
  if (!viewport) return empty

  var columns = columnsFor(toplevels, workspaceId)
  if (columns.length === 0) return empty

  // The span is the union of the tape and the viewport: when a single narrow
  // column sits alone on screen the viewport is the wider of the two, and
  // clipping the bracket to the tape would hide that there is empty space.
  var spanStart = Math.min(columns[0].x, viewport.start)
  var spanEnd = Math.max(columns[columns.length - 1].x + columns[columns.length - 1].width, viewport.end)
  var span = spanEnd - spanStart
  if (!(span > 0)) return empty

  var focusedIndex = -1
  var mostRecent = -1

  for (var f = 0; f < columns.length; f++) {
    if (columns[f].focused) focusedIndex = f
    if (mostRecent === -1 || columns[f].recency < columns[mostRecent].recency) mostRecent = f
  }

  if (focusedIndex === -1) focusedIndex = mostRecent

  var segments = []

  for (var i = 0; i < columns.length; i++) {
    var column = columns[i]
    var visible = overlap(column, viewport)

    segments.push({
      index: i,
      position: (column.x - spanStart) / span,
      length: column.width / span,
      focused: i === focusedIndex,
      onScreen: visible >= column.width * VISIBLE_FRACTION,
      peeking: visible > 0 && visible < column.width * VISIBLE_FRACTION,
      windows: column.windows,
      titles: column.titles
    })
  }

  return {
    columns: segments,
    count: segments.length,
    focusedIndex: focusedIndex,
    viewport: {
      position: (viewport.start - spanStart) / span,
      length: viewport.length / span
    },
    valid: true
  }
}

// Cheap identity for a tape, so a rebuild that found nothing new can be
// dropped instead of reassigned: every assignment is a new JS object, which
// re-evaluates every binding and repaints every segment. At heartbeat rates
// that is a repaint per tick of a widget that has not changed.
function signatureOf(tape) {
  if (!tape.valid) return "invalid"

  var parts = [tape.focusedIndex]
  for (var i = 0; i < tape.columns.length; i++) {
    var column = tape.columns[i]
    parts.push(column.position.toFixed(4) + "," + column.length.toFixed(4)
      + (column.onScreen ? "v" : (column.peeking ? "p" : "h"))
      + column.windows)
  }
  if (tape.viewport) parts.push(tape.viewport.position.toFixed(4) + "," + tape.viewport.length.toFixed(4))
  return parts.join("|")
}

function tooltipFor(tape) {
  if (!tape.valid) return ""

  var position = tape.focusedIndex >= 0 ? (tape.focusedIndex + 1) : "?"
  var label = "Column " + position + " of " + tape.count
  if (tape.focusedIndex < 0) return label

  var titles = tape.columns[tape.focusedIndex].titles
  if (titles.length > 1) label += " \u2014 " + titles.length + " windows"
  return label
}
