import type { Metadata } from 'next'
import type { ReactNode } from 'react'

// The student page is a client component, so it can't export metadata itself.
// The page swaps in the course title once the course loads.
export const metadata: Metadata = {
  title: 'Your course',
}

export default function CourseLearnLayout({ children }: { children: ReactNode }) {
  return children
}
