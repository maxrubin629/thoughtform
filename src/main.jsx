import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { SessionApp } from "./SessionApp.jsx";
import "./styles.css";

const sessionMode = new URLSearchParams(window.location.search).get("mode") === "session";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {sessionMode ? <SessionApp /> : <App />}
  </React.StrictMode>,
);
