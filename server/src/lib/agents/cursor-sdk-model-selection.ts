export type CursorSdkModelParam = {
  id: string;
  value: string;
};

export type DecodedCursorSdkModelSelection = {
  id: string;
  params: CursorSdkModelParam[];
};

export function encodeCursorSdkModelValue(
  modelId: string,
  params: CursorSdkModelParam[]
): string {
  const cleanId = modelId.trim();
  const cleanParams = params
    .map((param) => ({
      id: param.id.trim(),
      value: param.value.trim(),
    }))
    .filter((param) => param.id.length > 0 && param.value.length > 0);
  if (cleanParams.length === 0) {
    return cleanId;
  }
  return `${cleanId}[${cleanParams.map((param) => `${param.id}=${param.value}`).join(",")}]`;
}

export function decodeCursorSdkModelValue(value: string): DecodedCursorSdkModelSelection {
  const trimmed = value.trim();
  const match = /^(.*)\[(.*)\]$/.exec(trimmed);
  if (!match) {
    return { id: trimmed, params: [] };
  }
  const id = (match[1] ?? "").trim();
  const params = (match[2] ?? "")
    .split(",")
    .map((entry) => {
      const [rawId, ...rawValueParts] = entry.split("=");
      return {
        id: rawId?.trim() ?? "",
        value: rawValueParts.join("=").trim(),
      };
    })
    .filter((param) => param.id.length > 0 && param.value.length > 0);
  return { id: id || trimmed, params };
}
