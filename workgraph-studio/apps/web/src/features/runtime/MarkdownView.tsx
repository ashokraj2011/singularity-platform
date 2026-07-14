/**
 * Minimal, dependency-free markdown renderer for workbench artifact content
 * (implementation contracts, QA task packs, verification rules, traceability
 * matrices, certification receipts, the final pack). Covers the constructs
 * those artifacts actually use — headings, bold/inline-code, bullet/numbered
 * lists, GFM tables, fenced code blocks, horizontal rules, paragraphs — and
 * renders everything else as plain text. Intentionally small: we don't pull a
 * markdown library into the monorepo just for read-only artifact display.
 *
 * Not a general-purpose markdown engine; if artifacts grow richer constructs,
 * swap this for react-markdown. Inline rendering escapes via React (no
 * dangerouslySetInnerHTML), so artifact content can't inject HTML.
 */
import React from 'react'

// ── inline: **bold**, `code` ────────────────────────────────────────────────
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  // Split on `code` first, then bold within non-code segments.
  const codeParts = text.split(/(`[^`]+`)/g)
  codeParts.forEach((part, ci) => {
    if (/^`[^`]+`$/.test(part)) {
      out.push(
        <code key={`${keyPrefix}-c${ci}`} style={{ fontFamily: 'monospace', background: 'rgba(128,128,128,0.18)', padding: '1px 4px', borderRadius: 3, fontSize: '0.92em' }}>
          {part.slice(1, -1)}
        </code>,
      )
      return
    }
    const boldParts = part.split(/(\*\*[^*]+\*\*)/g)
    boldParts.forEach((bp, bi) => {
      if (/^\*\*[^*]+\*\*$/.test(bp)) {
        out.push(<strong key={`${keyPrefix}-b${ci}-${bi}`}>{bp.slice(2, -2)}</strong>)
      } else if (bp) {
        out.push(<React.Fragment key={`${keyPrefix}-t${ci}-${bi}`}>{bp}</React.Fragment>)
      }
    })
  })
  return out
}

function splitTableRow(line: string): string[] {
  return line.replace(/^\||\|$/g, '').split('|').map(c => c.trim())
}
function isTableDivider(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-')
}

export function MarkdownView({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: React.ReactNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block
    if (/^```/.test(line.trim())) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++ }
      i++ // closing fence
      blocks.push(
        <pre key={key++} style={{ margin: '8px 0', padding: '10px 12px', background: '#0f172a', color: '#e2e8f0', borderRadius: 8, fontSize: 11.5, lineHeight: 1.5, overflow: 'auto' }}>
          {buf.join('\n')}
        </pre>,
      )
      continue
    }

    // Heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      const level = h[1].length
      const size = [18, 16, 14.5, 13.5, 12.5, 12][level - 1]
      blocks.push(
        <div key={key++} style={{ fontSize: size, fontWeight: 800, color: 'inherit', margin: level <= 2 ? '14px 0 6px' : '10px 0 4px', letterSpacing: '-0.01em' }}>
          {renderInline(h[2], `h${key}`)}
        </div>,
      )
      i++
      continue
    }

    // Horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push(<hr key={key++} style={{ border: 'none', borderTop: '1px solid rgba(128,128,128,0.3)', margin: '12px 0' }} />)
      i++
      continue
    }

    // GFM table: header row + divider row
    if (line.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      const header = splitTableRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitTableRow(lines[i])); i++
      }
      blocks.push(
        <table key={key++} style={{ borderCollapse: 'collapse', margin: '8px 0', fontSize: 12, width: '100%' }}>
          <thead>
            <tr>{header.map((c, ci) => (
              <th key={ci} style={{ textAlign: 'left', padding: '5px 8px', borderBottom: '2px solid rgba(128,128,128,0.3)', fontWeight: 700 }}>{renderInline(c, `th${key}-${ci}`)}</th>
            ))}</tr>
          </thead>
          <tbody>{rows.map((r, ri) => (
            <tr key={ri}>{r.map((c, ci) => (
              <td key={ci} style={{ padding: '5px 8px', borderBottom: '1px solid rgba(128,128,128,0.3)', verticalAlign: 'top' }}>{renderInline(c, `td${key}-${ri}-${ci}`)}</td>
            ))}</tr>
          ))}</tbody>
        </table>,
      )
      continue
    }

    // Lists (consecutive - / * / 1. lines)
    const listMatch = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line)
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[2])
      const itemsBuf: string[] = []
      while (i < lines.length) {
        const lm = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i])
        if (!lm) break
        itemsBuf.push(lm[3]); i++
      }
      const ListTag = ordered ? 'ol' : 'ul'
      blocks.push(
        <ListTag key={key++} style={{ margin: '6px 0', paddingLeft: 22, fontSize: 12.5, lineHeight: 1.6, color: 'inherit' }}>
          {itemsBuf.map((it, ii) => <li key={ii}>{renderInline(it, `li${key}-${ii}`)}</li>)}
        </ListTag>,
      )
      continue
    }

    // Blank line
    if (!line.trim()) { i++; continue }

    // Paragraph (gather consecutive non-structural lines)
    const paraBuf: string[] = [line]
    i++
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*([-*]|\d+\.)\s|\s*([-*_])\3{2,}\s*$)/.test(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1]))) {
      paraBuf.push(lines[i]); i++
    }
    blocks.push(
      <p key={key++} style={{ margin: '6px 0', fontSize: 12.5, lineHeight: 1.6, color: 'inherit' }}>
        {renderInline(paraBuf.join(' '), `p${key}`)}
      </p>,
    )
  }

  return <div>{blocks}</div>
}
