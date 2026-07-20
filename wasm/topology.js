// SPDX-License-Identifier: GPL-2.0-or-later
//
// Turn a <pre> block describing a topology into an interactive spanning-tree
// simulation, powered by the MSTPD WebAssembly core. Write your topologies
// inside <pre class="mstp-topology"> blocks, and they are replaced in place by
// a live, clickable diagram.
//
//   <link rel="stylesheet" href="topology.css" />
//   <script type="module" src="dist/mstpd.mjs"></script>
//   <script type="module" src="topology.js"></script>
//
// Grammar (one statement per line; # or // starts a comment):
//
//   NAME @X,Y [prio=N] [proto=stp|rstp|mstp|none] [icon=C]  # a bridge at grid cell X,Y
//   A -- B [cost=N] [down] [A:flag ...]                # a link between two bridges
//   A -> B [cost=N] [A:flag ...]                       # a one-way link (A transmits, B receives)
//   # global options
//   :protocol rstp|stp|mstp|none
//   :forward-delay N
//   :max-age N
//   :max-hops N
//   :tx-hold N
//
// Endpoint flags: edge, no-auto-edge, network, bpdu-guard, root-guard, no-p2p
//
// proto=none turns the spanning tree off on a bridge: it sends no BPDUs, drops
// the ones it receives, and its ports have no role or state.
//
// A regular link with an #mstp: anchor puts the nearest topology above in a
// given state, e.g. <a href="#mstp:B--C,30">: see "control links" below.
//
// The MSTPD core is loaded via its own <script> tag (above), which publishes
// window.mstpd; this module picks loadMSTPD off it rather than importing. We
// could instead import it:
//
// import { loadMSTPD } from "./dist/mstpd.mjs";

const loadMSTPD = window.mstpd.loadMSTPD;
const SVGNS = "http://www.w3.org/2000/svg";
const UNIT = 110; // grid cell -> px
const NODE_RADIUS = 24; // node radius in px
const NO_STP_RADIUS = 16; // half the side of a bridge that runs no protocol
const PORT_MARKER_OFFSET = NODE_RADIUS + 9; // how far from a node's centre its port marker sits
const PAD = NODE_RADIUS + 24; // viewBox margin around the nodes
const PARALLEL_GAP = 16; // px between parallel links joining the same pair
const SLOW_FACTOR = 3; // how much the snail stretches each simulated second
const FLIGHT_MS = 500; // how long a BPDU takes to cross a link
const PILL_GAP = 90; // how far apart BPDUs leaving the same port at once set off
const MAX_WAVES = 50; // give up on a cascade that never settles
const QUIET_TIME = 4; // seconds without a port change before we call it converged

// Port/link state -> colour
const STATE_COLOR = {
  forwarding: "#2a7",
  learning: "#d90",
  listening: "#d90",
  blocking: "#e55",
  discarding: "#e55",
};
const colorFor = (s) => STATE_COLOR[s] || "#888";

// BPDU type -> colour, for the pills that animate along the links while
// running. A transmitted BPDU is sorted into exactly one of the base buckets.
// tc is not a base type but the ring drawn around any pill whose frame also
// carries a topology change (the TC flag, or a legacy TCN BPDU).
const BPDU_COLOR = {
  hello: "#3b82f6", // a plain periodic BPDU
  proposal: "#f59e0b", // RST BPDU carrying the proposal flag
  agreement: "#22c55e", // RST BPDU carrying the agreement flag
  tc: "#ef4444", // ring: the frame also carries a topology change
};

// -- grammar --------------------------------------------------------

function parseOpts(s) {
  const o = {};
  for (const tok of (s || "").trim().split(/\s+/)) {
    if (!tok) continue;
    const eq = tok.indexOf("=");
    if (eq >= 0) o[tok.slice(0, eq).toLowerCase()] = tok.slice(eq + 1);
    else o[tok.toLowerCase()] = true;
  }
  return o;
}

// Endpoint flag -> the addPort() options it sets. A network port is switch
// facing, so auto-edge has no business turning it into an edge.
const PORT_FLAGS = {
  edge: { edge: true },
  "no-auto-edge": { autoEdge: false },
  network: { network: true, autoEdge: false },
  "bpdu-guard": { bpduGuard: true },
  "root-guard": { restrictedRole: true },
  "no-p2p": { p2p: false },
};

function parseTopology(text) {
  const nodes = [];
  const links = [];
  const errors = [];
  const directives = { protocol: "rstp" };
  const seen = new Set();

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw
      .replace(/#.*$/, "")
      .replace(/\/\/.*$/, "")
      .trim();
    if (!line) return;
    const ln = i + 1;

    // Global options
    if (line[0] === ":") {
      const [key, ...rest] = line.slice(1).split(/\s+/);
      const val = rest.join(" ");
      switch (key.toLowerCase()) {
        case "protocol":
          directives.protocol = val.toLowerCase();
          break;
        case "forward-delay":
          directives.forwardDelay = +val;
          break;
        case "max-age":
          directives.maxAge = +val;
          break;
        case "max-hops":
          directives.maxHops = +val;
          break;
        case "tx-hold":
          directives.txHoldCount = +val;
          break;
        default:
          errors.push(`line ${ln}: unknown directive :${key}`);
      }
      return;
    }

    // Links
    let m;
    if ((m = line.match(/^(\S+)\s*(--|->)\s*(\S+)\s*(.*)$/))) {
      const [a, op, b] = [m[1], m[2], m[3]];
      const link = {
        a,
        b,
        oneway: op === "->",
        cost: undefined,
        down: false,
        aOpts: {},
        bOpts: {},
        line: ln,
      };
      for (const tok of m[4].trim().split(/\s+/)) {
        if (!tok) continue;
        const eq = tok.indexOf("=");
        const key = (eq >= 0 ? tok.slice(0, eq) : tok).toLowerCase();
        const val = eq >= 0 ? tok.slice(eq + 1) : true;
        const colon = key.indexOf(":");
        if (colon >= 0) {
          const who = key.slice(0, colon);
          const flag = key.slice(colon + 1);
          const target =
            who === a.toLowerCase()
              ? link.aOpts
              : who === b.toLowerCase()
                ? link.bOpts
                : null;
          if (!target) errors.push(`line ${ln}: ${who} is not an endpoint`);
          else if (!PORT_FLAGS[flag])
            errors.push(`line ${ln}: unknown port flag ${flag}`);
          else Object.assign(target, PORT_FLAGS[flag]);
        } else if (key === "cost") {
          link.cost = +val;
        } else if (key === "down") {
          link.down = true;
        } else {
          errors.push(`line ${ln}: unknown link option ${key}`);
        }
      }
      links.push(link);
      return;
    }

    // Nodes
    if ((m = line.match(/^(\S+)\s+@\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*(.*)$/))) {
      const name = m[1];
      if (seen.has(name)) {
        errors.push(`line ${ln}: duplicate node ${name}`);
        return;
      }
      seen.add(name);
      const opts = parseOpts(m[4]);
      nodes.push({
        name,
        x: +m[2],
        y: +m[3],
        prio: opts.prio != null ? +opts.prio : undefined,
        proto:
          typeof opts.proto === "string" ? opts.proto.toLowerCase() : undefined,
        icon: typeof opts.icon === "string" ? opts.icon : undefined,
        line: ln,
      });
      return;
    }

    errors.push(`line ${ln}: cannot parse "${line}"`);
  });

  for (const l of links) {
    if (!seen.has(l.a)) errors.push(`line ${l.line}: unknown node ${l.a}`);
    if (!seen.has(l.b)) errors.push(`line ${l.line}: unknown node ${l.b}`);
  }

  return {
    directives,
    nodes,
    links: links.filter((l) => seen.has(l.a) && seen.has(l.b)),
    errors,
  };
}

// -- DOM helpers ----------------------------------------------------

function svgEl(name, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

function h(tag, opts = {}, ...kids) {
  const e = document.createElement(tag);
  if (opts.class) e.className = opts.class;
  if (opts.text != null) e.textContent = opts.text;
  if (opts.html != null) e.innerHTML = opts.html;
  if (opts.title) e.title = opts.title;
  if (opts.onclick) e.onclick = opts.onclick;
  for (const k of kids) if (k) e.appendChild(k);
  return e;
}

// The trailing space lives inside, so it goes away with the icon.
const icon = (e) => `<i class="mstp-icon">${e} </i>`;

// Same as icon() but without the trailing space, for icon-only buttons.
const squareIcon = (e) => `<i class="mstp-icon">${e}</i>`;

// Hello time is left out: the core only accepts 2 seconds.
const timersOf = (d) => ({
  forwardDelay: d.forwardDelay,
  maxAge: d.maxAge,
  maxHops: d.maxHops,
  txHoldCount: d.txHoldCount,
});

// Widgets render inside a shadow root to ensure host page's CSS does not impact
// it.
let widgetSheet;
function widgetStyleSheet() {
  if (widgetSheet) return widgetSheet;
  widgetSheet = new CSSStyleSheet();
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = [...sheet.cssRules];
    } catch {
      continue; // cross-origin sheet we're not allowed to read
    }
    if (rules.some((r) => r.cssText.includes(".mstp-topo"))) {
      widgetSheet.replaceSync(rules.map((r) => r.cssText).join("\n"));
      break;
    }
  }
  return widgetSheet;
}

