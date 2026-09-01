import { parseRealtorBenchmarkCliOptions } from '../cli-options'

describe('realtor benchmark evaluator CLI', () => {
  it('requires explicit evidence, reviews, and output paths', () => {
    expect(parseRealtorBenchmarkCliOptions([
      '--evidence=evidence.json',
      '--reviews=reviews.json',
      '--output=release.json',
    ])).toMatchObject({
      evidencePath: expect.stringMatching(/evidence\.json$/),
      reviewsPath: expect.stringMatching(/reviews\.json$/),
      outputPath: expect.stringMatching(/release\.json$/),
    })
    expect(() => parseRealtorBenchmarkCliOptions(['--evidence=evidence.json'])).toThrow(
      '--reviews=<path> is required',
    )
    expect(() => parseRealtorBenchmarkCliOptions([
      '--evidence=evidence.json',
      '--reviews=reviews.json',
      '--output=release.json',
      '--approve=true',
    ])).toThrow('Unknown argument')
  })
})
