import React, { type ComponentType } from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import './App.css'

// Every window loads this page; lib.rs labels the settings and first-run ones.
// Each loads only its own page's code: the search window, which stays open in
// the background, never holds the settings or first-run screens in memory.
const label = getCurrentWindow().label;
const page: Promise<ComponentType> =
  label === "settings"
    ? import("./settings/settings-window").then((m) => m.SettingsWindow)
    : label === "onboarding"
      ? import("./onboarding/onboarding-window").then((m) => m.OnboardingWindow)
      : import("./App").then((m) => m.default);

page.then((Root) =>
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  ),
);
