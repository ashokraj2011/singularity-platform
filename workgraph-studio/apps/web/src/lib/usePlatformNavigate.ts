import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { toPlatformPath } from "./platformRoutes";

export type PlatformNavigateOptions = { replace?: boolean };

/**
 * Drop-in replacement for react-router's useNavigate(), backed by Next's router.
 * Accepts the call shapes the workgraph-web pages already use:
 *   navigate("/runs/123")               → router.push   (mapped to the Next route)
 *   navigate("/x", { replace: true })   → router.replace
 *   navigate(-1)                        → router.back()
 *
 * Paths are translated to canonical platform-web routes via toPlatformPath(),
 * since these pages run in-process inside platform-web (Next) where the route
 * namespace differs from workgraph-web's historical internal paths.
 */
export function usePlatformNavigate() {
  const router = useRouter();
  return useCallback(
    (to: string | number, opts?: PlatformNavigateOptions) => {
      if (typeof to === "number") {
        router.back();
        return;
      }
      const path = toPlatformPath(to);
      if (opts?.replace) router.replace(path);
      else router.push(path);
    },
    [router],
  );
}
