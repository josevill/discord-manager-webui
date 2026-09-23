import { useEffect, useState } from "react";

export type LayoutMode = "phone" | "tablet" | "desktop";

function readLayoutMode(): LayoutMode {
  if (typeof window === "undefined") return "desktop";
  if (window.matchMedia("(max-width: 767px)").matches) return "phone";
  if (window.matchMedia("(max-width: 1099px)").matches) return "tablet";
  return "desktop";
}

export function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(readLayoutMode);

  useEffect(() => {
    const mqPhone = window.matchMedia("(max-width: 767px)");
    const mqTablet = window.matchMedia("(min-width: 768px) and (max-width: 1099px)");
    const update = () => setMode(readLayoutMode());
    update();
    mqPhone.addEventListener("change", update);
    mqTablet.addEventListener("change", update);
    return () => {
      mqPhone.removeEventListener("change", update);
      mqTablet.removeEventListener("change", update);
    };
  }, []);

  return mode;
}
