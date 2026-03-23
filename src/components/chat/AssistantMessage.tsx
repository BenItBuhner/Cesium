interface AssistantMessageProps {
  content: string;
}

export function AssistantMessage({ content }: AssistantMessageProps) {
  return (
    <p className="px-[1px] font-sans text-[14px] font-normal leading-normal text-[var(--text-primary)]">
      {content}
    </p>
  );
}
