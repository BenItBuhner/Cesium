import { redirect } from "next/navigation";
import { WORKSPACE_ROUTE } from "@/lib/workbench-view";

type SearchParamsInput = Record<string, string | string[] | undefined>;

function toQueryString(sp: SearchParamsInput): string {
  const qs = new URLSearchParams();
  for (const [key, raw] of Object.entries(sp)) {
    if (raw == null) {
      continue;
    }
    const values = Array.isArray(raw) ? raw : [raw];
    for (const val of values) {
      qs.append(key, val);
    }
  }
  return qs.toString();
}

/** Legacy URL; workbench is a single `/workspace` route (agent is the default when `view` is omitted). */
export default async function LegacyAgentPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  const sp = await searchParams;
  const q = toQueryString(sp);
  redirect(q ? `${WORKSPACE_ROUTE}?${q}` : WORKSPACE_ROUTE);
}