// -- single widget --------------------------------------------------

async function mount(el) {
  if (el.dataset.mstpMounted) return;
  el.dataset.mstpMounted = "1";

  // A <div> wrapper holds its definition in a nested <pre><code> block.
  const code = el.querySelector(":scope > pre > code");
  const source = (code || el).textContent;
  const model = parseTopology(source);

  const root = h("div", { class: "mstp-topo" });
  const bar = h("div", { class: "mstp-bar" });
  const runBtn = h("button", {
    class: "mstp-btn mstp-toggle",
    html: `<span>${icon("▶️")}Start</span><span>${icon("⏹️")}Stop</span>`,
  });
  const backBtn = h("button", {
    class: "mstp-btn",
    html: `${icon("⏮️")}Back`,
  });
  const stepBtn = h("button", {
    class: "mstp-btn",
    html: `${icon("⏭️")}Step`,
  });
  const resetBtn = h("button", {
    class: "mstp-btn",
    html: `${icon("🔄")}Reset`,
  });
  const editBtn = h("button", {
    class: "mstp-btn",
    html: `${icon("✏️")}Edit`,
  });
  const saveBtn = h("button", {
    class: "mstp-btn mstp-accent",
    html: `${icon("💾")}Save`,
  });
  const discardBtn = h("button", {
    class: "mstp-btn",
    html: `${icon("🗑️")}Discard`,
  });
  const detachBtn = h("button", { class: "mstp-btn mstp-detach" });
  runBtn.disabled =
    backBtn.disabled =
    stepBtn.disabled =
    resetBtn.disabled =
      true;
  saveBtn.hidden = discardBtn.hidden = true;
  const clockTime = h("span", { text: "t=0s" });
  const clockBpdu = h("span", { text: "0 BPDUs" });
  const clockConv = h("span", { class: "mstp-clock-c" });
  const clock = h(
    "span",
    { class: "mstp-clock" },
    h("span", { class: "mstp-clock-t" }, clockTime),
    h("span", { class: "mstp-clock-b" }, clockBpdu),
    clockConv,
  );
  const slowBox = document.createElement("input");
  slowBox.type = "checkbox";
  const slow = h(
    "label",
    {
      class: "mstp-slow",
      title: "Slow motion — stretch each second so BPDUs are easier to follow",
    },
    slowBox,
    h("span", { text: "🐌" }),
  );
  bar.append(
    runBtn,
    backBtn,
    stepBtn,
    resetBtn,
    editBtn,
    saveBtn,
    discardBtn,
    clock,
    slow,
    detachBtn,
  );

  const stage = h("div", { class: "mstp-stage" });
  const svg = svgEl("svg", { preserveAspectRatio: "xMidYMid meet" });
  const canvas = h("div", { class: "mstp-canvas" }, svg);
  const panel = h("div", { class: "mstp-panel" });
  const panelBody = h("div", { class: "mstp-panel-body" });
  panel.appendChild(panelBody);
  const legend = h("div", { class: "mstp-legend" });
  stage.append(canvas, panel, legend);

  // The editor replaces the stage and legend while editing the definition.
  const textarea = h("textarea", { class: "mstp-edit-area" });
  textarea.spellcheck = false;
  textarea.setAttribute("aria-label", "Topology definition");
  const editor = h("div", { class: "mstp-editor" }, textarea);
  editor.hidden = true;

  const errBox = h("div", { class: "mstp-errors" });
  errBox.hidden = true;

  root.append(bar, stage, editor, errBox);

  const host = h("div", { class: "mstp-host" });
  const shadow = host.attachShadow({ mode: "open" });
  shadow.adoptedStyleSheets = [widgetStyleSheet()];
  shadow.append(root);
  el.replaceWith(host);

  const w = {
    model,
    source,
    root,
    host,
    bar,
    detachBtn,
    svg,
    panel: panelBody,
    stage,
    legend,
    editor,
    textarea,
    errBox,
    runBtn,
    backBtn,
    stepBtn,
    resetBtn,
    editBtn,
    saveBtn,
    discardBtn,
    clockTime,
    clockBpdu,
    clockConv,
    slow,
    speed: 1, // real seconds per simulated second (snail bumps it to SLOW_FACTOR)
    mstp: null,
    nodes: [],
    links: [],
    selected: null,
    flagsOpen: new Set(), // ports whose flag/state details are unfolded, by name
    editing: false,
    timerError: false, // the core refused the timers
    time: 0,
    // Convergence: the ports are settled once none of them changes role or
    // state any more. sig is the fingerprint we compare from second to second,
    // actionAt the time of the last cut or restore, changeAt the time of the
    // last change, and settledAt the changeAt of the last quiet second (null
    // while the ports are still moving).
    sig: "",
    actionAt: 0,
    changeAt: 0,
    settledAt: null,
    bpdus: 0, // BPDUs that have set off since the build
    running: false, // the Start/Stop state
    stepping: false, // a single step is playing, and the loop stops at its end
    raf: null, // animation-loop handle
    clock: 0, // clock in ms (see animate)
    last: 0, // timestamp of the previous frame
    nextAt: 0, // clock time of the next step
    lastClick: { link: null, t: 0 }, // manual double-click detection
    flights: [], // pills flying along the links
    wave: null, // the BPDUs on the wire, and when the last of them lands
    lastSeq: 0, // the newest BPDU already turned into a pill
    // Step back: every op applied since the build (a simulated second, a wave
    // delivery, a link cut or restore) goes into history. The cursor is how
    // many of them the sim currently shows; it falls behind history.length
    // after a step back, and stepping or running moves it forward again.
    history: [],
    cursor: 0,
  };

  widgets.set(host, w);
  applyViewBox(w);
  buildLegend(w);
  showErrors(w);

  svg.addEventListener("pointerdown", (ev) => {
    if (w.mstp && ev.target === svg) select(w, null);
  });
  runBtn.onclick = () => (w.running ? stopRunning(w) : setRunning(w, true));
  backBtn.onclick = () => stepBack(w);
  stepBtn.onclick = () => stepOnce(w);
  resetBtn.onclick = () => {
    setRunning(w, false);
    build(w);
    select(w, null);
  };
  editBtn.onclick = () => enterEdit(w);
  saveBtn.onclick = () => saveEdit(w);
  discardBtn.onclick = () => exitEdit(w);
  detachBtn.onclick = () =>
    setDetached(w, !w.root.classList.contains("mstp-detached"));
  bar.addEventListener("pointerdown", (ev) => startDrag(w, ev));
  root.addEventListener("pointerdown", (ev) => startResize(w, ev), true);
  root.addEventListener("pointermove", (ev) => updateResizeCursor(w, ev));
  setDetached(w, false);
  slowBox.onchange = () => {
    w.speed = slowBox.checked ? SLOW_FACTOR : 1;
  };

  try {
    w.mstp = await loadMSTPD({
      print: () => {},
      printErr: () => {},
    });
    build(w);
    select(w, null);
    w.runBtn.disabled = w.stepBtn.disabled = w.resetBtn.disabled = false;
  } catch (e) {
    panelBody.textContent = "Failed to load simulation: " + e;
    console.error(e);
    build(w);
  }
  return w;
}

// -- detach ---------------------------------------------------------

// Only one widget floats in the corner at a time.
let detachedWidget = null;

// Detach a widget to a sticky floating widget in the top-right corner, or put it
// back where it belongs. While detached, the host keeps its measured height so
// the space in the page stays the same. Detaching one widget re-attaches any
// other one already floating.
function setDetached(w, on) {
  if (on) {
    if (detachedWidget && detachedWidget !== w)
      setDetached(detachedWidget, false);
    w.host.style.height = `${w.host.getBoundingClientRect().height}px`;
    w.host.classList.add("mstp-vacated");
    w.root.classList.add("mstp-detached");
    // Open past the 40em stacking breakpoint so the panel sits on the side. The
    // breakpoint measures the content box, so clear the two 1px borders plus a
    // pixel.
    w.root.style.width = "calc(40em + 3px)";
    w.detachBtn.innerHTML = squareIcon("✖️");
    w.detachBtn.title = "Put the widget back";
    detachedWidget = w;
  } else {
    w.root.classList.remove("mstp-detached");
    w.host.classList.remove("mstp-vacated");
    w.host.style.height = "";
    // Drop any dragged position and resized size so a later detach starts back
    // in the corner at its natural size.
    w.root.style.left = w.root.style.top = w.root.style.right = "";
    w.root.style.width = w.root.style.height = w.root.style.cursor = "";
    w.detachBtn.innerHTML = squareIcon("📌");
    w.detachBtn.title = "Detach to a floating corner";
    if (detachedWidget === w) detachedWidget = null;
  }
}

