import type { Metadata } from "next";
import { LegalPageShell } from "@/components/legal/LegalPageShell";
import { TermsDocument } from "@/components/legal/TermsDocument";
import { TERMS_EFFECTIVE_DATE, TERMS_VERSION } from "@/lib/legal/terms";

export const metadata: Metadata = {
  title: "Terms of Service - Cesium",
  description: `Cesium Terms of Service, version ${TERMS_VERSION}, effective ${TERMS_EFFECTIVE_DATE}.`,
};

export default function TermsPage() {
  return (
    <LegalPageShell title="Terms of Service">
      <TermsDocument />
    </LegalPageShell>
  );
}
