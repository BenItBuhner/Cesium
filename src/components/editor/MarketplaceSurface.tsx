"use client";

import { VscodeExtensionsSettingsPanel } from "@/components/editor/vscode-extensions-settings";

export function MarketplaceSurface() {
  return (
    <div className="h-full overflow-auto bg-[var(--bg-main)]">
      <div className="mx-auto max-w-[980px] px-[24px] py-[22px]">
        <VscodeExtensionsSettingsPanel />
      </div>
    </div>
  );
}