// Reattach the widget if the window is resized.
window.addEventListener("resize", () => {
  if (detachedWidget) setDetached(detachedWidget, false);
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Drag the floating widget around by its bar when detached. The widget stays inside
// the window.
function startDrag(w, ev) {
  if (!w.root.classList.contains("mstp-detached")) return;
  if (ev.target.closest("button, input, label")) return;
  ev.preventDefault();
  const rect = w.root.getBoundingClientRect();
  const dx = ev.clientX - rect.left;
  const dy = ev.clientY - rect.top;
  w.root.style.left = `${rect.left}px`;
  w.root.style.top = `${rect.top}px`;
  w.root.style.right = "auto";

  const move = (e) => {
    const x = clamp(e.clientX - dx, 0, window.innerWidth - w.root.offsetWidth);
    const y = clamp(
      e.clientY - dy,
      0,
      window.innerHeight - w.root.offsetHeight,
    );
    w.root.style.left = `${x}px`;
    w.root.style.top = `${y}px`;
  };
  const up = () => {
    w.bar.removeEventListener("pointermove", move);
    w.bar.removeEventListener("pointerup", up);
  };
  w.bar.setPointerCapture(ev.pointerId);
  w.bar.addEventListener("pointermove", move);
  w.bar.addEventListener("pointerup", up);
}

const RESIZE_EDGE = 8; // width of the grab zone along each border, in pixels
const SNAP = 16; // a border this close to a window edge snaps flush to it
const MIN_W = 340;
const MIN_H = MIN_W;

// Pull a border flush to a window edge when it lands within the snap zone.
const snap = (v, edge) => (Math.abs(v - edge) <= SNAP ? edge : v);

// A resize is under way, so hover should not fight the border cursor.
let resizing = false;

// Which borders the pointer sits on, within the grab zone.
function resizeEdges(w, ev) {
  const r = w.root.getBoundingClientRect();
  return {
    left: ev.clientX - r.left <= RESIZE_EDGE,
    right: r.right - ev.clientX <= RESIZE_EDGE,
    top: ev.clientY - r.top <= RESIZE_EDGE,
    bottom: r.bottom - ev.clientY <= RESIZE_EDGE,
  };
}

function edgeCursor(e) {
  if ((e.top && e.left) || (e.bottom && e.right)) return "nwse-resize";
  if ((e.top && e.right) || (e.bottom && e.left)) return "nesw-resize";
  if (e.left || e.right) return "ew-resize";
  if (e.top || e.bottom) return "ns-resize";
  return "";
}

// Side-by-side layout: the panel body is absolutely positioned, so the widget
// height is set by the canvas and any extra height would just be empty space.
const sideBySide = (w) => getComputedStyle(w.panel).position === "absolute";

// Show the matching resize cursor while hovering a border of the floating widget.
function updateResizeCursor(w, ev) {
  if (resizing) return;
  if (!w.root.classList.contains("mstp-detached")) return;
  const e = resizeEdges(w, ev);
  if (sideBySide(w)) e.top = e.bottom = false;
  w.root.style.cursor = edgeCursor(e);
}

// Resize the floating widget by dragging any border or corner. The widget stays
// inside the window and keeps a minimum size.
function startResize(w, ev) {
  if (ev.button !== 0) return;
  if (!w.root.classList.contains("mstp-detached")) return;
  // Leave the bar's controls alone even when they sit near a border.
  if (ev.target.closest("button, input, label, select, textarea")) return;
  const e = resizeEdges(w, ev);
  // With the height locked, a grab on the top or bottom border does nothing.
  const lockH = sideBySide(w);
  if (lockH) e.top = e.bottom = false;
  if (!e.left && !e.right && !e.top && !e.bottom) return;
  ev.preventDefault();
  ev.stopPropagation();

  const rect = w.root.getBoundingClientRect();
  const startX = ev.clientX;
  const startY = ev.clientY;
  const x0 = rect.left;
  const y0 = rect.top;
  const x1 = rect.right;
  const y1 = rect.bottom;
  w.root.style.left = `${x0}px`;
  w.root.style.top = `${y0}px`;
  w.root.style.right = "auto";
  w.root.style.width = `${rect.width}px`;
  w.root.style.height = lockH ? "" : `${rect.height}px`;
  resizing = true;
  w.root.style.cursor = edgeCursor(e);

  const move = (m) => {
    const dx = m.clientX - startX;
    const dy = m.clientY - startY;
    let l = x0,
      t = y0,
      r = x1,
      b = y1;
    if (e.left) l = snap(clamp(x0 + dx, 0, x1 - MIN_W), 0);
    if (e.right)
      r = snap(
        clamp(x1 + dx, x0 + MIN_W, window.innerWidth),
        window.innerWidth,
      );
    w.root.style.left = `${l}px`;
    w.root.style.width = `${r - l}px`;
    // Lock the height to the natural size whenever the layout is side-by-side,
    // even if widening crossed into it mid-drag, or when no vertical border is
    // being dragged.
    if (sideBySide(w) || (!e.top && !e.bottom)) {
      w.root.style.top = `${y0}px`;
      w.root.style.height = "";
      return;
    }
    if (e.top) t = snap(clamp(y0 + dy, 0, y1 - MIN_H), 0);
    if (e.bottom)
      b = snap(
        clamp(y1 + dy, y0 + MIN_H, window.innerHeight),
        window.innerHeight,
      );
    w.root.style.top = `${t}px`;
    w.root.style.height = `${b - t}px`;
  };
  const up = () => {
    resizing = false;
    w.root.style.cursor = "";
    w.root.removeEventListener("pointermove", move);
    w.root.removeEventListener("pointerup", up);
  };
  w.root.setPointerCapture(ev.pointerId);
  w.root.addEventListener("pointermove", move);
  w.root.addEventListener("pointerup", up);
}

// -- layout ---------------------------------------------------------

// Fit the viewBox to the static node coordinates and lock the SVG aspect ratio.
function applyViewBox(w) {
  const xs = w.model.nodes.map((n) => n.x * UNIT);
  const ys = w.model.nodes.map((n) => n.y * UNIT);
  const minX = Math.min(0, ...xs) - PAD;
  const minY = Math.min(0, ...ys) - PAD;
  const vbW = Math.max(...xs, 0) - Math.min(...xs, 0) + 2 * PAD || 2 * PAD;
  const vbH = Math.max(...ys, 0) - Math.min(...ys, 0) + 2 * PAD || 2 * PAD;
  w.svg.setAttribute("viewBox", `${minX} ${minY} ${vbW} ${vbH}`);
  w.svg.style.aspectRatio = `${vbW} / ${vbH}`;
}

// The protocols in play: what each bridge asks for, or the global default. A
// bridge running no protocol at all is not one of them.
function protocolsUsed(w) {
  const protos = new Set(
    w.model.nodes.map((n) => n.proto || w.model.directives.protocol),
  );
  protos.delete("none");
  return protos;
}

function buildLegend(w) {
  w.legend.replaceChildren();
  const protos = protocolsUsed(w);
  const hasStp = protos.has("stp");
  const hasRapid = protos.has("rstp") || protos.has("mstp");
  // Rapid transitions skip learning, so it only shows in STP or on a link
  // forced off p2p, where the rapid handshake cannot happen.
  const hasSlowLink = w.model.links.some(
    (l) => l.aOpts.p2p === false || l.bOpts.p2p === false,
  );

  const entries = [["forwarding", colorFor("forwarding")]];
  if (hasStp || hasSlowLink) entries.push(["learning", colorFor("learning")]);
  entries.push([
    hasStp && hasRapid
      ? "blocking/discarding"
      : hasStp
        ? "blocking"
        : "discarding",
    colorFor("blocking"),
  ]);

  // Port states
  const stateSet = h("div", { class: "mstp-legend-set" });
  for (const [label, color] of entries) {
    const sw = h("i");
    sw.style.background = color;
    stateSet.appendChild(h("span", {}, sw, document.createTextNode(label)));
  }
  w.legend.append(stateSet, h("span", { class: "mstp-sep" }));

  // BPDU types
  const pillSet = h("div", { class: "mstp-legend-set" });
  const pills = [["hello", BPDU_COLOR.hello]];
  if (hasRapid) {
    pills.push(["proposal", BPDU_COLOR.proposal]);
    pills.push(["agreement", BPDU_COLOR.agreement]);
  }
  for (const [label, color] of pills) {
    const dot = h("i", { class: "mstp-dot" });
    dot.style.background = color;
    pillSet.appendChild(h("span", {}, dot, document.createTextNode(label)));
  }
  const ring = h("i", { class: "mstp-dot" });
  ring.style.background = "transparent";
  ring.style.border = `2px solid ${BPDU_COLOR.tc}`;
  pillSet.appendChild(
    h("span", {}, ring, document.createTextNode("topology change")),
  );
  w.legend.appendChild(pillSet);
}

// Error message if there is an issue with timers
const TIMER_ERROR =
  "timers rejected, using the defaults: max age must be between 6 and 40, " +
  "forward delay between 4 and 30, max hops between 6 and 100, " +
  "tx hold count between 1 and 10, and 2 * (forward delay - 1) >= max age";

function showErrors(w) {
  const errors = [...w.model.errors];
  if (w.timerError) errors.push(TIMER_ERROR);
  w.errBox.replaceChildren();
  if (!errors.length) {
    w.errBox.hidden = true;
    return;
  }
  w.errBox.hidden = false;
  w.errBox.append(
    h("strong", { text: "Topology errors:" }),
    ...errors.map((e) => h("div", { text: e })),
  );
}

// -- editing --------------------------------------------------------

function enterEdit(w) {
  setRunning(w, false);
  w.textarea.value = w.source;
  w.editing = true;
  w.stage.hidden = w.legend.hidden = true;
  w.editor.hidden = false;
  w.runBtn.hidden =
    w.backBtn.hidden =
    w.stepBtn.hidden =
    w.resetBtn.hidden =
    w.editBtn.hidden =
    w.slow.hidden =
      true;
  w.saveBtn.hidden = w.discardBtn.hidden = false;
  w.textarea.focus();
}

function leaveEdit(w) {
  w.editing = false;
  w.editor.hidden = true;
  w.stage.hidden = w.legend.hidden = false;
  w.runBtn.hidden =
    w.backBtn.hidden =
    w.stepBtn.hidden =
    w.resetBtn.hidden =
    w.editBtn.hidden =
    w.slow.hidden =
      false;
  w.saveBtn.hidden = w.discardBtn.hidden = true;
}

// Discard: drop the edits and return to the running diagram unchanged.
function exitEdit(w) {
  leaveEdit(w);
}

// Save: adopt the edited definition, re-lay the diagram, and rebuild the core.
function saveEdit(w) {
  w.source = w.textarea.value;
  w.model = parseTopology(w.source);
  applyViewBox(w);
  buildLegend(w);
  showErrors(w);
  leaveEdit(w);
  build(w);
  if (w.mstp) select(w, null);
}

function build(w) {
  const { mstp, model } = w;
  for (const n of w.nodes) n.bridge?.delete();
  w.nodes = [];
  w.links = [];
  w.timerError = false;
  w.time = 0;
  w.bpdus = 0;
  w.selected = null;
  w.flights = [];
  w.wave = null;
  w.lastSeq = 0;
  w.history = [];
  w.cursor = 0;
  w.svg.querySelector(".mstp-pills")?.remove();

  const byName = new Map();
  const timers = timersOf(model.directives);
  for (const md of model.nodes) {
    const protocol = md.proto || model.directives.protocol;
    const stp = protocol !== "none";
    let bridge = null;
    if (mstp) {
      bridge = mstp.createBridge(md.name, {
        priority: md.prio,
        protocol: stp ? protocol : undefined,
        configId: protocol === "mstp" ? { revision: 1, name: "r1" } : undefined,
      });
      if (bridge.setTimes(timers) < 0) w.timerError = true;
      // A bridge is created with the protocol off, so leave it that way for
      // proto=none: the ports still come up, but nothing drives them.
      if (stp) bridge.enable();
    }
    const node = {
      name: md.name,
      x: md.x * UNIT,
      y: md.y * UNIT,
      prio: md.prio,
      protocol,
      icon: md.icon,
      bridge,
      ports: [],
      nextPort: 1,
    };
    w.nodes.push(node);
    byName.set(md.name, node);
  }

  for (const ld of model.links) {
    const a = byName.get(ld.a);
    const b = byName.get(ld.b);
    let pa = null;
    let pb = null;
    let link;
    if (mstp) {
      pa = a.bridge.addPort(`${a.name}.${a.nextPort}`, {
        portno: a.nextPort++,
        cost: ld.cost,
        ...ld.aOpts,
      });
      pb = b.bridge.addPort(`${b.name}.${b.nextPort}`, {
        portno: b.nextPort++,
        cost: ld.cost,
        ...ld.bOpts,
      });
      pa.enable();
      pb.enable();
      link = mstp.link(pa, pb);
      if (ld.oneway) mstp.linkOneWay(pa, pb);
      else if (ld.down) link.break();
      a.ports.push(pa);
      b.ports.push(pb);
    } else {
      link = { broken: ld.down, toggle() {}, break() {}, restore() {} };
    }
    w.links.push({
      a,
      b,
      aPort: pa,
      bPort: pb,
      link,
      cost: ld.cost,
      oneway: ld.oneway, // this link can have a one-way fault
      faulty: ld.oneway, // and the fault is set right now
    });
  }

  // Record every BPDU from now on so the panel can offer a pcap download. A
  // rebuild starts a fresh capture.
  if (mstp) mstp.capture();
  markAction(w);
  showErrors(w);
  render(w);
  if (mstp) renderPanel(w);
}

// -- convergence ----------------------------------------------------
//
// The topology has converged once every port has stopped changing role and
// state. BPDUs keep flowing after that (hellos, and the topology change flag
// for a few more seconds), so the ports are what we watch.
function portSig(w) {
  const parts = [];
  for (const [handle, ps] of snapshot(w).ports)
    parts.push(`${handle}:${ps.role}:${ps.state}`);
  return parts.join(" ");
}

// Start measuring again: on a rebuild, and on every link cut or restore. The
// ports the link touches change right away, so that is not a change to count.
function markAction(w) {
  w.sig = portSig(w);
  w.actionAt = w.changeAt = w.time;
  w.settledAt = null;
  renderClock(w);
}

// After a second has been simulated: note whether anything moved. Once the
// ports have been quiet for QUIET_TIME, record the convergebce time.
function trackConvergence(w) {
  const sig = portSig(w);
  if (sig !== w.sig) {
    w.sig = sig;
    w.changeAt = w.time;
    w.settledAt = null;
  } else if (w.settledAt === null && w.time - w.changeAt >= QUIET_TIME) {
    w.settledAt = w.changeAt;
  }
}

// -- history / step back --------------------------------------------
//
// The core cannot rewind, but it is deterministic: a fresh build replayed
// through the same ops lands in the same state. So stepping back rebuilds the
// sim and re-applies the history, one op short. While the cursor is behind the
// tip, stepping or running forward replays the recorded ops (the cuts and
// restores come from the history, the rest the sim reproduces on its own) until
// the sim is live again.

// Note an op in the history. Behind the tip, the sim replays the same sequence,
// so the op matches the recorded one and the cursor just moves forward. A new
// action taken from the past crop the history to the current point.
function record(w, t, link) {
  const next = w.history[w.cursor];
  if (next && next.t === t && next.link === link) {
    w.cursor += 1;
    return;
  }
  w.history.length = w.cursor;
  w.history.push({ t, link });
  w.cursor = w.history.length;
}

// Re-apply one recorded op without animation. Pills that were flying land
// straight away: they are counted as sent and dropped, and only the last op's
// BPDUs stay pending on the wire.
function applyOp(w, op) {
  if (op.t === "toggle") {
    applyToggle(w, w.links[op.link]);
    return;
  }
  w.bpdus += w.flights.length;
  w.flights = [];
  let gen = 0;
  if (op.t === "tick") {
    w.time += 1;
    w.mstp.oneSecond();
  } else {
    gen = w.wave ? w.wave.gen + 1 : 0;
    w.mstp.deliverBPDUs();
  }
  emitWave(w, gen);
  if (gen >= MAX_WAVES) {
    w.wave = null;
    w.bpdus += w.flights.length;
    w.flights = [];
  }
  if (!w.wave) trackConvergence(w);
}

// Rebuild the core and silently replay the first cursor ops. The selection is
// carried over to the rebuilt nodes and links.
function replay(w) {
  const { history, cursor, selected } = w;
  const sel =
    selected &&
    (selected.type === "link"
      ? { type: "link", index: w.links.indexOf(selected.ref) }
      : { type: "node", name: selected.ref.name });
  build(w);
  w.history = history;
  while (w.cursor < cursor) applyOp(w, history[w.cursor++]);
  select(
    w,
    sel &&
      (sel.type === "link"
        ? { type: "link", ref: w.links[sel.index] }
        : { type: "node", ref: w.nodes.find((n) => n.name === sel.name) }),
  );
}

// Move one op back.
function stepBack(w) {
  if (!w.mstp || w.raf || w.cursor === 0) return;
  w.cursor -= 1;
  replay(w);
}

// The back button only works at rest, with at least one op to rewind.
function updateBackBtn(w) {
  w.backBtn.disabled = !w.mstp || w.raf !== null || w.cursor === 0;
}

// -- running --------------------------------------------------------

// Only one topology on the page runs at a time.
let activeWidget = null;

// Start a simulated second: run the timers, then put whatever the bridges
// transmit on the wire.
function stepTick(w) {
  if (!w.mstp) return;
  record(w, "tick");
  w.time += 1;
  w.nextAt = w.clock + 1000;

  w.mstp.oneSecond();
  emitWave(w, 0);
  if (!w.wave) endTick(w); // a quiet second: no BPDU to wait for
  redrawState(w);
}

// The wave has landed: hand the frames to the bridges and send whatever they
// answer with on its way.
function deliverWave(w) {
  record(w, "deliver");
  const gen = w.wave.gen + 1;
  w.wave = null;
  w.mstp.deliverBPDUs();
  emitWave(w, gen);
  if (gen >= MAX_WAVES) w.wave = null;
  if (!w.wave) endTick(w);
  redrawState(w);
}

// Nothing is left on the wire: note whether the ports moved, and leave a short
// pause before the next second starts.
function endTick(w) {
  trackConvergence(w);
  renderClock(w);
  w.nextAt = Math.max(w.nextAt, w.clock + 150);
}

// Redraw the diagram with the state currently on show.
function redrawState(w) {
  render(w);
  renderPanel(w);
}

// A BPDU is counted as its pill sets off, not when it is put on the wire: a wave
// is handed over at the end of a step and only leaves on the next one, and a
// number climbing while nothing moves is a puzzle.
function countLaunched(w, from) {
  const n = w.flights.filter(
    (f) => f.start >= from && f.start < w.clock,
  ).length;
  if (!n) return;
  w.bpdus += n;
  renderClock(w);
}

// The animation loop. One requestAnimationFrame runs the whole time we play.
// Each frame it moves the clock on, does any due redraw or step, and draws the
// pills. It reads the speed each frame, so the snail also affects pills already
// flying.
function animate(w, now) {
  const dt = now - w.last;
  w.last = now;
  const from = w.clock;
  // Slower (by speed) while pills fly, real time when idle.
  w.clock += dt / (w.flights.length ? w.speed : 1);

  countLaunched(w, from);
  w.flights = w.flights.filter((f) => w.clock < f.start + FLIGHT_MS);

  // Replaying: a recorded cut or restore comes back at its place between the
  // seconds and waves around it.
  while (w.cursor < w.history.length && w.history[w.cursor].t === "toggle") {
    const op = w.history[w.cursor];
    w.cursor += 1;
    applyToggle(w, w.links[op.link]);
    redrawState(w);
  }

  if (w.wave) {
    // A step ends once the BPDUs it was playing have been delivered.
    if (w.clock >= w.wave.landAt) {
      deliverWave(w);
      if (w.stepping) return endStep(w);
    }
  } else if (w.clock >= w.nextAt) {
    stepTick(w); // start the next second
    // A second nobody had anything to say in is a step of its own.
    if (w.stepping && !w.wave) return endStep(w);
  }

  drawPills(w);
  w.raf = requestAnimationFrame((t) => animate(w, t));
}

function startLoop(w) {
  if (activeWidget && activeWidget !== w) setRunning(activeWidget, false);
  activeWidget = w;
  w.last = performance.now();
  w.raf = requestAnimationFrame((t) => animate(w, t));
  w.stepBtn.disabled = true;
  updateBackBtn(w);
}

function stopLoop(w) {
  cancelAnimationFrame(w.raf);
  w.raf = null;
  if (activeWidget === w) activeWidget = null;
  w.stepBtn.disabled = !w.mstp;
  updateBackBtn(w);
}

// Play one step: send the BPDUs waiting on the wire across their links and
// deliver them. With nothing to send, run the next second instead, and do not
// sit through what is left of the current one.
function stepOnce(w) {
  if (!w.mstp || w.raf) return;
  // Replaying: a recorded cut or restore is a step of its own.
  const next = w.history[w.cursor];
  if (next && next.t === "toggle") {
    w.cursor += 1;
    applyToggle(w, w.links[next.link]);
    redrawState(w);
    return;
  }
  w.stepping = true;
  if (!w.wave) w.nextAt = w.clock;
  startLoop(w);
}

// The step is over. Whatever it has just put on the wire waits there for the
// next one, so leave it alone.
function endStep(w) {
  w.stepping = false;
  drawPills(w);
  stopLoop(w);
}

// When stopping, just toggle the running flag and finish the current step if
// any. Otherwise, just stop where we are.
function stopRunning(w) {
  if (w.raf && w.wave) {
    w.running = false;
    w.stepping = true;
    w.runBtn.classList.remove("mstp-active");
    return;
  }
  setRunning(w, false);
}

function setRunning(w, on) {
  if (on && !w.running) {
    w.running = true;
    w.stepping = false; // a step in flight simply carries on
    if (!w.raf) {
      w.nextAt = w.clock + 200;
      startLoop(w);
    }
    w.runBtn.classList.add("mstp-active");
    w.stepBtn.disabled = true;
  } else if (!on && (w.running || w.raf)) {
    w.running = w.stepping = false;
    stopLoop(w);
    w.runBtn.classList.remove("mstp-active");
  }
}

// -- BPDU animation -------------------------------------------------

// The BPDU each frame carries. A topology change is not a type of its own: the
// TC flag rides on whatever frame the port was already sending, so it is drawn
// as a ring around the pill.
const bpduType = (f) =>
  f.proposal ? "proposal" : f.agreement ? "agreement" : "hello";

// Which end of which link a port sits at, and where its pills fly to.
function portGeometry(w) {
  const m = new Map();
  for (const e of w.links) {
    if (!e.geom) continue;
    const { x1, y1, x2, y2 } = e.geom;
    if (e.aPort)
      m.set(e.aPort.handle, { link: e, sx: x1, sy: y1, tx: x2, ty: y2 });
    if (e.bPort)
      m.set(e.bPort.handle, { link: e, sx: x2, sy: y2, tx: x1, ty: y1 });
  }
  return m;
}

// Send the BPDUs the core has put on the wire since the last wave on their way,
// one pill per frame. Every pill takes FLIGHT_MS to cross its link, so they all
// land together and the wave can then be delivered. Stores the wave on the
// widget, or null when the bridges had nothing to say.
function emitWave(w, gen) {
  const frames = w.mstp.queuedBPDUs(w.lastSeq);
  const at = portGeometry(w);
  const now = w.clock;
  const nth = new Map(); // BPDUs a port is sending at once, to stagger them

  for (const f of frames) {
    w.lastSeq = Math.max(w.lastSeq, f.seq);
    const g = at.get(f.src);
    if (!g) continue;
    // Several BPDUs leaving one port at once are spread out a little so they
    // can be told apart.
    const i = nth.get(f.src) || 0;
    nth.set(f.src, i + 1);
    w.flights.push({
      link: g.link,
      src: f.src,
      sx: g.sx,
      sy: g.sy,
      tx: g.tx,
      ty: g.ty,
      color: BPDU_COLOR[bpduType(f)],
      tc: f.tc,
      start: now + i * PILL_GAP,
    });
  }

  // A cut puts its BPDUs on a wire that may still be carrying the previous ones.
  // The core holds them in one queue, so they make up a single wave, landing
  // when the last of them arrives.
  const landAt = w.flights.reduce(
    (m, f) => Math.max(m, f.start + FLIGHT_MS),
    0,
  );
  w.wave = landAt ? { gen, landAt } : null;
}

// Draw each flying pill at its spot for the current clock. The pill layer goes
// back on top each frame so render()'s redraw does not wipe it.
function drawPills(w) {
  let layer = w.svg.querySelector(".mstp-pills");
  if (!w.flights.length) {
    layer?.remove();
    return;
  }
  if (!layer)
    layer = svgEl("g", { class: "mstp-pills", "pointer-events": "none" });
  else layer.replaceChildren();
  w.svg.appendChild(layer);

  for (const f of w.flights) {
    if (w.clock < f.start) continue; // not launched yet
    const p = (w.clock - f.start) / FLIGHT_MS;
    const x = f.sx + (f.tx - f.sx) * p;
    const y = f.sy + (f.ty - f.sy) * p;
    const fade = Math.min(1, p / 0.15, (1 - p) / 0.15);

    svgEl(
      "circle",
      {
        cx: x,
        cy: y,
        r: f.tc ? 5 : 4.5,
        fill: f.color,
        stroke: f.tc ? BPDU_COLOR.tc : "#fff8",
        "stroke-width": f.tc ? 2.25 : 0.75,
        opacity: fade,
      },
      layer,
    );
  }
}

// -- state ----------------------------------------------------------

function snapshot(w) {
  if (!w.mstp) return { topo: null, bridges: new Map(), ports: new Map() };
  const topo = w.mstp.topology();
  const bridges = new Map();
  const ports = new Map();
  for (const b of topo.bridges) {
    bridges.set(b.handle, b);
    for (const p of b.ports) ports.set(p.handle, p);
  }
  return { topo, bridges, ports };
}

// Add the name of the bridge owning a bridge id: "8192.02:00:00:00:00:04 (E)".
function namedBridgeId(w, snap, id) {
  for (const n of w.nodes) {
    const b = snap.bridges.get(n.bridge?.handle);
    if (b && b.bridge_id === id) return `${id} (${n.name})`;
  }
  return id;
}

// A bridge with the spanning tree turned off. The core keeps it disabled: it
// never transmits, and drops whatever it receives.
const noStp = (n) => n.protocol === "none";

// A port with no carrier: its cable is cut, or BPDU guard has shut it down.
const isDown = (ps) => !!ps && !ps.up;

// The role and state of a port whose bridge runs no protocol mean nothing, so
// they are not shown.
const shown = (node, ps) => (noStp(node) ? null : ps);

// Does traffic cross this end of a link? Without a protocol nothing blocks the
// port, so a live cable is enough.
const forwards = (node, ps) =>
  noStp(node) ? !!ps && ps.up : ps?.state === "forwarding";

// The core reports RSTP/MSTP's discarding state as the kernel's "blocking"
// (MSTPD maps it onto BR_STATE_BLOCKING). Show the RSTP name when appropriate.
function stateLabel(w, state) {
  const p = w.model.directives.protocol;
  if (state === "blocking" && (p === "rstp" || p === "mstp"))
    return "discarding";
  return state;
}

// -- rendering ------------------------------------------------------

// Update a clock field, flashing it when its value changes. Only while the
// widget is not running: a flash every second would be a strobe, and it is the
// single click of a step that is easy to miss.
function setClockField(w, el, text) {
  if (el.textContent === text) return;
  el.textContent = text;
  if (w.running) return;
  el.classList.remove("mstp-bump");
  void el.offsetWidth; // let the browser catch up, so the flash starts again
  el.classList.add("mstp-bump");
}

function renderClock(w) {
  setClockField(w, w.clockTime, `t=${w.time}s`);
  w.clockTime.title = `${w.cursor} steps`;
  setClockField(w, w.clockBpdu, `${w.bpdus} BPDUs`);
  if (w.settledAt !== null)
    w.clockConv.textContent = `🌳 ${w.settledAt - w.actionAt}s`;
  else if (!w.bpdus)
    w.clockConv.replaceChildren(); // nothing has been sent yet
  else if (!w.clockConv.firstElementChild)
    w.clockConv.replaceChildren(h("i", { class: "mstp-wait", text: "⏳" }));
}

function render(w) {
  const snap = snapshot(w);
  const live = !!w.mstp;
  renderClock(w);
  updateBackBtn(w);
  w.svg.replaceChildren();

  const defs = svgEl("defs", {}, w.svg);
  const gray = svgEl("filter", { id: "mstp-gray" }, defs);
  svgEl("feColorMatrix", { type: "saturate", values: "0" }, gray);

  const gEdges = svgEl("g", {}, w.svg);
  const gNodes = svgEl("g", {}, w.svg);

  // Parallel links between the same pair of bridges share a straight line, so
  // fan them out perpendicular to it to keep each visible and separately
  // clickable.
  const pairKey = (e) =>
    e.a.name < e.b.name
      ? `${e.a.name}\0${e.b.name}`
      : `${e.b.name}\0${e.a.name}`;
  const groups = new Map();
  for (const e of w.links) {
    const k = pairKey(e);
    (groups.get(k) || groups.set(k, []).get(k)).push(e);
  }

  for (const e of w.links) {
    const pa = snap.ports.get(e.aPort?.handle);
    const pb = snap.ports.get(e.bPort?.handle);
    const active = live && forwards(e.a, pa) && forwards(e.b, pb);
    const down = live ? isDown(pa) || isDown(pb) : e.link.broken;

    const dx = e.b.x - e.a.x;
    const dy = e.b.y - e.a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;

    // Perpendicular offset for this link within its parallel group. The sign
    // keys off node names so A--B and B--A land on the same side.
    const group = groups.get(pairKey(e));
    const spread = (group.indexOf(e) - (group.length - 1) / 2) * PARALLEL_GAP;
    const orient = e.a.name < e.b.name ? 1 : -1;
    const ox = -uy * spread * orient;
    const oy = ux * spread * orient;

    // How far from a node's centre the link starts: on the border of its
    // circle, or of its box when it runs no protocol. A parallel link is pushed
    // sideways by (ox, oy), so it leaves the shape at a different place.
    const border = (n, dx, dy) => {
      if (!noStp(n))
        return Math.sqrt(
          Math.max(NODE_RADIUS * NODE_RADIUS - spread * spread, 0),
        );
      const tx = dx ? (Math.sign(dx) * NO_STP_RADIUS - ox) / dx : Infinity;
      const ty = dy ? (Math.sign(dy) * NO_STP_RADIUS - oy) / dy : Infinity;
      return Math.max(0, Math.min(tx, ty));
    };
    const fromA = border(e.a, ux, uy);
    const fromB = border(e.b, -ux, -uy);
    const x1 = e.a.x + ux * fromA + ox;
    const y1 = e.a.y + uy * fromA + oy;
    const x2 = e.b.x - ux * fromB + ox;
    const y2 = e.b.y - uy * fromB + oy;

    e.geom = { x1, y1, x2, y2 };

    if (live) {
      // Larger hit target
      const hit = svgEl(
        "line",
        {
          x1,
          y1,
          x2,
          y2,
          stroke: "transparent",
          "stroke-width": 18,
          "pointer-events": "stroke",
        },
        gEdges,
      );
      hit.style.cursor = "pointer";
      hit.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        // Single click highlights. Double click cuts/restores.
        if (w.lastClick.link === e && ev.timeStamp - w.lastClick.t < 400) {
          w.lastClick = { link: null, t: 0 };
          toggleLink(w, e);
          return;
        }
        w.lastClick = { link: e, t: ev.timeStamp };
        select(w, { type: "link", ref: e });
      });
    }

    svgEl(
      "line",
      {
        x1,
        y1,
        x2,
        y2,
        stroke: !live ? "#888" : down ? "#999" : active ? "#2a7" : "#e55",
        "stroke-width": w.selected?.ref === e ? 5 : active ? 3 : 2,
        "stroke-dasharray": !live || active || down ? "" : "7 5",
        opacity: down ? 0.5 : 1,
        "pointer-events": "none",
      },
      gEdges,
    );

    // The middle of the link, taken between the two port markers. They sit a
    // little inside the line, so the middle of the line itself would be off
    // centre when the two ends are not the same shape.
    const endA = noStp(e.a) ? fromA : PORT_MARKER_OFFSET;
    const endB = noStp(e.b) ? fromB : PORT_MARKER_OFFSET;
    const mx = (e.a.x + ux * endA + (e.b.x - ux * endB)) / 2 + ox;
    const my = (e.a.y + uy * endA + (e.b.y - uy * endB)) / 2 + oy;

    if (down) {
      const s = 7;
      const cross = {
        stroke: "#e55",
        "stroke-width": 3,
        "stroke-linecap": "round",
        "pointer-events": "none",
      };
      svgEl(
        "line",
        { x1: mx - s, y1: my - s, x2: mx + s, y2: my + s, ...cross },
        gEdges,
      );
      svgEl(
        "line",
        { x1: mx - s, y1: my + s, x2: mx + s, y2: my - s, ...cross },
        gEdges,
      );
    }

    if (e.faulty) {
      // A diode at the midpoint.
      const s = 8; // half length along the link
      const wsym = 7; // half width of the base and the bar
      const px = -uy;
      const py = ux;
      const color = !live ? "#888" : down ? "#999" : active ? "#2a7" : "#e55";
      const ax = mx - ux * s; // base (transmitting side)
      const ay = my - uy * s;
      const cx = mx + ux * s; // tip (receiving side)
      const cy = my + uy * s;
      svgEl(
        "polygon",
        {
          points: [
            [ax + px * wsym, ay + py * wsym],
            [ax - px * wsym, ay - py * wsym],
            [cx, cy],
          ]
            .map((p) => p.join(","))
            .join(" "),
          fill: color,
          "pointer-events": "none",
        },
        gEdges,
      );
      svgEl(
        "line",
        {
          x1: cx + px * wsym,
          y1: cy + py * wsym,
          x2: cx - px * wsym,
          y2: cy - py * wsym,
          stroke: color,
          "stroke-width": 3,
          "stroke-linecap": "round",
          "pointer-events": "none",
        },
        gEdges,
      );
    }

    // A port with no protocol has no role or state to show, so it gets no marker.
    if (!noStp(e.a)) drawEndpoint(gEdges, e.a, e.b, pa, ox, oy);
    if (!noStp(e.b)) drawEndpoint(gEdges, e.b, e.a, pb, ox, oy);
  }

  for (const n of w.nodes) {
    const b = snap.bridges.get(n.bridge?.handle);
    const isRoot = b && b.is_root && !noStp(n);
    const g = svgEl("g", {}, gNodes);
    if (live) g.style.cursor = "pointer";
    const shape = {
      fill: isRoot ? "#2a73" : "#8882",
      stroke: w.selected?.ref === n ? "#06f" : isRoot ? "#2a7" : "#888",
      "stroke-width": w.selected?.ref === n ? 4 : 2,
    };
    // A bridge with no protocol is a box.
    if (noStp(n))
      svgEl(
        "rect",
        {
          x: n.x - NO_STP_RADIUS,
          y: n.y - NO_STP_RADIUS,
          width: 2 * NO_STP_RADIUS,
          height: 2 * NO_STP_RADIUS,
          rx: 3,
          ...shape,
        },
        g,
      );
    else svgEl("circle", { cx: n.x, cy: n.y, r: NODE_RADIUS, ...shape }, g);
    drawNodeGlyph(g, n);
    svgEl(
      "text",
      {
        x: n.x,
        y: noStp(n) ? n.y + 4 : n.y - 1,
        "text-anchor": "middle",
        "font-weight": 600,
        "font-size": 13,
      },
      g,
    ).textContent = n.name;
    svgEl(
      "text",
      {
        x: n.x,
        y: n.y + 12,
        "text-anchor": "middle",
        "font-size": 9,
        opacity: 0.7,
      },
      g,
    ).textContent = noStp(n)
      ? ""
      : isRoot
        ? "ROOT"
        : b
          ? `${b.root_path_cost}`
          : "";
    if (live)
      g.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        select(w, { type: "node", ref: n });
      });
  }
}

