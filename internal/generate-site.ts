#!/usr/bin/env -S npx tsx
// Generate a static GitHub Pages site into dist/ from internal/Curriculum.md + dictionary/*.md.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const CURRICULUM = join(HERE, "Curriculum.md");
const DICT_DIR = join(ROOT, "dictionary");
const DIST_DIR = join(ROOT, "dist");

const SECTION_RE = /^## Section \d+ — .+$/;
const BULLET_RE = /^- (.+)$/;
const LINK_RE = /\[([^\]]+)\]\(\.\/([^)]+)\.md\)/g;

type Section = {
  index: number;
  heading: string;
  shortTitle: string;
  terms: string[];
};

type Entry = {
  term: string;
  slug: string;
  sectionIndex: number;
  sectionHeading: string;
  description: string;
  aliases: string[];
  bodyMarkdown: string;
  bodyHtml: string;
  plainText: string;
  outgoing: string[];
  backlinks: string[];
};

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function headingSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .replace(/ /g, "-");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseCurriculum(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;

  text.split("\n").forEach((raw, idx) => {
    const lineNo = idx + 1;
    const line = raw.trimEnd();
    if (line === "") return;

    if (line.startsWith("## ")) {
      if (!SECTION_RE.test(line)) {
        fail(
          `Curriculum.md:${lineNo}: section heading must match "## Section N — Title": ${line}`
        );
      }
      const heading = line.slice(3);
      const shortTitle = heading.replace(/^Section \d+ — /, "");
      current = {
        index: sections.length + 1,
        heading,
        shortTitle,
        terms: [],
      };
      sections.push(current);
      return;
    }

    if (line.startsWith("- ")) {
      if (!current) {
        fail(`Curriculum.md:${lineNo}: bullet before any section heading`);
      }
      const m = line.match(BULLET_RE);
      if (!m || !m[1]) {
        fail(`Curriculum.md:${lineNo}: malformed bullet: ${line}`);
      }
      current.terms.push(m[1]);
      return;
    }

    fail(`Curriculum.md:${lineNo}: unexpected line: ${line}`);
  });

  return sections;
}

