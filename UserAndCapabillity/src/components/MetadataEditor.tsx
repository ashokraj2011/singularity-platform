import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

interface MetadataEditorProps {
  value: Record<string, string>
  onChange: (metadata: Record<string, string>) => void
}

export function MetadataEditor({ value, onChange }: MetadataEditorProps) {
  const [draftKey, setDraftKey] = useState('')
  const [draftVal, setDraftVal] = useState('')

  const entries = Object.entries(value)

  function add() {
    const k = draftKey.trim()
    const v = draftVal.trim()
    if (!k) return
    onChange({ ...value, [k]: v })
    setDraftKey('')
    setDraftVal('')
  }

  function remove(key: string) {
    const next = { ...value }
    delete next[key]
    onChange(next)
  }

  function updateVal(key: string, newVal: string) {
    onChange({ ...value, [key]: newVal })
  }

  return (
    <div className="space-y-2">
      {entries.map(([k, v]) => (
        <div key={k} className="flex gap-2 items-center">
          <span className="text-xs font-mono bg-gray-100 text-gray-700 px-2 py-1.5 rounded w-32 shrink-0 truncate">
            {k}
          </span>
          <Input
            value={v}
            onChange={e => updateVal(k, e.target.value)}
            className="h-8 text-sm"
          />
          <button
            type="button"
            onClick={() => remove(k)}
            className="text-gray-400 hover:text-red-500 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}

      <div className="flex gap-2 items-center">
        <Input
          value={draftKey}
          onChange={e => setDraftKey(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), add())}
          placeholder="key"
          className="h-8 text-sm w-32 shrink-0 font-mono"
        />
        <Input
          value={draftVal}
          onChange={e => setDraftVal(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), add())}
          placeholder="value"
          className="h-8 text-sm"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={add}
          disabled={!draftKey.trim()}
          className="h-8 px-2 shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  )
}
