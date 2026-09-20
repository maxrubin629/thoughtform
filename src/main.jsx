import React from "react";
import { createRoot } from "react-dom/client";
import { CanonicalSessionApp } from "./CanonicalSessionApp.jsx";
import "./styles.css";

// Keep old bookmarks working while presenting a single workspace.
const url = new URL(window.location.href);
if (url.searchParams.has("mode")) {
  url.searchParams.delete("mode");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <CanonicalSessionApp />
  </React.StrictMode>,
);
