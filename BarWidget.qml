import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Where you are on the tape, for Hyprland's scrolling layout.
//
// The layout is a one-dimensional strip of columns wider than the screen, so
// the bar can show the one thing the screen itself cannot: what sits outside
// the viewport. Two modes, toggled by clicking:
//
//   map   columns drawn to scale, with a bracket marking the visible slice.
//         Reads like a scrollbar -- shows how much is off each edge, and
//         which columns are wide (a full-width column is the whole strip).
//
//   pips  one dot per column, focused one filled. No proportions, just
//         position and count.
//
// Hidden entirely on workspaces that are not using the scrolling layout,
// where none of this means anything.
BarWidget {
  id: root
  moduleName: "io.github.jvaxx.scrolling-position"

  // ---- Settings ------------------------------------------------------------

  // A hand-edited shell.json can put anything in here, and a bar widget that
  // throws takes a chunk of the bar down with it, so every value is coerced
  // back to something drawable rather than trusted.
  function numberSetting(name, fallback) {
    var value = Number(setting(name, fallback))
    return isFinite(value) ? value : fallback
  }

  readonly property string mode: String(setting("mode", "map")) === "pips" ? "pips" : "map"
  readonly property int mapLength: Math.max(Style.space(40), Style.space(numberSetting("mapLength", 110)))
  readonly property int pollInterval: Math.max(0, numberSetting("pollInterval", 600))
  readonly property bool hideWhenSingleColumn: setting("hideWhenSingleColumn", false) === true

  // ---- Data ----------------------------------------------------------------

  // lastIpcObject is explicitly not live, so the tape is rebuilt on demand
  // rather than bound: refresh the IPC snapshot, let it land, recompute.
  property var tape: ({ columns: [], count: 0, focusedIndex: -1, viewport: null, valid: false })
  property string tapeSignature: "invalid"

  // Per-monitor, not per-focus: a bar exists on every screen, and the one on
  // your second monitor has to describe that monitor's tape even while the
  // focus (and Hyprland.focusedMonitor with it) is on the first.
  readonly property var barScreen: root.QsWindow.window ? root.QsWindow.window.screen : null
  readonly property var monitor: barScreen ? Hyprland.monitorFor(barScreen) : Hyprland.focusedMonitor
  readonly property var workspace: monitor ? monitor.activeWorkspace : null

  readonly property bool scrollingLayout: workspace
    && workspace.lastIpcObject
    && String(workspace.lastIpcObject.tiledLayout) === "scrolling"

  readonly property bool hasContent: tape.valid
    && tape.count > 0
    && !(hideWhenSingleColumn && tape.count < 2)

  function recompute() {
    var next = monitor && workspace
      ? Model.buildTape(Hyprland.toplevels.values, workspace.id, monitor)
      : { columns: [], count: 0, focusedIndex: -1, viewport: null, valid: false }

    // Assigning is what triggers the repaint, so an unchanged tape is dropped:
    // the heartbeat exists to catch the rare silent change, not to redraw a
    // static strip twice a second.
    var signature = Model.signatureOf(next)
    if (signature === tapeSignature) return

    tapeSignature = signature
    tape = next
  }

  function refresh() {
    Hyprland.refreshWorkspaces()
    Hyprland.refreshToplevels()
    settle.restart()
  }

  function cycleMode() {
    var entry = { id: root.moduleName }
    for (var key in root.settings) if (key !== "id") entry[key] = root.settings[key]
    entry.mode = root.mode === "map" ? "pips" : "map"

    // Applied locally first so the click repaints immediately; the write comes
    // back through the bar as the same value. Same contract omarchy.clock uses
    // for its format ring, so the mode survives a restart.
    root.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  // Any Hyprland event may have moved the tape. The burst re-reads three times
  // over ~400ms because hyprctl reports geometry the instant a dispatch lands,
  // but a consume/expel settles across several frames.
  Connections {
    target: Hyprland

    function onRawEvent(event) { burst.restart() }
  }

  Timer {
    id: burst
    interval: 30
    repeat: true
    triggeredOnStart: true
    property int ticks: 0
    onRunningChanged: if (running) ticks = 0
    onTriggered: {
      root.refresh()
      ticks++
      interval = ticks < 2 ? 120 : 260
      if (ticks >= 3) stop()
    }
  }

  // Scrolling that changes no focus and maps no window (a column resize, a
  // plain tape scroll) emits nothing to hook, hence the heartbeat. It keeps
  // ticking while hidden, at a quarter of the rate: SUPER+ALT+L flips the
  // layout through `hyprctl keyword`, which is not guaranteed to surface as
  // an event either, and the widget still has to notice it came back.
  Timer {
    id: heartbeat
    interval: root.visible
      ? Math.max(120, root.pollInterval)
      : Math.max(480, root.pollInterval * 4)
    repeat: true
    running: root.pollInterval > 0
    onTriggered: root.refresh()
  }

  // One frame's grace for the IPC reply to populate lastIpcObject.
  Timer {
    id: settle
    interval: 60
    onTriggered: root.recompute()
  }

  // Hyprland emits nothing at all for a layout geometry change -- verified on
  // socket2: `layoutmsg colresize` moves every column on the tape and reports
  // no event, unlike focus moves which emit activewindowv2. So the actions
  // that reshape without refocusing have to announce themselves:
  //
  //   omarchy-shell -q io.github.jvaxx.scrolling-position refresh
  //
  // Add that line to a bind's script and this widget updates on the dispatch
  // instead of on the next heartbeat. With every such bind wired up,
  // `pollInterval: 0` makes the widget purely event-driven.
  IpcHandler {
    target: "io.github.jvaxx.scrolling-position"

    function refresh(): void { root.broadcast("refresh") }
  }

  Component.onCompleted: refresh()
  onVisibleChanged: if (visible) refresh()

  // ---- Geometry ------------------------------------------------------------

  readonly property int thickness: Style.space(5)
  readonly property int gap: Style.space(2)
  readonly property int pipSize: Style.space(5)
  readonly property int focusedPipLength: Style.space(14)
  readonly property int bracketOffset: Style.space(5)

  readonly property int axisLength: mode === "map"
    ? mapLength
    : Math.max(pipSize, tape.count * pipSize + Math.max(0, tape.count - 1) * gap
        + (tape.focusedIndex >= 0 ? focusedPipLength - pipSize : 0))

  readonly property color markColor: bar ? bar.barForeground : Color.foreground

  visible: scrollingLayout && hasContent
  implicitWidth: visible ? (vertical ? barSize : axisLength + Style.space(10)) : 0
  implicitHeight: visible ? (vertical ? axisLength + Style.space(10) : barSize) : 0

  Behavior on implicitWidth { enabled: !root.vertical; NumberAnimation { duration: 140; easing.type: Easing.OutCubic } }
  Behavior on implicitHeight { enabled: root.vertical; NumberAnimation { duration: 140; easing.type: Easing.OutCubic } }

  Item {
    id: canvas
    anchors.centerIn: parent
    width: root.vertical ? root.thickness + root.bracketOffset * 2 : root.axisLength
    height: root.vertical ? root.axisLength : root.thickness + root.bracketOffset * 2
    opacity: pointer.containsMouse ? 1 : 0.92

    Behavior on opacity { NumberAnimation { duration: 120 } }

    // ---- Map mode: columns to scale ----------------------------------------

    Repeater {
      model: root.mode === "map" ? root.tape.columns : []

      Rectangle {
        required property var modelData

        readonly property real span: root.axisLength
        readonly property real extent: Math.max(Style.space(2), modelData.length * span - root.gap)
        readonly property real offset: modelData.position * span

        x: root.vertical ? (canvas.width - width) / 2 - root.bracketOffset / 2 : offset
        y: root.vertical ? offset : (canvas.height - height) / 2 - root.bracketOffset / 2
        width: root.vertical ? root.thickness : extent
        height: root.vertical ? extent : root.thickness
        radius: Math.min(width, height) / 2
        color: root.markColor
        opacity: modelData.focused ? 1 : (modelData.onScreen ? 0.5 : (modelData.peeking ? 0.35 : 0.22))

        Behavior on x { NumberAnimation { duration: 130; easing.type: Easing.OutCubic } }
        Behavior on y { NumberAnimation { duration: 130; easing.type: Easing.OutCubic } }
        Behavior on width { NumberAnimation { duration: 130; easing.type: Easing.OutCubic } }
        Behavior on height { NumberAnimation { duration: 130; easing.type: Easing.OutCubic } }
        Behavior on opacity { NumberAnimation { duration: 130 } }
      }
    }

    // ---- Map mode: the visible slice ---------------------------------------

    Rectangle {
      id: bracket
      visible: root.mode === "map" && root.tape.viewport !== null

      readonly property var viewport: root.tape.viewport
      readonly property real span: root.axisLength
      readonly property real extent: viewport ? Math.max(Style.space(2), viewport.length * span) : 0
      readonly property real offset: viewport ? viewport.position * span : 0

      x: root.vertical ? (canvas.width + root.thickness) / 2 + root.gap : offset
      y: root.vertical ? offset : (canvas.height + root.thickness) / 2 + root.gap
      width: root.vertical ? Style.space(2) : extent
      height: root.vertical ? extent : Style.space(2)
      radius: Style.space(1)
      color: root.markColor
      opacity: 0.4

      Behavior on x { NumberAnimation { duration: 130; easing.type: Easing.OutCubic } }
      Behavior on y { NumberAnimation { duration: 130; easing.type: Easing.OutCubic } }
      Behavior on width { NumberAnimation { duration: 130; easing.type: Easing.OutCubic } }
      Behavior on height { NumberAnimation { duration: 130; easing.type: Easing.OutCubic } }
    }

    // ---- Pips mode ---------------------------------------------------------

    Row {
      visible: root.mode === "pips" && !root.vertical
      anchors.centerIn: parent
      spacing: root.gap

      Repeater {
        model: root.mode === "pips" && !root.vertical ? root.tape.columns : []

        Rectangle {
          required property var modelData

          width: modelData.focused ? root.focusedPipLength : root.pipSize
          height: root.pipSize
          radius: height / 2
          color: root.markColor
          opacity: modelData.focused ? 1 : (modelData.onScreen ? 0.5 : 0.28)

          Behavior on width { NumberAnimation { duration: 140; easing.type: Easing.OutCubic } }
          Behavior on opacity { NumberAnimation { duration: 140 } }
        }
      }
    }

    Column {
      visible: root.mode === "pips" && root.vertical
      anchors.centerIn: parent
      spacing: root.gap

      Repeater {
        model: root.mode === "pips" && root.vertical ? root.tape.columns : []

        Rectangle {
          required property var modelData

          width: root.pipSize
          height: modelData.focused ? root.focusedPipLength : root.pipSize
          radius: width / 2
          color: root.markColor
          opacity: modelData.focused ? 1 : (modelData.onScreen ? 0.5 : 0.28)

          Behavior on height { NumberAnimation { duration: 140; easing.type: Easing.OutCubic } }
          Behavior on opacity { NumberAnimation { duration: 140 } }
        }
      }
    }
  }

  MouseArea {
    id: pointer
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onClicked: root.cycleMode()
    onEntered: if (root.bar) root.bar.showTooltip(root, Model.tooltipFor(root.tape) + "  \u00b7  click to switch view")
    onExited: if (root.bar) root.bar.hideTooltip(root)
  }
}
