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
// Endpoint flags: edge, network, bpdu-guard, root-guard, no-p2p
//
// proto=none turns the spanning tree off on a bridge: it sends no BPDUs, drops
// the ones it receives, and its ports have no role or state.
//
// The MSTPD core is loaded via its own <script> tag (above), which publishes
// window.mstpd; this module picks loadMSTPD off it rather than importing. We
// could instead import it:
//
// import { loadMSTPD } from "./dist/mstpd.mjs";

const loadMSTPD = window.mstpd.loadMSTPD;
const SVGNS = "http://www.w3.org/2000/svg";
const UNIT = 110; // grid cell -> px
const R = 24; // node radius in px
const PAD = R + 24; // viewBox margin around the nodes
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
  runBtn.disabled = stepBtn.disabled = resetBtn.disabled = true;
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
    stepBtn,
    resetBtn,
    editBtn,
    saveBtn,
    discardBtn,
    clock,
    slow,
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
    svg,
    panel: panelBody,
    stage,
    legend,
    editor,
    textarea,
    errBox,
    runBtn,
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
  };

  applyViewBox(w);
  buildLegend(w);
  showErrors(w);

  svg.addEventListener("pointerdown", (ev) => {
    if (w.mstp && ev.target === svg) select(w, null);
  });
  runBtn.onclick = () => (w.running ? stopRunning(w) : setRunning(w, true));
  stepBtn.onclick = () => stepOnce(w);
  resetBtn.onclick = () => {
    setRunning(w, false);
    build(w);
    select(w, null);
  };
  editBtn.onclick = () => enterEdit(w);
  saveBtn.onclick = () => saveEdit(w);
  discardBtn.onclick = () => exitEdit(w);
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
      if (ld.oneway) {
        // A one-way fault cannot be toggled.
        mstp.linkOneWay(pa, pb);
        link = { broken: false, toggle() {}, break() {}, restore() {} };
      } else {
        link = mstp.link(pa, pb);
        if (ld.down) link.break();
      }
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
      oneway: ld.oneway,
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

// -- running --------------------------------------------------------

// Only one topology on the page runs at a time.
let activeWidget = null;

// Start a simulated second: run the timers, then put whatever the bridges
// transmit on the wire.
function stepTick(w) {
  if (!w.mstp) return;
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
}

function stopLoop(w) {
  cancelAnimationFrame(w.raf);
  w.raf = null;
  if (activeWidget === w) activeWidget = null;
  w.stepBtn.disabled = !w.mstp;
}

