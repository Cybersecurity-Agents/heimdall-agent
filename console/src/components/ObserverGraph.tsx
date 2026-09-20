import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { GraphNode, GraphPayload } from "../types";

const SUB_DISPLAY: Record<string, string> = {
  "未试·待突": "未试",
  "已测·打穿": "已连通",
  "已测·未穿": "未连通",
  "侦察·未穿": "待连通验证",
  "未试·最后": "未试·后置",
  "已测·最后": "未连通·后置",
  "侦察·最后": "待连通验证·后置",
  "未连通·最后": "未连通·后置",
  "待连通验证·最后": "待连通验证·后置",
  最后: "后置",
};

function isLaterNode(n: GraphNode) {
  if (typeof n.later === "boolean") return n.later;
  // Compatibility with old publications; never infer policy from node prose.
  const sub = String(n.sub || "");
  if (sub.includes("最后") || sub.includes("后置")) return true;
  if (n.group === "scan" || n.coverage === "scan-class") return true;
  return false;
}

function nodeSub(n: GraphNode) {
  let sub = SUB_DISPLAY[String(n.sub || "")] || String(n.sub || "");
  if (!isLaterNode(n)) return sub;
  if (sub === "未试" || sub === "未试·待突") return "未试·后置";
  if (sub === "未连通" || sub === "已测·未穿") return "未连通·后置";
  if (sub === "待连通验证" || sub === "侦察·未穿") return "待连通验证·后置";
  return sub || "后置";
}

function fitNode(n: GraphNode): GraphNode {
  const group = n.group || "";
  const label = String(n.label || "");
  const sub = String(n.sub || "").trim();
  let w = n.width || 188;
  let h = n.height || 68;
  if (group === "start") {
    const bulky = !!sub || label.length > 10;
    w = Math.max(w, bulky ? 188 : 148);
    h = Math.max(h, bulky ? 68 : 52);
  }
  if (w === n.width && h === n.height) return n;
  return { ...n, width: w, height: h };
}

