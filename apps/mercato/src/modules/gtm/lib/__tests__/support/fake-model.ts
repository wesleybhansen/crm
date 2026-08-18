import type { GtmDraftModel, GtmModelResult } from '../../ai/model'

/*
 * Deterministic fake model client for the GTM AI drafting tests. Captures the
 * prompts it is asked to generate against (so injection-safety tests can
 * inspect what reached the model) and returns whatever the responder produces.
 */
export class FakeModel implements GtmDraftModel {
  calls: { system: string; prompt: string }[] = []
  constructor(private responder: (input: { system: string; prompt: string }) => GtmModelResult) {}

  async generate(input: { system: string; prompt: string }): Promise<GtmModelResult> {
    this.calls.push(input)
    return this.responder(input)
  }
}

// Convenience: a model that returns a fixed subject/body JSON with fixed usage.
export function jsonModel(
  subject: string,
  body: string,
  usage: { model?: string; tokensIn?: number; tokensOut?: number } = {},
): FakeModel {
  return new FakeModel(() => ({
    text: JSON.stringify({ subject, body }),
    model: usage.model ?? 'fake-gemini',
    tokensIn: usage.tokensIn ?? 120,
    tokensOut: usage.tokensOut ?? 60,
  }))
}

// A model that always throws (provider/network failure), for fallback tests.
export function throwingModel(message = 'provider exploded'): FakeModel {
  return new FakeModel(() => {
    throw new Error(message)
  })
}

// A metering spy that records each call.
export function makeMeterSpy() {
  const calls: { model: string; tokensIn: number; tokensOut: number; feature: string }[] = []
  const meter = (usage: { model: string; tokensIn: number; tokensOut: number; feature: string }) => {
    calls.push(usage)
  }
  return { meter, calls }
}
