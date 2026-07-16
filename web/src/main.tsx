import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./design/global.css";
import "./design/components.css";
import "./design/layout.css";
import "./design/graph.css";
import "./design/cloud.css";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
