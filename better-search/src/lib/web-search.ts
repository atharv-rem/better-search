import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import contextLogo from "@/assets/logos/context.svg";
import exaLogo from "@/assets/logos/exa.svg";
import firecrawlLogo from "@/assets/logos/firecrawl.svg";
import tinyfishLogo from "@/assets/logos/tinyfish.svg";

// Web search with the user's own API key for a search provider (web_search.rs).
// The keys stay in the shell: pages only learn whether one is saved.

/** Keep in step with `PROVIDERS` in web_search.rs. `logo` is bundled, never
 *  fetched; `env` is the variable a .env file keeps its key in. */
export const PROVIDERS = [
  {
    id: "exa",
    name: "Exa",
    description: "Search built for AI, with the passages that match from each page.",
    keyUrl: "https://dashboard.exa.ai/api-keys",
    logo: exaLogo,
    env: ["EXA_API_KEY"],
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    description: "Web search from Firecrawl's scraping API.",
    keyUrl: "https://www.firecrawl.dev/app/api-keys",
    logo: firecrawlLogo,
    env: ["FIRECRAWL_API_KEY"],
  },
  {
    id: "tinyfish",
    name: "TinyFish",
    description: "Web search from TinyFish's agent platform.",
    keyUrl: "https://agent.tinyfish.ai/api-keys",
    logo: tinyfishLogo,
    env: ["TINYFISH_API_KEY"],
  },
  {
    id: "context",
    name: "Context.dev",
    description: "Web search from Context.dev's web data API.",
    keyUrl: "https://www.context.dev/",
    logo: contextLogo,
    env: ["CONTEXT_DEV_API_KEY", "CONTEXT_API_KEY"],
  },
] as const;

export type ProviderId = (typeof PROVIDERS)[number]["id"];
export type Provider = (typeof PROVIDERS)[number];

export function providerOf(id: string): Provider | null {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

export interface KeyStatus {
  provider: ProviderId;
  /** The key's last four characters; null when there's no key. */
  hint: string | null;
}

/** How much the key's account has used (`api_usage` in web_search.rs). */
export interface Usage {
  /** In `unit`s, over this `period`. */
  used: number | null;
  /** Credits left; null when the provider doesn't say. */
  left: number | null;
  unit: "credits" | "searches" | "usd";
  period: "month" | "billing period";
  /** Counted from Better Search's own searches, not reported by the provider. */
  local: boolean;
  /** The account's prepaid balance in US dollars. */
  balance_usd: number | null;
}

const count = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
// Sub-dollar amounts get a third digit: a search costs fractions of a cent.
const dollars = (n: number) =>
  n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: n > 0 && n < 1 ? 3 : 2,
  });

/** "1,240 credits used this month · 8,760 left". */
export function describeUsage(u: Usage) {
  const parts: string[] = [];
  if (u.used !== null) {
    const amount =
      u.unit === "usd"
        ? `${dollars(u.used)} spent`
        : u.unit === "searches"
          ? `${count(u.used)} ${u.used === 1 ? "search" : "searches"}`
          : `${count(u.used)} ${u.used === 1 ? "credit" : "credits"} used`;
    parts.push(`${amount}${u.local ? " through Better Search" : ""} this ${u.period}`);
  }
  if (u.left !== null) parts.push(`${count(u.left)} left`);
  if (u.balance_usd !== null) parts.push(`${dollars(u.balance_usd)} balance`);
  return parts.join(" · ") || "No usage reported yet.";
}

/** The key's usage, asked again whenever `key` (its hint) changes; nothing
 *  without a key. */
export function useUsage(provider: ProviderId, key: string | null | undefined) {
  const [usage, setUsage] = useState<{ key: string; value: Usage | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    invoke<Usage>("api_usage", { provider })
      .then((value) => !cancelled && setUsage({ key, value, error: null }))
      .catch((err) => !cancelled && setUsage({ key, value: null, error: String(err) }));
    return () => {
      cancelled = true;
    };
  }, [provider, key]);
  // Loading (undefined) until the answer for this key is in.
  return key && usage?.key === key ? usage : undefined;
}

/** Searches with the saved key. Rejects with a message to show. */
export function webSearch(provider: ProviderId, query: string): Promise<WebResult[]> {
  return invoke<WebResult[]>("web_search", { provider, query }).catch((err) => {
    throw new Error(String(err));
  });
}

/** Which providers have a key, and ways to change that. Each change resolves
 *  with a message to show if it didn't happen. */
export function useApiKeys() {
  const [keys, setKeys] = useState<KeyStatus[] | null>(null);
  useEffect(() => {
    invoke<KeyStatus[]>("api_keys")
      .then(setKeys)
      .catch(() => setKeys(PROVIDERS.map((p) => ({ provider: p.id, hint: null }))));
  }, []);

  const change = useCallback(async (command: string, args: Record<string, string>) => {
    try {
      const status = await invoke<KeyStatus>(command, args);
      setKeys((ks) => ks && ks.map((k) => (k.provider === status.provider ? status : k)));
      return null;
    } catch (err) {
      return String(err);
    }
  }, []);

  const save = useCallback((provider: ProviderId, key: string) => change("save_api_key", { provider, key }), [change]);
  const remove = useCallback((provider: ProviderId) => change("remove_api_key", { provider }), [change]);
  return { keys, save, remove };
}
