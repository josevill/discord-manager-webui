import { watch as chokidarWatch, type FSWatcher } from "chokidar";

export function watchConfigFile(path: string, onChange: () => void, debounceMs = 500): FSWatcher {
  const watcher = chokidarWatch(path, { ignoreInitial: true });
  let timer: NodeJS.Timeout | undefined;
  watcher.on("all", () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  });
  return watcher;
}
