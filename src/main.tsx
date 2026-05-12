import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

// Remove the splash screen immediately for the monitor-picker window so the
// picker UI is visible as soon as it loads. The main window keeps the splash
// until startup completes (handled by startupStore.markShellReady).
if (
  window.location.hash === "#/monitor-picker" ||
  window.location.hash.startsWith("#/monitor-picker/")
) {
  document.getElementById("splash")?.remove();
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
