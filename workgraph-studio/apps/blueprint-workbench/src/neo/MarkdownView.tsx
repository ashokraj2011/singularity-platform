/**
 * Markdown / code reader used inside the Blueprint Workbench artifact
 * viewer and the FocusPane "latest stage output" pane.
 *
 * Auto-detects content type:
 *   - Looks like JSON (starts with `{` or `[`)        → <pre> with syntax-styling class
 *   - Looks like Java/Python/TS/diff (heuristic)      → <pre> code
 *   - Otherwise rendered as markdown via react-markdown + remark-gfm
 *
 * Falls back to <pre> if the content is empty or markdown parsing
 * fails — never throws.
 */
import { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownViewProps {
  content?: string
  /** Optional kind hint from the artifact ("md", "code", "openapi", "json"). */
  kind?: string
  /** Optional title hint — files ending in `.json` / `.yaml` / `.java` etc.
   *  are rendered as code regardless of body heuristics. */
  title?: string
  className?: string
}

type Mode = 'markdown' | 'json' | 'code' | 'empty'

const CODE_TITLE_EXT = /\.(java|kt|scala|py|ts|tsx|js|jsx|go|rs|cs|cpp|c|h|hpp|xml|html|css|scss|toml|conf|sh|bash|sql|diff|patch)$/i
const CONFIG_TITLE_EXT = /\.(json|yaml|yml)$/i
const DIFF_BODY_HINT = /^---\s+[ab]\/|^@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@/m
const JAVA_BODY_HINT = /^\s*(?:package\s+[a-z][\w.]*;|public\s+(?:class|record|interface)\s)/m
const PY_BODY_HINT = /^\s*(?:from\s+\w[\w.]*\s+import|class\s+\w+\s*(\(|:))/m
const TS_BODY_HINT = /^\s*(?:import\s+.*\s+from\s+['"]|export\s+(?:const|function|class|interface)\s)/m

function detectMode(props: MarkdownViewProps): Mode {
  const text = (props.content ?? '').trim()
  if (!text) return 'empty'
  if (props.title) {
    if (CODE_TITLE_EXT.test(props.title)) return 'code'
    if (CONFIG_TITLE_EXT.test(props.title)) return 'json'
  }
  if (props.kind) {
    const k = props.kind.toLowerCase()
    if (k.includes('json') || k.includes('yaml')) return 'json'
    if (k.includes('diff') || k.includes('patch') || k.includes('code')) return 'code'
    if (k === 'markdown' || k === 'md' || k.endsWith('_md')) return 'markdown'
  }
  // Body-shape heuristics — bias toward markdown.
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    try { JSON.parse(text); return 'json' } catch { /* not actually json */ }
  }
  if (DIFF_BODY_HINT.test(text)) return 'code'
  if (JAVA_BODY_HINT.test(text)) return 'code'
  if (PY_BODY_HINT.test(text)) return 'code'
  if (TS_BODY_HINT.test(text)) return 'code'
  return 'markdown'
}

export function MarkdownView(props: MarkdownViewProps) {
  const mode = useMemo(() => detectMode(props), [props.content, props.kind, props.title])
  const text = props.content ?? ''
  const className = props.className ?? 'neo-markdown'

  if (mode === 'empty') {
    return <pre className={className}>(no content)</pre>
  }
  if (mode === 'json') {
    let pretty = text
    try { pretty = JSON.stringify(JSON.parse(text), null, 2) } catch { /* leave as-is */ }
    return <pre className={`${className} as-json`}>{pretty}</pre>
  }
  if (mode === 'code') {
    return <pre className={`${className} as-code`}>{text}</pre>
  }
  try {
    return (
      <div className={`${className} as-markdown`}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    )
  } catch {
    // react-markdown should never throw for arbitrary input but keep
    // a final fallback so a malformed string can't blank the artifact
    // reader.
    return <pre className={className}>{text}</pre>
  }
}
