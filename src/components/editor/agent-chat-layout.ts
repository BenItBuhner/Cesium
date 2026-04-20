/** Default: original editor horizontal inset. Narrow pane (≤640px container): safe-area only, aligned with agent center. */
export const EDITOR_CHAT_INSET_X_CLASS =
  "px-[clamp(28px,8vw,144px)] @max-[640px]:px-0 @max-[640px]:pl-[max(0px,env(safe-area-inset-left,0px))] @max-[640px]:pr-[max(0px,env(safe-area-inset-right,0px))]";
export const EDITOR_CHAT_CONTENT_CLASS =
  "mx-auto w-full max-w-[min(860px,calc(100%-28px))] @max-[640px]:mx-0 @max-[640px]:max-w-full";
export const EDITOR_CHAT_TRANSCRIPT_CONTAINER_CLASS = `${EDITOR_CHAT_CONTENT_CLASS} py-[clamp(18px,3.5vh,30px)]`;
