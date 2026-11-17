import React from "react";
import ReactDOM from "react-dom/client";
import "../theme/index.ts";

/** Render a page component into #root (loads the theme CSS). */
export function mount(node: React.ReactNode): void {
  ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode>{node}</React.StrictMode>);
}
