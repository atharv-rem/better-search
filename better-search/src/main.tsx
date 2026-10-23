import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { SettingsWindow } from "./settings/settings-window";
import './App.css'

// Both windows load this page; lib.rs `open_settings` labels the settings one.
const Root = getCurrentWindow().label === "settings" ? SettingsWindow : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
