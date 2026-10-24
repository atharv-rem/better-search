import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SEARCH_ENGINES, type Settings } from "@/lib/settings";
import { BrowserIcon, useInstalledBrowsers } from "@/components/browser-icon";
import { Shortcut } from "@/components/ui/kbd";
import { ActionButton, Group, Row, Segmented, Select, Switch } from "@/settings/controls";

type Save = (change: (s: Settings) => Settings) => Promise<string | null>;

const RESULT_LIMITS = [25, 50, 100, 200, 500].map((n) => ({ value: n, label: `${n} results` }));

export function SearchSection({ settings, save }: { settings: Settings; save: Save }) {
  const { search } = settings;
  const set = (change: Partial<Settings["search"]>) => save((s) => ({ ...s, search: { ...s.search, ...change } }));
  const [cleared, setCleared] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  return (
    <>
      <Group>
        <Row label="Results" description="How many matches a search lists at most.">
          <Select
            label="Results"
            value={search.max_results}
            // A limit picked elsewhere (the file) still shows.
            options={
              RESULT_LIMITS.some((o) => o.value === search.max_results)
                ? RESULT_LIMITS
                : [...RESULT_LIMITS, { value: search.max_results, label: `${search.max_results} results` }]
            }
            onChange={(max_results) => set({ max_results })}
          />
        </Row>
        <Row label="Enter" description={
            <>
              What <Shortcut keys={["Enter"]} /> does to a result. <Shortcut keys={["Ctrl", "Enter"]} /> does the other.
            </>
          }>
          <Segmented
            label="Enter"
            value={search.enter_reveals ? "reveal" : "open"}
            options={[
              { value: "open", label: "Open file" },
              { value: "reveal", label: "Show in Explorer" },
            ]}
            onChange={(v) => set({ enter_reveals: v === "reveal" })}
          />
        </Row>
      </Group>
      <Group>
        <Row label="Preview" description="Show a thumbnail or the first lines of the selected result.">
          <Switch checked={search.show_preview} onChange={(show_preview) => set({ show_preview })} label="Preview" />
        </Row>
        <Row label="Clear the search when closed" description="Start from an empty box instead of your last search.">
          <Switch
            checked={search.clear_on_close}
            onChange={(clear_on_close) => set({ clear_on_close })}
            label="Clear the search when closed"
          />
        </Row>
        <Row
          label="Recent searches"
          description="List your last searches under the empty search box. Turning this off forgets them."
          error={clearError}
        >
          {search.remember_recent && (
            <ActionButton
              disabled={cleared}
              onClick={() =>
                invoke("clear_recent_searches")
                  .then(() => {
                    setCleared(true);
                    setClearError(null);
                  })
                  .catch((err) => setClearError(String(err)))
              }
            >
              {cleared ? "Cleared" : "Clear"}
            </ActionButton>
          )}
          <Switch
            checked={search.remember_recent}
            onChange={(remember_recent) => {
              setCleared(false);
              set({ remember_recent });
            }}
            label="Recent searches"
          />
        </Row>
      </Group>
    </>
  );
}

export function WebSection({ settings, save }: { settings: Settings; save: Save }) {
  const { web } = settings;
  const browsers = useInstalledBrowsers(null);
  const browser = browsers.find((b) => b.id === web.browser) ?? browsers[0];
  // "Custom" shows the URL box before a URL is saved; searches keep using the
  // saved engine until one is.
  const [customOpen, setCustomOpen] = useState(web.engine === "custom");
  const [draftUrl, setDraftUrl] = useState(web.custom_url || "https://");
  const [urlError, setUrlError] = useState<string | null>(null);
  useEffect(() => {
    if (web.engine === "custom") setCustomOpen(true);
  }, [web.engine]);
  useEffect(() => {
    if (web.custom_url) setDraftUrl(web.custom_url);
  }, [web.custom_url]);

  const setWeb = (change: Partial<Settings["web"]>) => save((s) => ({ ...s, web: { ...s.web, ...change } }));

  const chooseEngine = async (engine: Settings["web"]["engine"]) => {
    setUrlError(null);
    if (engine === "custom") {
      setCustomOpen(true);
      if (web.custom_url) setUrlError(await setWeb({ engine }));
      return;
    }
    setCustomOpen(false);
    setUrlError(await setWeb({ engine }));
  };

  const saveUrl = async () => {
    if (web.engine === "custom" && draftUrl.trim() === web.custom_url) return;
    setUrlError(await setWeb({ engine: "custom", custom_url: draftUrl }));
  };

  return (
    <Group
      footer={
        <>
          Start a search with <span className="text-zinc-300">/</span> to search the web. Tab switches the browser.
        </>
      }
    >
      <Row label="Search engine">
        <Select
          label="Search engine"
          value={customOpen ? "custom" : web.engine}
          options={[...SEARCH_ENGINES.map((e) => ({ value: e.id, label: e.name })), { value: "custom" as const, label: "Custom" }]}
          onChange={chooseEngine}
        />
      </Row>
      {customOpen && (
        <Row label="Search URL" description="Your search goes where %s is." error={urlError}>
          <input
            value={draftUrl}
            onChange={(e) => setDraftUrl(e.target.value)}
            onBlur={saveUrl}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            placeholder="https://example.com/search?q=%s"
            aria-label="Search URL"
            spellCheck={false}
            className="h-7 w-72 rounded-md bg-white/[0.07] px-2.5 text-[11px] leading-4 text-white outline-hidden placeholder:text-zinc-500 focus:ring-1 focus:ring-[#6B97FF]"
          />
        </Row>
      )}
      <Row label="Browser" description="Where web searches open.">
        <Select
          label="Browser"
          value={browser.id}
          options={browsers.map((b) => ({ value: b.id, label: b.name, icon: <BrowserIcon browser={b} size={14} /> }))}
          onChange={(id) => setWeb({ browser: id })}
        />
      </Row>
    </Group>
  );
}
