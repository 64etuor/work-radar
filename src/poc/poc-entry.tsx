import React from "react";
import ReactDOM from "react-dom/client";
import { PocSettings } from "./PocSettings";
import "./poc.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PocSettings />
  </React.StrictMode>,
);
