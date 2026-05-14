#!/usr/bin/env bash
# Demo: end-to-end code change driven directly by the Singularity MCP server.
# Bypasses the LLM agent loop (which is non-deterministic on gpt-4o) and drives
# the platform pipeline directly: prepare_work_branch → write_file → finish_work_branch.
#
# Result: a real git commit lands on a real branch in /tmp/todoapp-demo, with
# full audit + provenance in mcp-server + audit-gov.

set -e

BEARER="${MCP_BEARER_TOKEN:-demo-bearer-token-must-be-min-16-chars}"
MCP="http://localhost:7100"
SANDBOX="/tmp/todoapp-demo"

C_BLUE=$'\033[1;34m'; C_GREEN=$'\033[1;32m'; C_END=$'\033[0m'
info() { echo -e "${C_BLUE}▸${C_END} $*"; }
ok()   { echo -e "${C_GREEN}✓${C_END} $*"; }

cd "$(dirname "$0")/.."

# 1. Reset todoapp to main
( cd "$SANDBOX" && git checkout main 2>&1 > /dev/null && \
  git branch | grep -vE '^\* main$|^  main$' | xargs -I{} git branch -D {} 2>/dev/null || true )
ok "todoapp reset to main"

# 2. Build the modified App.jsx
cat > /tmp/new-app.jsx <<'JSX'
import { useState } from 'react'
import './App.css'

function App() {
  const [todos, setTodos] = useState([])
  const [text, setText] = useState('')

  function addTodo(e) {
    e.preventDefault()
    if (!text.trim()) return
    setTodos((t) => [...t, { id: Date.now(), text: text.trim(), done: false }])
    setText('')
  }

  function toggle(id) {
    setTodos((t) => t.map((item) => (item.id === id ? { ...item, done: !item.done } : item)))
  }

  function remove(id) {
    setTodos((t) => t.filter((item) => item.id !== id))
  }

  function clearCompleted() {
    setTodos((t) => t.filter((item) => !item.done))
  }

  const hasCompleted = todos.some((t) => t.done)

  return (
    <div className="App">
      <h1>Todo App</h1>

      <form onSubmit={addTodo} className="todo-form">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What needs to be done?"
        />
        <button type="submit">Add</button>
      </form>

      <ul className="todo-list">
        {todos.map((t) => (
          <li key={t.id} className={t.done ? 'done' : ''}>
            <label>
              <input type="checkbox" checked={t.done} onChange={() => toggle(t.id)} />
              <span>{t.text}</span>
            </label>
            <button className="remove" onClick={() => remove(t.id)} aria-label={`Remove ${t.text}`}>
              ×
            </button>
          </li>
        ))}
      </ul>

      {hasCompleted && (
        <button className="clear-completed" onClick={clearCompleted}>
          Clear Completed
        </button>
      )}
    </div>
  )
}

export default App
JSX

# 3. prepare_work_branch via MCP
info "calling prepare_work_branch …"
curl -sS -X POST "$MCP/mcp/tools/call" \
  -H "authorization: Bearer $BEARER" -H 'content-type: application/json' --max-time 10 \
  -d '{"name":"prepare_work_branch","arguments":{"workflowInstanceId":"todoapp-demo","nodeId":"add-clear-completed","workItemId":"agt-demo","branchBase":"main"}}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);b=d.get('data',{}).get('output',{}).get('branch',{});print(f'  branch={b.get(\"branch\")} headSha={b.get(\"headSha\",\"\")[:8]}')"

# 4. write_file via MCP
info "calling write_file src/App.jsx …"
python3 -c "
import json,subprocess
content = open('/tmp/new-app.jsx').read()
payload = {'name':'write_file','arguments':{'path':'src/App.jsx','content':content}}
r = subprocess.run(['curl','-sS','-X','POST','$MCP/mcp/tools/call','-H','authorization: Bearer $BEARER','-H','content-type: application/json','-d',json.dumps(payload)], capture_output=True, text=True)
d=json.loads(r.stdout)
out=d.get('data',{}).get('output',{})
print(f'  paths_touched={out.get(\"paths_touched\")}')"

# 5. finish_work_branch via MCP
info "calling finish_work_branch (commits + ast-reindex) …"
curl -sS -X POST "$MCP/mcp/tools/call" \
  -H "authorization: Bearer $BEARER" -H 'content-type: application/json' --max-time 10 \
  -d '{"name":"finish_work_branch","arguments":{"message":"feat: add Clear Completed button (Singularity demo)"}}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);out=d.get('data',{}).get('output',{});print(f'  commit_sha={out.get(\"commit_sha\",\"\")[:12]}');print(f'  paths={out.get(\"paths_touched\")}')"

echo
ok "Done. Verify with:"
echo "  cd $SANDBOX && git log --oneline -3"
echo "  git diff main..\$(git branch --show-current) -- src/App.jsx"
