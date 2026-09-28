import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./library/library.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root không tồn tại");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
