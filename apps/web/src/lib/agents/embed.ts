const HOST_PATTERN = /^[a-z0-9.-]+(?::\d{1,5})?$/i;
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;
const FALLBACK_ORIGIN = "http://localhost:3000";

export const EMBED_CLOSE_MESSAGE = "delegate:close";

export function embedSnippet(origin: string, assistantId: string): string {
  return `<script src="${origin}/widget.js" data-assistant="${assistantId}" async></script>`;
}

export function requestOrigin(headers: Headers): string {
  const host = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(",")[0]?.trim();
  if (host === undefined || !HOST_PATTERN.test(host)) return FALLBACK_ORIGIN;
  const forwarded = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto =
    forwarded === "http" || forwarded === "https"
      ? forwarded
      : LOCAL_HOST.test(host)
        ? "http"
        : "https";
  return `${proto}://${host}`;
}

export function isEmbedPath(pathname: string): boolean {
  return /^\/embed\/[^/]+\/?$/.test(pathname);
}

export function widgetScript(): string {
  return `(function () {
  "use strict";
  var script = document.currentScript;
  if (!script || !script.src) return;
  var id = script.getAttribute("data-assistant") || "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return;
  var origin = new URL(script.src).origin;
  if (document.getElementById("delegate-widget-" + id)) return;

  var root = document.createElement("div");
  root.id = "delegate-widget-" + id;
  Object.assign(root.style, {
    position: "fixed", right: "20px", bottom: "20px", zIndex: "2147483000",
    display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "12px"
  });

  var frame = document.createElement("iframe");
  frame.src = origin + "/embed/" + id + "?widget=1";
  frame.title = "Assistant";
  frame.setAttribute("referrerpolicy", "strict-origin");
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox");
  frame.hidden = true;
  Object.assign(frame.style, {
    width: "min(380px, calc(100vw - 40px))", height: "min(600px, calc(100vh - 110px))",
    border: "1px solid rgba(127,127,127,0.25)", borderRadius: "14px",
    boxShadow: "0 18px 50px rgba(0,0,0,0.22)", background: "#fff", colorScheme: "normal"
  });

  var button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", "Open assistant");
  button.setAttribute("aria-expanded", "false");
  Object.assign(button.style, {
    width: "52px", height: "52px", borderRadius: "999px", border: "0", cursor: "pointer",
    background: "#1f4fd1", color: "#fff", display: "flex", alignItems: "center",
    justifyContent: "center", boxShadow: "0 8px 24px rgba(0,0,0,0.25)"
  });
  var ns = "http://www.w3.org/2000/svg";
  var icon = document.createElementNS(ns, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "22");
  icon.setAttribute("height", "22");
  icon.setAttribute("aria-hidden", "true");
  var path = document.createElementNS(ns, "path");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("d", "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z");
  icon.appendChild(path);
  button.appendChild(icon);

  function setOpen(open) {
    frame.hidden = !open;
    button.setAttribute("aria-expanded", open ? "true" : "false");
    button.setAttribute("aria-label", open ? "Close assistant" : "Open assistant");
    if (open) frame.focus();
  }
  button.addEventListener("click", function () { setOpen(frame.hidden); });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !frame.hidden) { setOpen(false); button.focus(); }
  });
  window.addEventListener("message", function (event) {
    if (event.origin !== origin || event.source !== frame.contentWindow) return;
    if (event.data && event.data.type === "${EMBED_CLOSE_MESSAGE}") { setOpen(false); button.focus(); }
  });

  root.appendChild(frame);
  root.appendChild(button);
  (document.body || document.documentElement).appendChild(root);
})();
`;
}
