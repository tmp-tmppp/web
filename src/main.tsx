import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Bootstrap } from "./Bootstrap";
import "./styles.css";
import "./pages.css";

const container = document.getElementById("root");
if (!container) throw new Error("index.html has no #root element");

createRoot(container).render(
  <StrictMode>
    <Bootstrap />
  </StrictMode>,
);
