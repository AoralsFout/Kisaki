import { describe, expect, it } from 'vitest'
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_COUNT,
  MAX_TOTAL_IMAGE_BYTES,
  validateImageFiles,
} from '../images'
import type { ImageAttachment } from '../types'

function fakeFile(name: string, type: string, size: number): File {
  return { name, type, size } as File
}

function existing(size: number): ImageAttachment {
  return { id: 'existing', name: 'old.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA==', size }
}

describe('image attachment validation', () => {
  it('accepts the image formats used by OpenAI-compatible vision inputs', () => {
    const files = [
      fakeFile('a.png', 'image/png', 10),
      fakeFile('b.jpg', 'image/jpeg', 10),
      fakeFile('c.webp', 'image/webp', 10),
      fakeFile('d.gif', 'image/gif', 10),
    ]
    expect(validateImageFiles(files).accepted).toEqual(files)
  })

  it('rejects unsupported and oversized files without discarding valid ones', () => {
    const valid = fakeFile('ok.png', 'image/png', 10)
    const result = validateImageFiles([
      fakeFile('vector.svg', 'image/svg+xml', 10),
      valid,
      fakeFile('huge.jpg', 'image/jpeg', MAX_IMAGE_BYTES + 1),
    ])
    expect(result.accepted).toEqual([valid])
    expect(result.error).toBe('unsupported')
  })

  it('enforces count and total request limits including existing images', () => {
    const tooMany = validateImageFiles(
      [fakeFile('new.png', 'image/png', 1)],
      Array.from({ length: MAX_IMAGE_COUNT }, () => existing(1)),
    )
    expect(tooMany.accepted).toHaveLength(0)
    expect(tooMany.error).toBe('tooMany')

    const total = validateImageFiles(
      [fakeFile('new.png', 'image/png', 2)],
      [existing(MAX_TOTAL_IMAGE_BYTES - 1)],
    )
    expect(total.accepted).toHaveLength(0)
    expect(total.error).toBe('totalTooLarge')
  })
})
