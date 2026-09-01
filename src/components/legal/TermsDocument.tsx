import {
  AGPL_NAME,
  AGPL_SPDX,
  CESIUM_SOURCE_URL,
  TERMS_EFFECTIVE_DATE,
  TERMS_SECTIONS,
  TERMS_VERSION,
} from "@/lib/legal/terms";

export function TermsDocument() {
  return (
    <article>
      <p className="mb-[10px] font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-disabled)]">
        Legal · {AGPL_SPDX}
      </p>
      <h1 className="text-balance text-[32px] font-semibold leading-tight tracking-tight">
        Terms of Service
      </h1>
      <p className="mt-[10px] text-[13.5px] text-[var(--text-secondary)]">
        Version {TERMS_VERSION} · Effective {TERMS_EFFECTIVE_DATE}
      </p>
      <p className="mt-[18px] text-[14.5px] leading-relaxed text-[var(--text-secondary)]">
        Short version: you are responsible for secrets you store, agents you
        run, and anything you sync or connect. The software is {AGPL_NAME}.
        Source is on{" "}
        <a
          href={CESIUM_SOURCE_URL}
          target="_blank"
          rel="noreferrer"
          className="text-[var(--text-primary)] underline decoration-[var(--border-card)] underline-offset-[3px] hover:decoration-[var(--text-primary)]"
        >
          GitHub
        </a>
        . Terms can change; you must check this page from time to time.
      </p>

      <nav aria-label="Contents" className="mt-[28px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] px-[18px] py-[16px]">
        <p className="mb-[10px] font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--text-disabled)]">
          Contents
        </p>
        <ol className="columns-1 gap-[24px] text-[13px] leading-[1.7] text-[var(--text-secondary)] sm:columns-2">
          {TERMS_SECTIONS.map((section, index) => (
            <li key={section.id} className="break-inside-avoid">
              <a
                href={`#${section.id}`}
                className="hover:text-[var(--text-primary)]"
              >
                {index + 1}. {section.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="mt-[40px] space-y-[36px]">
        {TERMS_SECTIONS.map((section, index) => (
          <section key={section.id} id={section.id} className="scroll-mt-[80px]">
            <h2 className="text-[18px] font-semibold tracking-tight">
              <span className="mr-[8px] font-mono text-[12px] text-[var(--text-disabled)]">
                {String(index + 1).padStart(2, "0")}
              </span>
              {section.title}
            </h2>
            <div className="mt-[10px] space-y-[12px] text-[14px] leading-[1.7] text-[var(--text-secondary)]">
              {section.paragraphs.map((paragraph) => (
                <p key={paragraph.slice(0, 48)}>{linkifyLegalText(paragraph)}</p>
              ))}
            </div>
          </section>
        ))}
      </div>
    </article>
  );
}

const URL_RE = /(https?:\/\/[^\s]+|\/(?:terms|license)(?:#[\w-]+)?)/g;

function linkifyLegalText(text: string) {
  const parts = text.split(URL_RE);
  return parts.map((part, index) => {
    if (!part) {
      return null;
    }
    if (part.startsWith("http://") || part.startsWith("https://")) {
      return (
        <a
          key={`${part}-${index}`}
          href={part}
          target="_blank"
          rel="noreferrer"
          className="break-words text-[var(--text-primary)] underline decoration-[var(--border-card)] underline-offset-[3px] hover:decoration-[var(--text-primary)]"
        >
          {part.replace(/^https:\/\//, "")}
        </a>
      );
    }
    if (part.startsWith("/")) {
      return (
        <a
          key={`${part}-${index}`}
          href={part}
          className="text-[var(--text-primary)] underline decoration-[var(--border-card)] underline-offset-[3px] hover:decoration-[var(--text-primary)]"
        >
          {part}
        </a>
      );
    }
    return <span key={`${part.slice(0, 24)}-${index}`}>{part}</span>;
  });
}
