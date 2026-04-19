import path from "node:path";

/**
 * Folders rendered dim in the explorer AND never recursed into by `fs/tree`.
 * Keep this list aggressive — walking home-dir caches (`.npm`, `.cargo`,
 * `snap/*`) balloons the initial tree to tens of megabytes and turns the app
 * into a "Loading workspace..." spinner for 30-90s when a Home workspace is
 * rooted at `$HOME`.
 */
const DIMMED_NAMES = new Set([
  // Per-project build / deps
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  ".next",
  ".nuxt",
  ".turbo",
  ".vercel",
  ".parcel-cache",
  ".rollup.cache",
  ".wrangler",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".nyc_output",
  "__pycache__",
  ".pytest_cache",
  ".tox",
  ".mypy_cache",
  ".venv",
  "venv",
  ".gradle",
  ".idea",
  ".vs",
  ".vscode-test",
  // Home-dir caches that explode on walks when the workspace is rooted at $HOME
  ".npm",
  ".pnpm-store",
  ".yarn",
  ".cache",
  ".cargo",
  ".rustup",
  ".pyenv",
  ".rbenv",
  ".nvm",
  ".nix",
  ".gem",
  ".m2",
  ".gradle-user-home",
  ".docker",
  ".local",
  "snap",
  "Library",
  "AppData",
]);

const LANGUAGE_BY_BASENAME = new Map<string, string>([
  [".babelrc", "json"],
  [".bash_aliases", "shell"],
  [".bash_profile", "shell"],
  [".bashrc", "shell"],
  [".cursorignore", "ignore"],
  [".dockerignore", "ignore"],
  [".editorconfig", "ini"],
  [".eslintignore", "ignore"],
  [".eslintrc", "json"],
  [".gitattributes", "ignore"],
  [".gitignore", "ignore"],
  [".gitmodules", "ini"],
  [".hintrc", "json"],
  [".ignore", "ignore"],
  [".jshintrc", "json"],
  [".npmignore", "ignore"],
  [".npmrc", "ini"],
  [".envrc", "shell"],
  [".prettierignore", "ignore"],
  [".prettierrc", "json"],
  [".profile", "shell"],
  [".slugignore", "ignore"],
  [".stylelintignore", "ignore"],
  [".swcrc", "json"],
  [".vercelignore", "ignore"],
  [".watchmanconfig", "json"],
  [".yarnrc", "ini"],
  [".zprofile", "shell"],
  [".zshrc", "shell"],
  ["berksfile", "ruby"],
  ["brewfile", "ruby"],
  ["capfile", "ruby"],
  ["containerfile", "dockerfile"],
  ["dockerfile", "dockerfile"],
  ["fastfile", "ruby"],
  ["gemfile", "ruby"],
  ["guardfile", "ruby"],
  ["podfile", "ruby"],
  ["rakefile", "ruby"],
  ["vagrantfile", "ruby"],
]);

const LANGUAGE_BY_SUFFIX = new Map<string, string>([
  [".blade.php", "php"],
]);

const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  [".bmp", "plaintext"],
  [".bash", "shell"],
  [".bat", "bat"],
  [".c", "cpp"],
  [".cc", "cpp"],
  [".cjs", "javascript"],
  [".clj", "clojure"],
  [".cljs", "clojure"],
  [".cljc", "clojure"],
  [".cmd", "bat"],
  [".conf", "ini"],
  [".cpp", "cpp"],
  [".cs", "csharp"],
  [".cts", "typescript"],
  [".css", "css"],
  [".dart", "dart"],
  [".edn", "clojure"],
  [".erb", "html"],
  [".fish", "shell"],
  [".gif", "plaintext"],
  [".go", "go"],
  [".gql", "graphql"],
  [".graphql", "graphql"],
  [".h", "cpp"],
  [".handlebars", "handlebars"],
  [".hbs", "handlebars"],
  [".hh", "cpp"],
  [".html", "html"],
  [".htm", "html"],
  [".hpp", "cpp"],
  [".hxx", "cpp"],
  [".ico", "plaintext"],
  [".ini", "ini"],
  [".java", "java"],
  [".js", "javascript"],
  [".jpeg", "plaintext"],
  [".jpg", "plaintext"],
  [".json", "json"],
  [".json5", "json"],
  [".jsonc", "json"],
  [".jsx", "javascript"],
  [".kt", "kotlin"],
  [".kts", "kotlin"],
  [".less", "less"],
  [".lua", "lua"],
  [".md", "markdown"],
  [".markdown", "markdown"],
  [".mdx", "markdown"],
  [".m", "objective-c"],
  [".mjs", "javascript"],
  [".mm", "objective-c"],
  [".mts", "typescript"],
  [".php", "php"],
  [".pl", "perl"],
  [".pm", "perl"],
  [".png", "plaintext"],
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
  [".rake", "ruby"],
  [".rs", "rust"],
  [".rb", "ruby"],
  [".ru", "ruby"],
  [".sass", "scss"],
  [".scala", "scala"],
  [".sc", "scala"],
  [".scss", "scss"],
  [".sh", "shell"],
  [".sql", "sql"],
  [".svg", "xml"],
  [".svelte", "html"],
  [".swift", "swift"],
  [".toml", "toml"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".txt", "plaintext"],
  [".vue", "html"],
  [".xml", "xml"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
  [".zsh", "shell"],
]);

const MIME_BY_EXTENSION = new Map<string, string>([
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".htm", "text/html; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".ts", "text/typescript; charset=utf-8"],
  [".tsx", "text/typescript; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".xml", "application/xml; charset=utf-8"],
  [".yaml", "application/yaml; charset=utf-8"],
  [".yml", "application/yaml; charset=utf-8"],
]);

const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);

export function getWorkspaceName(workspaceRoot: string): string {
  return path.basename(workspaceRoot);
}

export function resolveSafePath(workspaceRoot: string, relativePath: string): string {
  const normalizedRelative = relativePath.replace(/\\/g, "/");
  const resolved = path.resolve(workspaceRoot, normalizedRelative);
  const relative = path.relative(workspaceRoot, resolved);

  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Path escapes workspace root: ${relativePath}`);
  }

  return resolved;
}

export function toRelativePath(workspaceRoot: string, absolutePath: string): string {
  return path.relative(workspaceRoot, absolutePath).replace(/\\/g, "/");
}

export function inferLanguage(fileName: string): string {
  const normalizedPath = fileName.replace(/\\/g, "/").toLowerCase();
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

  const extension = path.posix.extname(lowerName);
  return LANGUAGE_BY_EXTENSION.get(extension) ?? "plaintext";
}

export function inferFileKind(fileName: string): "text" | "svg" | "image" {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".svg") {
    return "svg";
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }
  return "text";
}

export function inferMimeType(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  return MIME_BY_EXTENSION.get(extension) ?? "application/octet-stream";
}

export function isDimmed(name: string): boolean {
  return DIMMED_NAMES.has(name);
}

export function shouldIgnorePath(relativePath: string): boolean {
  return relativePath.length === 0;
}
