import { FakeEm } from './support/fake-em'
import { seedPlay } from './support/campaign-fixtures'
import { GtmPlay } from '../../data/entities'
import { backfillPlayNames, PLAY_NAME_BACKFILL_SAMPLE_CAP } from '../play-name-backfill'
import { fallbackPlayName } from '../play-name'

async function seedUnnamed(em: FakeEm, count: number): Promise<GtmPlay[]> {
  const plays: GtmPlay[] = []
  for (let i = 0; i < count; i += 1) {
    const play = await seedPlay(em, { signal: `signal ${i}` })
    play.createdAt = new Date(Date.UTC(2026, 0, 1 + i))
    plays.push(play)
  }
  return plays
}

describe('backfillPlayNames', () => {
  it('dry run: reports fallback names, calls no namer, writes nothing', async () => {
    const em = new FakeEm()
    const plays = await seedUnnamed(em, 3)
    const namerFor = jest.fn(async () => null)
    const result = await backfillPlayNames(em, { dryRun: true, limit: 50 }, namerFor)
    expect(namerFor).not.toHaveBeenCalled()
    expect(result.considered).toBe(3)
    expect(result.named).toBe(3)
    expect(result.failed).toBe(0)
    expect(result.sample).toEqual(plays.map((play) => ({ id: play.id, name: fallbackPlayName(play) })))
    for (const play of plays) {
      const row = await em.findOne(GtmPlay, { id: play.id })
      expect(row?.name ?? null).toBeNull()
    }
  })

  it('live run: writes the namer result, one namer per org, fallback when the namer is null', async () => {
    const em = new FakeEm()
    const plays = await seedUnnamed(em, 2)
    const namer = jest.fn(async (play: GtmPlay) => ({ name: `Named ${play.signal}`, source: 'model' as const }))
    const namerFor = jest.fn(async () => namer)
    const result = await backfillPlayNames(em, { dryRun: false, limit: 50 }, namerFor)
    expect(namerFor).toHaveBeenCalledTimes(1)
    expect(namer).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ considered: 2, named: 2, failed: 0 })
    for (const play of plays) {
      const row = await em.findOne(GtmPlay, { id: play.id })
      expect(row?.name).toBe(`Named ${play.signal}`)
    }

    // A second run finds nothing left to do.
    const again = await backfillPlayNames(em, { dryRun: false, limit: 50 }, namerFor)
    expect(again).toEqual({ considered: 0, named: 0, failed: 0, sample: [] })
  })

  it('uses the deterministic fallback when no namer is available for the org', async () => {
    const em = new FakeEm()
    const [play] = await seedUnnamed(em, 1)
    const result = await backfillPlayNames(em, { dryRun: false }, async () => null)
    expect(result.named).toBe(1)
    const row = await em.findOne(GtmPlay, { id: play.id })
    expect(row?.name).toBe(fallbackPlayName(play))
  })

  it('counts a failing play and keeps going', async () => {
    const em = new FakeEm()
    const plays = await seedUnnamed(em, 3)
    const namer = jest.fn(async (play: GtmPlay) => {
      if (play.id === plays[1].id) throw new Error('provider exploded')
      return { name: 'Fine', source: 'model' as const }
    })
    const result = await backfillPlayNames(em, { dryRun: false }, async () => namer)
    expect(result).toMatchObject({ considered: 3, named: 2, failed: 1 })
    expect((await em.findOne(GtmPlay, { id: plays[1].id }))?.name ?? null).toBeNull()
  })

  it('respects the limit, skips already-named rows, and caps the sample at 10', async () => {
    const em = new FakeEm()
    const plays = await seedUnnamed(em, 15)
    plays[0].name = 'Already named'
    await em.flush()
    const result = await backfillPlayNames(em, { dryRun: true, limit: 12 }, async () => null)
    expect(result.considered).toBe(12)
    expect(result.sample).toHaveLength(PLAY_NAME_BACKFILL_SAMPLE_CAP)
    expect(result.sample.map((entry) => entry.id)).not.toContain(plays[0].id)
    // Oldest first.
    expect(result.sample[0].id).toBe(plays[1].id)
    for (const entry of result.sample) {
      expect(Object.keys(entry).sort()).toEqual(['id', 'name'])
    }
  })
})
