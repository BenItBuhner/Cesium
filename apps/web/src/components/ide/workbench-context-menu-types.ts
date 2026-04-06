export type WorkbenchMenuItem =
  | {
      type: "item";
      id: string;
      label: string;
      shortcut?: string;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { type: "sep" };
