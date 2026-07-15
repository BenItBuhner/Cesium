import { redirect } from "next/navigation";
import { WORKSPACE_ROUTE } from "@/lib/workbench-view";

type SearchParamsInput = Record<string, string | string[] | undefined>;

function toQueryString(sp: SearchParamsInput): string {
  const qs = new URLSearchParams();
  for (const [key, raw] of Object.entries(sp)) {
    if (raw == null) {
      continue;
    }
    // Drop legacy classic-IDE view; agent shell is the only workbench.
    if (key === "view") {
      const values = Array.isArray(raw) ? raw : [raw];
      const kept = values.filter((v) => v === "settings" || v === "agent");
      for (const val of kept) {
        if (val === "settings") {
          qs.append(key, val);
        }
      }
      continue;
    }
    const values = Array.isArray(raw) ? raw : [raw];
    for (const val of values) {
      qs.append(key, val);
    }
  }
  return qs.toString();
}

/** Legacy URL; workbench lives at `/agent`. */
export default async function LegacyWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  const sp = await searchParams;
  const q = toQueryString(sp);
  redirect(q ? `${WORKSPACE_ROUTE}?${q}` : WORKSPACE_ROUTE);
}
