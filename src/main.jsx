import React from "react";
import { createRoot } from "react-dom/client";
import { CanonicalSessionApp } from "./CanonicalSessionApp.jsx";
import { liveWorkspaceClient } from "./workspaceClient.js";
import "./styles.css";

// Keep old bookmarks working while presenting a single workspace.
const url = new URL(window.location.href);
if (url.searchParams.has("mode")) {
  url.searchParams.delete("mode");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

const root = createRoot(document.getElementById("root"));
const example = import.meta.env.MODE === "example" || url.pathname === "/example" || url.searchParams.get("example") === "1";
async function start() {
  const client = example
    ? (await import("./exampleWorkspace.js")).createExampleWorkspace()
    : liveWorkspaceClient;
  root.render(<React.StrictMode><CanonicalSessionApp client={client} /></React.StrictMode>);
}
start().catch(() => root.render(<p role="alert">ThoughtForm could not open. Please reload this page.</p>));
