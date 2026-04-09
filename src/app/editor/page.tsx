import { redirect } from "next/navigation";
import { WORKBENCH_VIEW_SEARCH_PARAM } from "@/lib/workbench-view";

type SearchParamsInput = Record<string, string | string[] | undefined>;

function buildEditorRedirectQuery(sp: SearchParamsInput): string {
  const qs = new URLSearchParams();
  for (const [key, raw] of Object.entries(sp)) {
    if (key === WORKBENCH_VIEW_SEARCH_PARAM) {
      continue;
    }
    if (raw == null) {
      continue;
    }
    const values = Array.isArray(raw) ? raw : [raw];
    for (const val of values) {
      qs.append(key, val);
    }
  }
  qs.set(WORKBENCH_VIEW_SEARCH_PARAM, "editor");
  return qs.toString();
}

/** Legacy URL; classic IDE is `/?view=editor` on the same workbench route. */
export default async function LegacyEditorPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  const sp = await searchParams;
  redirect(`/?${buildEditorRedirectQuery(sp)}`);
}
