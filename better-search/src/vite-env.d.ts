/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dev only: the first-run screen to open on (onboarding-window.tsx). */
  readonly VITE_ONBOARDING?: string;
}
