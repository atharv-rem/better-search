import { useCallback, useEffect, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { KeyStatus } from "@/lib/web-search";
import googleLogo from "@/assets/logos/google.svg";
import groqLogo from "@/assets/logos/groq.svg";
import openRouterLogo from "@/assets/logos/openrouter.svg";
import githubLogo from "@/assets/logos/github.svg";
import openAiLogo from "@/assets/logos/openai.svg";
import anthropicLogo from "@/assets/logos/anthropic.svg";
import deepSeekLogo from "@/assets/logos/deepseek.svg";
import perplexityLogo from "@/assets/logos/perplexity.svg";
import ollamaLogo from "@/assets/logos/ollama.svg";
import lmStudioLogo from "@/assets/logos/lmstudio.svg";

// Answers from an AI model with the user's own key, or a model on this
// machine (ai.rs). As with web search, the keys stay in the shell.

/** Keep in step with `PROVIDERS` in ai.rs. `env` is the variable a .env file
 *  keeps its key in; `model` is what's used until the user picks one (empty:
 *  the first the provider lists). `free`: has a free tier; `local`: runs on
 *  this machine, without a key. `logo` is bundled, never fetched. */
export const AI_PROVIDERS = [
  {
    id: "google",
    name: "Google AI Studio",
    short: "Gemini",
    keyUrl: "https://aistudio.google.com/apikey",
    env: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    model: "gemini-flash-latest",
    free: true,
    local: false,
    logo: googleLogo,
  },
  {
    id: "groq",
    name: "Groq",
    short: "Groq",
    keyUrl: "https://console.groq.com/keys",
    env: ["GROQ_API_KEY"],
    model: "llama-3.3-70b-versatile",
    free: true,
    local: false,
    logo: groqLogo,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    short: "OpenRouter",
    keyUrl: "https://openrouter.ai/settings/keys",
    env: ["OPENROUTER_API_KEY"],
    model: "",
    free: true,
    local: false,
    logo: openRouterLogo,
  },
  {
    id: "github",
    name: "GitHub Models",
    short: "GitHub",
    keyUrl: "https://github.com/settings/personal-access-tokens",
    env: ["GITHUB_TOKEN", "GITHUB_MODELS_TOKEN"],
    model: "openai/gpt-4.1-mini",
    free: true,
    local: false,
    logo: githubLogo,
  },
  {
    id: "openai",
    name: "OpenAI",
    short: "ChatGPT",
    keyUrl: "https://platform.openai.com/api-keys",
    env: ["OPENAI_API_KEY"],
    model: "gpt-5-mini",
    free: false,
    local: false,
    logo: openAiLogo,
  },
  {
    id: "anthropic",
    name: "Claude",
    short: "Claude",
    keyUrl: "https://platform.claude.com/settings/keys",
    env: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
    model: "claude-opus-5-5",
    free: false,
    local: false,
    logo: anthropicLogo,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    short: "DeepSeek",
    keyUrl: "https://platform.deepseek.com/api_keys",
    env: ["DEEPSEEK_API_KEY"],
    model: "deepseek-chat",
    free: false,
    local: false,
    logo: deepSeekLogo,
  },
  {
    id: "perplexity",
    name: "Perplexity",
    short: "Perplexity",
    keyUrl: "https://www.perplexity.ai/account/api/keys",
    env: ["PERPLEXITY_API_KEY", "PPLX_API_KEY"],
    model: "sonar",
    free: false,
    local: false,
    logo: perplexityLogo,
  },
  {
    id: "ollama",
    name: "Ollama",
    short: "Ollama",
    keyUrl: "https://ollama.com/download",
    env: [],
    model: "",
    free: true,
    local: true,
    logo: ollamaLogo,
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    short: "LM Studio",
    keyUrl: "https://lmstudio.ai/download",
    env: [],
    model: "",
    free: true,
    local: true,
    logo: lmStudioLogo,
  },
] as const;

export type AiProviderId = (typeof AI_PROVIDERS)[number]["id"];
export type AiProvider = (typeof AI_PROVIDERS)[number];

/** The ones with a key to save, for the keys table. */
export const AI_KEY_PROVIDERS = AI_PROVIDERS.filter((p) => !p.local);

export function aiProviderOf(id: string): AiProvider | null {
  return AI_PROVIDERS.find((p) => p.id === id) ?? null;
}

/** A web result the answer cites by its number (1-based). */
export interface AiSource {
  title: string;
  url: string;
  snippet: string;
}

type AiEvent = { kind: "text"; text: string } | { kind: "sources"; sources: AiSource[] };

/** Asks `provider` (`model` empty: its default), drawing on `sources`.
 *  `onText` gets each piece of the answer as it arrives; `onSources` the pages
 *  a provider searched itself. Resolves once the answer is complete (or
 *  stopped); rejects with a message to show. */
export function askAi(
  provider: AiProviderId,
  model: string,
  question: string,
  sources: AiSource[],
  onText: (text: string) => void,
  onSources: (sources: AiSource[]) => void
): Promise<void> {
  const onEvent = new Channel<AiEvent>();
  onEvent.onmessage = (e) => (e.kind === "text" ? onText(e.text) : onSources(e.sources));
  return invoke<void>("ask_ai", { provider, model, question, sources, onEvent }).catch((err) => {
    throw new Error(String(err));
  });
}

/** Stops the answer that's streaming in, if any. */
export function stopAi() {
  invoke("stop_ai").catch(() => {});
}

/** The models `provider` offers, for suggestions; null while they load or
 *  when there's no asking (no key). */
export function useAiModels(provider: AiProviderId | null, enabled: boolean) {
  const [models, setModels] = useState<{ provider: string; list: string[]; error: string | null } | null>(null);
  useEffect(() => {
    if (!provider || !enabled) return;
    let cancelled = false;
    invoke<string[]>("ai_models", { provider })
      .then((list) => !cancelled && setModels({ provider, list, error: null }))
      .catch((err) => !cancelled && setModels({ provider, list: [], error: String(err) }));
    return () => {
      cancelled = true;
    };
  }, [provider, enabled]);
  return provider && enabled && models?.provider === provider ? models : null;
}

/** Which AI providers have a key, and ways to change that. Each change
 *  resolves with a message to show if it didn't happen. */
export function useAiKeys() {
  const [keys, setKeys] = useState<KeyStatus[] | null>(null);
  useEffect(() => {
    invoke<KeyStatus[]>("ai_keys")
      .then(setKeys)
      .catch(() => setKeys(AI_KEY_PROVIDERS.map((p) => ({ provider: p.id, hint: null }))));
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

  const save = useCallback((provider: string, key: string) => change("save_ai_key", { provider, key }), [change]);
  const remove = useCallback((provider: string) => change("remove_ai_key", { provider }), [change]);
  return { keys, save, remove };
}
