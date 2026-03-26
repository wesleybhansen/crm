'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Plus, DollarSign, FileText, Link2, Send, Loader2, X, ExternalLink, Package } from 'lucide-react'

type Product = {
  id: string; name: string; description: string | null; price: string
  currency: string; billing_type: string; is_active: boolean; created_at: string
}

type Invoice = {
  id: string; invoice_number: string; contact_id: string | null; status: string
  total: string; currency: string; due_date: string | null; created_at: string; paid_at: string | null
  stripe_payment_link: string | null
}

type Tab = 'products' | 'invoices'

export default function PaymentsPage() {
  const [tab, setTab] = useState<Tab>('products')
  const [products, setProducts] = useState<Product[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)

  // Create product form
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newPrice, setNewPrice] = useState('')
  const [newBillingType, setNewBillingType] = useState('one_time')
  const [creating, setCreating] = useState(false)

  // Create invoice form
  const [invoiceItems, setInvoiceItems] = useState([{ name: '', price: '', quantity: '1' }])
  const [invoiceNotes, setInvoiceNotes] = useState('')
  const [creatingInvoice, setCreatingInvoice] = useState(false)

  useEffect(() => { loadData() }, [tab])

  function loadData() {
    setLoading(true)
    if (tab === 'products') {
      fetch('/api/payments/products', { credentials: 'include' })
        .then(r => r.json())
        .then(d => { if (d.ok) setProducts(d.data || []); setLoading(false) })
        .catch(() => setLoading(false))
    } else {
      fetch('/api/payments/invoices', { credentials: 'include' })
        .then(r => r.json())
        .then(d => { if (d.ok) setInvoices(d.data || []); setLoading(false) })
        .catch(() => setLoading(false))
    }
  }

  async function createProduct() {
    if (!newName.trim() || !newPrice.trim()) return
    setCreating(true)
    try {
      const res = await fetch('/api/payments/products', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ name: newName, description: newDescription, price: newPrice, billingType: newBillingType }),
      })
      const data = await res.json()
      if (data.ok) {
        setNewName(''); setNewDescription(''); setNewPrice(''); setShowCreate(false)
        loadData()
      }
    } catch {}
    setCreating(false)
  }

  async function createInvoice() {
    const items = invoiceItems.filter(i => i.name.trim() && i.price.trim())
    if (items.length === 0) return
    setCreatingInvoice(true)
    try {
      const res = await fetch('/api/payments/invoices', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          lineItems: items.map(i => ({ name: i.name, price: Number(i.price), quantity: Number(i.quantity) || 1 })),
          notes: invoiceNotes,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setInvoiceItems([{ name: '', price: '', quantity: '1' }]); setInvoiceNotes(''); setShowCreate(false)
        loadData()
      }
    } catch {}
    setCreatingInvoice(false)
  }

  const statusColors: Record<string, string> = {
    draft: 'bg-muted text-muted-foreground',
    sent: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    paid: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
    overdue: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    cancelled: 'bg-muted text-muted-foreground line-through',
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold">Payments</h1>
        <Button type="button" size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="size-3.5 mr-1.5" /> {tab === 'products' ? 'New Product' : 'New Invoice'}
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-4 mb-6">
        {([
          { id: 'products' as Tab, label: 'Products & Services', icon: Package },
          { id: 'invoices' as Tab, label: 'Invoices', icon: FileText },
        ]).map(t => (
          <button key={t.id} type="button" onClick={() => { setTab(t.id); setShowCreate(false) }}
            className={`flex items-center gap-2 text-sm font-medium pb-1 border-b-2 transition ${
              tab === t.id ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}>
            <t.icon className="size-4" /> {t.label}
          </button>
        ))}
      </div>

      {/* Create Product Modal */}
      {showCreate && tab === 'products' && (
        <div className="rounded-lg border bg-card p-5 mb-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">New Product / Service</h3>
            <IconButton type="button" variant="ghost" size="sm" onClick={() => setShowCreate(false)} aria-label="Close">
              <X className="size-4" />
            </IconButton>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Name</label>
              <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. 1-on-1 Coaching Session" className="h-9 text-sm" autoFocus />
            </div>
            <div className="col-span-2">
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Description</label>
              <Input value={newDescription} onChange={e => setNewDescription(e.target.value)} placeholder="Optional description" className="h-9 text-sm" />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Price ($)</label>
              <Input type="number" value={newPrice} onChange={e => setNewPrice(e.target.value)} placeholder="0.00" className="h-9 text-sm" step="0.01" />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Billing</label>
              <select value={newBillingType} onChange={e => setNewBillingType(e.target.value)}
                className="w-full h-9 rounded-md border bg-card px-3 text-sm">
                <option value="one_time">One-time</option>
                <option value="recurring">Monthly recurring</option>
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button type="button" size="sm" onClick={createProduct} disabled={creating || !newName.trim() || !newPrice.trim()}>
              {creating ? <Loader2 className="size-3 animate-spin mr-1" /> : <Plus className="size-3 mr-1" />} Create
            </Button>
          </div>
        </div>
      )}

      {/* Create Invoice Modal */}
      {showCreate && tab === 'invoices' && (
        <div className="rounded-lg border bg-card p-5 mb-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">New Invoice</h3>
            <IconButton type="button" variant="ghost" size="sm" onClick={() => setShowCreate(false)} aria-label="Close">
              <X className="size-4" />
            </IconButton>
          </div>
          <div>
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-2">Line Items</label>
            <div className="space-y-2">
              {invoiceItems.map((item, i) => (
                <div key={i} className="flex gap-2">
                  <Input value={item.name} onChange={e => {
                    const updated = [...invoiceItems]; updated[i] = { ...item, name: e.target.value }; setInvoiceItems(updated)
                  }} placeholder="Item description" className="flex-1 h-9 text-sm" />
                  <Input type="number" value={item.quantity} onChange={e => {
                    const updated = [...invoiceItems]; updated[i] = { ...item, quantity: e.target.value }; setInvoiceItems(updated)
                  }} placeholder="Qty" className="w-16 h-9 text-sm" />
                  <Input type="number" value={item.price} onChange={e => {
                    const updated = [...invoiceItems]; updated[i] = { ...item, price: e.target.value }; setInvoiceItems(updated)
                  }} placeholder="$0.00" className="w-24 h-9 text-sm" step="0.01" />
                  {invoiceItems.length > 1 && (
                    <IconButton type="button" variant="ghost" size="sm" onClick={() => setInvoiceItems(invoiceItems.filter((_, j) => j !== i))} aria-label="Remove">
                      <X className="size-3.5" />
                    </IconButton>
                  )}
                </div>
              ))}
              <button type="button" onClick={() => setInvoiceItems([...invoiceItems, { name: '', price: '', quantity: '1' }])}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                <Plus className="size-3" /> Add line item
              </button>
            </div>
          </div>
          <div>
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Notes (optional)</label>
            <Input value={invoiceNotes} onChange={e => setInvoiceNotes(e.target.value)} placeholder="Payment terms, thank you message, etc." className="h-9 text-sm" />
          </div>
          <div className="flex items-center justify-between pt-2 border-t">
            <p className="text-sm font-semibold">
              Total: ${invoiceItems.reduce((sum, i) => sum + (Number(i.price) * (Number(i.quantity) || 1)), 0).toFixed(2)}
            </p>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button type="button" size="sm" onClick={createInvoice}
                disabled={creatingInvoice || invoiceItems.every(i => !i.name.trim() || !i.price.trim())}>
                {creatingInvoice ? <Loader2 className="size-3 animate-spin mr-1" /> : <FileText className="size-3 mr-1" />} Create Invoice
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Products List */}
      {tab === 'products' && (
        loading ? <div className="text-sm text-muted-foreground">Loading...</div> :
        products.length === 0 ? (
          <div className="rounded-lg border p-12 text-center">
            <Package className="size-8 mx-auto mb-3 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">No products yet. Add your first product or service to start getting paid.</p>
          </div>
        ) : (
          <div className="rounded-lg border divide-y">
            {products.map(p => (
              <div key={p.id} className="flex items-center gap-4 px-5 py-4">
                <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
                  <DollarSign className="size-5 text-accent" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{p.name}</p>
                  {p.description && <p className="text-xs text-muted-foreground truncate">{p.description}</p>}
                </div>
                <div className="text-right shrink-0 mr-2">
                  <p className="text-sm font-semibold tabular-nums">${Number(p.price).toFixed(2)}</p>
                  <p className="text-[11px] text-muted-foreground">{p.billing_type === 'recurring' ? '/month' : 'one-time'}</p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={async () => {
                  const res = await fetch('/api/stripe/connect', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                    body: JSON.stringify({ type: 'product', productId: p.id }),
                  })
                  const data = await res.json()
                  if (data.ok && data.url) {
                    navigator.clipboard.writeText(data.url).then(() => alert('Payment link copied to clipboard!')).catch(() => window.open(data.url, '_blank'))
                  } else {
                    alert(data.error || 'Failed to generate link')
                  }
                }}>
                  <Link2 className="size-3 mr-1" /> Payment Link
                </Button>
              </div>
            ))}
          </div>
        )
      )}

      {/* Invoices List */}
      {tab === 'invoices' && (
        loading ? <div className="text-sm text-muted-foreground">Loading...</div> :
        invoices.length === 0 ? (
          <div className="rounded-lg border p-12 text-center">
            <FileText className="size-8 mx-auto mb-3 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">No invoices yet. Create your first invoice to get paid.</p>
          </div>
        ) : (
          <div className="rounded-lg border divide-y">
            {invoices.map(inv => (
              <div key={inv.id} className="flex items-center gap-4 px-5 py-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{inv.invoice_number}</p>
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${statusColors[inv.status] || ''}`}>
                      {inv.status}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {inv.due_date ? `Due ${new Date(inv.due_date).toLocaleDateString()}` : 'No due date'}
                  </p>
                </div>
                <p className="text-sm font-semibold tabular-nums shrink-0 mr-2">${Number(inv.total).toFixed(2)}</p>
                {inv.status === 'draft' && (
                  <Button type="button" variant="outline" size="sm" onClick={async () => {
                    const res = await fetch('/api/stripe/connect', {
                      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                      body: JSON.stringify({ type: 'invoice', invoiceId: inv.id }),
                    })
                    const data = await res.json()
                    if (data.ok && data.url) {
                      navigator.clipboard.writeText(data.url).then(() => { alert('Payment link copied! Invoice marked as sent.'); loadData() })
                    } else {
                      alert(data.error || 'Failed to generate link')
                    }
                  }}>
                    <Send className="size-3 mr-1" /> Send
                  </Button>
                )}
                {inv.status === 'sent' && inv.stripe_payment_link && (
                  <Button type="button" variant="outline" size="sm" onClick={() => navigator.clipboard.writeText(inv.stripe_payment_link!)}>
                    <Link2 className="size-3 mr-1" /> Copy Link
                  </Button>
                )}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  )
}