// Play one step: send the BPDUs waiting on the wire across their links and
// deliver them. With nothing to send, run the next second instead, and do not
// sit through what is left of the current one.
function stepOnce(w) {
  if (!w.mstp || w.raf) return;
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

    // A parallel link is offset perpendicular by `spread`, so it meets the
    // circle nearer its edge: back off along the link to land on the border.
    const along = Math.sqrt(Math.max(R * R - spread * spread, 0));
    const x1 = e.a.x + ux * along + ox;
    const y1 = e.a.y + uy * along + oy;
    const x2 = e.b.x - ux * along + ox;
    const y2 = e.b.y - uy * along + oy;

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

    if (down) {
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
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

    if (e.oneway) {
      // A diode at the midpoint.
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
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
    svgEl(
      "circle",
      {
        cx: n.x,
        cy: n.y,
        r: R,
        fill: isRoot ? "#2a73" : "#8882",
        stroke: w.selected?.ref === n ? "#06f" : isRoot ? "#2a7" : "#888",
        "stroke-width": w.selected?.ref === n ? 4 : 2,
      },
      g,
    );
    drawNodeGlyph(g, n);
    svgEl(
      "text",
      {
        x: n.x,
        y: n.y - 1,
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
      ? "no STP"
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
        "font-size": 30,
        opacity: 0.3,
        filter: "url(#mstp-gray)",
        "pointer-events": "none",
      },
      parent,
    ).textContent = n.icon;
    return;
  }
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
  const px = from.x + ux * (R + 9) + ox;
  const py = from.y + uy * (R + 9) + oy;
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

// Cutting a link takes down whatever is on it: the core drops the frames it had
// queued there, so their pills go too. The bridges react at once, without
// waiting for the next second, so put the BPDUs they answer with on the wire
// now: that is where reconvergence starts.
function toggleLink(w, e) {
  if (e.oneway) return; // a one-way fault cannot be toggled
  e.link.toggle();
  w.flights = w.flights.filter((f) => f.link !== e);
  emitWave(w, w.wave ? w.wave.gen : 0);
  markAction(w);
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
      text: `Link ${e.a.name} ${e.oneway ? "→" : "–"} ${e.b.name} `,
    });
    if (e.oneway) head.appendChild(badge("ONE-WAY", "#d90"));
    else if (broken) head.appendChild(badge("CUT", "#e55"));
    panel.appendChild(head);
    if (!e.oneway)
      panel.appendChild(
        h("button", {
          class: "mstp-btn mstp-toggle" + (broken ? " mstp-active" : ""),
          html:
            `<span>${icon("✂️")}Cut link</span>` +
            `<span>${icon("🔗")}Restore link</span>`,
          onclick: () => toggleLink(w, e),
        }),
      );
    // Both ends of a cable have the same cost, so take it from whichever of them
    // runs the protocol.
    const known = pa || pb;
    const rows = [
      [`${e.a.name} port`, roleState(w, pa), colorFor(pa?.state)],
      [`${e.b.name} port`, roleState(w, pb), colorFor(pb?.state)],
      [
        "cost",
        e.cost != null
          ? e.cost
          : `auto (${known ? known.external_path_cost : "?"})`,
      ],
    ];
    const na = portFlags(pa);
    const nb = portFlags(pb);
    if (na) rows.push([`${e.a.name} flags`, na]);
    if (nb) rows.push([`${e.b.name} flags`, nb]);
    panel.appendChild(kvTable(rows));
    if (w.mstp && e.aPort)
      panel.appendChild(pcapButton(w, `${e.a.name}-${e.b.name}.pcap`, e.aPort));
    panel.appendChild(
      h("p", {
        class: "mstp-hint",
        text: e.oneway
          ? "A one-way link: BPDUs travel one direction only."
          : "Double-click a link to cut it.",
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
        ["root", b.designated_root],
        ["cost to root", b.root_path_cost],
        ["protocol", b.protocol_version.toUpperCase()],
      ]),
    );

  const tbl = h("table", { class: "mstp-ports" });
  tbl.innerHTML = "<thead><tr><th>port</th><th>role / state</th></tr></thead>";
  const body = h("tbody");
  for (const port of n.ports) {
    const ps = shown(n, snap.ports.get(port.handle));
    const tr = h("tr");
    tr.appendChild(h("td", { text: peerLabel(w, port, n) }));
    const td = h("td", { text: roleState(w, ps) });
    td.style.color = colorFor(ps?.state);
    tr.appendChild(td);
    body.appendChild(tr);
  }
  tbl.appendChild(body);
  panel.appendChild(tbl);
}

function roleState(w, ps) {
  return ps ? `${ps.role} / ${stateLabel(w, ps.state)}` : "-";
}

function portFlags(ps) {
  if (!ps) return "";
  const notes = [];
  if (ps.restricted_role) notes.push("root-guard");
  if (ps.bpdu_guard_port)
    notes.push(ps.bpdu_guard_error ? "bpdu-guard tripped" : "bpdu-guard");
  if (ps.network_port) notes.push("network");
  if (ps.oper_edge) notes.push("edge");
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

// -- bootstrap ------------------------------------------------------

const SELECTOR = "pre.mstp-topology, div.mstp-topology:has(> pre > code)";

function mountAll(scope = document) {
  for (const el of scope.querySelectorAll(SELECTOR)) mount(el);
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", () => mountAll());
else mountAll();
