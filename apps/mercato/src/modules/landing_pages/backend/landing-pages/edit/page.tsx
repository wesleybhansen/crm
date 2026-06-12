'use client'

import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import EditLandingPage from '../../../components/EditorContent'

function EditorWithParams() {
  const searchParams = useSearchParams()
  const id = searchParams.get('id')

  if (!id) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground">
        No page ID provided. <a href="/backend/landing-pages" className="text-[#1d4ed8] dark:text-[#93c5fd] underline">Back to Landing Pages</a>
      </div>
    )
  }

  return <EditLandingPage pageId={id} />
}

export default function EditLandingPagePage() {
  return (
    <Suspense fallback={<div className="p-6 text-center text-sm text-muted-foreground">Loading editor...</div>}>
      <EditorWithParams />
    </Suspense>
  )
}
