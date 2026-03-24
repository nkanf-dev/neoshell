import React from "react";
import ReactDOM from "react-dom/client";

import { NeoShellApp } from "./components/neo-shell-app";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <NeoShellApp />
  </React.StrictMode>
);
