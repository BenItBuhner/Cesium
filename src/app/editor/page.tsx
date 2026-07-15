import { redirect } from "next/navigation";
import { WORKSPACE_ROUTE } from "@/lib/workbench-view";

type SearchParamsInput = Record<string, string | string[] | undefined>;

function toQueryString(sp: SearchParamsInput): string {
  const qs = new URLSearchParams();
  for (const [key, raw] of Object.entries(sp)) {
    if (raw == null) {
      continue;
    }
    // Classic IDE route is gone; never forward `view=editor`.
    if (key === "view") {
      const values = Array.isArray(raw) ? raw : [raw];
      for (const val of values) {
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

/** Legacy URL; classic IDE shell was removed — agent route is the workbench. */
export default async function LegacyEditorPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  const sp = await searchParams;
  const q = toQueryString(sp);
  redirect(q ? `${WORKSPACE_ROUTE}?${q}` : WORKSPACE_ROUTE);
}
