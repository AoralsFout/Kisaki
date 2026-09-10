import { describe, expect, it } from 'vitest'
import { SessionAggregate } from './sessionAggregate'
import { SessionCollection } from './sessionCollection'

function session(id: string, now: number) {
  return SessionAggregate.create({ id, title: id, now })
}

describe('SessionCollection', () => {
  it('creates and restores only the version 2 document', () => {
    const collection = SessionCollection.create(session('one', 1))
    collection.add(session('two', 2))
    const document = collection.snapshot()

    expect(document.schemaVersion).toBe(2)
    expect(document.currentSessionId).toBe('two')
    expect(SessionCollection.restore(document).snapshot()).toEqual(document)
  })

  it('rejects legacy documents without attempting migration', () => {
    expect(() => SessionCollection.restore({ sessions: [], currentId: 'legacy' }))
      .toThrow('Unsupported session document schema')
  })

  it('switches to the most recently updated remaining session when deleting current', () => {
    const first = session('first', 1)
    const second = session('second', 2)
    const third = session('third', 3)
    first.rename('updated first', 10)
    const collection = SessionCollection.create(first)
    collection.add(second)
    collection.add(third)

    collection.delete('third')

    expect(collection.snapshot().currentSessionId).toBe('first')
  })

  it('protects collection identity invariants', () => {
    const collection = SessionCollection.create(session('one', 1))
    expect(() => collection.add(session('one', 2))).toThrow('Duplicate session id')
    expect(() => collection.switchTo('missing')).toThrow('Session does not exist')
    expect(() => collection.delete('one')).toThrow('Cannot delete the last session')
  })
})
