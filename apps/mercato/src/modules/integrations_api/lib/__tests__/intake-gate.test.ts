import {
  decideIntakeGate,
  readLaunchpadBriefing,
  seedCompletesIntake,
  seededByFor,
  type NoliCoreReader,
} from '../intake-gate'

type Tables = Record<string, Array<Record<string, unknown>>>

function fakeCore(tables: Tables, opts: { failOn?: string } = {}) {
  const calls: Array<{ table: string; column: string; value: unknown }> = []
  const client: NoliCoreReader = {
    from: (table: string) => ({
      select: () => {
        const run = (column: string, match: (v: unknown) => boolean, value: unknown) => {
          calls.push({ table, column, value })
          if (opts.failOn === table) return Promise.resolve({ data: null, error: { message: 'boom' } })
          return Promise.resolve({ data: (tables[table] ?? []).filter((r) => match(r[column])), error: null })
        }
        return {
          eq: (column: string, value: string) => run(column, (v) => v === value, value),
          in: (column: string, values: string[]) => run(column, (v) => values.includes(v as string), values),
        }
      },
    }),
  }
  return { client, calls }
}

const USER = 'u-1'
const OTHER = 'u-2'
const lpSub = { organization_id: 'org-1', status: 'active', metadata: { source: 'launch-pad' } }

describe('CRM intake gate', () => {
  it('keeps completed and seeded profiles on the dashboard', () => {
    expect(decideIntakeGate({ onboarding_complete: true }, null)).toBe('dashboard')
    // A null flag is a pre-flag workspace: the old dashboard only asked on false.
    expect(decideIntakeGate({ onboarding_complete: null }, null)).toBe('dashboard')
    expect(decideIntakeGate({ onboarding_complete: false, seeded_by: 'launchpad-lab', business_description: 'Bookkeeping for agents' }, null)).toBe('dashboard')
  })

  it('does not treat an unseeded or empty-description profile as briefed', () => {
    expect(decideIntakeGate({ onboarding_complete: false, seeded_by: null, business_description: 'Typed halfway' }, null)).toBe('intake')
    expect(decideIntakeGate({ onboarding_complete: false, seeded_by: 'noli-hub', business_description: '   ' }, null)).toBe('intake')
    expect(decideIntakeGate(null, null)).toBe('intake')
  })

  it('shows the Lab line to a Launch Pad member before the Lab, the dashboard after', () => {
    expect(decideIntakeGate(null, { member: true, briefed: false })).toBe('awaiting_lab')
    expect(decideIntakeGate(null, { member: true, briefed: true })).toBe('dashboard')
  })

  it('keeps the intake for everyone else and fails open when Launch Pad state is unknown', () => {
    expect(decideIntakeGate(null, { member: false, briefed: false })).toBe('intake')
    expect(decideIntakeGate({ onboarding_complete: false }, null)).toBe('intake')
  })

  it('lets a seeded description complete the intake, but not a name alone', () => {
    expect(seedCompletesIntake({ hasBusinessName: false, hasPipeline: false, hasDescription: true })).toBe(true)
    expect(seedCompletesIntake({ hasBusinessName: true, hasPipeline: true, hasDescription: false })).toBe(true)
    expect(seedCompletesIntake({ hasBusinessName: true, hasPipeline: false, hasDescription: false })).toBe(false)
    expect(seedCompletesIntake({ hasBusinessName: false, hasPipeline: true, hasDescription: false })).toBe(false)
  })

  it('records who seeded, accepting only the known Lab source', () => {
    expect(seededByFor('launchpad-lab')).toBe('launchpad-lab')
    expect(seededByFor(undefined)).toBe('noli-hub')
    expect(seededByFor('<script>')).toBe('noli-hub')
  })
})

describe('readLaunchpadBriefing', () => {
  it('reads a Launch Pad member who has not finished the Lab as awaiting', async () => {
    const { client } = fakeCore({
      organization_members: [{ user_id: USER, organization_id: 'org-1' }],
      subscriptions: [lpSub],
      cos_business_profile: [{ user_id: USER, profile: { cosName: 'Noli', whatYouDo: '' } }],
      launchpad_lab_sessions: [{ user_id: USER, status: 'open' }],
    })
    await expect(readLaunchpadBriefing(client, USER)).resolves.toEqual({ member: true, briefed: false })
  })

  it('counts a Chief of Staff profile or a completed Lab session as briefed', async () => {
    const viaCos = fakeCore({
      organization_members: [{ user_id: USER, organization_id: 'org-1' }],
      subscriptions: [lpSub],
      cos_business_profile: [{ user_id: USER, profile: { whatYouDo: 'Bookkeeping for agents' } }],
    })
    await expect(readLaunchpadBriefing(viaCos.client, USER)).resolves.toEqual({ member: true, briefed: true })
    const viaLab = fakeCore({
      organization_members: [{ user_id: USER, organization_id: 'org-1' }],
      subscriptions: [{ organization_id: 'org-1', status: 'trialing', metadata: { launchpad_program: 'growth' } }],
      launchpad_lab_sessions: [{ user_id: USER, status: 'complete' }],
    })
    await expect(readLaunchpadBriefing(viaLab.client, USER)).resolves.toEqual({ member: true, briefed: true })
  })

  it('ignores canceled Launch Pad rows and plain Noli subscriptions', async () => {
    const { client } = fakeCore({
      organization_members: [{ user_id: USER, organization_id: 'org-1' }],
      subscriptions: [
        { organization_id: 'org-1', status: 'canceled', metadata: { source: 'launch-pad' } },
        { organization_id: 'org-1', status: 'active', metadata: { source: 'stripe' } },
      ],
    })
    await expect(readLaunchpadBriefing(client, USER)).resolves.toEqual({ member: false, briefed: false })
  })

  it('never reads another user or organization', async () => {
    const { client, calls } = fakeCore({
      organization_members: [
        { user_id: USER, organization_id: 'org-1' },
        { user_id: OTHER, organization_id: 'org-2' },
      ],
      subscriptions: [lpSub, { organization_id: 'org-2', status: 'active', metadata: { source: 'launch-pad' } }],
      cos_business_profile: [{ user_id: OTHER, profile: { whatYouDo: 'Someone else' } }],
      launchpad_lab_sessions: [{ user_id: OTHER, status: 'complete' }],
    })
    await expect(readLaunchpadBriefing(client, USER)).resolves.toEqual({ member: true, briefed: false })
    for (const c of calls) {
      if (c.column === 'user_id') expect(c.value).toBe(USER)
      if (c.column === 'organization_id') expect(c.value).toEqual(['org-1'])
    }
  })

  it('returns null on a noli-core read failure so callers fall back to the intake', async () => {
    const { client } = fakeCore({ organization_members: [{ user_id: USER, organization_id: 'org-1' }] }, { failOn: 'subscriptions' })
    await expect(readLaunchpadBriefing(client, USER)).resolves.toBeNull()
  })
})
