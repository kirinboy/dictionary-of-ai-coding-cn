#!/usr/bin/env -S npx tsx
// Generate a static GitHub Pages site into dist/ from internal/Curriculum.md + dictionary/*.md.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const CURRICULUM = join(HERE, "Curriculum.md");
const RELATIONS_FILE = join(HERE, "map-relations.json");
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

type MapRelations = {
  labeledRelations: Record<string, { verb: string; desc: string }>;
  confusable: Record<string, Array<{ id: string; note: string }>>;
};

function loadMapRelations(
  entries: Entry[],
  edges: Array<{ source: string; target: string }>
): MapRelations {
  const raw = JSON.parse(readFileSync(RELATIONS_FILE, "utf8")) as MapRelations;
  const validSlugs = new Set(entries.map((e) => e.slug));
  const edgeSet = new Set(edges.map((e) => `${e.source}->${e.target}`));

  for (const key of Object.keys(raw.labeledRelations)) {
    const parts = key.split("->");
    const src = parts[0];
    const dst = parts[1];
    if (!src || !dst || !validSlugs.has(src) || !validSlugs.has(dst)) {
      fail(`map-relations.json: invalid labeledRelations key "${key}"`);
    }
    if (!edgeSet.has(key)) {
      fail(
        `map-relations.json: labeledRelations "${key}" does not match an actual link in dictionary/*.md`
      );
    }
  }

  for (const [slug, items] of Object.entries(raw.confusable)) {
    if (!validSlugs.has(slug)) {
      fail(`map-relations.json: unknown confusable key "${slug}"`);
    }
    for (const item of items) {
      if (!validSlugs.has(item.id)) {
        fail(
          `map-relations.json: unknown confusable target "${item.id}" under "${slug}"`
        );
      }
    }
  }

  return raw;
}

function buildGraphData(sections: Section[], entries: Entry[]) {
  const slugByTerm = new Map(entries.map((e) => [e.term, e.slug]));
  const nodes = entries.map((e) => ({
    id: e.slug,
    term: e.term,
    shortLabel: e.term.replace(/（.+）$/, ""),
    section: e.sectionIndex,
    description: e.description,
    aliases: e.aliases,
    outCount: e.outgoing.length,
    inCount: e.backlinks.length,
  }));
  const edges: Array<{ source: string; target: string }> = [];
  for (const e of entries) {
    for (const targetTerm of e.outgoing) {
      const targetSlug = slugByTerm.get(targetTerm);
      if (targetSlug) {
        edges.push({ source: e.slug, target: targetSlug });
      }
    }
  }
  const sectionMeta = sections.map((s) => ({
    index: s.index,
    heading: s.heading,
    shortTitle: s.shortTitle.replace(/（.+）$/, ""),
    count: s.terms.length,
  }));
  const relations = loadMapRelations(entries, edges);
  return {
    sections: sectionMeta,
    nodes,
    edges,
    labeledRelations: relations.labeledRelations,
    confusable: relations.confusable,
  };
}

