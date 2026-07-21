import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { CanonicalSessionApp } from "./CanonicalSessionApp.jsx";
import "./styles.css";

const mode = new URLSearchParams(window.location.search).get("mode");
const classicMode = mode === "classic";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {classicMode ? <App /> : <CanonicalSessionApp />}
  </React.StrictMode>,
);
