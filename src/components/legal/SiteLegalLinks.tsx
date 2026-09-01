import Link from "next/link";
import {
  AGPL_SPDX,
  CESIUM_SOURCE_URL,
  LICENSE_PATH,
  TERMS_PATH,
} from "@/lib/legal/terms";

const linkClass = "transition-colors hover:text-[var(--text-primary)]";

/** Footer legal cluster used on marketing pages. */
export function SiteLegalLinks() {
  return (
    <>
      <Link href={TERMS_PATH} className={linkClass}>
        Terms
      </Link>
      <Link href={LICENSE_PATH} className={linkClass}>
        License
      </Link>
      <a href={CESIUM_SOURCE_URL} target="_blank" rel="noreferrer" className={linkClass}>
        Source
      </a>
      <Link href={LICENSE_PATH} className={`font-mono ${linkClass}`}>
        {AGPL_SPDX}
      </Link>
    </>
  );
}