function edgePath(a: GraphNode, b: GraphNode) {
  const x1 = a.x + a.width;
  const y1 = a.y + a.height / 2;
  const x2 = b.x;
  const y2 = b.y + b.height / 2;
  const mx = (x1 + x2) / 2;
  return `M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}

function fragUrl(id: string) {
  return `url(${new URL("#" + id, location.href.split("#")[0]).href})`;
}

function nodesBBox(nodes: GraphNode[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, w: maxX - minX, h: maxY - minY };
}

function layoutKey(nodes: GraphNode[]) {
  return nodes.map((n) => n.id + ":" + n.x + ":" + n.y + ":" + n.width + ":" + n.height).join("|");
}

type Props = {
  graph: GraphPayload | null;
  empty: string;
  warming?: boolean;
  selected?: string | null;
  ariaLabel: string;
  onSelect: (id: string) => void;
  onScale?: (scale: number) => void;
};

export type ObserverGraphHandle = {
  zoomBy: (factor: number) => void;
  resetView: () => void;
};

export const ObserverGraph = forwardRef<ObserverGraphHandle, Props>(function ObserverGraph(
  { graph, empty, warming, selected, ariaLabel, onSelect, onScale },
  ref
) {
  const host = useRef<HTMLDivElement>(null);
  const pan = useRef({ x: 16, y: 16, scale: 1 });
  const drag = useRef<{ x: number; y: number; panX: number; panY: number; moved: boolean } | null>(null);
  const onScaleRef = useRef(onScale);
  const nodesRef = useRef<GraphNode[]>([]);
  const layoutKeyRef = useRef("");
  const renderKeyRef = useRef("");
  const userView = useRef(false);
  onScaleRef.current = onScale;

  const applyView = () => {
    const el = host.current;
    const world = el?.querySelector(".world") as SVGGElement | null;
    if (!world || !el) return;
    world.setAttribute("transform", `translate(${pan.current.x} ${pan.current.y}) scale(${pan.current.scale})`);
    if (el.classList.contains("empty")) return;
    const cell = 32 * pan.current.scale;
    el.style.backgroundPosition = `${pan.current.x}px ${pan.current.y}px`;
    el.style.backgroundSize = `${cell}px ${cell}px`;
  };

  const fitView = () => {
    const el = host.current;
    const nodes = nodesRef.current;
    if (!el || !el.querySelector(".world") || !nodes.length) return;
    const box = nodesBBox(nodes);
    if (!box || box.w < 1 || box.h < 1) return;
    const pad = 32;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    if (cw < 16 || ch < 16) return;
    const scale = Math.min(3.5, Math.max(0.08, Math.min(cw / (box.w + pad * 2), ch / (box.h + pad * 2))));
    pan.current.scale = scale;
    pan.current.x = -box.minX * scale + (cw - box.w * scale) / 2;
    pan.current.y = -box.minY * scale + (ch - box.h * scale) / 2;
    applyView();
    onScaleRef.current?.(scale);
  };

  const zoomAt = (factor: number, mx?: number, my?: number) => {
    const el = host.current;
    if (!el || !el.querySelector(".world")) return;
    const rect = el.getBoundingClientRect();
    const cx = mx ?? rect.width / 2;
    const cy = my ?? rect.height / 2;
    const old = pan.current.scale;
    const next = Math.min(4, Math.max(0.08, old * factor));
    if (next === old) return;
    userView.current = true;
    pan.current.x = cx - (cx - pan.current.x) * (next / old);
    pan.current.y = cy - (cy - pan.current.y) * (next / old);
    pan.current.scale = next;
    applyView();
    onScaleRef.current?.(next);
  };

  useImperativeHandle(ref, () => ({
    zoomBy: (factor: number) => zoomAt(factor),
    resetView: () => {
      userView.current = false;
      fitView();
    },
  }));

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const nodes = ((graph && graph.view && graph.view.nodes) || []).map(fitNode);
    nodesRef.current = nodes;
    if (!graph || !nodes.length) {
      el.className = "net empty" + (warming ? " waiting" : "");
      el.style.backgroundPosition = "";
      el.style.backgroundSize = "";
      el.innerHTML = `<div class="field-scan" aria-hidden="true"></div><p class="field-caption"></p>`;
      const cap = el.querySelector(".field-caption");
      if (cap) cap.textContent = empty;
      layoutKeyRef.current = "";
      renderKeyRef.current = "";
      userView.current = false;
      return;
    }
    const edges = (graph.view && graph.view.edges) || [];
    const by = Object.fromEntries(nodes.map((n) => [n.id, n]));
    const NS = "http://www.w3.org/2000/svg";
    const key = layoutKey(nodes);
    const renderKey = JSON.stringify([nodes, edges, ariaLabel]);
    const existing = el.querySelector("svg.dag");
    if (existing && renderKey === renderKeyRef.current) {
      el.querySelectorAll("g.vnode").forEach((node) => {
        node.classList.toggle("is-on", node.getAttribute("data-id") === selected);
      });
      return;
    }
    el.className = "net";
    el.innerHTML = "";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "dag");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", ariaLabel);
    const defs = document.createElementNS(NS, "defs");
    const marker = document.createElementNS(NS, "marker");
    marker.setAttribute("id", "hm-arr");
    marker.setAttribute("markerWidth", "6");
    marker.setAttribute("markerHeight", "6");
    marker.setAttribute("refX", "5.2");
    marker.setAttribute("refY", "3");
    marker.setAttribute("orient", "auto");
    const head = document.createElementNS(NS, "path");
    head.setAttribute("d", "M0,0.4 L5.2,3 L0,5.6");
    head.setAttribute("class", "arr-head");
    marker.appendChild(head);
    defs.appendChild(marker);
    const world = document.createElementNS(NS, "g");
    world.setAttribute("class", "world");
    const edgesG = document.createElementNS(NS, "g");
    const nodesG = document.createElementNS(NS, "g");
    for (const e of edges) {
      const a = by[e.from];
      const b = by[e.to];
      if (!a || !b) continue;
      const path = document.createElementNS(NS, "path");
      path.setAttribute("class", "vedge" + (e.dashes ? " is-dash" : "") + (e.tone === "open" || b.status === "open" ? " is-open" : ""));
      path.setAttribute("d", edgePath(a, b));
      path.setAttribute("fill", "none");
      path.setAttribute("marker-end", fragUrl("hm-arr"));
      edgesG.appendChild(path);
    }
    nodes.forEach((n) => {
      const group = n.group || "recon";
      const g = document.createElementNS(NS, "g");
      g.setAttribute("class", "vnode" + (selected === n.id ? " is-on" : "") + (group === "start" ? " is-start" : "") + (n.status === "todo" ? " is-todo" : "") + (n.status === "open" ? " is-open" : "") + (isLaterNode(n) ? " is-later" : ""));
      g.setAttribute("data-id", n.id);
      g.setAttribute("data-group", group);
      g.setAttribute("data-status", n.status || "");
      g.style.transform = `translate(${n.x}px, ${n.y}px)`;
      const body = document.createElementNS(NS, "rect");
      body.setAttribute("class", "body");
      body.setAttribute("x", "0");
      body.setAttribute("y", "0");
      body.setAttribute("width", String(n.width));
      body.setAttribute("height", String(n.height));
      body.setAttribute("rx", "2");
      const pip = document.createElementNS(NS, "circle");
      pip.setAttribute("class", "pip");
      pip.setAttribute("r", "2.4");
      pip.setAttribute("cx", "10");
      pip.setAttribute("cy", "10");
      const fo = document.createElementNS(NS, "foreignObject");
      fo.setAttribute("x", "0");
      fo.setAttribute("y", "0");
      fo.setAttribute("width", String(n.width));
      fo.setAttribute("height", String(n.height));
      const cell = document.createElement("div");
      cell.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
      cell.className = "cell" + (group === "start" ? " start" : "");
      const title = document.createElement("span");
      title.className = "t";
      title.textContent = n.label || n.id;
      const sub = document.createElement("span");
      sub.className = "s";
      const label = nodeSub(n);
      if (label) sub.textContent = label;
      else sub.hidden = true;
      cell.appendChild(title);
      cell.appendChild(sub);
      fo.appendChild(cell);
      g.appendChild(body);
      g.appendChild(pip);
      g.appendChild(fo);
      nodesG.appendChild(g);
    });
    world.appendChild(edgesG);
    world.appendChild(nodesG);
    svg.appendChild(defs);
    svg.appendChild(world);
    el.appendChild(svg);
    const firstLayout = !layoutKeyRef.current;
    layoutKeyRef.current = key;
    renderKeyRef.current = renderKey;
    if (firstLayout) userView.current = false;
    applyView();
    const frame = requestAnimationFrame(() => {
      if (userView.current) applyView();
      else fitView();
    });
    return () => cancelAnimationFrame(frame);
  }, [graph, empty, warming, selected, ariaLabel]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onMove = (ev: PointerEvent) => {
      if (!drag.current) return;
      const dx = ev.clientX - drag.current.x;
      const dy = ev.clientY - drag.current.y;
      if (!drag.current.moved && dx * dx + dy * dy < 36) return;
      if (!drag.current.moved) {
        drag.current.moved = true;
        try { el.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
        document.documentElement.classList.add("is-panning-graph");
      }
      pan.current.x = drag.current.panX + dx;
      pan.current.y = drag.current.panY + dy;
      userView.current = true;
      el.classList.add("is-panning");
      applyView();
    };
    const onUp = (ev: PointerEvent) => {
      if (!drag.current) return;
      const moved = drag.current.moved;
      if (moved) {
        try { el.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      }
      drag.current = null;
      el.classList.remove("is-panning");
      document.documentElement.classList.remove("is-panning-graph");
      if (!moved) {
        const hit = (ev.target as Element | null)?.closest?.("g[data-id]");
        const id = hit && el.contains(hit) ? hit.getAttribute("data-id") : "";
        if (id) onSelect(id);
      }
    };
    const onDown = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      drag.current = { x: ev.clientX, y: ev.clientY, panX: pan.current.x, panY: pan.current.y, moved: false };
    };
    const onWheel = (ev: WheelEvent) => {
      if (!el.querySelector(".world")) return;
      ev.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      zoomAt(ev.deltaY < 0 ? 1.08 : 1 / 1.08, mx, my);
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    const ro = new ResizeObserver(() => {
      if (!userView.current) fitView();
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.classList.remove("is-panning-graph");
      el.classList.remove("is-panning");
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("wheel", onWheel);
    };
  }, [onSelect]);

  return <div ref={host} className="net empty" />;
});
