#!/usr/bin/env node
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { marked } = require("../agent-and-tools/node_modules/marked");

const args = process.argv.slice(2);
let output = "docs/platform-handbook.html";
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--output") {
    output = args[index + 1];
    index += 1;
  } else if (arg === "-h" || arg === "--help") {
    console.log("Usage: node bin/render-platform-handbook-html.mjs [--output PATH]");
    process.exit(0);
  } else {
    console.error(`unknown argument: ${arg}`);
    process.exit(2);
  }
}

const mdPath = "docs/platform-handbook.md";
const htmlPath = "docs/platform-handbook.html";
const markdown = fs.readFileSync(mdPath, "utf8");
const currentHtml = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, "utf8") : "";
const style = (currentHtml.match(/<style>[\s\S]*?<\/style>/) || ["<style></style>"])[0];
const generatedDate = currentHtml.match(/Generated (\d{4}-\d{2}-\d{2})/)?.[1]
  || new Date().toISOString().slice(0, 10);

function stripTags(value) {
  return String(value).replace(/<[^>]*>/g, "");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function slugify(value) {
  return stripTags(value)
    .toLowerCase()
    .trim()
    .replace(/[`]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

const seen = new Map();
const toc = [];
const renderer = new marked.Renderer();

renderer.heading = (text, level, raw) => {
  const base = slugify(raw || text) || `section-${toc.length + 1}`;
  const count = seen.get(base) || 0;
  seen.set(base, count + 1);
  const id = count ? `${base}-${count}` : base;
  const plain = stripTags(text);
  if (level === 2 || level === 3) toc.push({ level, id, text: plain });
  const escapedId = escapeHtml(id);
  const escapedLabel = escapeHtml(plain);
  return `<h${level} id="${escapedId}">${text}<a class="anchor" href="#${escapedId}" aria-label="Link to ${escapedLabel}">#</a></h${level}>\n`;
};

renderer.code = (code, infostring) => {
  const lang = String(infostring || "").trim().split(/\s+/)[0];
  if (lang === "mermaid") return `<pre class="mermaid">${escapeHtml(code)}</pre>\n`;
  const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
  return `<pre><code${cls}>${escapeHtml(code)}</code></pre>\n`;
};

marked.setOptions({ gfm: true, breaks: false, mangle: false, headerIds: false, renderer });

const body = marked.parse(markdown);
const tocHtml = toc
  .map((item) => `<a class="toc-l${item.level}" href="#${escapeHtml(item.id)}">${escapeHtml(item.text)}</a>`)
  .join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Singularity Platform Handbook</title>
${style}
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
  mermaid.initialize({ startOnLoad: true, theme: 'neutral' });
</script>
</head>
<body>
<div class="shell">
<aside>
  <div class="brand">Singularity Handbook</div>
  <div class="sub">Standalone HTML generated from <code>docs/platform-handbook.md</code></div>
  <div class="nav-title">Contents</div>
  ${tocHtml}
</aside>
<main>
<article class="article">
  <div class="topline"><span class="badge">Platform Docs</span><span>Generated ${generatedDate}</span><span>Source: docs/platform-handbook.md</span></div>
${body}
  <div class="footer">Generated from Markdown. Edit <code>docs/platform-handbook.md</code> as the source of truth, then regenerate this HTML file.</div>
</article>
</main>
</div>
</body>
</html>
`;

fs.writeFileSync(output, html);
console.log(`wrote ${output} (${html.length} bytes, ${toc.length} toc entries)`);
