import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'

const ignores = [
  'node_modules/**',
  '.next/**',
  '.mercato/**',
  'dist/**',
  'packages/**/dist/**',
  'packages/**/src/**/*.jsx',
  'out/**',
  'build/**',
  'generated/**',
  '**/generated/**',
  '**/.mercato/**',
  'docs/.docusaurus/**',
  'docs/build/**',
  'next-env.d.ts',
]

const ruleOverrides = {
  'react/display-name': 'off',

  'react-hooks/immutability': 'off',
  'react-hooks/preserve-manual-memoization': 'off',
  'react-hooks/purity': 'off',
  'react-hooks/refs': 'off',
  'react-hooks/set-state-in-effect': 'off',
  'react-hooks/static-components': 'off',
}

export default [
  ...nextCoreWebVitals,
  { ignores },
  {
    name: 'project/mercato-app-next-compatibility',
    files: ['apps/mercato/**/*.{js,jsx,ts,tsx}'],
    rules: {
      '@next/next/no-html-link-for-pages': 'off',
      'react/no-unescaped-entities': 'off',
    },
  },
  { name: 'project/rule-overrides', rules: ruleOverrides },
]