// A faint background glyph sitting behind the node's labels. Either the user's
// icon character (desaturated and faded so the labels stay legible) or, by
// default, the switch symbol.
function drawNodeGlyph(parent, n) {
  if (n.icon) {
    svgEl(
      "text",
      {
        x: n.x,
        y: n.y,
        "text-anchor": "middle",
        "dominant-baseline": "central",
        "font-size": noStp(n) ? (30 * NO_STP_RADIUS) / NODE_RADIUS : 30,
        opacity: 0.3,
        filter: "url(#mstp-gray)",
        "pointer-events": "none",
      },
      parent,
    ).textContent = n.icon;
    return;
  }
  if (noStp(n)) return;
  // Draw a switch symbol otherwise.
  const g = svgEl(
    "g",
    {
      stroke: "#888",
      "stroke-width": 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      fill: "none",
      opacity: 0.3,
      "pointer-events": "none",
    },
    parent,
  );
  const edge = 13; // half the total glyph width
  const head = 4; // arrowhead size
  // Two interleaved pairs of arrows. Each arrow spans half the width: tails
  // meet at the centre and the tips point outward, the rightward pair on the
  // right half and the leftward pair on the left half.
  [-9, -3, 3, 9].forEach((dy, i) => {
    const right = i % 2 === 0;
    const y = n.y + dy;
    const tail = n.x;
    const tip = n.x + (right ? edge : -edge);
    const dir = right ? -1 : 1;
    svgEl("line", { x1: tail, y1: y, x2: tip, y2: y }, g);
    svgEl(
      "polyline",
      {
        points: `${tip + dir * head},${y - head} ${tip},${y} ${tip + dir * head},${y + head}`,
      },
      g,
    );
  });
}

