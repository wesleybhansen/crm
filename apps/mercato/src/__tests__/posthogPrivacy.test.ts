import {
  redactPostHogEventUrls,
  redactReplayRequestUrl,
} from '../components/posthogPrivacy'

describe('CRM PostHog privacy', () => {
  it('strips query strings and fragments from replay URLs', () => {
    expect(
      redactReplayRequestUrl({
        name: 'https://crm.noliai.com/invite?token=secret#done',
        status: 200,
      }),
    ).toEqual({
      name: 'https://crm.noliai.com/invite',
      status: 200,
    })
  })

  it('recursively redacts URL fields without dropping CRM analytics', () => {
    expect(
      redactPostHogEventUrls({
        uuid: 'event-1',
        event: '$pageview',
        properties: {
          $current_url: 'https://crm.noliai.com/backend?session=secret',
          nested: [{ attr__href: '/customers/1?access=secret' }],
          customer_label: 'keep?this=value',
        },
        $set_once: {
          initial_url: 'https://crm.noliai.com/login?redirect=private',
        },
      }),
    ).toEqual({
      uuid: 'event-1',
      event: '$pageview',
      properties: {
        $current_url: 'https://crm.noliai.com/backend',
        nested: [{ attr__href: '/customers/1' }],
        customer_label: 'keep?this=value',
      },
      $set_once: {
        initial_url: 'https://crm.noliai.com/login',
      },
    })
    expect(redactPostHogEventUrls(null)).toBeNull()
  })
})
