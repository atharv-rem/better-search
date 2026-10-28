import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { ArcBands } from "@/components/arc-bands";

/** The settings home: the product mark on the red arc bands. */
export function HomeSection() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  return (
    <div className="relative isolate flex h-full w-full items-center justify-center overflow-hidden bg-black select-none">
      <ArcBands />

      <div className="flex items-center gap-2.5">
        <img src="/logo.svg" alt="" className="size-7 invert" />
        <h2 className="font-pixel text-[24px] leading-none whitespace-nowrap text-white">better-search</h2>
        {version && (
          <span className="mt-1 rounded-full bg-white px-2 py-0.5 text-[10px] leading-none font-semibold text-black">
            v {version}
          </span>
        )}
      </div>
    </div>
  );
}
