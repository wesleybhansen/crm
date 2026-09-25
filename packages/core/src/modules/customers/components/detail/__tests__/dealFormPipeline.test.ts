import { z } from 'zod'
import { optionalUuidField, pickDefaultPipelineId, pickFirstStageId } from '../dealFormPipeline'

const UUID = '3f2b8c1e-4a5d-4e6f-8a7b-9c0d1e2f3a4b'

describe('optionalUuidField', () => {
  const schema = z.object({ pipelineId: optionalUuidField('pipeline.invalid') })

  it('treats an unselected picker ("" or null) as not set instead of "Invalid UUID"', () => {
    expect(schema.parse({ pipelineId: '' })).toEqual({ pipelineId: undefined })
    expect(schema.parse({ pipelineId: null })).toEqual({ pipelineId: undefined })
    expect(schema.parse({})).toEqual({ pipelineId: undefined })
  })

  it('accepts a real id', () => {
    expect(schema.parse({ pipelineId: UUID })).toEqual({ pipelineId: UUID })
  })

  it('rejects junk with the plain-English message key', () => {
    const result = schema.safeParse({ pipelineId: 'not-a-uuid' })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0].message).toBe('pipeline.invalid')
  })
})

describe('deal form pipeline defaults', () => {
  it('starts a new deal in the default pipeline, else the first one', () => {
    expect(pickDefaultPipelineId([])).toBeNull()
    expect(pickDefaultPipelineId([
      { id: 'a', name: 'A', isDefault: false },
      { id: 'b', name: 'B', isDefault: true },
    ])).toBe('b')
    expect(pickDefaultPipelineId([
      { id: 'a', name: 'A', isDefault: false },
      { id: 'b', name: 'B', isDefault: false },
    ])).toBe('a')
  })

  it('starts a new deal at the lowest ordered stage', () => {
    expect(pickFirstStageId([])).toBeNull()
    expect(pickFirstStageId([
      { id: 's2', label: 'Two', order: 2 },
      { id: 's0', label: 'Zero', order: 0 },
      { id: 's1', label: 'One', order: 1 },
    ])).toBe('s0')
  })
})