// Disabled and Designated both start with "D", so mark disabled ports with "X".
const roleLetter = (role) => (role === "Disabled" ? "X" : role[0]);

function drawEndpoint(parent, from, to, ps, ox = 0, oy = 0) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = from.x + ux * PORT_MARKER_OFFSET + ox;
  const py = from.y + uy * PORT_MARKER_OFFSET + oy;
  svgEl(
    "rect",
    {
      x: px - 6,
      y: py - 6,
      width: 12,
      height: 12,
      rx: 2,
      fill: colorFor(ps?.state),
      "pointer-events": "none",
    },
    parent,
  );
  const role = ps ? ps.role : "";
  if (role)
    svgEl(
      "text",
      {
        x: px,
        y: py + 3,
        "text-anchor": "middle",
        "font-size": 8,
        fill: "#fff",
        "font-weight": 700,
        "pointer-events": "none",
      },
      parent,
    ).textContent = roleLetter(role);
}

// -- details panel --------------------------------------------------

function select(w, sel) {
  w.selected = sel;
  render(w);
  renderPanel(w);
}

// Cutting a cable takes down whatever is on it: the core drops the frames it had
// queued there, so their pills go too.
function applyToggle(w, e) {
  if (e.oneway) {
    // Specific case for a one way link, we toggle the faulty state.
    e.faulty = !e.faulty;
    if (e.faulty) w.mstp.linkOneWay(e.aPort, e.bPort);
    else w.mstp.link(e.aPort, e.bPort);
  } else {
    e.link.toggle();
    w.flights = w.flights.filter((f) => f.link !== e);
    emitWave(w, w.wave ? w.wave.gen : 0);
  }
  markAction(w);
}

