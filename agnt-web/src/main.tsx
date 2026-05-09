import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "prismjs/themes/prism-tomorrow.css";
import "./styles/global.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Service-worker registration is opt-in via build env so dev (HMR) and tests
// don't get caching surprises. The worker itself ships as `public/sw.js`.
//
// When a new worker activates and evicts older caches, it posts an
// `agnt-cache-evicted` message. We import lazily and surface a soft
// "new version available — reload to apply" toast via notices-store so
// users know their next action might paint with refreshed JS/CSS.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.kind !== "agnt-cache-evicted") return;
    void import("./state/notices-store").then(({ useNoticesStore }) => {
      useNoticesStore.getState().enqueue({
        severity: "info",
        title: "agnt-web updated",
        message: "Reload the page to load the latest build.",
        durationMs: 12_000,
      });
    });
  });
}
