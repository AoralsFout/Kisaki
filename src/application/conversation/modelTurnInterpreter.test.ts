import { describe, expect, it, vi } from 'vitest'
import type { ModelStreamSnapshot } from './modelStreamDecoder'
import { interpretModelTurn } from './modelTurnInterpreter'

const stream = (overrides: Partial<ModelStreamSnapshot> = {}): ModelStreamSnapshot => ({
  thinking: '',
  visibleText: '',
  sawThink: false,
  thinkComplete: false,
  ...overrides,
})

const options = {
  requestId: 'request-1',
  turn: 1,
  sayToolName: 'say',
  extractTextToolCalls: vi.fn(() => []),
  stripTextToolCalls: vi.fn((text: string) => text),
}

describe('interpretModelTurn', () => {
  it('uses decoded visible text instead of leaking think content', () => {
    const result = interpretModelTurn(
      { type: 'done', text: '<think>secret</think>answer' },
      stream({ sawThink: true, thinkComplete: true, thinking: 'secret', visibleText: 'answer' }),
      options,
    )
    expect(result).toEqual({ type: 'final-text', text: 'answer' })
  })

  it('normalizes textual fallback calls into a tool batch', () => {
    const result = interpretModelTurn(
      { type: 'done', text: 'read_file({"path":"a.txt"})' },
      stream(),
      {
        ...options,
        extractTextToolCalls: () => [{ id: 'read', name: 'read_file', arguments: { path: 'a.txt' } }],
        stripTextToolCalls: () => '',
      },
    )
    expect(result).toMatchObject({
      type: 'tool-batch',
      batch: {
        source: 'text',
        actions: [{ call: { requestId: 'request-1', turn: 1 } }],
      },
    })
  })

  it('normalizes native calls through the same output variant', () => {
    const result = interpretModelTurn({
      type: 'tools',
      calls: [{
        id: 'say-1',
        type: 'function',
        function: { name: 'say', arguments: '{"display":"done"}' },
      }],
    }, stream(), options)
    expect(result).toMatchObject({
      type: 'tool-batch',
      batch: { source: 'native', sayCall: { id: 'say-1' }, actions: [] },
    })
  })

  it('classifies blank and malformed empty tool responses explicitly', () => {
    expect(interpretModelTurn({ type: 'done', text: '   ' }, stream(), options)).toEqual({ type: 'empty' })
    expect(interpretModelTurn({ type: 'tools', calls: [] }, stream(), options)).toEqual({ type: 'empty' })
  })
})