function toggleLink(w, e) {
  record(w, "toggle", w.links.indexOf(e));
  applyToggle(w, e);
  select(w, { type: "link", ref: e });
}

function renderPanel(w) {
  const panel = w.panel;
  panel.replaceChildren();
  const snap = snapshot(w);

  if (!w.selected) {
    panel.appendChild(h("h3", { text: "Global timers" }));
    const b0 = snap.topo.bridges[0];
    const protos = protocolsUsed(w);
    // Hops are an MSTP notion. Inside a region MSTP counts hops instead of
    // ageing BPDUs, and every MSTP bridge here joins the same region, so max age
    // only matters when some bridge speaks STP or RSTP.
    const hasMstp = protos.has("mstp");
    const oneRegion = hasMstp && protos.size === 1;
    const rows = [["protocol", w.model.directives.protocol.toUpperCase()]];
    if (b0) {
      rows.push(
        ["hello time", `${b0.hello_time} s`],
        ["forward delay", `${b0.forward_delay} s`],
      );
      if (!oneRegion) rows.push(["max age", `${b0.max_age} s`]);
      if (hasMstp) rows.push(["max hops", b0.max_hops]);
      rows.push(["tx hold count", b0.tx_hold_count]);
    }
    panel.appendChild(kvTable(rows));
    if (w.mstp) panel.appendChild(pcapButton(w, "bpdus.pcap"));
    panel.appendChild(
      h("p", {
        class: "mstp-hint",
        text: "Click a bridge or link for details. Double-click a link to cut or restore it.",
      }),
    );
    return;
  }

  if (w.selected.type === "link") {
    const e = w.selected.ref;
    const pa = shown(e.a, snap.ports.get(e.aPort.handle));
    const pb = shown(e.b, snap.ports.get(e.bPort.handle));
    const broken = e.link.broken;
    const head = h("h3", {
      text: `Link ${e.a.name} ${e.faulty ? "→" : "–"} ${e.b.name} `,
    });
    if (e.faulty) head.appendChild(badge("ONE-WAY", "#d90"));
    else if (broken) head.appendChild(badge("CUT", "#e55"));
    panel.appendChild(head);
    // Both ends of a cable have the same cost, so take it from whichever of them
    // runs the protocol.
    const known = pa || pb;
    panel.appendChild(
      kvTable([
        [
          "cost",
          e.cost != null
            ? e.cost
            : `auto (${known ? known.external_path_cost : "?"})`,
        ],
      ]),
    );
    panel.appendChild(
      portsTable(w, snap, [
        {
          port: e.aPort,
          ps: pa,
          label: e.a.name,
          rapid: isRapid(e.a),
        },
        {
          port: e.bPort,
          ps: pb,
          label: e.b.name,
          rapid: isRapid(e.b),
        },
      ]),
    );
    panel.appendChild(
      h("button", {
        class:
          "mstp-btn mstp-toggle" +
          ((e.oneway ? e.faulty : broken) ? " mstp-active" : ""),
        html: e.oneway
          ? `<span>${icon("✂️")}Break one way</span>` +
            `<span>${icon("🔗")}Repair link</span>`
          : `<span>${icon("✂️")}Cut link</span>` +
            `<span>${icon("🔗")}Restore link</span>`,
        onclick: () => toggleLink(w, e),
      }),
    );
    if (w.mstp && e.aPort)
      panel.appendChild(pcapButton(w, `${e.a.name}-${e.b.name}.pcap`, e.aPort));
    panel.appendChild(
      h("p", {
        class: "mstp-hint",
        text: !e.oneway
          ? "Double-click a link to cut it."
          : e.faulty
            ? `A one-way fault: ${e.b.name} receives but never transmits. ` +
              "Double-click the link to mend it."
            : `Double-click the link to break ${e.b.name}'s transmitter.`,
      }),
    );
    return;
  }

  // node
  const n = w.selected.ref;
  const b = snap.bridges.get(n.bridge.handle);
  const head = h("h3", { text: n.name + " " });
  if (b && b.is_root && !noStp(n)) head.appendChild(badge("ROOT", "#2a7"));
  if (noStp(n)) head.appendChild(badge("NO STP", "#888"));
  panel.appendChild(head);
  if (b && noStp(n)) panel.appendChild(kvTable([["protocol", "none"]]));
  else if (b)
    panel.appendChild(
      kvTable([
        ["priority", n.prio ?? 32768],
        ["bridge id", b.bridge_id],
        ["root", namedBridgeId(w, snap, b.designated_root)],
        ["cost to root", b.root_path_cost],
        ["protocol", b.protocol_version.toUpperCase()],
      ]),
    );

  const entries = n.ports.map((port) => ({
    port,
    ps: shown(n, snap.ports.get(port.handle)),
    label: peerLabel(w, port, n),
    rapid: isRapid(n),
  }));
  panel.appendChild(portsTable(w, snap, entries));
}

