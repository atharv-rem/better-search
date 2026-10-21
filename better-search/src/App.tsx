import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { InputMessage } from "@/components/ui/input-message";

function App() {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLDivElement>(null);

  // Focus the search bar whenever the window is shown and focused (Alt+S)
  useEffect(() => {
    const focusSearch = () => searchRef.current?.querySelector("textarea")?.focus();
    focusSearch();

    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) focusSearch();
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Hide window when pressing Escape
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        try {
          await invoke("hide_window");
        } catch {
          try {
            await getCurrentWindow().hide();
          } catch (err) {
            console.error("Failed to hide window:", err);
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  return (
    // Full-window translucent tint (no blur, so no extra GPU work)
    <div className="dark flex h-screen w-screen items-center justify-center bg-black/70 select-none">
      <div className="w-110">
        <InputMessage
          ref={searchRef}
          size="compact"
          maxRows={4}
          value={query}
          onValueChange={setQuery}
          onSend={(text) => console.log("send:", text)}
          placeholder="what should i look for you?"
          className="gap-0! bg-black! p-[5px]! text-white"
          style={{
            boxShadow:
              "0 0 0 1px rgb(255 255 255 / 0.1), 0 4px 12px rgb(0 0 0 / 0.8), 0 20px 50px rgb(0 0 0 / 0.95), 0 40px 120px rgb(0 0 0 / 0.9)",
          }}
          textareaProps={{ className: "placeholder:text-zinc-400!" }}
        />
      </div>
    </div>
  );
}

export default App;