function buildHtml(
  sections: Section[],
  entries: Entry[],
  graphJson: string
): string {
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
      <div class="entry-actions">
        <button class="graph-jump-btn" type="button" data-graph-slug="${escapeHtml(entry.slug)}" title="在知识图谱中定位此词条">图谱定位</button>
        <button class="copy-link-btn" type="button" data-copy-slug="${escapeHtml(entry.slug)}" title="复制词条链接" aria-label="复制词条链接">#</button>
      </div>
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
  <meta name="description" content="将 AI 编程的核心词汇翻译成直白易懂的中文。共 7 个章节、72 个核心术语，支持即时搜索与交互式知识图谱。" />
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

    .entry-actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .graph-jump-btn {
      border: 1px solid var(--border);
      background: var(--surface-subtle);
      color: var(--text-secondary);
      font-size: 12px;
      font-family: inherit;
      padding: 2px 8px;
      border-radius: 6px;
      cursor: pointer;
      transition: border-color 0.15s, color 0.15s;
    }

    .graph-jump-btn:hover {
      border-color: var(--accent);
      color: var(--accent);
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

    /* View switcher */
    .view-switch {
      display: inline-flex;
      padding: 3px;
      border-radius: 9px;
      background: var(--surface-subtle);
      border: 1px solid var(--border);
      gap: 2px;
    }

    .view-tab {
      border: none;
      background: transparent;
      color: var(--text-secondary);
      font-size: 13px;
      font-weight: 500;
      font-family: inherit;
      padding: 4px 12px;
      border-radius: 6px;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s, color 0.15s;
    }

    .view-tab.active {
      background: var(--surface);
      color: var(--text);
      box-shadow: var(--shadow-sm);
      font-weight: 600;
    }

    body[data-view="map"] .layout { display: none; }
    body[data-view="map"] .menu-btn { display: none !important; }
    body[data-view="map"] .graph-view { display: none; }
    body[data-view="map"] .map-view { display: flex; }

    body[data-view="graph"] .layout { display: none; }
    body[data-view="graph"] .menu-btn { display: none !important; }
    body[data-view="graph"] .map-view { display: none; }
    body[data-view="graph"] .graph-view { display: flex; }

    body[data-view="dict"] .map-view { display: none; }
    body[data-view="dict"] .graph-view { display: none; }

    /* Editorial Knowledge Map View (Prototype-inspired) */
    .map-view {
      display: none;
      flex-direction: column;
      height: calc(100vh - var(--header-h));
      background: #f6f5ef;
      color: #1f2421;
      overflow: hidden;
    }

    [data-theme="dark"] .map-view {
      background: #101413;
      color: #e6ebe8;
    }

    .map-workspace {
      flex: 1;
      min-height: 0;
      display: flex;
      gap: 16px;
      padding: 16px 20px 12px;
      overflow: hidden;
    }

    .map-canvas-shell {
      flex: 1;
      min-width: 0;
      position: relative;
      background: #fcfbf8;
      border: 1px solid #e3e1d8;
      border-radius: 16px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    [data-theme="dark"] .map-canvas-shell {
      background: #141918;
      border-color: #27302d;
    }

    .map-viewport {
      flex: 1;
      overflow: auto;
      position: relative;
      padding: 18px 20px 56px;
    }

    .map-board {
      position: relative;
      transform-origin: top left;
      transition: transform 0.18s ease;
      min-width: 860px;
    }

    .map-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(260px, 1fr));
      gap: 16px;
      align-items: start;
      position: relative;
      z-index: 2;
    }

    .map-col {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .map-svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 4;
      overflow: visible;
    }

    .map-zone {
      border-radius: 22px;
      padding: 16px 16px 18px;
      transition: opacity 0.2s;
    }

    .map-zone[data-sec="1"] { background: #e9f2e6; }
    .map-zone[data-sec="2"] { background: #e6f0f8; }
    .map-zone[data-sec="3"] { background: #ece8f5; }
    .map-zone[data-sec="4"] { background: #f8ece6; }
    .map-zone[data-sec="5"] { background: #f8f0e2; }
    .map-zone[data-sec="6"] { background: #ede9f5; }
    .map-zone[data-sec="7"] { background: #e7f2e7; }

    [data-theme="dark"] .map-zone[data-sec="1"] { background: rgba(46, 107, 72, 0.18); }
    [data-theme="dark"] .map-zone[data-sec="2"] { background: rgba(59, 130, 196, 0.18); }
    [data-theme="dark"] .map-zone[data-sec="3"] { background: rgba(111, 92, 195, 0.18); }
    [data-theme="dark"] .map-zone[data-sec="4"] { background: rgba(217, 107, 67, 0.18); }
    [data-theme="dark"] .map-zone[data-sec="5"] { background: rgba(217, 146, 38, 0.17); }
    [data-theme="dark"] .map-zone[data-sec="6"] { background: rgba(124, 92, 196, 0.18); }
    [data-theme="dark"] .map-zone[data-sec="7"] { background: rgba(60, 141, 87, 0.18); }

    .map-zone-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 12px;
      padding: 0 4px;
    }

    .map-zone-title {
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: #1f2421;
    }

    [data-theme="dark"] .map-zone-title { color: #eef3f0; }

    .map-zone-toggle {
      border: none;
      background: rgba(255, 255, 255, 0.62);
      color: #4b5563;
      font-size: 11.5px;
      font-family: inherit;
      padding: 3px 9px;
      border-radius: 999px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }

    .map-zone-toggle:hover { background: rgba(255, 255, 255, 0.95); color: #111827; }
    [data-theme="dark"] .map-zone-toggle { background: rgba(255, 255, 255, 0.08); color: #cbd5e1; }
    [data-theme="dark"] .map-zone-toggle:hover { background: rgba(255, 255, 255, 0.16); color: #ffffff; }

    .map-zone-cards {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .map-card {
      position: relative;
      display: flex;
      align-items: flex-start;
      gap: 10px;
      width: 100%;
      text-align: left;
      padding: 10px 16px;
      border-radius: 26px;
      background: rgba(255, 255, 255, 0.94);
      border: 1.5px solid rgba(20, 24, 22, 0.1);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
      cursor: pointer;
      font-family: inherit;
      color: inherit;
      transition: border-color 0.15s, box-shadow 0.18s, transform 0.12s, opacity 0.18s;
    }

    [data-theme="dark"] .map-card {
      background: rgba(24, 30, 28, 0.92);
      border-color: rgba(255, 255, 255, 0.1);
    }

    .map-card:hover {
      border-color: #2e6b48;
      transform: translateY(-1px);
    }

    .map-card.selected {
      border: 2px solid #2e6b48;
      box-shadow: 0 0 0 4px rgba(177, 223, 128, 0.5), 0 4px 12px rgba(46, 107, 72, 0.14);
      background: #ffffff;
      z-index: 3;
    }

    [data-theme="dark"] .map-card.selected {
      border-color: #5cc487;
      box-shadow: 0 0 0 4px rgba(92, 196, 135, 0.25);
      background: #1b2421;
    }

    .map-card.related {
      border-color: rgba(46, 107, 72, 0.55);
    }

    .map-card.dimmed {
      opacity: 0.42;
    }

    .map-card.hidden { display: none; }

    .map-card-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      margin-top: 6px;
      flex-shrink: 0;
    }

    .map-card-content {
      min-width: 0;
      flex: 1;
    }

    .map-card-title {
      font-size: 14px;
      font-weight: 700;
      line-height: 1.35;
      color: #181c1a;
    }

    [data-theme="dark"] .map-card-title { color: #f1f5f3; }

    .map-card-sub {
      font-size: 11.5px;
      color: #5c635f;
      line-height: 1.4;
      margin-top: 2px;
      display: -webkit-box;
      -webkit-line-clamp: 1;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    [data-theme="dark"] .map-card-sub { color: #9aa5a0; }

    .map-footer-bar {
      position: absolute;
      left: 14px;
      right: 14px;
      bottom: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      pointer-events: none;
      z-index: 6;
    }

    .map-legend-inline {
      pointer-events: auto;
      display: inline-flex;
      align-items: center;
      gap: 14px;
      padding: 6px 12px;
      border-radius: 999px;
      background: rgba(252, 251, 248, 0.92);
      border: 1px solid #e3e1d8;
      backdrop-filter: blur(8px);
      font-size: 12px;
      color: #525955;
    }

    [data-theme="dark"] .map-legend-inline {
      background: rgba(20, 25, 24, 0.9);
      border-color: #27302d;
      color: #a6b2ac;
    }

    .map-legend-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .map-line-swatch {
      width: 18px;
      height: 2px;
      border-radius: 2px;
    }

    .map-tools-right {
      pointer-events: auto;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }

    .map-mode-btn {
      border: 1px solid #dcdad0;
      background: rgba(255, 255, 255, 0.94);
      color: #374151;
      font-size: 12px;
      font-family: inherit;
      padding: 5px 11px;
      border-radius: 999px;
      cursor: pointer;
    }

    .map-mode-btn:hover { border-color: #2e6b48; color: #2e6b48; }
    .map-mode-btn.active { background: #2e6b48; border-color: #2e6b48; color: #ffffff; }
    [data-theme="dark"] .map-mode-btn { background: #1a211f; border-color: #2d3834; color: #d1d8d4; }
    [data-theme="dark"] .map-mode-btn.active { background: #2e6b48; border-color: #2e6b48; color: #ffffff; }

    .map-zoom-pill {
      display: inline-flex;
      align-items: center;
      background: rgba(255, 255, 255, 0.94);
      border: 1px solid #dcdad0;
      border-radius: 999px;
      overflow: hidden;
      font-size: 12px;
    }

    [data-theme="dark"] .map-zoom-pill { background: #1a211f; border-color: #2d3834; }

    .map-zoom-btn {
      border: none;
      background: transparent;
      color: inherit;
      padding: 5px 9px;
      cursor: pointer;
      font-family: inherit;
    }

    .map-zoom-btn:hover { background: rgba(0, 0, 0, 0.05); }
    .map-zoom-val { padding: 0 4px; font-family: var(--font-mono); font-size: 11.5px; color: var(--text-muted); }

    /* Right Editorial Detail Card */
    .map-detail {
      width: 340px;
      flex-shrink: 0;
      background: #fcfbf8;
      border: 1px solid #e3e1d8;
      border-radius: 16px;
      padding: 22px 22px 20px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    [data-theme="dark"] .map-detail {
      background: #141918;
      border-color: #27302d;
    }

    .map-crumb {
      font-size: 12.5px;
      font-weight: 600;
      color: #2e6b48;
    }

    [data-theme="dark"] .map-crumb { color: #67d195; }

    .map-detail-en {
      margin: 4px 0 0;
      font-family: Georgia, "Times New Roman", "Songti SC", serif;
      font-size: 32px;
      line-height: 1.15;
      letter-spacing: -0.02em;
    }

    .map-detail-zh {
      margin: 4px 0 0;
      font-size: 17px;
      font-weight: 700;
      color: #272d29;
    }

    [data-theme="dark"] .map-detail-zh { color: #dbe3de; }

    .map-detail-desc {
      margin: 0;
      font-size: 14px;
      line-height: 1.7;
      color: #474f4a;
    }

    [data-theme="dark"] .map-detail-desc { color: #b1bbb5; }

    .map-detail-sec-title {
      font-size: 14px;
      font-weight: 700;
      margin: 0 0 10px;
      color: #1f2421;
    }

    [data-theme="dark"] .map-detail-sec-title { color: #eef3f0; }

    .map-rel-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .map-rel-row {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13.5px;
      color: #363d39;
    }

    [data-theme="dark"] .map-rel-row { color: #c7d1cb; }

    .map-rel-pill {
      display: inline-flex;
      align-items: center;
      padding: 3px 10px;
      border-radius: 7px;
      background: #e9f2e6;
      color: #1f3c2a;
      font-size: 12.5px;
      font-weight: 600;
      border: 1px solid rgba(46, 107, 72, 0.18);
      cursor: pointer;
      font-family: inherit;
      white-space: nowrap;
      transition: background 0.12s, border-color 0.12s;
    }

    .map-rel-pill:hover { background: #d6ebd0; border-color: #2e6b48; }
    [data-theme="dark"] .map-rel-pill { background: rgba(46, 107, 72, 0.28); color: #a8e6c1; border-color: rgba(103, 209, 149, 0.25); }

    .map-rel-pill.muted {
      background: #eeede8;
      color: #2f3532;
      border-color: rgba(0, 0, 0, 0.08);
    }

    [data-theme="dark"] .map-rel-pill.muted { background: #212826; color: #d3dcd7; border-color: rgba(255, 255, 255, 0.08); }

    .map-detail-actions {
      margin-top: auto;
      padding-top: 8px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .map-read-btn {
      width: 100%;
      padding: 10px 16px;
      border-radius: 10px;
      border: 1.5px solid #2e6b48;
      background: #ffffff;
      color: #2e6b48;
      font-size: 14px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }

    .map-read-btn:hover { background: #2e6b48; color: #ffffff; }
    [data-theme="dark"] .map-read-btn { background: transparent; color: #67d195; border-color: #5cc487; }
    [data-theme="dark"] .map-read-btn:hover { background: #2e6b48; color: #ffffff; }

    .map-graph-btn {
      width: 100%;
      padding: 7px 12px;
      border-radius: 8px;
      border: 1px solid #dcdad0;
      background: transparent;
      color: #5a635e;
      font-size: 12.5px;
      font-family: inherit;
      cursor: pointer;
    }

    .map-graph-btn:hover { border-color: #2e6b48; color: #2e6b48; }
    [data-theme="dark"] .map-graph-btn { border-color: #2c3632; color: #9ea9a3; }

    /* Bottom Recommended Reading Bar */
    .map-bottom-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 20px;
      background: #fcfbf8;
      border-top: 1px solid #e3e1d8;
      flex-shrink: 0;
      overflow-x: auto;
    }

    [data-theme="dark"] .map-bottom-bar {
      background: #141918;
      border-top-color: #27302d;
    }

    .map-path-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
      white-space: nowrap;
      font-size: 13px;
    }

    .map-path-label {
      font-weight: 700;
      color: #2a302c;
      margin-right: 4px;
    }

    [data-theme="dark"] .map-path-label { color: #dbe3de; }

    .map-path-step {
      padding: 4px 12px;
      border-radius: 8px;
      border: 1px solid #dcdad0;
      background: #eff2eb;
      color: #2c3530;
      font-size: 12.5px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: border-color 0.12s, background 0.12s;
    }

    .map-path-step:hover { border-color: #2e6b48; }
    .map-path-step.active {
      border: 1.5px solid #2e6b48;
      background: #ffffff;
      color: #2e6b48;
    }

    [data-theme="dark"] .map-path-step { background: #1e2623; border-color: #2f3a36; color: #cdd6d1; }
    [data-theme="dark"] .map-path-step.active { background: #192920; border-color: #5cc487; color: #67d195; }

    .map-path-arrow { color: #8c948f; font-size: 12px; }
    .map-bottom-note { font-size: 12px; color: #7c847f; white-space: nowrap; }

    .view-tab.active.map-accent {
      background: #2e6b48;
      color: #ffffff;
    }

    @media (max-width: 1080px) {
      .map-workspace { flex-direction: column; overflow-y: auto; }
      .map-canvas-shell { min-height: 480px; }
      .map-detail { width: 100%; overflow: visible; }
      .map-bottom-note { display: none; }
    }

    /* Graph View */
    .graph-view {
      display: none;
      position: relative;
      width: 100%;
      height: calc(100vh - var(--header-h));
      overflow: hidden;
      background:
        radial-gradient(circle at 42% 48%, color-mix(in srgb, var(--accent) 9%, transparent) 0%, transparent 56%),
        radial-gradient(var(--border) 1px, transparent 1px),
        var(--bg);
      background-size: 100% 100%, 24px 24px, 100% 100%;
    }

    .graph-stage {
      position: relative;
      flex: 1;
      min-width: 0;
      height: 100%;
    }

    .graph-canvas {
      display: block;
      width: 100%;
      height: 100%;
    }

    .graph-legend {
      position: absolute;
      top: 14px;
      left: 14px;
      right: 14px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      pointer-events: none;
      z-index: 10;
    }

    .legend-chip {
      pointer-events: auto;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 11px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--surface) 88%, transparent);
      backdrop-filter: blur(12px);
      color: var(--text-secondary);
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      box-shadow: var(--shadow-sm);
      transition: border-color 0.15s, opacity 0.15s, transform 0.12s;
    }

    .legend-chip:hover { border-color: var(--border-strong); color: var(--text); transform: translateY(-1px); }
    .legend-chip.active { border-color: var(--accent); color: var(--text); font-weight: 600; background: var(--surface); }
    .legend-chip.dimmed { opacity: 0.4; }

    .legend-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .graph-controls {
      position: absolute;
      bottom: 16px;
      left: 16px;
      right: 16px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      z-index: 10;
      pointer-events: none;
    }

    .graph-ctrl-group {
      pointer-events: auto;
      display: inline-flex;
      background: color-mix(in srgb, var(--surface) 90%, transparent);
      backdrop-filter: blur(12px);
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
      box-shadow: var(--shadow-sm);
    }

    .graph-ctrl-btn {
      border: none;
      border-right: 1px solid var(--border);
      background: transparent;
      color: var(--text-secondary);
      font-size: 12.5px;
      font-family: inherit;
      padding: 7px 12px;
      cursor: pointer;
      transition: background 0.12s, color 0.12s;
    }

    .graph-ctrl-btn:last-child { border-right: none; }
    .graph-ctrl-btn:hover { background: var(--surface-subtle); color: var(--text); }
    .graph-ctrl-btn.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }

    .graph-focus-pill {
      pointer-events: auto;
      display: none;
      align-items: center;
      gap: 8px;
      padding: 5px 12px;
      border-radius: 999px;
      background: var(--accent);
      color: #ffffff;
      font-size: 12.5px;
      font-weight: 500;
      box-shadow: 0 4px 14px color-mix(in srgb, var(--accent) 35%, transparent);
    }

    .graph-focus-pill.visible { display: inline-flex; }

    .graph-focus-clear {
      border: none;
      background: rgba(255, 255, 255, 0.22);
      color: #ffffff;
      border-radius: 999px;
      padding: 1px 7px;
      font-size: 11.5px;
      cursor: pointer;
      font-family: inherit;
    }

    .graph-focus-clear:hover { background: rgba(255, 255, 255, 0.35); }

    .graph-inspector {
      width: 390px;
      height: 100%;
      overflow-y: auto;
      padding: 20px 22px 32px;
      background: color-mix(in srgb, var(--surface) 94%, transparent);
      backdrop-filter: blur(16px);
      border-left: 1px solid var(--border);
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .inspector-empty {
      margin: auto 0;
      text-align: center;
      color: var(--text-muted);
      font-size: 13.5px;
      line-height: 1.75;
      padding: 24px 12px;
    }

    .inspector-empty strong { color: var(--text); display: block; margin-bottom: 8px; font-size: 16px; }

    .inspector-hub-list {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 6px;
      margin-top: 16px;
    }

    .inspector-top-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .inspector-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--text-muted);
    }

    .inspector-close {
      border: 1px solid var(--border);
      background: var(--surface-subtle);
      color: var(--text-secondary);
      border-radius: 6px;
      padding: 2px 8px;
      font-size: 12px;
      cursor: pointer;
      font-family: inherit;
    }

    .inspector-close:hover { color: var(--text); border-color: var(--border-strong); }

    .inspector-title {
      margin: 0;
      font-size: 20px;
      line-height: 1.3;
    }

    .inspector-desc {
      margin: 0;
      padding: 10px 12px;
      border-left: 3px solid var(--accent);
      background: var(--surface-subtle);
      border-radius: 0 8px 8px 0;
      font-size: 13.5px;
      color: var(--text-secondary);
      line-height: 1.65;
    }

    .inspector-stats {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      font-size: 12px;
    }

    .stat-pill {
      padding: 3px 9px;
      border-radius: 999px;
      background: var(--surface-subtle);
      border: 1px solid var(--border);
      color: var(--text-secondary);
    }

    .inspector-tabs {
      display: flex;
      gap: 4px;
      padding: 3px;
      background: var(--surface-subtle);
      border: 1px solid var(--border);
      border-radius: 8px;
    }

    .inspector-tab {
      flex: 1;
      border: none;
      background: transparent;
      color: var(--text-secondary);
      font-size: 13px;
      font-family: inherit;
      padding: 6px 10px;
      border-radius: 6px;
      cursor: pointer;
    }

    .inspector-tab.active {
      background: var(--surface);
      color: var(--text);
      font-weight: 600;
      box-shadow: var(--shadow-sm);
    }

    .inspector-pane { display: flex; flex-direction: column; gap: 14px; }
    .inspector-pane.hidden { display: none; }

    .inspector-article {
      font-size: 14px;
      line-height: 1.75;
    }

    .inspector-article p { margin: 0 0 12px; font-size: 14px; }
    .inspector-article table { font-size: 12.5px; }
    .inspector-article th, .inspector-article td { padding: 7px 10px; }

    .inspector-cta {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 9px 14px;
      border-radius: 8px;
      background: var(--accent);
      color: #ffffff;
      font-size: 13.5px;
      font-weight: 600;
      border: none;
      cursor: pointer;
      font-family: inherit;
      text-decoration: none;
    }

    .inspector-cta:hover { opacity: 0.92; }

    .inspector-group-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .inspector-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .node-chip {
      font-size: 12px;
      padding: 3px 9px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--surface-subtle);
      color: var(--text-secondary);
      cursor: pointer;
      font-family: inherit;
      transition: border-color 0.12s, color 0.12s;
    }

    .node-chip:hover { border-color: var(--accent); color: var(--accent); }

    .hero-graph-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      border-radius: 999px;
      background: var(--accent);
      color: #ffffff;
      border: none;
      font-size: 13px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
    }

    .hero-graph-btn:hover { opacity: 0.92; }

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
      .graph-view { flex-direction: column; }
      .graph-inspector {
        width: 100%;
        height: 42%;
        border-left: none;
        border-top: 1px solid var(--border);
      }
      .graph-hint { display: none; }
    }
  </style>
</head>
<body data-view="map">
  <header class="topbar">
    <button class="menu-btn" id="menuBtn" type="button" aria-label="打开目录">☰</button>
    <a class="brand" href="#" id="brandLink">
      <span>AI Coding 词典</span>
      <span class="brand-badge">${entries.length} 词</span>
    </a>
    <div class="view-switch" role="tablist" aria-label="视图切换">
      <button class="view-tab active map-accent" id="tabMap" type="button" role="tab" aria-selected="true">知识地图</button>
      <button class="view-tab" id="tabGraph" type="button" role="tab" aria-selected="false">知识图谱</button>
      <button class="view-tab" id="tabDict" type="button" role="tab" aria-selected="false">词条列表</button>
    </div>
    <div class="search-wrap" id="searchWrap">
      <span class="search-icon">⌕</span>
      <input class="search-input" id="searchInput" type="search" placeholder="搜索中文、英文或别名…" autocomplete="off" />
      <span class="search-kbd">/</span>
      <button class="search-clear" id="searchClear" type="button" aria-label="清空搜索">×</button>
    </div>
    <div class="topbar-actions">
      <button class="icon-btn" id="themeToggle" type="button" aria-label="切换深浅色主题">切换主题</button>
      <a class="icon-btn" href="https://github.com/kirinboy/dictionary-of-ai-coding-cn" target="_blank" rel="noopener noreferrer">GitHub</a>
    </div>
  </header>

  <div class="drawer-backdrop" id="drawerBackdrop"></div>

  <section class="map-view" id="mapView" aria-label="词典知识地图">
    <div class="map-workspace">
      <div class="map-canvas-shell">
        <div class="map-viewport" id="mapViewport">
          <div class="map-board" id="mapBoard">
            <svg class="map-svg" id="mapSvg" aria-hidden="true"></svg>
            <div class="map-grid" id="mapGrid"></div>
          </div>
        </div>
        <div class="map-footer-bar">
          <div class="map-legend-inline">
            <span class="map-legend-item"><span class="map-line-swatch" style="background:#9ca3af"></span>引用关联</span>
            <span class="map-legend-item"><span class="map-line-swatch" style="background:#2e6b48"></span>已标注关系</span>
          </div>
          <div class="map-tools-right">
            <button class="map-mode-btn" id="mapExpandAllBtn" type="button">展开全部 72 词条</button>
            <div class="map-zoom-pill">
              <button class="map-zoom-btn" id="mapZoomOut" type="button" title="缩小">−</button>
              <span class="map-zoom-val" id="mapZoomVal">100%</span>
              <button class="map-zoom-btn" id="mapZoomIn" type="button" title="放大">＋</button>
              <button class="map-zoom-btn" id="mapZoomReset" type="button" title="重置缩放">⛶</button>
            </div>
          </div>
        </div>
      </div>
      <aside class="map-detail" id="mapDetail" aria-label="词条速览"></aside>
    </div>
    <div class="map-bottom-bar">
      <div class="map-path-wrap" id="mapPathWrap">
        <span class="map-path-label">推荐阅读顺序</span>
      </div>
      <span class="map-bottom-note" id="mapBottomNote">7 个主题 · 72 个词条 · 核心概念速览</span>
    </div>
  </section>

  <section class="graph-view" id="graphView" aria-label="词典知识图谱">
    <div class="graph-stage">
      <div class="graph-legend" id="graphLegend"></div>
      <canvas class="graph-canvas" id="graphCanvas"></canvas>
      <div class="graph-controls">
        <div class="graph-ctrl-group" role="group" aria-label="连线方向筛选">
          <button class="graph-ctrl-btn active" type="button" data-dir="both">全部连线</button>
          <button class="graph-ctrl-btn" type="button" data-dir="out">仅看引用</button>
          <button class="graph-ctrl-btn" type="button" data-dir="in">仅看被引用</button>
        </div>
        <div class="graph-ctrl-group" role="group" aria-label="视图操作">
          <button class="graph-ctrl-btn" id="zoomInBtn" type="button" title="放大">＋</button>
          <button class="graph-ctrl-btn" id="zoomOutBtn" type="button" title="缩小">－</button>
          <button class="graph-ctrl-btn" id="resetGraphBtn" type="button">适应全局</button>
        </div>
        <div class="graph-focus-pill" id="graphFocusPill">
          <span id="graphFocusText"></span>
          <button class="graph-focus-clear" id="graphFocusClear" type="button">退出聚焦</button>
        </div>
      </div>
    </div>
    <aside class="graph-inspector" id="graphInspector" aria-label="节点详情"></aside>
  </section>

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
          <button class="hero-graph-btn" id="heroGraphBtn" type="button">✦ 打开交互式知识图谱</button>
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

  <script id="graph-data" type="application/json">${graphJson.replace(/<\/script/gi, "<\\/script")}</script>

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
      var tabMap = document.getElementById("tabMap");
      var tabDict = document.getElementById("tabDict");
      var tabGraph = document.getElementById("tabGraph");
      var brandLink = document.getElementById("brandLink");

      var entries = Array.prototype.slice.call(document.querySelectorAll(".entry"));
      var sections = Array.prototype.slice.call(document.querySelectorAll(".dict-section"));
      var navTerms = Array.prototype.slice.call(document.querySelectorAll(".nav-term"));
      var navSections = Array.prototype.slice.call(document.querySelectorAll(".nav-section"));

      var currentView = "map";
      var mapApi = null;
      var graphApi = null;

      function showToast(msg) {
        toast.textContent = msg;
        toast.classList.add("show");
        clearTimeout(showToast._t);
        showToast._t = setTimeout(function () {
          toast.classList.remove("show");
        }, 1800);
      }

      function setView(view, focusSlug) {
        currentView = view;
        document.body.dataset.view = view;
        tabMap.classList.toggle("active", view === "map");
        tabMap.classList.toggle("map-accent", view === "map");
        tabMap.setAttribute("aria-selected", view === "map" ? "true" : "false");
        tabDict.classList.toggle("active", view === "dict");
        tabDict.setAttribute("aria-selected", view === "dict" ? "true" : "false");
        tabGraph.classList.toggle("active", view === "graph");
        tabGraph.setAttribute("aria-selected", view === "graph" ? "true" : "false");
        closeDrawer();
        if (view === "map") {
          if (!mapApi) mapApi = initMap();
          mapApi.setSearchQuery(searchInput.value);
          if (focusSlug) mapApi.selectNode(focusSlug);
          else mapApi.redrawArrows();
          if (window.location.hash && window.location.hash !== "#map") {
            history.replaceState(null, "", "#map");
          }
        } else if (view === "graph") {
          if (!graphApi) graphApi = initGraph();
          graphApi.resize();
          graphApi.setSearchQuery(searchInput.value);
          if (focusSlug) {
            graphApi.focusNode(focusSlug);
          }
          if (window.location.hash !== "#graph") {
            history.replaceState(null, "", "#graph");
          }
        } else if (focusSlug) {
          var target = document.getElementById(focusSlug);
          if (target) {
            if (target.classList.contains("hidden")) clearSearch();
            history.replaceState(null, "", "#" + encodeURIComponent(focusSlug));
            target.scrollIntoView({ behavior: "smooth", block: "start" });
            setTimeout(function () { flashTarget(focusSlug); }, 120);
          }
        } else if (window.location.hash === "#graph" || window.location.hash === "#map") {
          history.replaceState(null, "", window.location.pathname);
        }
      }

      tabMap.addEventListener("click", function () { setView("map"); });
      tabDict.addEventListener("click", function () { setView("dict"); });
      tabGraph.addEventListener("click", function () { setView("graph"); });
      brandLink.addEventListener("click", function (e) {
        e.preventDefault();
        setView("map");
      });

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
        if (graphApi) graphApi.draw();
        if (mapApi) mapApi.redrawArrows();
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

        if (mapApi) mapApi.setSearchQuery(rawQuery);
        if (graphApi) graphApi.setSearchQuery(rawQuery);

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
        } else if (e.key === "Escape") {
          if (document.activeElement === searchInput) {
            clearSearch();
            searchInput.blur();
          } else if (currentView === "graph" && graphApi) {
            graphApi.clearSelection();
          }
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
        var jumpBtn = e.target.closest(".graph-jump-btn");
        if (jumpBtn) {
          setView("graph", jumpBtn.dataset.graphSlug);
          return;
        }
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

      // Hero quick CTA
      var heroGraphBtn = document.getElementById("heroGraphBtn");
      if (heroGraphBtn) {
        heroGraphBtn.addEventListener("click", function () { setView("graph"); });
      }

      // Tactile 60fps Clustered Physics Knowledge Graph Engine
      function initGraph() {
        var raw = document.getElementById("graph-data").textContent;
        var data = JSON.parse(raw);
        var canvas = document.getElementById("graphCanvas");
        var ctx = canvas.getContext("2d");
        var legendEl = document.getElementById("graphLegend");
        var inspectorEl = document.getElementById("graphInspector");
        var focusPill = document.getElementById("graphFocusPill");
        var focusText = document.getElementById("graphFocusText");
        var focusClear = document.getElementById("graphFocusClear");

        var SECTION_PALETTE = {
          1: { hex: "#3b82f6", light: "#93c5fd", rgb: "59,130,246" },
          2: { hex: "#8b5cf6", light: "#c4b5fd", rgb: "139,92,246" },
          3: { hex: "#10b981", light: "#6ee7b7", rgb: "16,185,129" },
          4: { hex: "#f43f5e", light: "#fda4af", rgb: "244,63,94" },
          5: { hex: "#f59e0b", light: "#fcd34d", rgb: "245,158,11" },
          6: { hex: "#06b6d4", light: "#67e8f9", rgb: "6,182,212" },
          7: { hex: "#d946ef", light: "#f0abfc", rgb: "217,70,239" }
        };

        var nodeMap = new Map();
        var outMap = new Map();
        var inMap = new Map();
        var activeSection = 0;
        var edgeDir = "both";
        var searchQuery = "";
        var selectedId = null;
        var hoveredId = null;
        var activeInspectorTab = "links";

        // Smooth camera state (lerped every frame for silky inertia)
        var width = 800;
        var height = 600;
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        var camX = 0, camY = 0, camScale = 0.72;
        var targetCamX = 0, targetCamY = 0, targetCamScale = 0.72;
        var panVelX = 0, panVelY = 0;

        // 7 spacious module cluster anchors arranged in a balanced constellation
        var clusterCenters = {};
        var secCount = data.sections.length;
        var ringRadius = 430;
        data.sections.forEach(function (sec, idx) {
          var angle = (idx / secCount) * Math.PI * 2 - Math.PI / 2;
          clusterCenters[sec.index] = {
            x: Math.cos(angle) * ringRadius,
            y: Math.sin(angle) * ringRadius,
            shortTitle: sec.shortTitle
          };
        });

        var secCounters = {};
        var nodes = data.nodes.map(function (n) {
          var c = clusterCenters[n.section] || { x: 0, y: 0 };
          var idx = secCounters[n.section] || 0;
          secCounters[n.section] = idx + 1;
          var golden = idx * 2.39996;
          var localR = idx === 0 ? 0 : 42 + Math.sqrt(idx) * 34;
          var degree = n.inCount + n.outCount;
          var obj = {
            id: n.id,
            term: n.term,
            shortLabel: n.shortLabel,
            section: n.section,
            description: n.description,
            aliases: n.aliases || [],
            inCount: n.inCount,
            outCount: n.outCount,
            degree: degree,
            r: 7 + Math.min(20, Math.sqrt(n.inCount) * 2.75),
            x: c.x + Math.cos(golden) * localR,
            y: c.y + Math.sin(golden) * localR,
            vx: 0,
            vy: 0,
            visAlpha: 1,
            visScale: 1,
            searchText: (n.term + " " + n.description + " " + (n.aliases || []).join(" ")).toLowerCase()
          };
          nodeMap.set(obj.id, obj);
          outMap.set(obj.id, []);
          inMap.set(obj.id, []);
          return obj;
        });

        var edges = data.edges.map(function (e, idx) {
          var s = nodeMap.get(e.source);
          var t = nodeMap.get(e.target);
          if (s && t) {
            outMap.get(s.id).push(t);
            inMap.get(t.id).push(s);
          }
          return {
            source: s,
            target: t,
            sameSec: s && t ? s.section === t.section : false,
            phase: (idx * 0.137) % 1
          };
        }).filter(function (e) { return e.source && e.target; });

        var topHubs = nodes.slice().sort(function (a, b) { return b.inCount - a.inCount; }).slice(0, 8);

        // Physics state
        var simEnergy = 1.0;
        var draggingNode = null;
        var dragTargetX = 0;
        var dragTargetY = 0;
        var dragVelX = 0;
        var dragVelY = 0;

        function stepPhysics() {
          var activeEnergy = draggingNode ? Math.max(simEnergy, 0.35) : simEnergy;
          if (activeEnergy < 0.002 && !draggingNode) return;

          // 1. Node-node repulsion & soft collision
          for (var i = 0; i < nodes.length; i++) {
            var a = nodes[i];
            for (var j = i + 1; j < nodes.length; j++) {
              var b = nodes[j];
              var dx = b.x - a.x;
              var dy = b.y - a.y;
              var distSq = dx * dx + dy * dy + 0.01;
              var sameSec = a.section === b.section;
              var maxRange = sameSec ? 240 : 280;
              if (distSq > maxRange * maxRange) continue;

              var dist = Math.sqrt(distSq);
              var minDist = a.r + b.r + (sameSec ? 44 : 78);
              var rep = (sameSec ? 1600 : 2600) / distSq;
              if (dist < minDist) {
                rep += ((minDist - dist) / dist) * 0.36;
              }
              var fx = (dx / dist) * rep * activeEnergy;
              var fy = (dy / dist) * rep * activeEnergy;
              if (a !== draggingNode) { a.vx -= fx; a.vy -= fy; }
              if (b !== draggingNode) { b.vx += fx; b.vy += fy; }
            }
          }

          // 2. Elastic spring pull along edges (tactile drag tug!)
          for (var k = 0; k < edges.length; k++) {
            var e = edges[k];
            var s = e.source;
            var t = e.target;
            var isDragEdge = (s === draggingNode || t === draggingNode);
            if (!e.sameSec && !isDragEdge) continue;

            var dx2 = t.x - s.x;
            var dy2 = t.y - s.y;
            var d2 = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 1;
            var restLen = e.sameSec ? 96 : 260;
            var strength = isDragEdge ? (e.sameSec ? 0.032 : 0.006) : 0.007;
            var pull = (d2 - restLen) * strength * activeEnergy;
            var px = (dx2 / d2) * pull;
            var py = (dy2 / d2) * pull;
            if (s !== draggingNode) { s.vx += px; s.vy += py; }
            if (t !== draggingNode) { t.vx -= px; t.vy -= py; }
          }

          // 3. Soft cluster anchor gravity (keeps each module neatly grouped)
          for (var m = 0; m < nodes.length; m++) {
            var nd = nodes[m];
            if (nd === draggingNode) {
              var prevX = nd.x;
              var prevY = nd.y;
              nd.x += (dragTargetX - nd.x) * 0.44;
              nd.y += (dragTargetY - nd.y) * 0.44;
              dragVelX = (nd.x - prevX) * 0.55;
              dragVelY = (nd.y - prevY) * 0.55;
              nd.vx = 0;
              nd.vy = 0;
              continue;
            }
            var cc = clusterCenters[nd.section];
            if (cc) {
              nd.vx += (cc.x - nd.x) * 0.022 * activeEnergy;
              nd.vy += (cc.y - nd.y) * 0.022 * activeEnergy;
            }
            nd.vx *= 0.84;
            nd.vy *= 0.84;
            nd.x += nd.vx;
            nd.y += nd.vy;
          }

          if (!draggingNode) {
            simEnergy *= 0.978;
          }
        }

        // Pre-warm layout smoothly before first frame
        for (var pre = 0; pre < 140; pre++) {
          stepPhysics();
        }
        simEnergy = 0.08;

        // Build section legend chips
        var allBtn = document.createElement("button");
        allBtn.type = "button";
        allBtn.className = "legend-chip active";
        allBtn.dataset.sec = "0";
        allBtn.innerHTML = "<span>全部模块</span>";
        legendEl.appendChild(allBtn);

        data.sections.forEach(function (sec) {
          var pal = SECTION_PALETTE[sec.index];
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "legend-chip";
          btn.dataset.sec = String(sec.index);
          btn.innerHTML = '<span class="legend-dot" style="background:' + pal.hex + '"></span><span>0' + sec.index + " " + sec.shortTitle + "</span>";
          legendEl.appendChild(btn);
        });

        function flyToSection(secId) {
          if (secId === 0) {
            fitView();
            return;
          }
          var members = nodes.filter(function (n) { return n.section === secId; });
          if (!members.length) return;
          var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          members.forEach(function (n) {
            if (n.x - n.r < minX) minX = n.x - n.r;
            if (n.x + n.r > maxX) maxX = n.x + n.r;
            if (n.y - n.r < minY) minY = n.y - n.r;
            if (n.y + n.r > maxY) maxY = n.y + n.r;
          });
          targetCamX = (minX + maxX) / 2;
          targetCamY = (minY + maxY) / 2;
          var spanX = (maxX - minX) + 180;
          var spanY = (maxY - minY) + 180;
          targetCamScale = Math.max(0.55, Math.min(1.55, Math.min(width / spanX, height / spanY)));
        }

        legendEl.addEventListener("click", function (e) {
          var btn = e.target.closest(".legend-chip");
          if (!btn) return;
          var secId = Number(btn.dataset.sec);
          activeSection = activeSection === secId ? 0 : secId;
          Array.prototype.slice.call(legendEl.querySelectorAll(".legend-chip")).forEach(function (el) {
            var id = Number(el.dataset.sec);
            el.classList.toggle("active", id === activeSection);
            el.classList.toggle("dimmed", activeSection !== 0 && id !== 0 && id !== activeSection);
          });
          flyToSection(activeSection);
        });

        document.querySelectorAll(".graph-ctrl-btn[data-dir]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            edgeDir = btn.dataset.dir;
            document.querySelectorAll(".graph-ctrl-btn[data-dir]").forEach(function (b) {
              b.classList.toggle("active", b === btn);
            });
          });
        });

        function screenToWorld(sx, sy) {
          return {
            x: (sx - width / 2) / camScale + camX,
            y: (sy - height / 2) / camScale + camY
          };
        }

        function fitView(instant) {
          var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          nodes.forEach(function (n) {
            if (n.x - n.r < minX) minX = n.x - n.r;
            if (n.x + n.r > maxX) maxX = n.x + n.r;
            if (n.y - n.r < minY) minY = n.y - n.r;
            if (n.y + n.r > maxY) maxY = n.y + n.r;
          });
          var spanX = (maxX - minX) + 220;
          var spanY = (maxY - minY) + 240;
          targetCamX = (minX + maxX) / 2;
          targetCamY = (minY + maxY) / 2;
          targetCamScale = Math.max(0.32, Math.min(1.15, Math.min(width / spanX, height / spanY)));
          if (instant) {
            camX = targetCamX;
            camY = targetCamY;
            camScale = targetCamScale;
          }
        }

        function resize() {
          var rect = canvas.parentElement.getBoundingClientRect();
          width = Math.max(300, rect.width);
          height = Math.max(300, rect.height);
          dpr = Math.min(window.devicePixelRatio || 1, 2);
          canvas.width = Math.floor(width * dpr);
          canvas.height = Math.floor(height * dpr);
          canvas.style.width = width + "px";
          canvas.style.height = height + "px";
          if (!resize._inited) {
            resize._inited = true;
            fitView(true);
          }
        }

        function drawRoundRect(x, y, w, h, r) {
          ctx.beginPath();
          ctx.moveTo(x + r, y);
          ctx.lineTo(x + w - r, y);
          ctx.quadraticCurveTo(x + w, y, x + w, y + r);
          ctx.lineTo(x + w, y + h - r);
          ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
          ctx.lineTo(x + r, y + h);
          ctx.quadraticCurveTo(x, y + h, x, y + h - r);
          ctx.lineTo(x, y + r);
          ctx.quadraticCurveTo(x, y, x + r, y);
          ctx.closePath();
        }

        function drawCurvedEdge(s, t, color, lineWidth, alpha, withArrow, pulseT) {
          var dx = t.x - s.x;
          var dy = t.y - s.y;
          var dist = Math.sqrt(dx * dx + dy * dy) || 1;
          var bend = Math.min(64, dist * 0.16);
          var mx = (s.x + t.x) / 2 - (dy / dist) * bend;
          var my = (s.y + t.y) / 2 + (dx / dist) * bend;

          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = color;
          ctx.lineWidth = lineWidth;
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.quadraticCurveTo(mx, my, t.x, t.y);
          ctx.stroke();

          // Animated luminous light pulse gliding along the Bezier arc
          if (pulseT !== null) {
            var u = 1 - pulseT;
            var px = u * u * s.x + 2 * u * pulseT * mx + pulseT * pulseT * t.x;
            var py = u * u * s.y + 2 * u * pulseT * my + pulseT * pulseT * t.y;
            ctx.globalAlpha = Math.min(1, alpha + 0.15);
            ctx.fillStyle = color;
            ctx.shadowColor = color;
            ctx.shadowBlur = 10;
            ctx.beginPath();
            ctx.arc(px, py, Math.max(2.3, 3.2 / Math.sqrt(camScale)), 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;
          }

          if (withArrow && dist > t.r + 12) {
            // Tangent near target end of quadratic curve
            var tx = t.x - mx;
            var ty = t.y - my;
            var tLen = Math.sqrt(tx * tx + ty * ty) || 1;
            var ex = t.x - (tx / tLen) * (t.r + 4);
            var ey = t.y - (ty / tLen) * (t.r + 4);
            var ang = Math.atan2(ty, tx);
            var hl = Math.max(5.5, 7 / Math.sqrt(camScale));
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.moveTo(ex, ey);
            ctx.lineTo(ex - hl * Math.cos(ang - 0.42), ey - hl * Math.sin(ang - 0.42));
            ctx.lineTo(ex - hl * Math.cos(ang + 0.42), ey - hl * Math.sin(ang + 0.42));
            ctx.closePath();
            ctx.fill();
          }
          ctx.restore();
        }

        var animTime = 0;
        function drawFrame(now) {
          animTime = (now || 0) * 0.00055;
          if (currentView !== "graph") {
            requestAnimationFrame(drawFrame);
            return;
          }

          stepPhysics();

          // Smooth camera spring-lerp & pan inertia
          if (!panning) {
            targetCamX -= panVelX / camScale;
            targetCamY -= panVelY / camScale;
            panVelX *= 0.88;
            panVelY *= 0.88;
            if (Math.abs(panVelX) < 0.05) panVelX = 0;
            if (Math.abs(panVelY) < 0.05) panVelY = 0;
          }
          camX += (targetCamX - camX) * 0.16;
          camY += (targetCamY - camY) * 0.16;
          camScale += (targetCamScale - camScale) * 0.16;

          var isDark = document.documentElement.dataset.theme === "dark";
          var textColor = isDark ? "#f0f6fc" : "#18181b";
          var pillBg = isDark ? "rgba(13,17,23,0.78)" : "rgba(255,255,255,0.86)";
          var pillBorder = isDark ? "rgba(255,255,255,0.1)" : "rgba(24,24,27,0.09)";
          var outColor = isDark ? "#60a5fa" : "#2563eb";
          var inColor = isDark ? "#fbbf24" : "#d97706";

          var focusId = draggingNode ? draggingNode.id : (hoveredId || selectedId);
          var outsSet = new Set();
          var insSet = new Set();
          if (focusId) {
            (outMap.get(focusId) || []).forEach(function (n) { outsSet.add(n.id); });
            (inMap.get(focusId) || []).forEach(function (n) { insSet.add(n.id); });
          }

          ctx.save();
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, width, height);

          ctx.translate(width / 2, height / 2);
          ctx.scale(camScale, camScale);
          ctx.translate(-camX, -camY);

          // 1. Draw 7 breathing translucent module islands (group hulls)
          for (var sIdx = 0; sIdx < data.sections.length; sIdx++) {
            var sec = data.sections[sIdx];
            var pal = SECTION_PALETTE[sec.index];
            var members = nodes.filter(function (n) { return n.section === sec.index; });
            if (!members.length) continue;

            var cx = 0, cy = 0;
            members.forEach(function (n) { cx += n.x; cy += n.y; });
            cx /= members.length;
            cy /= members.length;

            var maxR = 70;
            members.forEach(function (n) {
              var d = Math.sqrt((n.x - cx) * (n.x - cx) + (n.y - cy) * (n.y - cy)) + n.r + 36;
              if (d > maxR) maxR = d;
            });

            var secDimmed = (activeSection !== 0 && activeSection !== sec.index) || (focusId && nodeMap.get(focusId).section !== sec.index);
            var hullAlpha = secDimmed ? 0.28 : 1;

            ctx.save();
            ctx.globalAlpha = hullAlpha;

            // Soft radial nebula fill
            var grad = ctx.createRadialGradient(cx, cy, maxR * 0.12, cx, cy, maxR);
            grad.addColorStop(0, "rgba(" + pal.rgb + "," + (isDark ? "0.14" : "0.09") + ")");
            grad.addColorStop(0.75, "rgba(" + pal.rgb + "," + (isDark ? "0.06" : "0.04") + ")");
            grad.addColorStop(1, "rgba(" + pal.rgb + ",0)");
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
            ctx.fill();

            // Delicate glass ring border
            ctx.setLineDash([6, 6]);
            ctx.strokeStyle = "rgba(" + pal.rgb + "," + (isDark ? "0.28" : "0.24") + ")";
            ctx.lineWidth = 1.25 / Math.sqrt(camScale);
            ctx.beginPath();
            ctx.arc(cx, cy, maxR - 4, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);

            // Floating module title pill at top of island
            var title = "0" + sec.index + "  " + sec.shortTitle;
            var tSize = Math.max(11, Math.min(15, 13 / Math.sqrt(camScale)));
            ctx.font = "700 " + tSize + 'px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
            var tw = ctx.measureText(title).width;
            var px = cx - tw / 2 - 12;
            var py = cy - maxR - tSize * 0.85;
            drawRoundRect(px, py, tw + 24, tSize + 12, (tSize + 12) / 2);
            ctx.fillStyle = isDark ? "rgba(22,27,34,0.88)" : "rgba(255,255,255,0.92)";
            ctx.fill();
            ctx.strokeStyle = "rgba(" + pal.rgb + ",0.45)";
            ctx.lineWidth = 1 / Math.sqrt(camScale);
            ctx.stroke();

            ctx.fillStyle = isDark ? pal.light : pal.hex;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(title, cx, py + (tSize + 12) / 2 + 0.5);
            ctx.restore();
          }

          // 2. Draw curved edges (ambient first, then focused glowing arcs with flowing pulses)
          var focusedEdges = [];
          for (var i = 0; i < edges.length; i++) {
            var e = edges[i];
            var s = e.source;
            var t = e.target;
            if (activeSection !== 0 && s.section !== activeSection && t.section !== activeSection) continue;

            if (focusId) {
              var isOut = s.id === focusId && (edgeDir === "both" || edgeDir === "out");
              var isIn = t.id === focusId && (edgeDir === "both" || edgeDir === "in");
              if (isOut || isIn) {
                focusedEdges.push({ e: e, isOut: isOut });
              } else if (e.sameSec) {
                drawCurvedEdge(s, t, "rgba(" + SECTION_PALETTE[s.section].rgb + ",1)", 0.8 / camScale, 0.035, false, null);
              }
            } else {
              var qOk = !searchQuery || (s.searchText.indexOf(searchQuery) !== -1 && t.searchText.indexOf(searchQuery) !== -1);
              var palS = SECTION_PALETTE[s.section];
              var baseAlpha = e.sameSec ? (isDark ? 0.22 : 0.18) : (isDark ? 0.045 : 0.04);
              if (!qOk) baseAlpha *= 0.2;
              drawCurvedEdge(s, t, "rgba(" + palS.rgb + ",1)", (e.sameSec ? 1.15 : 0.8) / Math.sqrt(camScale), baseAlpha, false, null);
            }
          }

          for (var f = 0; f < focusedEdges.length; f++) {
            var fe = focusedEdges[f];
            var pulsePos = (animTime + fe.e.phase) % 1;
            drawCurvedEdge(
              fe.e.source,
              fe.e.target,
              fe.isOut ? outColor : inColor,
              (fe.isOut ? 2.2 : 1.8) / Math.sqrt(camScale),
              fe.isOut ? 0.85 : 0.76,
              true,
              pulsePos
            );
          }

          // 3. Draw tactile glassy orbs & pill-backed labels
          for (var j = 0; j < nodes.length; j++) {
            var n = nodes[j];
            var palN = SECTION_PALETTE[n.section];
            var secOk = activeSection === 0 || n.section === activeSection;
            var qOk2 = !searchQuery || n.searchText.indexOf(searchQuery) !== -1;
            var isFocus = n.id === focusId;
            var isRelated = focusId && (
              isFocus ||
              ((edgeDir === "both" || edgeDir === "out") && outsSet.has(n.id)) ||
              ((edgeDir === "both" || edgeDir === "in") && insSet.has(n.id))
            );

            var targetAlpha = 1;
            if (!secOk || !qOk2) targetAlpha = 0.12;
            else if (focusId && !isRelated) targetAlpha = 0.14;

            var targetScale = (n === draggingNode) ? 1.24 : (isFocus ? 1.14 : 1.0);
            n.visAlpha += (targetAlpha - n.visAlpha) * 0.2;
            n.visScale += (targetScale - n.visScale) * 0.22;

            var rr = n.r * n.visScale;

            ctx.save();
            ctx.globalAlpha = n.visAlpha;

            // Expanding luminous ring when focused / dragged / selected
            if (isFocus || n.id === selectedId) {
              var pulseR = rr + 7 + Math.sin(animTime * 5) * 2.2;
              ctx.beginPath();
              ctx.arc(n.x, n.y, pulseR, 0, Math.PI * 2);
              ctx.fillStyle = "rgba(" + palN.rgb + ",0.18)";
              ctx.fill();
              ctx.strokeStyle = "rgba(" + palN.rgb + ",0.65)";
              ctx.lineWidth = 1.6 / Math.sqrt(camScale);
              ctx.stroke();
            }

            // Glassy orb with radial specular highlight
            ctx.shadowColor = "rgba(" + palN.rgb + "," + (isFocus ? "0.65" : "0.35") + ")";
            ctx.shadowBlur = isFocus ? 22 : 10;
            var orbGrad = ctx.createRadialGradient(n.x - rr * 0.32, n.y - rr * 0.32, rr * 0.1, n.x, n.y, rr);
            orbGrad.addColorStop(0, palN.light);
            orbGrad.addColorStop(0.55, palN.hex);
            orbGrad.addColorStop(1, palN.hex);
            ctx.beginPath();
            ctx.arc(n.x, n.y, rr, 0, Math.PI * 2);
            ctx.fillStyle = orbGrad;
            ctx.fill();
            ctx.shadowBlur = 0;

            // Crisp border rim
            ctx.lineWidth = (isFocus || n.id === selectedId ? 2.4 : 1.4) / Math.sqrt(camScale);
            ctx.strokeStyle = (isFocus || n.id === selectedId) ? (isDark ? "#ffffff" : "#18181b") : (isDark ? "rgba(13,17,23,0.85)" : "rgba(255,255,255,0.92)");
            ctx.stroke();

            // Pill-backed Chinese label
            var showLabel =
              isFocus ||
              isRelated ||
              (searchQuery && qOk2) ||
              (activeSection !== 0 && secOk) ||
              camScale >= 0.72 ||
              n.inCount >= 10;

            if (showLabel && n.visAlpha > 0.22) {
              var lSize = Math.max(10.5, Math.min(13.5, 11.8 / Math.sqrt(camScale)));
              ctx.font = (isFocus || n.inCount >= 20 ? "700 " : "500 ") + lSize + 'px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
              var lw = ctx.measureText(n.shortLabel).width;
              var padX = 7;
              var pillH = lSize + 7;
              var pillX = n.x - lw / 2 - padX;
              var pillY = n.y + rr + 5 / Math.sqrt(camScale);

              drawRoundRect(pillX, pillY, lw + padX * 2, pillH, pillH / 2);
              ctx.fillStyle = pillBg;
              ctx.fill();
              ctx.strokeStyle = isFocus ? palN.hex : pillBorder;
              ctx.lineWidth = (isFocus ? 1.2 : 0.8) / Math.sqrt(camScale);
              ctx.stroke();

              ctx.fillStyle = textColor;
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              ctx.fillText(n.shortLabel, n.x, pillY + pillH / 2 + 0.5);
            }

            ctx.restore();
          }

          ctx.restore();
          requestAnimationFrame(drawFrame);
        }

        function escapeText(str) {
          return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
        }

        function renderInspector(nodeId) {
          var n = nodeId ? nodeMap.get(nodeId) : null;
          if (!n) {
            focusPill.classList.remove("visible");
            var hubChips = topHubs.map(function (h) {
              return '<button type="button" class="node-chip" data-focus-id="' + escapeText(h.id) + '"><span class="legend-dot" style="display:inline-block;margin-right:5px;background:' + SECTION_PALETTE[h.section].hex + '"></span>' + escapeText(h.shortLabel) + "</button>";
            }).join("");
            inspectorEl.innerHTML =
              '<div class="inspector-empty"><strong>AI Coding 模块知识图谱</strong>' +
              "按 7 大章节聚为 7 座知识星团（" + nodes.length + " 词条 · " + edges.length + " 条关联），节点越大代表被其他词条引用的次数越多。<br /><br />" +
              "直接<strong>拖拽任意节点</strong>感受弹性联动，滚轮缩放，或点击节点查看流光依赖路径与完整词条。" +
              '<div class="inspector-hub-list">' + hubChips + "</div></div>";
            return;
          }

          focusText.textContent = "已聚焦：" + n.shortLabel;
          focusPill.classList.add("visible");

          var sec = data.sections.find(function (s) { return s.index === n.section; });
          var outs = outMap.get(n.id) || [];
          var ins = inMap.get(n.id) || [];

          var outChips = outs.length
            ? outs.map(function (t) {
                return '<button type="button" class="node-chip" data-focus-id="' + escapeText(t.id) + '">' + escapeText(t.shortLabel) + "</button>";
              }).join("")
            : '<span style="font-size:12px;color:var(--text-muted)">无主动引用</span>';

          var inChips = ins.length
            ? ins.map(function (t) {
                return '<button type="button" class="node-chip" data-focus-id="' + escapeText(t.id) + '">' + escapeText(t.shortLabel) + "</button>";
              }).join("")
            : '<span style="font-size:12px;color:var(--text-muted)">暂无反向引用</span>';

          var entryEl = document.getElementById(n.id);
          var bodyEl = entryEl ? entryEl.querySelector(".entry-body") : null;
          var bodyHtml = bodyEl ? bodyEl.innerHTML : "";

          inspectorEl.innerHTML =
            '<div class="inspector-top-row">' +
              '<div class="inspector-badge"><span class="legend-dot" style="background:' + SECTION_PALETTE[n.section].hex + '"></span><span>Section ' + n.section + " · " + escapeText(sec ? sec.shortTitle : "") + "</span></div>" +
              '<button type="button" class="inspector-close" data-clear-focus="1">清除选中</button>' +
            "</div>" +
            '<h3 class="inspector-title">' + escapeText(n.term) + "</h3>" +
            '<p class="inspector-desc">' + escapeText(n.description) + "</p>" +
            '<div class="inspector-stats">' +
              '<span class="stat-pill">引用 ' + outs.length + " 个词条</span>" +
              '<span class="stat-pill">被引用 ' + ins.length + " 次</span>" +
            "</div>" +
            '<div class="inspector-tabs" role="tablist">' +
              '<button type="button" class="inspector-tab ' + (activeInspectorTab === "links" ? "active" : "") + '" data-itab="links">关联网络</button>' +
              '<button type="button" class="inspector-tab ' + (activeInspectorTab === "article" ? "active" : "") + '" data-itab="article">完整词条</button>' +
            "</div>" +
            '<div class="inspector-pane ' + (activeInspectorTab === "links" ? "" : "hidden") + '" data-ipane="links">' +
              '<div><div class="inspector-group-title"><span class="legend-dot" style="background:#3b82f6"></span>引用了（出度 · ' + outs.length + '）</div><div class="inspector-chips">' + outChips + "</div></div>" +
              '<div><div class="inspector-group-title"><span class="legend-dot" style="background:#f59e0b"></span>被以下词条引用（入度 · ' + ins.length + '）</div><div class="inspector-chips">' + inChips + "</div></div>" +
            "</div>" +
            '<div class="inspector-pane ' + (activeInspectorTab === "article" ? "" : "hidden") + '" data-ipane="article">' +
              '<div class="inspector-article">' + bodyHtml + "</div>" +
            "</div>" +
            '<button type="button" class="inspector-cta" data-read-id="' + escapeText(n.id) + '">在词典页打开 ↗</button>';
          inspectorEl.scrollTop = 0;
        }

        inspectorEl.addEventListener("click", function (e) {
          var clearBtn = e.target.closest("[data-clear-focus]");
          if (clearBtn) { clearSelection(); return; }
          var tabBtn = e.target.closest("[data-itab]");
          if (tabBtn) {
            activeInspectorTab = tabBtn.dataset.itab;
            inspectorEl.querySelectorAll("[data-itab]").forEach(function (b) {
              b.classList.toggle("active", b.dataset.itab === activeInspectorTab);
            });
            inspectorEl.querySelectorAll("[data-ipane]").forEach(function (p) {
              p.classList.toggle("hidden", p.dataset.ipane !== activeInspectorTab);
            });
            return;
          }
          var focusBtn = e.target.closest("[data-focus-id]");
          if (focusBtn) { focusNode(focusBtn.dataset.focusId); return; }
          var innerLink = e.target.closest(".inspector-article a.term-link");
          if (innerLink && innerLink.dataset.target) {
            e.preventDefault();
            focusNode(innerLink.dataset.target);
            return;
          }
          var readBtn = e.target.closest("[data-read-id]");
          if (readBtn) { setView("dict", readBtn.dataset.readId); }
        });

        focusClear.addEventListener("click", clearSelection);

        function hitTest(sx, sy) {
          var p = screenToWorld(sx, sy);
          for (var i = nodes.length - 1; i >= 0; i--) {
            var n = nodes[i];
            var dx = p.x - n.x;
            var dy = p.y - n.y;
            var hitR = Math.max(n.r + 7 / camScale, 14 / camScale);
            if (dx * dx + dy * dy <= hitR * hitR) return n;
          }
          return null;
        }

        // Tactile pointer interactions: smooth node drag with release momentum + inertial pan
        var panning = false;
        var moved = false;
        var lastSX = 0;
        var lastSY = 0;

        canvas.addEventListener("pointerdown", function (e) {
          var rect = canvas.getBoundingClientRect();
          var sx = e.clientX - rect.left;
          var sy = e.clientY - rect.top;
          lastSX = sx;
          lastSY = sy;
          moved = false;
          panVelX = 0;
          panVelY = 0;
          var hit = hitTest(sx, sy);
          if (hit) {
            draggingNode = hit;
            var wp = screenToWorld(sx, sy);
            dragTargetX = wp.x;
            dragTargetY = wp.y;
            dragVelX = 0;
            dragVelY = 0;
            simEnergy = Math.max(simEnergy, 0.55);
            canvas.style.cursor = "grabbing";
          } else {
            panning = true;
            canvas.style.cursor = "grabbing";
          }
          canvas.setPointerCapture(e.pointerId);
        });

        canvas.addEventListener("pointermove", function (e) {
          var rect = canvas.getBoundingClientRect();
          var sx = e.clientX - rect.left;
          var sy = e.clientY - rect.top;
          if (draggingNode) {
            var distMove = Math.hypot(sx - lastSX, sy - lastSY);
            if (distMove > 2) moved = true;
            var wp = screenToWorld(sx, sy);
            dragTargetX = wp.x;
            dragTargetY = wp.y;
            simEnergy = Math.max(simEnergy, 0.45);
          } else if (panning) {
            var dx = sx - lastSX;
            var dy = sy - lastSY;
            if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
            targetCamX -= dx / camScale;
            targetCamY -= dy / camScale;
            camX = targetCamX;
            camY = targetCamY;
            panVelX = dx * 0.72;
            panVelY = dy * 0.72;
            lastSX = sx;
            lastSY = sy;
          } else {
            var hit = hitTest(sx, sy);
            hoveredId = hit ? hit.id : null;
            canvas.style.cursor = hit ? "grab" : "default";
          }
        });

        canvas.addEventListener("pointerup", function (e) {
          var rect = canvas.getBoundingClientRect();
          var sx = e.clientX - rect.left;
          var sy = e.clientY - rect.top;
          if (draggingNode) {
            if (!moved) {
              selectedId = draggingNode.id;
              renderInspector(selectedId);
            } else {
              // Apply gentle release glide momentum
              draggingNode.vx = dragVelX;
              draggingNode.vy = dragVelY;
              simEnergy = Math.max(simEnergy, 0.4);
            }
            draggingNode = null;
          } else if (panning && !moved) {
            var hit = hitTest(sx, sy);
            selectedId = hit ? hit.id : null;
            renderInspector(selectedId);
          }
          panning = false;
          canvas.style.cursor = hitTest(sx, sy) ? "grab" : "default";
        });

        canvas.addEventListener("wheel", function (e) {
          e.preventDefault();
          var rect = canvas.getBoundingClientRect();
          var sx = e.clientX - rect.left;
          var sy = e.clientY - rect.top;
          var before = screenToWorld(sx, sy);
          var factor = Math.exp(-e.deltaY * 0.0014);
          targetCamScale = Math.max(0.28, Math.min(3.2, targetCamScale * factor));
          // Keep cursor anchor point stable while zooming
          var nextW = {
            x: (sx - width / 2) / targetCamScale + targetCamX,
            y: (sy - height / 2) / targetCamScale + targetCamY
          };
          targetCamX += before.x - nextW.x;
          targetCamY += before.y - nextW.y;
        }, { passive: false });

        document.getElementById("zoomInBtn").addEventListener("click", function () {
          targetCamScale = Math.min(3.2, targetCamScale * 1.28);
        });
        document.getElementById("zoomOutBtn").addEventListener("click", function () {
          targetCamScale = Math.max(0.28, targetCamScale * 0.78);
        });
        document.getElementById("resetGraphBtn").addEventListener("click", function () {
          selectedId = null;
          activeSection = 0;
          edgeDir = "both";
          Array.prototype.slice.call(legendEl.querySelectorAll(".legend-chip")).forEach(function (el) {
            el.classList.toggle("active", el.dataset.sec === "0");
            el.classList.remove("dimmed");
          });
          document.querySelectorAll(".graph-ctrl-btn[data-dir]").forEach(function (b) {
            b.classList.toggle("active", b.dataset.dir === "both");
          });
          renderInspector(null);
          fitView(false);
        });

        window.addEventListener("resize", function () {
          if (currentView === "graph") resize();
        });

        function focusNode(id) {
          var n = nodeMap.get(id);
          if (!n) return;
          selectedId = id;
          targetCamX = n.x;
          targetCamY = n.y;
          targetCamScale = Math.max(targetCamScale, 1.15);
          renderInspector(id);
        }

        function clearSelection() {
          selectedId = null;
          renderInspector(null);
        }

        renderInspector(null);
        requestAnimationFrame(drawFrame);

        return {
          resize: resize,
          draw: function () {},
          focusNode: focusNode,
          setSearchQuery: function (q) {
            searchQuery = (q || "").trim().toLowerCase();
            if (searchQuery) {
              var match = nodes.find(function (n) { return n.searchText.indexOf(searchQuery) !== -1; });
              if (match && !selectedId) {
                targetCamX = match.x;
                targetCamY = match.y;
                targetCamScale = Math.max(targetCamScale, 1.05);
              }
            }
          },
          clearSelection: clearSelection
        };
      }

      // Editorial Knowledge Map Engine (Prototype-inspired 3-col Bento + Labeled SVG Curved Arrows)
      function initMap() {
        var raw = document.getElementById("graph-data").textContent;
        var data = JSON.parse(raw);
        var mapGrid = document.getElementById("mapGrid");
        var mapSvg = document.getElementById("mapSvg");
        var mapBoard = document.getElementById("mapBoard");
        var mapDetail = document.getElementById("mapDetail");
        var mapPathWrap = document.getElementById("mapPathWrap");
        var mapExpandAllBtn = document.getElementById("mapExpandAllBtn");
        var mapZoomVal = document.getElementById("mapZoomVal");
        var mapBottomNote = document.getElementById("mapBottomNote");

        var ZONE_DOTS = {
          1: "#2f7d4d",
          2: "#3b82c4",
          3: "#6f5cc3",
          4: "#d96b43",
          5: "#d99226",
          6: "#7c5cc4",
          7: "#3c8d57"
        };

        var ZONE_SHORT_TITLES = {
          1: "01 模型",
          2: "02 会话与上下文",
          3: "03 工具与环境",
          4: "04 失效模式",
          5: "05 交接",
          6: "06 记忆与引导",
          7: "07 工作模式"
        };

        // Prototype curated core terms per section (22 core terms visible cleanly by default)
        var CORE_IDS = new Set([
          "模型model", "token词元", "推理inference", "harness驾驭框架",
          "agent智能体", "上下文context", "会话session", "上下文窗口context-window",
          "工具tool", "mcp模型上下文协议", "沙箱sandbox",
          "幻觉hallucination", "注意力退化attention-degradation",
          "spec规格说明书", "ticket任务单", "上下文压缩compaction",
          "agentsmd", "skill技能", "subagent子智能体",
          "人在回路human-in-the-loop", "自动化检查automated-check", "软件工厂software-factory"
        ]);

        // Curated labeled relationships & confusable comparisons loaded from internal/map-relations.json
        var LABELED_REL = data.labeledRelations || {};
        var CONFUSABLE = data.confusable || {};

        var READING_PATH = [
          { id: "模型model", label: "Model" },
          { id: "harness驾驭框架", label: "Harness" },
          { id: "agent智能体", label: "Agent" },
          { id: "工具tool", label: "Tool" },
          { id: "上下文窗口context-window", label: "Context window" },
          { id: "会话session", label: "Session" },
          { id: "上下文压缩compaction", label: "Compaction" },
          { id: "skill技能", label: "Skill" },
          { id: "人在回路human-in-the-loop", label: "HITL" }
        ];

        var nodeMap = new Map();
        var outMap = new Map();
        var inMap = new Map();
        var expandedZones = new Set();
        var expandAll = false;
        var mapZoom = 1;
        var mapQuery = "";
        var selectedId = "harness驾驭框架";

        data.nodes.forEach(function (n) {
          var m = n.term.match(/^(.+?)（(.+?)）$/);
          var enTitle = n.term;
          var zhTitle = "";
          if (m) {
            if (/^[A-Za-z0-9]/.test(m[1])) {
              enTitle = m[1];
              zhTitle = m[2];
            } else {
              zhTitle = m[1];
              enTitle = m[2];
            }
          }
          var obj = {
            id: n.id,
            term: n.term,
            shortLabel: n.shortLabel,
            enTitle: enTitle,
            zhTitle: zhTitle,
            cardTitle: zhTitle ? (enTitle + " " + zhTitle) : enTitle,
            section: n.section,
            description: n.description,
            inCount: n.inCount,
            outCount: n.outCount,
            searchText: (n.term + " " + n.description + " " + (n.aliases || []).join(" ")).toLowerCase()
          };
          nodeMap.set(obj.id, obj);
          outMap.set(obj.id, []);
          inMap.set(obj.id, []);
        });

        data.edges.forEach(function (e) {
          var s = nodeMap.get(e.source);
          var t = nodeMap.get(e.target);
          if (s && t) {
            outMap.get(s.id).push(t);
            inMap.get(t.id).push(s);
          }
        });

        if (!nodeMap.has(selectedId) && data.nodes.length > 0) {
          selectedId = data.nodes[0].id;
        }

        function escapeText(str) {
          return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
        }

        // Build 3-column Bento matching prototype: Col1 [1,4,6], Col2 [2,5], Col3 [3,7]
        var COLUMNS = [[1, 4, 6], [2, 5], [3, 7]];
        var cardEls = new Map();
        var zoneToggleBtns = new Map();

        COLUMNS.forEach(function (secList) {
          var col = document.createElement("div");
          col.className = "map-col";
          secList.forEach(function (secId) {
            var zoneNodes = data.nodes
              .map(function (n) { return nodeMap.get(n.id); })
              .filter(function (n) { return n && n.section === secId; });

            var zone = document.createElement("div");
            zone.className = "map-zone";
            zone.dataset.sec = String(secId);

            var head = document.createElement("div");
            head.className = "map-zone-head";
            head.innerHTML = '<span class="map-zone-title">' + escapeText(ZONE_SHORT_TITLES[secId] || ("0" + secId)) + "</span>";

            var toggleBtn = document.createElement("button");
            toggleBtn.type = "button";
            toggleBtn.className = "map-zone-toggle";
            toggleBtn.dataset.sec = String(secId);
            head.appendChild(toggleBtn);
            zoneToggleBtns.set(secId, toggleBtn);

            var list = document.createElement("div");
            list.className = "map-zone-cards";

            zoneNodes.forEach(function (nd) {
              var card = document.createElement("button");
              card.type = "button";
              card.className = "map-card";
              card.dataset.id = nd.id;
              card.innerHTML =
                '<span class="map-card-dot" style="background:' + ZONE_DOTS[secId] + '"></span>' +
                '<div class="map-card-content">' +
                  '<div class="map-card-title">' + escapeText(nd.cardTitle) + "</div>" +
                  '<div class="map-card-sub">' + escapeText(nd.description) + "</div>" +
                "</div>";
              card.addEventListener("click", function () {
                selectNode(nd.id);
              });
              list.appendChild(card);
              cardEls.set(nd.id, card);
            });

            zone.appendChild(head);
            zone.appendChild(list);
            col.appendChild(zone);
          });
          mapGrid.appendChild(col);
        });

        // Build bottom reading path
        READING_PATH.forEach(function (step, idx) {
          if (idx > 0) {
            var arr = document.createElement("span");
            arr.className = "map-path-arrow";
            arr.textContent = "→";
            mapPathWrap.appendChild(arr);
          }
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "map-path-step";
          btn.dataset.id = step.id;
          btn.textContent = step.label;
          btn.addEventListener("click", function () {
            selectNode(step.id);
          });
          mapPathWrap.appendChild(btn);
        });

        function isCardVisible(nd) {
          if (mapQuery) {
            return nd.searchText.indexOf(mapQuery) !== -1;
          }
          if (expandAll || expandedZones.has(nd.section)) return true;
          return CORE_IDS.has(nd.id) || nd.id === selectedId;
        }

        function updateVisibilityAndHighlight() {
          var outsSet = new Set((outMap.get(selectedId) || []).map(function (n) { return n.id; }));
          var insSet = new Set((inMap.get(selectedId) || []).map(function (n) { return n.id; }));
          var visibleCount = 0;

          nodeMap.forEach(function (nd) {
            var el = cardEls.get(nd.id);
            if (!el) return;
            var vis = isCardVisible(nd);
            el.classList.toggle("hidden", !vis);
            if (vis) visibleCount++;
            var isSel = nd.id === selectedId;
            var isRel = outsSet.has(nd.id) || insSet.has(nd.id);
            el.classList.toggle("selected", isSel);
            el.classList.toggle("related", !isSel && isRel);
            el.classList.toggle("dimmed", !isSel && !isRel && !mapQuery);
          });

          zoneToggleBtns.forEach(function (btn, secId) {
            var total = data.nodes.filter(function (n) { return n.section === secId; }).length;
            var isExp = expandAll || expandedZones.has(secId);
            btn.textContent = isExp ? "收起" : ("全部 " + total);
          });

          mapExpandAllBtn.classList.toggle("active", expandAll);
          mapExpandAllBtn.textContent = expandAll ? "切换为精简核心视图" : "展开全部 72 词条";
          mapBottomNote.textContent = "7 个主题 · 当前展示 " + visibleCount + " / " + data.nodes.length + " 个词条";

          mapPathWrap.querySelectorAll(".map-path-step").forEach(function (btn) {
            btn.classList.toggle("active", btn.dataset.id === selectedId);
          });

          requestAnimationFrame(drawArrows);
        }

        function drawArrows() {
          while (mapSvg.firstChild) mapSvg.removeChild(mapSvg.firstChild);
          var srcEl = cardEls.get(selectedId);
          if (!srcEl || srcEl.classList.contains("hidden")) return;

          var boardRect = mapBoard.getBoundingClientRect();
          if (boardRect.width === 0) return;

          var isDark = document.documentElement.dataset.theme === "dark";
          var green = isDark ? "#5cc487" : "#2e6b48";
          var gray = isDark ? "#64748b" : "#9ca3af";
          var labelBg = isDark ? "#141918" : "#ffffff";

          var ns = "http://www.w3.org/2000/svg";
          var defs = document.createElementNS(ns, "defs");

          function addMarker(id, color) {
            var marker = document.createElementNS(ns, "marker");
            marker.setAttribute("id", id);
            marker.setAttribute("viewBox", "0 0 10 10");
            marker.setAttribute("refX", "8");
            marker.setAttribute("refY", "5");
            marker.setAttribute("markerWidth", "6");
            marker.setAttribute("markerHeight", "6");
            marker.setAttribute("orient", "auto-start-reverse");
            var path = document.createElementNS(ns, "path");
            path.setAttribute("d", "M 1 1.5 L 8.5 5 L 1 8.5 z");
            path.setAttribute("fill", color);
            marker.appendChild(path);
            defs.appendChild(marker);
          }
          addMarker("arrowGreen", green);
          addMarker("arrowGray", gray);
          mapSvg.appendChild(defs);

          function getBox(el) {
            var r = el.getBoundingClientRect();
            return {
              left: (r.left - boardRect.left) / mapZoom,
              right: (r.right - boardRect.left) / mapZoom,
              top: (r.top - boardRect.top) / mapZoom,
              bottom: (r.bottom - boardRect.top) / mapZoom,
              cx: ((r.left + r.right) / 2 - boardRect.left) / mapZoom,
              cy: ((r.top + r.bottom) / 2 - boardRect.top) / mapZoom
            };
          }

          var srcBox = getBox(srcEl);
          var outs = outMap.get(selectedId) || [];
          var visibleOuts = outs.filter(function (t) {
            var el = cardEls.get(t.id);
            return el && !el.classList.contains("hidden");
          });

          // Draw general gray arrows first, then green labeled arrows on top
          visibleOuts.sort(function (a, b) {
            var la = LABELED_REL[selectedId + "->" + a.id] ? 1 : 0;
            var lb = LABELED_REL[selectedId + "->" + b.id] ? 1 : 0;
            return la - lb;
          });

          visibleOuts.forEach(function (targetNode, idx) {
            var tgtEl = cardEls.get(targetNode.id);
            if (!tgtEl) return;
            var tgtBox = getBox(tgtEl);
            var rel = LABELED_REL[selectedId + "->" + targetNode.id];
            var isLabeled = Boolean(rel);

            // Pick clean anchor sides based on relative position
            var x1, y1, x2, y2, cx1, cy1, cx2, cy2;
            var sameCol = Math.abs(srcBox.cx - tgtBox.cx) < 120;
            if (sameCol) {
              // Curve gracefully along right edge of cards in same column
              x1 = srcBox.right;
              y1 = srcBox.cy;
              x2 = tgtBox.right;
              y2 = tgtBox.cy;
              var bulge = 38 + (idx % 3) * 14;
              cx1 = Math.max(x1, x2) + bulge;
              cy1 = y1;
              cx2 = Math.max(x1, x2) + bulge;
              cy2 = y2;
            } else if (tgtBox.cx > srcBox.cx) {
              x1 = srcBox.right;
              y1 = srcBox.cy;
              x2 = tgtBox.left - 3;
              y2 = tgtBox.cy;
              var dx = (x2 - x1) * 0.45;
              cx1 = x1 + dx;
              cy1 = y1;
              cx2 = x2 - dx;
              cy2 = y2;
            } else {
              x1 = srcBox.left;
              y1 = srcBox.cy;
              x2 = tgtBox.right + 3;
              y2 = tgtBox.cy;
              var dxL = (x1 - x2) * 0.45;
              cx1 = x1 - dxL;
              cy1 = y1;
              cx2 = x2 + dxL;
              cy2 = y2;
            }

            var d = "M " + x1 + " " + y1 + " C " + cx1 + " " + cy1 + ", " + cx2 + " " + cy2 + ", " + x2 + " " + y2;
            var path = document.createElementNS(ns, "path");
            path.setAttribute("d", d);
            path.setAttribute("fill", "none");
            path.setAttribute("stroke", isLabeled ? green : gray);
            path.setAttribute("stroke-width", isLabeled ? "2.1" : "1.2");
            path.setAttribute("stroke-opacity", isLabeled ? "0.92" : "0.42");
            path.setAttribute("marker-end", isLabeled ? "url(#arrowGreen)" : "url(#arrowGray)");
            mapSvg.appendChild(path);

            if (isLabeled) {
              // Cubic Bezier midpoint at t=0.52
              var t = 0.52;
              var u = 1 - t;
              var lx = u*u*u*x1 + 3*u*u*t*cx1 + 3*u*t*t*cx2 + t*t*t*x2;
              var ly = u*u*u*y1 + 3*u*u*t*cy1 + 3*u*t*t*cy2 + t*t*t*y2;
              var textLen = rel.verb.length * 12 + 16;

              var rect = document.createElementNS(ns, "rect");
              rect.setAttribute("x", String(lx - textLen / 2));
              rect.setAttribute("y", String(ly - 11));
              rect.setAttribute("width", String(textLen));
              rect.setAttribute("height", "22");
              rect.setAttribute("rx", "11");
              rect.setAttribute("fill", labelBg);
              rect.setAttribute("stroke", green);
              rect.setAttribute("stroke-width", "1.4");
              mapSvg.appendChild(rect);

              var txt = document.createElementNS(ns, "text");
              txt.setAttribute("x", String(lx));
              txt.setAttribute("y", String(ly + 4));
              txt.setAttribute("text-anchor", "middle");
              txt.setAttribute("font-size", "11.5");
              txt.setAttribute("font-weight", "700");
              txt.setAttribute("fill", green);
              txt.textContent = rel.verb;
              mapSvg.appendChild(txt);
            }
          });
        }

        function renderDetail(id) {
          var nd = nodeMap.get(id);
          if (!nd) return;
          var secName = (ZONE_SHORT_TITLES[nd.section] || "").replace(/^\d+\s+/, "");
          var outs = outMap.get(nd.id) || [];
          var ins = inMap.get(nd.id) || [];

          // Build "它负责什么 / 核心关联" rows
          var relRows = [];
          outs.forEach(function (t) {
            var rel = LABELED_REL[nd.id + "->" + t.id];
            if (rel) {
              relRows.push({ id: t.id, label: t.shortLabel, note: rel.desc, primary: true });
            }
          });
          if (relRows.length < 4) {
            outs.forEach(function (t) {
              if (relRows.length >= 5) return;
              if (relRows.some(function (r) { return r.id === t.id; })) return;
              relRows.push({ id: t.id, label: t.shortLabel, note: t.description.slice(0, 18) + (t.description.length > 18 ? "…" : ""), primary: false });
            });
          }

          var relTitle = nd.id === "harness驾驭框架" ? "它负责什么" : "核心关联";
          var relHtml = relRows.length
            ? relRows.map(function (r) {
                return '<div class="map-rel-row"><button type="button" class="map-rel-pill" data-map-select="' + escapeText(r.id) + '">' + escapeText(r.label) + '</button><span>→</span><span>' + escapeText(r.note) + "</span></div>";
              }).join("")
            : '<div style="font-size:13px;color:var(--text-muted)">为基础底层概念，被 ' + ins.length + " 个词条引用。</div>";

          // Build "容易混淆 / 被引用" rows
          var confList = CONFUSABLE[nd.id];
          var secondTitle = confList ? "容易混淆" : ("被以下核心词条引用（" + ins.length + "）");
          var secondHtml = "";
          if (confList) {
            secondHtml = confList.map(function (c) {
              var cn = nodeMap.get(c.id);
              return '<div class="map-rel-row"><button type="button" class="map-rel-pill muted" data-map-select="' + escapeText(c.id) + '">' + escapeText(cn ? cn.enTitle : c.id) + "</button><span>：</span><span>" + escapeText(c.note) + "</span></div>";
            }).join("");
          } else if (ins.length > 0) {
            secondHtml = '<div style="display:flex;flex-wrap:wrap;gap:6px;">' + ins.slice(0, 8).map(function (t) {
              return '<button type="button" class="map-rel-pill muted" data-map-select="' + escapeText(t.id) + '">' + escapeText(t.shortLabel) + "</button>";
            }).join("") + "</div>";
          } else {
            secondHtml = '<div style="font-size:13px;color:var(--text-muted)">暂无反向引用</div>';
          }

          mapDetail.innerHTML =
            '<div>' +
              '<div class="map-crumb">' + escapeText(secName) + " / " + escapeText(nd.enTitle) + "</div>" +
              '<h2 class="map-detail-en">' + escapeText(nd.enTitle) + "</h2>" +
              (nd.zhTitle ? '<div class="map-detail-zh">' + escapeText(nd.zhTitle) + "</div>" : "") +
            "</div>" +
            '<p class="map-detail-desc">' + escapeText(nd.description) + "</p>" +
            '<div><h3 class="map-detail-sec-title">' + escapeText(relTitle) + '</h3><div class="map-rel-list">' + relHtml + "</div></div>" +
            '<div><h3 class="map-detail-sec-title">' + escapeText(secondTitle) + '</h3><div class="map-rel-list">' + secondHtml + "</div></div>" +
            '<div class="map-detail-actions">' +
              '<button type="button" class="map-read-btn" data-map-read="' + escapeText(nd.id) + '">阅读完整词条 ↗</button>' +
              '<button type="button" class="map-graph-btn" data-map-graph="' + escapeText(nd.id) + '">在交互式知识图谱中查看</button>' +
            "</div>";
        }

        function selectNode(id) {
          if (!nodeMap.has(id)) return;
          selectedId = id;
          renderDetail(id);
          updateVisibilityAndHighlight();
          var el = cardEls.get(id);
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
          }
        }

        mapGrid.addEventListener("click", function (e) {
          var tBtn = e.target.closest(".map-zone-toggle");
          if (tBtn) {
            var secId = Number(tBtn.dataset.sec);
            if (expandAll) {
              expandAll = false;
              expandedZones.clear();
            } else if (expandedZones.has(secId)) {
              expandedZones.delete(secId);
            } else {
              expandedZones.add(secId);
            }
            updateVisibilityAndHighlight();
          }
        });

        mapDetail.addEventListener("click", function (e) {
          var selBtn = e.target.closest("[data-map-select]");
          if (selBtn) { selectNode(selBtn.dataset.mapSelect); return; }
          var readBtn = e.target.closest("[data-map-read]");
          if (readBtn) { setView("dict", readBtn.dataset.mapRead); return; }
          var graphBtn = e.target.closest("[data-map-graph]");
          if (graphBtn) { setView("graph", graphBtn.dataset.mapGraph); }
        });

        mapExpandAllBtn.addEventListener("click", function () {
          expandAll = !expandAll;
          if (!expandAll) expandedZones.clear();
          updateVisibilityAndHighlight();
        });

        function applyZoom(z) {
          mapZoom = Math.max(0.7, Math.min(1.35, Math.round(z * 100) / 100));
          mapBoard.style.transform = "scale(" + mapZoom + ")";
          mapZoomVal.textContent = Math.round(mapZoom * 100) + "%";
          requestAnimationFrame(drawArrows);
        }

        document.getElementById("mapZoomIn").addEventListener("click", function () { applyZoom(mapZoom + 0.1); });
        document.getElementById("mapZoomOut").addEventListener("click", function () { applyZoom(mapZoom - 0.1); });
        document.getElementById("mapZoomReset").addEventListener("click", function () { applyZoom(1); });

        window.addEventListener("resize", function () {
          if (currentView === "map") requestAnimationFrame(drawArrows);
        });

        renderDetail(selectedId);
        updateVisibilityAndHighlight();

        return {
          selectNode: selectNode,
          redrawArrows: drawArrows,
          setSearchQuery: function (q) {
            mapQuery = (q || "").trim().toLowerCase();
            updateVisibilityAndHighlight();
          }
        };
      }

      // Route initial view from URL hash (default: Editorial Knowledge Map)
      var initHash = window.location.hash;
      if (initHash === "#graph") {
        setView("graph");
      } else if (initHash && initHash !== "#map") {
        var decodedSlug = decodeURIComponent(initHash.slice(1));
        if (document.getElementById(decodedSlug)) {
          setView("dict", decodedSlug);
        } else {
          setView("map");
        }
      } else {
        setView("map");
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

  const graphData = buildGraphData(sections, entries);
  const graphJson = JSON.stringify(graphData);

  mkdirSync(DIST_DIR, { recursive: true });
  writeFileSync(
    join(DIST_DIR, "index.html"),
    buildHtml(sections, entries, graphJson)
  );
  writeFileSync(join(DIST_DIR, "graph.json"), JSON.stringify(graphData, null, 2));
  writeFileSync(join(DIST_DIR, ".nojekyll"), "");
  console.log(
    `Generated dist/index.html & dist/graph.json (${entries.length} nodes, ${graphData.edges.length} edges across ${sections.length} sections).`
  );
}

main();