// A bridge whose protocol makes the rapid transitions and handshake happen.
const isRapid = (node) => node.protocol === "rstp" || node.protocol === "mstp";

// The port table shown in both the node and link panels: a "port" / "role /
// state" grid where each row folds out its flag and state details. Each entry
// is { port, ps, label, rapid }. ps is null for a port with no role to show.
function portsTable(w, snap, entries) {
  const tbl = h("table", { class: "mstp-ports" });
  const detailed = entries.filter((e) => e.ps);
  const allOpen =
    detailed.length > 0 && detailed.every((e) => w.flagsOpen.has(e.port.name));

  const hcell = h(
    "div",
    { class: "mstp-rs" },
    h("span", { text: "role / state" }),
  );
  if (detailed.length)
    hcell.appendChild(
      flagsDots(allOpen, () => {
        for (const e of detailed)
          if (allOpen) w.flagsOpen.delete(e.port.name);
          else w.flagsOpen.add(e.port.name);
        renderPanel(w);
      }),
    );
  tbl.appendChild(
    h("thead", {}, h("tr", {}, h("th", { text: "port" }), h("th", {}, hcell))),
  );

  const body = h("tbody");
  for (const { port, ps, label, rapid } of entries) {
    const tr = h("tr");
    tr.appendChild(h("td", { text: label }));
    const cell = h("div", { class: "mstp-rs" });
    const rs = h("span", { text: roleState(w, ps) });
    rs.style.color = colorFor(ps?.state);
    cell.appendChild(rs);
    const open = w.flagsOpen.has(port.name);
    if (ps)
      cell.appendChild(
        flagsDots(open, () => {
          if (open) w.flagsOpen.delete(port.name);
          else w.flagsOpen.add(port.name);
          renderPanel(w);
        }),
      );
    tr.appendChild(h("td", {}, cell));
    body.appendChild(tr);
    if (ps && open) {
      const cont = h(
        "td",
        { class: "mstp-port-detail-cell" },
        kvTable(portDetails(w, snap, ps, rapid)),
      );
      cont.colSpan = 2;
      body.appendChild(h("tr", { class: "mstp-port-detail" }, cont));
    }
  }
  tbl.appendChild(body);
  return tbl;
}

