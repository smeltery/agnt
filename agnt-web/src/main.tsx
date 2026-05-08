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
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