function parseFrontmatter(raw: string): {
  description: string;
  aliases: string[];
  body: string;
} {
  if (!raw.startsWith("---\n")) {
    return { description: "", aliases: [], body: raw };
  }
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) {
    return { description: "", aliases: [], body: raw };
  }
  const fm = raw.slice(4, end);
  const body = raw.slice(end + 5).replace(/^\n+/, "");

  let description = "";
  const aliases: string[] = [];
  let inAliases = false;

  for (const line of fm.split("\n")) {
    if (line.startsWith("description:")) {
      inAliases = false;
      description = line
        .slice("description:".length)
        .trim()
        .replace(/^["']|["']$/g, "");
    } else if (line.startsWith("aliases:")) {
      inAliases = true;
    } else if (inAliases && /^\s*-\s+/.test(line)) {
      aliases.push(
        line
          .replace(/^\s*-\s+/, "")
          .trim()
          .replace(/^["']|["']$/g, "")
      );
    } else if (/^\S+:/.test(line)) {
      inAliases = false;
    }
  }

  return { description, aliases, body };
}

function renderInline(md: string, knownTerms: Set<string>): string {
  // Protect inline code spans first
  const codeSpans: string[] = [];
  let text = md.replace(/`([^`]+)`/g, (_, code: string) => {
    const idx = codeSpans.length;
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000CODE${idx}\u0000`;
  });

  // Protect links (internal ./Term.md and external https://...)
  const links: string[] = [];
  text = text.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, label: string, href: string) => {
      const idx = links.length;
      let html: string;
      if (href.startsWith("./") && href.endsWith(".md")) {
        const target = decodeURIComponent(href.slice(2, -3));
        if (!knownTerms.has(target)) {
          fail(`Broken internal link target: ${href}`);
        }
        const slug = headingSlug(target);
        html = `<a class="term-link" href="#${encodeURIComponent(slug)}" data-target="${escapeHtml(slug)}">${escapeHtml(label)}</a>`;
      } else {
        html = `<a class="ext-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
      }
      links.push(html);
      return `\u0000LINK${idx}\u0000`;
    }
  );

  // Escape remaining HTML
  text = escapeHtml(text);

  // Bold **...**
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  // Italic _..._ (avoid matching underscores inside words like foo_bar)
  text = text.replace(
    /(^|[\s（(「“—\-:：，。；、])_([^_\n]+)_(?=[\s）)」”.,;:!?，。；：、—\-]|$)/g,
    "$1<em>$2</em>"
  );

  // Restore links and inline code
  text = text.replace(/\u0000LINK(\d+)\u0000/g, (_, i: string) => {
    return links[Number(i)] ?? "";
  });
  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_, i: string) => {
    return codeSpans[Number(i)] ?? "";
  });

  return text;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return (
    cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell))
  );
}

function renderMarkdown(md: string, knownTerms: Set<string>): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Skip blank lines
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block
    if (line.trimStart().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith("```")) {
        codeLines.push(lines[i] ?? "");
        i++;
      }
      if (i < lines.length) i++;
      blocks.push(
        `<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ""}>${escapeHtml(codeLines.join("\n"))}</code></pre>`
      );
      continue;
    }

    // Markdown table
    if (
      line.trim().startsWith("|") &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1] ?? "")
    ) {
      const headers = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").trim().startsWith("|")) {
        rows.push(splitTableRow(lines[i] ?? ""));
        i++;
      }
      const thead = `<thead><tr>${headers
        .map((h) => `<th>${renderInline(h, knownTerms)}</th>`)
        .join("")}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map(
          (r) =>
            `<tr>${r
              .map((c) => `<td>${renderInline(c, knownTerms)}</td>`)
              .join("")}</tr>`
        )
        .join("")}</tbody>`;
      blocks.push(`<div class="table-wrap"><table>${thead}${tbody}</table></div>`);
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^[-*+]\s+/, ""));
        i++;
      }
      blocks.push(
        `<ul>${items
          .map((item) => `<li>${renderInline(item, knownTerms)}</li>`)
          .join("")}</ul>`
      );
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        `<ol>${items
          .map((item) => `<li>${renderInline(item, knownTerms)}</li>`)
          .join("")}</ol>`
      );
      continue;
    }

    // Blockquote
    if (line.trimStart().startsWith("> ")) {
      const qLines: string[] = [];
      while (i < lines.length && (lines[i] ?? "").trimStart().startsWith("> ")) {
        qLines.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(
        `<blockquote>${renderInline(qLines.join(" "), knownTerms)}</blockquote>`
      );
      continue;
    }

    // Paragraph (collect consecutive non-blank, non-special lines)
    const pLines: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !(lines[i] ?? "").trimStart().startsWith("```") &&
      !(lines[i] ?? "").trim().startsWith("|") &&
      !/^[-*+]\s+/.test(lines[i] ?? "") &&
      !/^\d+\.\s+/.test(lines[i] ?? "") &&
      !(lines[i] ?? "").trimStart().startsWith("> ")
    ) {
      pLines.push(lines[i] ?? "");
      i++;
    }
    const paraText = pLines.join("\n").trim();

    // Style _避免使用：_ and _用法示例：_ cleanly
    if (paraText.startsWith("_避免使用：_")) {
      const rest = paraText.slice("_避免使用：_".length).trim();
      blocks.push(
        `<div class="callout avoid"><span class="callout-label">避免使用</span><span>${renderInline(rest, knownTerms)}</span></div>`
      );
    } else if (paraText === "_用法示例：_") {
      // Collect following quoted dialogue paragraphs as a usage dialogue block
      const dialogue: string[] = [];
      while (i < lines.length) {
        while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
        if (i >= lines.length) break;
        const nextLine = (lines[i] ?? "").trim();
        if (
          nextLine.startsWith("“") ||
          nextLine.startsWith('"') ||
          nextLine.startsWith("「")
        ) {
          const dLines: string[] = [];
          while (i < lines.length && (lines[i] ?? "").trim() !== "") {
            dLines.push(lines[i] ?? "");
            i++;
          }
          dialogue.push(dLines.join(" ").trim());
        } else {
          break;
        }
      }
      if (dialogue.length > 0) {
        blocks.push(
          `<div class="usage-box"><div class="usage-label">用法示例</div>${dialogue
            .map((d) => `<p class="usage-line">${renderInline(d, knownTerms)}</p>`)
            .join("")}</div>`
        );
      } else {
        blocks.push(`<p><em>用法示例：</em></p>`);
      }
    } else {
      blocks.push(`<p>${renderInline(paraText, knownTerms)}</p>`);
    }
  }

  return blocks.join("\n");
}