// A three-dot toggle that folds a port's flag/state details in and out.
function flagsDots(open, toggle) {
  const b = h("button", {
    class: "mstp-dots" + (open ? " mstp-dots-open" : ""),
    text: "⋯",
    title: open ? "Hide port details" : "Show port details",
  });
  b.type = "button";
  b.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    toggle();
  });
  return b;
}

// The flags and the rest of the state worth showing for one port, as kvTable
// rows.
function portDetails(w, snap, ps, rapid) {
  const rows = [];
  rows.push(["port id", ps.port_id]);
  rows.push(["link type", ps.oper_p2p ? "point-to-point" : "shared"]);
  rows.push(["edge", edgeState(ps)]);
  rows.push(["path cost", ps.external_path_cost]);

  const flags = portFlags(ps, rapid);
  if (flags) rows.push(["flags", flags]);
  const hs = handshake(ps);
  if (hs) rows.push(["handshake", hs]);

  rows.push([
    "designated bridge",
    namedBridgeId(w, snap, ps.designated_bridge),
  ]);
  rows.push(["designated port", ps.designated_port]);
  return rows;
}

// The RSTP role-transition variables that are set on the port right now.
function handshake(ps) {
  const notes = [];
  if (ps.proposing) notes.push("proposing");
  if (ps.proposed) notes.push("proposed");
  if (ps.agree) notes.push("agree");
  if (ps.agreed) notes.push("agreed");
  if (ps.sync) notes.push("sync");
  if (ps.synced) notes.push("synced");
  if (ps.re_root) notes.push("re-root");
  return notes.join(", ");
}

function edgeState(ps) {
  const cfg = [];
  if (ps.admin_edge) cfg.push("admin");
  if (ps.auto_edge) cfg.push("auto");
  const oper = ps.oper_edge ? "yes" : "no";
  return cfg.length ? `${oper} (${cfg.join(", ")})` : oper;
}

function roleState(w, ps) {
  return ps ? `${ps.role} / ${stateLabel(w, ps.state)}` : "-";
}

function portFlags(ps, rapid) {
  if (!ps) return "";
  const notes = [];
  if (ps.network_port) notes.push("network");
  if (ps.restricted_role) notes.push("root-guard");
  if (ps.restricted_tcn) notes.push("tcn-guard");
  if (ps.bpdu_guard_port)
    notes.push(ps.bpdu_guard_error ? "bpdu-guard tripped" : "bpdu-guard");
  if (rapid && ps.up && !ps.send_rstp) notes.push("STP fallback");
  if (ps.disputed) notes.push("disputed");
  if (ps.ba_inconsistent) notes.push("BA inconsistent");
  return notes.join(", ");
}

function peerLabel(w, port, node) {
  const e = w.links.find((e) => e.aPort === port || e.bPort === port);
  if (!e) return port.name;
  return `→ ${e.a === node ? e.b.name : e.a.name}`;
}

// Each row is [key, value] or [key, value, color] to tint the value cell.
function kvTable(rows) {
  const tbl = h("table", { class: "mstp-kv" });
  const body = h("tbody");
  for (const [k, v, color] of rows) {
    const td = h("td", { text: String(v) });
    if (color) td.style.color = color;
    body.appendChild(h("tr", {}, h("th", { text: k }), td));
  }
  tbl.appendChild(body);
  return tbl;
}

function badge(text, color) {
  const b = h("span", { class: "mstp-badge", text });
  b.style.background = color;
  return b;
}

// The BPDUs the core has transmitted but whose pills have not set off yet, one
// count per port. They are on the wire and the capture holds them, but they are
// not part of what has been played, so the pcap leaves them out.
function notLaunched(w) {
  const n = new Map();
  for (const f of w.flights)
    if (f.start >= w.clock) n.set(f.src, (n.get(f.src) || 0) + 1);
  return n;
}

// A button that saves captured BPDUs as a pcap: the whole capture when no port
// is given, or just that port's link (both directions) when one is.
function pcapButton(w, filename, port) {
  return h("button", {
    class: "mstp-btn mstp-pcap",
    html: `${icon("📦")}Download packets`,
    onclick: () => w.mstp.downloadPcap(port, filename, notLaunched(w)),
  });
}

// -- control links --------------------------------------------------
//
// A regular <a href="#mstp:OP,OP,..."> link anywhere in the page puts the
// nearest topology in a given state: a click resets it, then applies each op
// in turn, without animation. An op is either:
//
//   N     play N steps, as the Step button would
//   A--B  toggle the link between bridges A and B; with several links
//         between the two, A--B:2 picks the second, in definition order
//
// So #mstp:B--C,30 restarts the topology, cuts the link B -- C and plays 30
// steps.

// Host element -> widget, to find the widget a control link drives.
const widgets = new WeakMap();

// The topology a control link drives: the closest one before the link.
function closestWidget(from) {
  let before = null;
  for (const host of document.querySelectorAll(".mstp-host")) {
    if (from.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_PRECEDING)
      before = host;
  }
  return before && widgets.get(before);
}

// Reset a topology and apply a #mstp: op list to it.
function seek(w, spec) {
  if (!w.mstp || w.editing) return;
  setRunning(w, false);
  build(w);
  for (const tok of spec.split(",")) {
    const op = tok.trim();
    if (!op) continue;
    if (/^\d+$/.test(op)) {
      for (let i = 0; i < +op; i++) {
        const t = w.wave ? "deliver" : "tick";
        record(w, t);
        applyOp(w, { t });
      }
      continue;
    }
    const m = op.match(/^(.+?)\s*--\s*(.+?)(?::(\d+))?$/);
    const matching = m
      ? w.links
          .map((l, i) => i)
          .filter(
            (i) =>
              (w.links[i].a.name === m[1] && w.links[i].b.name === m[2]) ||
              (w.links[i].a.name === m[2] && w.links[i].b.name === m[1]),
          )
      : [];
    const idx = matching[(m?.[3] ? +m[3] : 1) - 1] ?? -1;
    if (idx < 0) {
      console.warn(`mstp: cannot apply "${op}"`);
      continue;
    }
    record(w, "toggle", idx);
    applyOp(w, { t: "toggle", link: idx });
  }
  select(w, null);
}

document.addEventListener("click", (ev) => {
  const a = ev.target.closest?.("a[href^='#mstp:']");
  if (!a) return;
  ev.preventDefault();
  const w = closestWidget(a);
  if (!w) return;
  seek(w, decodeURIComponent(a.hash.slice(6)));

  // Scroll element into view if needed.
  if (w.root.classList.contains("mstp-detached")) return;
  const rect = w.host.getBoundingClientRect();
  const winH = window.innerHeight || document.documentElement.clientHeight;
  if (rect.top < 0 || rect.bottom > winH) w.host.scrollIntoView();
});

// -- bootstrap ------------------------------------------------------

const SELECTOR = "pre.mstp-topology, div.mstp-topology:has(> pre > code)";

function mountAll(scope = document) {
  for (const el of scope.querySelectorAll(SELECTOR)) mount(el);
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", () => mountAll());
else mountAll();
