import type { Appearance } from '@clerk/types';

/* Clerk Appearance config matching the Noli design system. Inlined from
 * packages/auth in the noli-platform monorepo. Keep in sync if the canonical
 * version there changes. */

export const noliClerkAppearance: Appearance = {
  variables: {
    colorPrimary: '#6366F1',
    colorBackground: '#0E0E16',
    colorInputBackground: 'rgba(255,255,255,0.04)',
    colorText: '#FFFFFF',
    colorTextSecondary: 'rgba(255,255,255,0.6)',
    colorInputText: '#FFFFFF',
    colorDanger: '#EF4444',
    fontFamily: '"Satoshi", -apple-system, BlinkMacSystemFont, sans-serif',
  },
};
