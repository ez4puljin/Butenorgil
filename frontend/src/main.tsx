import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./app";
import "./styles/index.css";

// ── Pinch zoom бүрэн хориглох ─────────────────────────────────────────────
// Chrome Android user-scalable=no-г дүрмийн дагуу үл тоодог тул JS ашиглана.
document.addEventListener(
  "touchmove",
  (e) => { if (e.touches.length > 1) e.preventDefault(); },
  { passive: false }
);
document.addEventListener(
  "touchstart",
  (e) => { if (e.touches.length > 1) e.preventDefault(); },
  { passive: false }
);
// Double-tap zoom хориглох
let _lastTap = 0;
document.addEventListener("touchend", (e) => {
  const now = Date.now();
  if (now - _lastTap < 300) e.preventDefault();
  _lastTap = now;
}, false);
// ─────────────────────────────────────────────────────────────────────────────

// ── PWA Service Worker бүртгэл ───────────────────────────────────────────
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
// ─────────────────────────────────────────────────────────────────────────────

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