function stripMarkdownToPlainText(md: string): string {
  return md
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_#|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildHtml(sections: Section[], entries: Entry[]): string {
  const entryByTerm = new Map(entries.map((e) => [e.term, e]));

  const sidebarHtml = sections
    .map((sec) => {
      const items = sec.terms
        .map((term) => {
          const entry = entryByTerm.get(term);
          if (!entry) return "";
          return `<a class="nav-term" href="#${encodeURIComponent(entry.slug)}" data-slug="${escapeHtml(entry.slug)}">${escapeHtml(term)}</a>`;
        })
        .join("\n");
      return `<details class="nav-section" open data-section="${sec.index}">
  <summary class="nav-section-title">
    <span class="nav-section-num">0${sec.index}</span>
    <span class="nav-section-text">${escapeHtml(sec.shortTitle)}</span>
    <span class="nav-section-count">${sec.terms.length}</span>
  </summary>
  <div class="nav-term-list">
    ${items}
  </div>
</details>`;
    })
    .join("\n");

  const sectionPillsHtml = sections
    .map(
      (sec) =>
        `<a class="section-pill" href="#section-${sec.index}"><span class="pill-num">0${sec.index}</span>${escapeHtml(sec.shortTitle.replace(/（.+）$/, ""))}</a>`
    )
    .join("\n");

  const sectionsHtml = sections
    .map((sec) => {
      const cards = sec.terms
        .map((term) => {
          const entry = entryByTerm.get(term);
          if (!entry) return "";

          const aliasesHtml =
            entry.aliases.length > 0
              ? `<div class="entry-aliases">${entry.aliases
                  .map((a) => `<span class="alias-tag">${escapeHtml(a)}</span>`)
                  .join("")}</div>`
              : "";

          const backlinksHtml =
            entry.backlinks.length > 0
              ? `<footer class="backlinks">
  <span class="backlinks-label">被以下词条引用</span>
  <div class="backlinks-list">
    ${entry.backlinks
      .map((src) => {
        const srcEntry = entryByTerm.get(src);
        if (!srcEntry) return "";
        return `<a class="backlink-chip" href="#${encodeURIComponent(srcEntry.slug)}" data-target="${escapeHtml(srcEntry.slug)}">${escapeHtml(src)}</a>`;
      })
      .join("")}
  </div>
</footer>`
              : "";

          const searchIndex = [
            entry.term,
            entry.description,
            ...entry.aliases,
            entry.plainText,
          ]
            .join(" ")
            .toLowerCase();

          return `<article class="entry" id="${escapeHtml(entry.slug)}" data-slug="${escapeHtml(entry.slug)}" data-section="${sec.index}" data-search="${escapeHtml(searchIndex)}">
  <header class="entry-header">
    <div class="entry-meta">
      <span class="entry-section-tag">Section ${sec.index} · ${escapeHtml(sec.shortTitle.replace(/（.+）$/, ""))}</span>
      <button class="copy-link-btn" type="button" data-copy-slug="${escapeHtml(entry.slug)}" title="复制词条链接" aria-label="复制词条链接">#</button>
    </div>
    <h2 class="entry-title">${escapeHtml(entry.term)}</h2>
    ${entry.description ? `<p class="entry-desc">${escapeHtml(entry.description)}</p>` : ""}
    ${aliasesHtml}
  </header>
  <div class="entry-body">
    ${entry.bodyHtml}
  </div>
  ${backlinksHtml}
</article>`;
        })
        .join("\n");

      return `<section class="dict-section" id="section-${sec.index}" data-section="${sec.index}">
  <div class="section-header">
    <span class="section-badge">Section ${sec.index}</span>
    <h2 class="section-title">${escapeHtml(sec.shortTitle)}</h2>
  </div>
  ${cards}
</section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AI Coding 词典（AI Coding Dictionary 中文版）</title>
  <meta name="description" content="将 AI 编程的核心词汇翻译成直白易懂的中文。共 7 个章节、72 个核心术语，支持即时搜索与词条双向引用。" />
  <script>
    (function () {
      var saved = localStorage.getItem("theme");
      var dark = saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    })();
  </script>
  <style>
    :root {
      --bg: #faf9f6;
      --surface: #ffffff;
      --surface-subtle: #f4f3ef;
      --border: #e5e4de;
      --border-strong: #d4d3cb;
      --text: #18181b;
      --text-secondary: #52525b;
      --text-muted: #71717a;
      --accent: #2563eb;
      --accent-soft: rgba(37, 99, 235, 0.09);
      --avoid-bg: #fef2f2;
      --avoid-border: #fecaca;
      --avoid-text: #991b1b;
      --usage-bg: #f8fafc;
      --usage-border: #e2e8f0;
      --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.04);
      --header-h: 60px;
      --sidebar-w: 296px;
      --radius: 10px;
      --font-sans: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", Roboto, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    [data-theme="dark"] {
      --bg: #0d1117;
      --surface: #161b22;
      --surface-subtle: #1c2128;
      --border: #30363d;
      --border-strong: #484f58;
      --text: #e6edf3;
      --text-secondary: #b1bac4;
      --text-muted: #8b949e;
      --accent: #58a6ff;
      --accent-soft: rgba(88, 166, 255, 0.14);
      --avoid-bg: rgba(248, 81, 73, 0.1);
      --avoid-border: rgba(248, 81, 73, 0.35);
      --avoid-text: #ff7b72;
      --usage-bg: #12171e;
      --usage-border: #262c36;
      --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.25);
    }

    * { box-sizing: border-box; }

    html {
      scroll-behavior: smooth;
      scroll-padding-top: calc(var(--header-h) + 20px);
    }

    body {
      margin: 0;
      font-family: var(--font-sans);
      background: var(--bg);
      color: var(--text);
      line-height: 1.75;
      -webkit-font-smoothing: antialiased;
    }

    /* Top Header */
    .topbar {
      position: sticky;
      top: 0;
      z-index: 40;
      height: var(--header-h);
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 20px;
      background: color-mix(in srgb, var(--surface) 88%, transparent);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
    }

    .menu-btn {
      display: none;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      color: var(--text);
      cursor: pointer;
      font-size: 18px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
      color: var(--text);
      font-weight: 700;
      font-size: 16px;
      letter-spacing: -0.01em;
      white-space: nowrap;
    }

    .brand-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
    }

    .search-wrap {
      flex: 1;
      max-width: 460px;
      margin-left: auto;
      position: relative;
      display: flex;
      align-items: center;
    }

    .search-input {
      width: 100%;
      height: 36px;
      padding: 0 56px 0 34px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface-subtle);
      color: var(--text);
      font-size: 14px;
      font-family: inherit;
      outline: none;
      transition: border-color 0.15s, background 0.15s;
    }

    .search-input:focus {
      border-color: var(--accent);
      background: var(--surface);
    }

    .search-icon {
      position: absolute;
      left: 11px;
      color: var(--text-muted);
      pointer-events: none;
      font-size: 14px;
    }

    .search-kbd {
      position: absolute;
      right: 10px;
      font-size: 11px;
      font-family: var(--font-mono);
      color: var(--text-muted);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 1px 5px;
      pointer-events: none;
    }

    .search-clear {
      position: absolute;
      right: 8px;
      display: none;
      border: none;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
      padding: 4px;
    }

    .search-wrap.has-query .search-kbd { display: none; }
    .search-wrap.has-query .search-clear { display: block; }

    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 36px;
      padding: 0 10px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      color: var(--text-secondary);
      text-decoration: none;
      font-size: 13px;
      cursor: pointer;
      transition: border-color 0.15s, color 0.15s;
      white-space: nowrap;
    }

    .icon-btn:hover {
      border-color: var(--border-strong);
      color: var(--text);
    }

    /* Layout */
    .layout {
      display: flex;
      max-width: 1380px;
      margin: 0 auto;
    }

    /* Sidebar */
    .sidebar {
      position: sticky;
      top: var(--header-h);
      width: var(--sidebar-w);
      height: calc(100vh - var(--header-h));
      overflow-y: auto;
      padding: 20px 14px 40px;
      border-right: 1px solid var(--border);
      flex-shrink: 0;
    }

    .nav-section {
      margin-bottom: 10px;
    }

    .nav-section-title {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary);
      cursor: pointer;
      list-style: none;
      user-select: none;
    }

    .nav-section-title::-webkit-details-marker { display: none; }
    .nav-section-title:hover { background: var(--surface-subtle); }

    .nav-section-num {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--accent);
      opacity: 0.9;
    }

    .nav-section-text {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .nav-section-count {
      font-size: 11px;
      color: var(--text-muted);
      font-family: var(--font-mono);
    }

    .nav-term-list {
      display: flex;
      flex-direction: column;
      margin-top: 2px;
      padding-left: 10px;
      border-left: 1px solid var(--border);
      margin-left: 14px;
    }

    .nav-term {
      display: block;
      padding: 5px 10px;
      border-radius: 6px;
      font-size: 13px;
      color: var(--text-secondary);
      text-decoration: none;
      line-height: 1.4;
      transition: background 0.12s, color 0.12s;
    }

    .nav-term:hover {
      background: var(--surface-subtle);
      color: var(--text);
    }

    .nav-term.active {
      background: var(--accent-soft);
      color: var(--accent);
      font-weight: 600;
    }

    .nav-term.hidden,
    .nav-section.hidden {
      display: none;
    }

    /* Main Content */
    .main {
      flex: 1;
      min-width: 0;
      padding: 32px 40px 80px;
      max-width: 900px;
      margin: 0 auto;
    }

    .hero {
      padding: 28px 32px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      box-shadow: var(--shadow-sm);
      margin-bottom: 32px;
    }

    .hero h1 {
      margin: 0 0 12px;
      font-size: 28px;
      line-height: 1.3;
      letter-spacing: -0.02em;
    }

    .hero p {
      margin: 0 0 12px;
      color: var(--text-secondary);
      font-size: 15px;
    }

    .hero-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 16px;
      font-size: 13px;
      color: var(--text-muted);
    }

    .hero-meta a {
      color: var(--accent);
      text-decoration: none;
    }

    .hero-meta a:hover { text-decoration: underline; }

    .section-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 18px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
    }

    .section-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 11px;
      border-radius: 999px;
      background: var(--surface-subtle);
      border: 1px solid var(--border);
      color: var(--text-secondary);
      text-decoration: none;
      font-size: 13px;
      transition: border-color 0.15s, color 0.15s;
    }

    .section-pill:hover {
      border-color: var(--accent);
      color: var(--accent);
    }

    .pill-num {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--accent);
    }

    .search-status {
      display: none;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      margin-bottom: 24px;
      border-radius: var(--radius);
      background: var(--accent-soft);
      color: var(--text);
      font-size: 14px;
    }

    .search-status.visible { display: flex; }

    .empty-state {
      display: none;
      text-align: center;
      padding: 56px 20px;
      color: var(--text-muted);
      background: var(--surface);
      border: 1px dashed var(--border);
      border-radius: var(--radius);
    }

    .empty-state.visible { display: block; }

    /* Sections & Entries */
    .dict-section {
      margin-bottom: 48px;
    }

    .dict-section.hidden { display: none; }

    .section-header {
      display: flex;
      align-items: baseline;
      gap: 12px;
      margin-bottom: 20px;
      padding-bottom: 10px;
      border-bottom: 2px solid var(--border);
    }

    .section-badge {
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 600;
      color: var(--accent);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }

    .section-title {
      margin: 0;
      font-size: 20px;
      line-height: 1.35;
    }

    .entry {
      padding: 24px 28px;
      margin-bottom: 20px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: var(--shadow-sm);
      transition: border-color 0.2s, box-shadow 0.2s;
    }

    .entry.hidden { display: none; }

    .entry.flash {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-soft);
    }

    .entry-header {
      margin-bottom: 16px;
    }

    .entry-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 6px;
    }

    .entry-section-tag {
      font-size: 12px;
      color: var(--text-muted);
      font-weight: 500;
    }

    .copy-link-btn {
      border: 1px solid transparent;
      background: transparent;
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 14px;
      padding: 2px 7px;
      border-radius: 6px;
      cursor: pointer;
    }

    .copy-link-btn:hover {
      border-color: var(--border);
      color: var(--accent);
      background: var(--surface-subtle);
    }

    .entry-title {
      margin: 0 0 10px;
      font-size: 22px;
      line-height: 1.3;
      letter-spacing: -0.01em;
    }

    .entry-desc {
      margin: 0;
      padding: 10px 14px;
      border-left: 3px solid var(--accent);
      background: var(--surface-subtle);
      border-radius: 0 8px 8px 0;
      font-size: 14.5px;
      color: var(--text-secondary);
      line-height: 1.65;
    }

    .entry-aliases {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 10px;
    }

    .alias-tag {
      font-size: 12px;
      font-family: var(--font-mono);
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--surface-subtle);
      border: 1px solid var(--border);
      color: var(--text-muted);
    }

    .entry-body p {
      margin: 0 0 14px;
      font-size: 15.5px;
    }

    .entry-body p:last-child { margin-bottom: 0; }

    .entry-body ul,
    .entry-body ol {
      margin: 0 0 14px;
      padding-left: 22px;
      font-size: 15.5px;
    }

    .entry-body li { margin-bottom: 6px; }

    .entry-body code {
      font-family: var(--font-mono);
      font-size: 0.88em;
      padding: 2px 6px;
      border-radius: 5px;
      background: var(--surface-subtle);
      border: 1px solid var(--border);
    }

    .entry-body pre {
      overflow-x: auto;
      padding: 14px 16px;
      border-radius: 8px;
      background: var(--surface-subtle);
      border: 1px solid var(--border);
      margin: 0 0 14px;
    }

    .entry-body pre code {
      padding: 0;
      border: none;
      background: transparent;
    }

    .term-link {
      color: var(--accent);
      text-decoration: none;
      border-bottom: 1px dashed color-mix(in srgb, var(--accent) 55%, transparent);
      transition: background 0.12s;
    }

    .term-link:hover {
      background: var(--accent-soft);
      border-bottom-style: solid;
    }

    .ext-link {
      color: var(--accent);
      text-decoration: underline;
    }

    .table-wrap {
      overflow-x: auto;
      margin: 16px 0;
      border: 1px solid var(--border);
      border-radius: 8px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
      line-height: 1.6;
    }

    th, td {
      padding: 10px 14px;
      text-align: left;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }

    th {
      background: var(--surface-subtle);
      font-weight: 600;
      color: var(--text);
      white-space: nowrap;
    }

    tr:last-child td { border-bottom: none; }

    .callout.avoid {
      display: flex;
      gap: 10px;
      align-items: baseline;
      padding: 11px 14px;
      margin: 14px 0;
      border-radius: 8px;
      background: var(--avoid-bg);
      border: 1px solid var(--avoid-border);
      font-size: 14.5px;
    }

    .callout-label {
      flex-shrink: 0;
      font-size: 12px;
      font-weight: 700;
      color: var(--avoid-text);
      padding: 1px 6px;
      border-radius: 4px;
      border: 1px solid var(--avoid-border);
    }

    .usage-box {
      margin-top: 16px;
      padding: 14px 16px;
      border-radius: 8px;
      background: var(--usage-bg);
      border: 1px solid var(--usage-border);
    }

    .usage-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 8px;
      letter-spacing: 0.02em;
    }

    .usage-line {
      margin: 0 0 8px !important;
      font-size: 14.5px !important;
      color: var(--text-secondary);
    }

    .usage-line:last-child { margin-bottom: 0 !important; }

    .backlinks {
      margin-top: 18px;
      padding-top: 14px;
      border-top: 1px solid var(--border);
    }

    .backlinks-label {
      display: block;
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 8px;
    }

    .backlinks-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .backlink-chip {
      font-size: 12.5px;
      padding: 3px 9px;
      border-radius: 999px;
      background: var(--surface-subtle);
      border: 1px solid var(--border);
      color: var(--text-secondary);
      text-decoration: none;
      transition: border-color 0.12s, color 0.12s;
    }

    .backlink-chip:hover {
      border-color: var(--accent);
      color: var(--accent);
    }

    .drawer-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 45;
      background: rgba(0, 0, 0, 0.45);
    }

    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 60;
      padding: 10px 16px;
      border-radius: 8px;
      background: var(--text);
      color: var(--bg);
      font-size: 13px;
      opacity: 0;
      transform: translateY(8px);
      pointer-events: none;
      transition: opacity 0.2s, transform 0.2s;
    }

    .toast.show {
      opacity: 1;
      transform: translateY(0);
    }

    @media (max-width: 960px) {
      .menu-btn { display: inline-flex; }
      .sidebar {
        position: fixed;
        top: var(--header-h);
        left: 0;
        z-index: 50;
        background: var(--surface);
        transform: translateX(-100%);
        transition: transform 0.2s ease;
        box-shadow: 4px 0 24px rgba(0, 0, 0, 0.15);
      }
      .sidebar.open { transform: translateX(0); }
      .drawer-backdrop.open { display: block; }
      .main { padding: 20px 16px 64px; }
      .hero { padding: 20px; }
      .entry { padding: 18px; }
      .brand-badge { display: none; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <button class="menu-btn" id="menuBtn" type="button" aria-label="打开目录">☰</button>
    <a class="brand" href="#">
      <span>AI Coding 词典</span>
      <span class="brand-badge">${entries.length} 词</span>
    </a>
    <div class="search-wrap" id="searchWrap">
      <span class="search-icon">⌕</span>
      <input class="search-input" id="searchInput" type="search" placeholder="搜索中文词条、英文原词、别名或正文…" autocomplete="off" />
      <span class="search-kbd">/</span>
      <button class="search-clear" id="searchClear" type="button" aria-label="清空搜索">×</button>
    </div>
    <div class="topbar-actions">
      <button class="icon-btn" id="themeToggle" type="button" aria-label="切换深浅色主题">切换主题</button>
      <a class="icon-btn" href="https://github.com/kirinboy/dictionary-of-ai-coding-cn" target="_blank" rel="noopener noreferrer">GitHub</a>
    </div>
  </header>

  <div class="drawer-backdrop" id="drawerBackdrop"></div>

  <div class="layout">
    <aside class="sidebar" id="sidebar" aria-label="词典目录">
      ${sidebarHtml}
    </aside>

    <main class="main">
      <section class="hero">
        <h1>AI Coding 词典（中文版）</h1>
        <p><strong>AI 编程常常让人觉得只有专家才能玩转</strong>：满屏难懂的黑话、莫名其妙的翻车、还有跟实际工作量完全对不上的账单。其实这套工具的基本规则花一个下午就能掌握——本词典将 AI 编程的核心词汇翻译成直白易懂的中文。</p>
        <div class="hero-meta">
          <span>共 ${sections.length} 个章节 · ${entries.length} 个词条 · 支持词条双向引用</span>
          <span>·</span>
          <span>原著：<a href="https://github.com/mattpocock/dictionary-of-ai-coding" target="_blank" rel="noopener noreferrer">mattpocock/dictionary-of-ai-coding</a></span>
        </div>
        <nav class="section-pills" aria-label="章节快速跳转">
          ${sectionPillsHtml}
        </nav>
      </section>

      <div class="search-status" id="searchStatus">
        <span id="searchStatusText"></span>
        <button class="icon-btn" id="resetSearchBtn" type="button">清除筛选</button>
      </div>

      <div class="empty-state" id="emptyState">
        没有找到匹配的词条，试试换一个关键词（支持中文、英文原词或缩写）。
      </div>

      ${sectionsHtml}
    </main>
  </div>

  <div class="toast" id="toast" role="status" aria-live="polite"></div>

  <script>
    (function () {
      var searchInput = document.getElementById("searchInput");
      var searchWrap = document.getElementById("searchWrap");
      var searchClear = document.getElementById("searchClear");
      var searchStatus = document.getElementById("searchStatus");
      var searchStatusText = document.getElementById("searchStatusText");
      var resetSearchBtn = document.getElementById("resetSearchBtn");
      var emptyState = document.getElementById("emptyState");
      var themeToggle = document.getElementById("themeToggle");
      var menuBtn = document.getElementById("menuBtn");
      var sidebar = document.getElementById("sidebar");
      var backdrop = document.getElementById("drawerBackdrop");
      var toast = document.getElementById("toast");

      var entries = Array.prototype.slice.call(document.querySelectorAll(".entry"));
      var sections = Array.prototype.slice.call(document.querySelectorAll(".dict-section"));
      var navTerms = Array.prototype.slice.call(document.querySelectorAll(".nav-term"));
      var navSections = Array.prototype.slice.call(document.querySelectorAll(".nav-section"));

      function showToast(msg) {
        toast.textContent = msg;
        toast.classList.add("show");
        clearTimeout(showToast._t);
        showToast._t = setTimeout(function () {
          toast.classList.remove("show");
        }, 1800);
      }

      // Theme toggle
      function updateThemeLabel() {
        var dark = document.documentElement.dataset.theme === "dark";
        themeToggle.textContent = dark ? "浅色" : "深色";
      }
      updateThemeLabel();
      themeToggle.addEventListener("click", function () {
        var next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        localStorage.setItem("theme", next);
        updateThemeLabel();
      });

      // Mobile drawer
      function closeDrawer() {
        sidebar.classList.remove("open");
        backdrop.classList.remove("open");
      }
      menuBtn.addEventListener("click", function () {
        sidebar.classList.toggle("open");
        backdrop.classList.toggle("open");
      });
      backdrop.addEventListener("click", closeDrawer);

      // Search filtering
      function applyFilter(rawQuery) {
        var q = rawQuery.trim().toLowerCase();
        searchWrap.classList.toggle("has-query", q.length > 0);

        var tokens = q ? q.split(/\\s+/).filter(Boolean) : [];
        var visibleSlugs = new Set();
        var visibleSections = new Set();

        entries.forEach(function (el) {
          var haystack = el.dataset.search || "";
          var matched = tokens.every(function (t) { return haystack.indexOf(t) !== -1; });
          el.classList.toggle("hidden", !matched);
          if (matched) {
            visibleSlugs.add(el.dataset.slug);
            visibleSections.add(el.dataset.section);
          }
        });

        sections.forEach(function (sec) {
          sec.classList.toggle("hidden", !visibleSections.has(sec.dataset.section));
        });

        navTerms.forEach(function (a) {
          a.classList.toggle("hidden", !visibleSlugs.has(a.dataset.slug));
        });

        navSections.forEach(function (det) {
          var show = visibleSections.has(det.dataset.section);
          det.classList.toggle("hidden", !show);
          if (show && q) det.open = true;
        });

        if (q) {
          searchStatus.classList.add("visible");
          searchStatusText.textContent = "找到 " + visibleSlugs.size + " 个与「" + rawQuery.trim() + "」相关的词条";
          emptyState.classList.toggle("visible", visibleSlugs.size === 0);
        } else {
          searchStatus.classList.remove("visible");
          emptyState.classList.remove("visible");
        }
      }

      searchInput.addEventListener("input", function () {
        applyFilter(searchInput.value);
      });

      function clearSearch() {
        searchInput.value = "";
        applyFilter("");
      }

      searchClear.addEventListener("click", function () {
        clearSearch();
        searchInput.focus();
      });
      resetSearchBtn.addEventListener("click", clearSearch);

      // Keyboard shortcuts: / or Cmd/Ctrl+K to focus search, Esc to clear
      document.addEventListener("keydown", function (e) {
        if ((e.key === "/" && document.activeElement !== searchInput) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) {
          e.preventDefault();
          searchInput.focus();
          searchInput.select();
        } else if (e.key === "Escape" && document.activeElement === searchInput) {
          clearSearch();
          searchInput.blur();
        }
      });

      // Highlight target entry on internal link click
      function flashTarget(slug) {
        var target = document.getElementById(slug);
        if (!target) return;
        if (target.classList.contains("hidden")) {
          clearSearch();
        }
        target.classList.remove("flash");
        void target.offsetWidth;
        target.classList.add("flash");
        setTimeout(function () { target.classList.remove("flash"); }, 1400);
      }

      document.addEventListener("click", function (e) {
        var link = e.target.closest("a.term-link, a.backlink-chip, a.nav-term");
        if (link) {
          var slug = link.dataset.target || link.dataset.slug;
          if (slug) {
            if (document.getElementById(slug) && document.getElementById(slug).classList.contains("hidden")) {
              clearSearch();
            }
            closeDrawer();
            setTimeout(function () { flashTarget(slug); }, 80);
          }
          return;
        }
        var copyBtn = e.target.closest(".copy-link-btn");
        if (copyBtn) {
          var copySlug = copyBtn.dataset.copySlug;
          var url = window.location.origin + window.location.pathname + "#" + encodeURIComponent(copySlug);
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(function () {
              showToast("已复制词条链接");
            });
          } else {
            showToast(url);
          }
        }
      });

      // Active sidebar scrollspy
      if ("IntersectionObserver" in window) {
        var navMap = new Map();
        navTerms.forEach(function (a) { navMap.set(a.dataset.slug, a); });
        var currentActive = null;
        var observer = new IntersectionObserver(function (obsEntries) {
          obsEntries.forEach(function (item) {
            if (item.isIntersecting) {
              var slug = item.target.dataset.slug;
              var navEl = navMap.get(slug);
              if (navEl && navEl !== currentActive) {
                if (currentActive) currentActive.classList.remove("active");
                navEl.classList.add("active");
                currentActive = navEl;
              }
            }
          });
        }, { rootMargin: "-15% 0px -75% 0px" });
        entries.forEach(function (el) { observer.observe(el); });
      }
    })();
  </script>
</body>
</html>
`;
}

function main(): void {
  const sections = parseCurriculum(readFileSync(CURRICULUM, "utf8"));
  const knownTerms = new Set<string>();

  for (const sec of sections) {
    for (const term of sec.terms) {
      if (knownTerms.has(term)) {
        fail(`Curriculum.md: duplicate term "${term}"`);
      }
      knownTerms.add(term);
    }
  }

  const onDisk = new Set(
    readdirSync(DICT_DIR)
      .filter((n) => n.endsWith(".md"))
      .map((n) => n.slice(0, -3))
  );
  const orphans = [...onDisk].filter((t) => !knownTerms.has(t)).sort();
  if (orphans.length > 0) {
    fail(
      `dictionary/ entries not referenced by Curriculum.md: ${orphans.join(", ")}`
    );
  }

  const entries: Entry[] = [];
  const backlinksMap = new Map<string, string[]>();

  for (const sec of sections) {
    for (const term of sec.terms) {
      const entryPath = join(DICT_DIR, `${term}.md`);
      let raw: string;
      try {
        raw = readFileSync(entryPath, "utf8");
      } catch {
        fail(`Curriculum.md references "${term}" but ${entryPath} does not exist`);
      }
      const { description, aliases, body } = parseFrontmatter(raw);
      const outgoingSet = new Set<string>();
      for (const m of body.matchAll(LINK_RE)) {
        const targetRaw = m[2];
        if (!targetRaw) continue;
        const target = decodeURIComponent(targetRaw);
        if (target !== term && knownTerms.has(target)) {
          outgoingSet.add(target);
        }
      }
      const outgoing = [...outgoingSet];
      for (const target of outgoing) {
        const list = backlinksMap.get(target) ?? [];
        list.push(term);
        backlinksMap.set(target, list);
      }

      entries.push({
        term,
        slug: headingSlug(term),
        sectionIndex: sec.index,
        sectionHeading: sec.heading,
        description,
        aliases,
        bodyMarkdown: body,
        bodyHtml: renderMarkdown(body, knownTerms),
        plainText: stripMarkdownToPlainText(body),
        outgoing,
        backlinks: [],
      });
    }
  }

  for (const entry of entries) {
    entry.backlinks = backlinksMap.get(entry.term) ?? [];
  }

  mkdirSync(DIST_DIR, { recursive: true });
  writeFileSync(join(DIST_DIR, "index.html"), buildHtml(sections, entries));
  writeFileSync(join(DIST_DIR, ".nojekyll"), "");
  console.log(
    `Generated dist/index.html (${entries.length} entries across ${sections.length} sections).`
  );
}

main();
