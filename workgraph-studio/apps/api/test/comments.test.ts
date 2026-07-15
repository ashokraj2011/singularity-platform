import { describe, it, expect } from 'vitest'
import { parseMentions, threadComments } from '../src/modules/comments/comment'

describe('parseMentions', () => {
  it('extracts distinct @handles, ignoring emails and mid-word @', () => {
    expect(parseMentions('hey @alice and @bob.smith, ping @alice again')).toEqual(['alice', 'bob.smith'])
    expect(parseMentions('mail me at foo@bar.com')).toEqual([])
    expect(parseMentions('@architect please review REQ-3')).toEqual(['architect'])
  })
})

describe('threadComments', () => {
  it('groups replies under their root comment', () => {
    const list = [
      { id: 'c1', parentId: null },
      { id: 'c2', parentId: 'c1' },
      { id: 'c3', parentId: null },
      { id: 'c4', parentId: 'c1' },
    ]
    const tree = threadComments(list)
    expect(tree.map((t) => t.comment.id)).toEqual(['c1', 'c3'])
    expect(tree[0].replies.map((r) => r.id)).toEqual(['c2', 'c4'])
    expect(tree[1].replies).toEqual([])
  })
})
