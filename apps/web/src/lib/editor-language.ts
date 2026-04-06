"use client";

const LANGUAGE_ALIASES = new Map<string, string>([
  ["bash", "shell"],
  ["clojurescript", "clojure"],
  ["config", "ini"],
  ["conf", "ini"],
  ["cfg", "ini"],
  ["dotenv", "dotenv"],
  ["env", "dotenv"],
  ["gitignore", "ignore"],
  ["ignore", "ignore"],
  ["mdx", "markdown"],
  ["plain", "plaintext"],
  ["text", "plaintext"],
  ["properties", "ini"],
  ["shellscript", "shell"],
  ["sh", "shell"],
  ["zsh", "shell"],
  ["fish", "shell"],
  ["yml", "yaml"],
]);

const LANGUAGE_BY_BASENAME = new Map<string, string>([
  [".cursorignore", "ignore"],
  [".dockerignore", "ignore"],
  [".editorconfig", "ini"],
  [".envrc", "shell"],
  [".eslintignore", "ignore"],
  [".gitattributes", "ignore"],
  [".gitignore", "ignore"],
  [".gitmodules", "ini"],
  [".ignore", "ignore"],
  [".npmignore", "ignore"],
  [".npmrc", "ini"],
  [".profile", "shell"],
  [".prettierignore", "ignore"],
  [".stylelintignore", "ignore"],
  [".zshrc", "shell"],
  [".yarnrc", "ini"],
  ["containerfile", "dockerfile"],
  ["dockerfile", "dockerfile"],
  ["gemfile", "ruby"],
  ["rakefile", "ruby"],
  ["vagrantfile", "ruby"],
]);

const LANGUAGE_BY_SUFFIX = new Map<string, string>([
  [".blade.php", "php"],
]);

const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  [".bash", "shell"],
  [".bat", "bat"],
  [".c", "cpp"],
  [".cc", "cpp"],
  [".clj", "clojure"],
  [".cljs", "clojure"],
  [".cljc", "clojure"],
  [".cmd", "bat"],
  [".conf", "ini"],
  [".cpp", "cpp"],
  [".cs", "csharp"],
  [".css", "css"],
  [".cts", "typescript"],
  [".dart", "dart"],
  [".erb", "html"],
  [".fish", "shell"],
  [".go", "go"],
  [".gql", "graphql"],
  [".graphql", "graphql"],
  [".h", "cpp"],
  [".handlebars", "handlebars"],
  [".hbs", "handlebars"],
  [".hh", "cpp"],
  [".hpp", "cpp"],
  [".htm", "html"],
  [".html", "html"],
  [".hxx", "cpp"],
  [".ini", "ini"],
  [".java", "java"],
  [".js", "javascript"],
  [".json", "json"],
  [".json5", "json"],
  [".jsonc", "json"],
  [".jsx", "javascript"],
  [".kt", "kotlin"],
  [".kts", "kotlin"],
  [".less", "less"],
  [".lua", "lua"],
  [".m", "objective-c"],
  [".markdown", "markdown"],
  [".md", "markdown"],
  [".mdx", "markdown"],
  [".mjs", "javascript"],
  [".mm", "objective-c"],
  [".mts", "typescript"],
  [".php", "php"],
  [".pl", "perl"],
  [".pm", "perl"],
  [".properties", "ini"],
  [".proto", "protobuf"],
  [".ps1", "powershell"],
  [".psd1", "powershell"],
  [".psm1", "powershell"],
  [".pug", "pug"],
  [".py", "python"],
  [".pyi", "python"],
  [".pyw", "python"],
  [".r", "r"],
  [".rb", "ruby"],
  [".rake", "ruby"],
  [".rs", "rust"],
  [".ru", "ruby"],
  [".sass", "scss"],
  [".sc", "scala"],
  [".scala", "scala"],
  [".scss", "scss"],
  [".sh", "shell"],
  [".sql", "sql"],
  [".svg", "xml"],
  [".svelte", "html"],
  [".swift", "swift"],
  [".toml", "toml"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".vue", "html"],
  [".xml", "xml"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
  [".zsh", "shell"],
]);

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").toLowerCase();
}

export function inferEditorLanguageFromPath(filePath?: string): string | null {
  if (!filePath) {
    return null;
  }

  const normalizedPath = normalizePath(filePath);
  const lowerName = normalizedPath.split("/").at(-1) ?? normalizedPath;

  if (normalizedPath.endsWith("/.git/info/exclude")) {
    return "ignore";
  }

  if (/^\.env(?:\..+)?$/i.test(lowerName)) {
    return "dotenv";
  }

  const basenameLanguage = LANGUAGE_BY_BASENAME.get(lowerName);
  if (basenameLanguage) {
    return basenameLanguage;
  }

  for (const [suffix, language] of LANGUAGE_BY_SUFFIX) {
    if (lowerName.endsWith(suffix)) {
      return language;
    }
  }

  const dotIndex = lowerName.lastIndexOf(".");
  if (dotIndex >= 0) {
    const extension = lowerName.slice(dotIndex);
    return LANGUAGE_BY_EXTENSION.get(extension) ?? null;
  }

  return null;
}

export function resolveEditorLanguageId(
  language?: string,
  filePath?: string
): string {
  const normalizedLanguage = language?.trim().toLowerCase() ?? "";
  const aliasedLanguage = normalizedLanguage
    ? (LANGUAGE_ALIASES.get(normalizedLanguage) ?? normalizedLanguage)
    : null;

  if (aliasedLanguage && aliasedLanguage !== "plaintext") {
    return aliasedLanguage;
  }

  return inferEditorLanguageFromPath(filePath) ?? aliasedLanguage ?? "plaintext";
}
