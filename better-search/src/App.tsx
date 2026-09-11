import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import searchIcon from "./assets/search.svg";

function App() {
  const contentRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState("");
  const lastSizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });

  // Auto-adjust textarea height dynamically as text wraps or multi-line input is entered
  const adjustTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  };

  useLayoutEffect(() => {
    adjustTextareaHeight();
  }, [query]);

  // Adjust Tauri window size whenever search bar dimensions change
  useEffect(() => {
    const resizeWindow = async () => {
      if (!contentRef.current) return;

      const rect = contentRef.current.getBoundingClientRect();
      const width = Math.ceil(rect.width);
      const height = Math.ceil(rect.height);

      if (width <= 0 || height <= 0) return;

      if (
        lastSizeRef.current.width !== width ||
        lastSizeRef.current.height !== height
      ) {
        try {
          // Attempt via Tauri Rust command first for direct native window resize
          await invoke("resize_window", { width: Number(width), height: Number(height) });
        } catch {
          try {
            const appWindow = getCurrentWindow();
            await appWindow.setSize(new LogicalSize(width, height));
          } catch (err) {
            console.error("Failed to resize Tauri window:", err);
          }
        }
        lastSizeRef.current = { width, height };
      }
    };

    const observer = new ResizeObserver(() => {
      resizeWindow();
    });

    if (contentRef.current) {
      observer.observe(contentRef.current);
    }

    resizeWindow();

    return () => {
      observer.disconnect();
    };
  }, [query]);

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
    <div
      ref={contentRef}
      className="w-[600px] flex items-center gap-[10px] bg-zinc-900/95 text-white border border-zinc-700/60 rounded-none px-5 py-3.5 shadow-2xl backdrop-blur-xl overflow-hidden select-none"
    >
      <div className="flex items-center justify-center size-[15px]">
        <img src={searchIcon} alt="Search" className="w-5 h-5 invert opacity-60 pointer-events-none -translate-0.5" />
      </div>
      <textarea
        ref={textareaRef}
        rows={1}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="what should i look for you?"
        className="w-full bg-transparent text-white placeholder-[#a7a7a7] outline-none resize-none overflow-hidden text-base leading-[12px] font-inter p-0 m-0 scrollbar-none [scrollbar-width:none]"
      />
      {query && (
        <button
          onClick={() => setQuery("")}
          className="shrink-0 text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors flex items-center justify-center w-5 h-6"
          type="button"
          aria-label="Clear search"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}

export default App;