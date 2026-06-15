'use client'

import { Button } from '@open-mercato/ui/primitives/button'
import { Headphones, Settings } from 'lucide-react'
import CustomerServiceQueue from '../CustomerServiceQueue'

export default function CustomerServiceQueuePage() {
  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <Headphones className="size-5 text-muted-foreground" /> Review queue
        </h1>
        <Button type="button" variant="outline" size="sm"
          onClick={() => window.location.href = '/backend/customer-service'}>
          <Settings className="size-3.5 mr-1" />
          Settings
        </Button>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Review each drafted reply, edit it if you like, then approve to send or dismiss it.
      </p>

      <CustomerServiceQueue />
    </div>
  )
}
