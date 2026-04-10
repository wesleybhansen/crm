'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Plus, DollarSign, FileText, Link2, Loader2, X, Package, CreditCard, Check, XCircle, Plug, Trash2, CheckCircle, Clock, History, Mail, Copy, ExternalLink, Pencil, ChevronDown, ChevronUp, ArrowUpRight, ArrowDownLeft, Eye, MousePointerClick, RotateCcw, Ban } from 'lucide-react'

type Product = {
  id: string; name: string; description: string | null; price: string
  currency: string; billing_type: string; is_active: boolean; created_at: string
  terms_url: string | null; trial_days: number | null
}

type Contact = {
  id: string; display_name: string; primary_email: string | null
}

type Invoice = {
  id: string; invoice_number: string; contact_id: string | null; status: string
  total: string; currency: string; due_date: string | null; created_at: string; paid_at: string | null
  stripe_payment_link: string | null; terms_url: string | null
  contact_name: string | null; contact_email: string | null
}

type StripeConnection = {
  id: string
  stripeAccountId: string
  businessName: string | null
  livemode: boolean
  isActive: boolean
  connectedAt: string
}

type PaymentRecord = {
  id: string; invoice_id: string | null; contact_id: string | null
  amount: string; currency: string; status: string; contact_name: string | null
  invoice_number: string | null; created_at: string; metadata: Record<string, any> | null
  stripe_url: string | null; stripe_payment_intent_id: string | null
  stripe_subscription_id: string | null; refunded_amount: string | null
}

type InvoiceEmail = {
  id: string; direction: string; from_address: string; to_address: string
  cc: string | null; bcc: string | null
  subject: string; body_html: string | null; status: string
  sent_at: string; opened_at: string | null; clicked_at: string | null; created_at: string
}

type Tab = 'products' | 'invoices' | 'history'

export default function PaymentsPage() {
  const [tab, setTab] = useState<Tab>('products')
  const [products, setProducts] = useState<Product[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [records, setRecords] = useState<PaymentRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)

  // History filters
  const [historyStatus, setHistoryStatus] = useState('all')
  const [expandedRecord, setExpandedRecord] = useState<string | null>(null)

  // Stripe connection state
  const [stripeConnection, setStripeConnection] = useState<StripeConnection | null>(null)
  const [stripeLoading, setStripeLoading] = useState(true)
  const [disconnecting, setDisconnecting] = useState(false)
  const [showManualConnect, setShowManualConnect] = useState(false)
  const [manualAccountId, setManualAccountId] = useState('')
  const [manualConnecting, setManualConnecting] = useState(false)
  const [stripeMessage, setStripeMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Refund state
  const [refundRecord, setRefundRecord] = useState<PaymentRecord | null>(null)
  const [refundAmount, setRefundAmount] = useState('')
  const [refundType, setRefundType] = useState<'full' | 'partial'>('full')
  const [refunding, setRefunding] = useState(false)
  const [refundFeedback, setRefundFeedback] = useState<{ id: string; type: 'success' | 'error'; text: string } | null>(null)

  // Subscription cancel state
  const [cancelSubRecord, setCancelSubRecord] = useState<PaymentRecord | null>(null)
  const [cancelAtPeriodEnd, setCancelAtPeriodEnd] = useState(true)
  const [cancellingSub, setCancellingSub] = useState(false)
  const [cancelSubFeedback, setCancelSubFeedback] = useState<{ id: string; type: 'success' | 'error'; text: string } | null>(null)

  // Create product form
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newPrice, setNewPrice] = useState('')
  const [newBillingType, setNewBillingType] = useState('one_time')
  const [newTrialDays, setNewTrialDays] = useState('')
  const [newTermsUrl, setNewTermsUrl] = useState('')
  const [newRequiresShipping, setNewRequiresShipping] = useState(false)
  const [newCollectPhone, setNewCollectPhone] = useState(false)
  const [newCourseIds, setNewCourseIds] = useState<string[]>([])
  const [availableCourses, setAvailableCourses] = useState<Array<{ id: string; title: string }>>([])
  const [creating, setCreating] = useState(false)

  // Edit product state
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editPrice, setEditPrice] = useState('')
  const [editBillingType, setEditBillingType] = useState('one_time')
  const [editTermsUrl, setEditTermsUrl] = useState('')
  const [editTrialDays, setEditTrialDays] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)

  // Create invoice form
  const [invoiceItems, setInvoiceItems] = useState([{ name: '', price: '', quantity: '1' }])
  const [invoiceNotes, setInvoiceNotes] = useState('')
  const [creatingInvoice, setCreatingInvoice] = useState(false)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [selectedContactId, setSelectedContactId] = useState('')
  const [contactSearch, setContactSearch] = useState('')
  const [contactDropdownOpen, setContactDropdownOpen] = useState(false)
  const [invoiceDueDate, setInvoiceDueDate] = useState('')
  const [invoiceTermsUrl, setInvoiceTermsUrl] = useState('')
  const [invoiceRecipientEmail, setInvoiceRecipientEmail] = useState('')
  const [invoiceRecipientName, setInvoiceRecipientName] = useState('')

  // Email compose
  const [emailConfirmInvoice, setEmailConfirmInvoice] = useState<string | null>(null)
  const [emailConfirmAddress, setEmailConfirmAddress] = useState('')
  const [emailContactName, setEmailContactName] = useState('')
  const [emailRecipientSearch, setEmailRecipientSearch] = useState('')
  const [emailRecipientDropdownOpen, setEmailRecipientDropdownOpen] = useState(false)
  const [emailSubject, setEmailSubject] = useState('')
  const [emailBody, setEmailBody] = useState('')
  const [emailCc, setEmailCc] = useState('')
  const [emailBcc, setEmailBcc] = useState('')
  const [showCcBcc, setShowCcBcc] = useState(false)
  const [openMoreMenu, setOpenMoreMenu] = useState<string | null>(null)

  // Payment link display
  const [generatedLinks, setGeneratedLinks] = useState<Record<string, string>>({})
  const [generatingLink, setGeneratingLink] = useState<string | null>(null)
  const [linkCopied, setLinkCopied] = useState<string | null>(null)

  // Email sending
  const [sendingEmail, setSendingEmail] = useState<string | null>(null)
  const [emailFeedback, setEmailFeedback] = useState<{ id: string; type: 'success' | 'error'; text: string } | null>(null)

  // Email history
  const [invoiceEmails, setInvoiceEmails] = useState<Record<string, InvoiceEmail[]>>({})
  const [expandedInvoiceEmail, setExpandedInvoiceEmail] = useState<string | null>(null)
  const [loadingEmails, setLoadingEmails] = useState<string | null>(null)
  const [expandedEmailBody, setExpandedEmailBody] = useState<string | null>(null)

  useEffect(() => {
    loadStripeConnection()
    loadContacts()
    // Close contact dropdown on outside click
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (!target.closest('[data-contact-picker]')) setContactDropdownOpen(false)
      if (!target.closest('[data-email-recipient-picker]')) setEmailRecipientDropdownOpen(false)
      if (!target.closest('[data-more-menu]')) setOpenMoreMenu(null)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  useEffect(() => { loadData() }, [tab, historyStatus])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('stripe_connected') === 'true') {
      setStripeMessage({ type: 'success', text: 'Stripe account connected successfully!' })
      window.history.replaceState({}, '', window.location.pathname)
      loadStripeConnection()
    } else if (params.get('stripe_error')) {
      setStripeMessage({ type: 'error', text: `Stripe connection failed: ${params.get('stripe_error')}` })
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])

  function loadStripeConnection() {
    setStripeLoading(true)
    fetch('/api/payments/stripe/connections', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (d.ok) setStripeConnection(d.data || null)
        setStripeLoading(false)
      })
      .catch(() => setStripeLoading(false))
  }

  async function disconnectStripe() {
    setDisconnecting(true)
    try {
      await fetch('/api/payments/stripe/connections', { method: 'DELETE', credentials: 'include' })
      setStripeConnection(null)
      setStripeMessage({ type: 'success', text: 'Stripe account disconnected.' })
    } catch {
      setStripeMessage({ type: 'error', text: 'Failed to disconnect Stripe.' })
    }
    setDisconnecting(false)
  }

  async function manualConnect() {
    if (!manualAccountId.trim()) return
    setManualConnecting(true)
    try {
      const res = await fetch('/api/payments/stripe/connect-oauth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ stripeAccountId: manualAccountId.trim() }),
      })
      const data = await res.json()
      if (data.ok) {
        setManualAccountId('')
        setShowManualConnect(false)
        setStripeMessage({ type: 'success', text: 'Stripe account connected manually!' })
        loadStripeConnection()
      } else {
        setStripeMessage({ type: 'error', text: data.error || 'Failed to connect.' })
      }
    } catch {
      setStripeMessage({ type: 'error', text: 'Failed to connect.' })
    }
    setManualConnecting(false)
  }

  function loadContacts() {
    fetch('/api/customers/people?pageSize=100', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        // CRUD factory returns various formats — try all known shapes
        let items: Contact[] = []
        if (Array.isArray(d.data?.items)) items = d.data.items
        else if (Array.isArray(d.data)) items = d.data
        else if (Array.isArray(d.items)) items = d.items
        else if (Array.isArray(d)) items = d
        // Normalize field names (API may return camelCase or snake_case)
        setContacts(items.map((c: any) => ({
          id: c.id,
          display_name: c.display_name || c.displayName || c.name || '',
          primary_email: c.primary_email || c.primaryEmail || c.email || null,
        })))
      })
      .catch(() => {})
  }

  function loadData() {
    setLoading(true)
    if (tab === 'products') {
      fetch('/api/payments/products', { credentials: 'include' })
        .then(r => r.json())
        .then(d => { if (d.ok) setProducts(d.data || []); setLoading(false) })
        .catch(() => setLoading(false))
    } else if (tab === 'invoices') {
      fetch('/api/payments/invoices', { credentials: 'include' })
        .then(r => r.json())
        .then(d => {
          if (d.ok) {
            const invs = d.data || []
            setInvoices(invs)
            // Preload email history for sent/paid invoices (for the "Emailed to" badge)
            for (const inv of invs) {
              if ((inv.status === 'sent' || inv.status === 'paid') && !invoiceEmails[inv.id]) {
                fetch(`/api/payments/invoices/${inv.id}/emails`, { credentials: 'include' })
                  .then(r => r.json())
                  .then(ed => { if (ed.ok) setInvoiceEmails(prev => ({ ...prev, [inv.id]: ed.data || [] })) })
                  .catch(() => {})
              }
            }
          }
          setLoading(false)
        })
        .catch(() => setLoading(false))
    } else {
      const params = new URLSearchParams({ pageSize: '50' })
      if (historyStatus !== 'all') params.set('status', historyStatus)
      fetch(`/api/payments/records?${params}`, { credentials: 'include' })
        .then(r => r.json())
        .then(d => { if (d.ok) setRecords(d.data || []); setLoading(false) })
        .catch(() => setLoading(false))
    }
  }

  async function createProduct() {
    if (!newName.trim() || !newPrice.trim()) return
    setCreating(true)
    try {
      const res = await fetch('/api/payments/products', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ name: newName, description: newDescription, price: newPrice, billingType: newBillingType, termsUrl: newTermsUrl || undefined, requiresShipping: newRequiresShipping, collectPhone: newCollectPhone, productType: newRequiresShipping ? 'physical' : 'digital', courseIds: newCourseIds.length > 0 ? newCourseIds : undefined, trialDays: newBillingType === 'recurring' && newTrialDays ? Number(newTrialDays) : undefined }),
      })
      const data = await res.json()
      if (data.ok) {
        setNewName(''); setNewDescription(''); setNewPrice(''); setNewTermsUrl(''); setNewTrialDays(''); setNewRequiresShipping(false); setNewCollectPhone(false); setNewCourseIds([]); setShowCreate(false)
        loadData()
      }
    } catch {}
    setCreating(false)
  }

  function startEditProduct(product: Product) {
    setEditingProduct(product)
    setEditName(product.name)
    setEditDescription(product.description || '')
    setEditPrice(String(Number(product.price)))
    setEditBillingType(product.billing_type)
    setEditTermsUrl(product.terms_url || '')
    setEditTrialDays(product.trial_days ? String(product.trial_days) : '')
  }

  function cancelEditProduct() {
    setEditingProduct(null)
  }

  async function saveEditProduct() {
    if (!editingProduct || !editName.trim() || !editPrice.trim()) return
    setSavingEdit(true)
    try {
      const res = await fetch('/api/payments/products', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ id: editingProduct.id, name: editName, description: editDescription, price: editPrice, billingType: editBillingType, termsUrl: editTermsUrl || undefined, trialDays: editBillingType === 'recurring' && editTrialDays ? Number(editTrialDays) : undefined }),
      })
      const data = await res.json()
      if (data.ok) {
        setEditingProduct(null)
        loadData()
      }
    } catch {}
    setSavingEdit(false)
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
          contactId: selectedContactId || undefined,
          dueDate: invoiceDueDate || undefined,
          termsUrl: invoiceTermsUrl || undefined,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setInvoiceItems([{ name: '', price: '', quantity: '1' }]); setInvoiceNotes(''); setSelectedContactId(''); setInvoiceDueDate(''); setInvoiceTermsUrl(''); setShowCreate(false)
        loadData()
      }
    } catch {}
    setCreatingInvoice(false)
  }

  async function deleteProduct(productId: string) {
    if (!confirm('Delete this product?')) return
    try {
      await fetch('/api/payments/products', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ id: productId }),
      })
      loadData()
    } catch {}
  }

  async function updateInvoiceStatus(invoiceId: string, status: string) {
    try {
      await fetch('/api/payments/invoices', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ id: invoiceId, status }),
      })
      loadData()
    } catch {}
  }

  async function deleteInvoice(invoiceId: string) {
    if (!confirm('Delete this draft invoice?')) return
    try {
      await fetch('/api/payments/invoices', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ id: invoiceId }),
      })
      loadData()
    } catch {}
  }

  async function issueRefund() {
    if (!refundRecord) return
    const recordId = refundRecord.id
    setRefunding(true)
    setRefundFeedback(null)
    try {
      const res = await fetch('/api/payments/stripe/refund', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          paymentRecordId: recordId,
          amount: refundType === 'partial' && refundAmount ? Number(refundAmount) : undefined,
          reason: 'requested_by_customer',
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setRefundFeedback({ id: recordId, type: 'success', text: `Refund of $${data.data.amount.toFixed(2)} issued successfully` })
        setRefundRecord(null)
        loadData()
      } else {
        setRefundFeedback({ id: recordId, type: 'error', text: data.error || 'Failed to issue refund' })
      }
    } catch {
      setRefundFeedback({ id: recordId, type: 'error', text: 'Failed to issue refund' })
    }
    setRefunding(false)
  }

  async function cancelSubscription() {
    if (!cancelSubRecord?.stripe_subscription_id) return
    const recordId = cancelSubRecord.id
    setCancellingSub(true)
    setCancelSubFeedback(null)
    try {
      const res = await fetch('/api/payments/stripe/cancel-subscription', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          subscriptionId: cancelSubRecord.stripe_subscription_id,
          cancelAtPeriodEnd,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setCancelSubFeedback({ id: recordId, type: 'success', text: cancelAtPeriodEnd ? 'Subscription will cancel at end of billing period' : 'Subscription cancelled immediately' })
        setCancelSubRecord(null)
        loadData()
      } else {
        setCancelSubFeedback({ id: recordId, type: 'error', text: data.error || 'Failed to cancel subscription' })
      }
    } catch {
      setCancelSubFeedback({ id: recordId, type: 'error', text: 'Failed to cancel subscription' })
    }
    setCancellingSub(false)
  }

  async function generatePaymentLink(invoiceId: string) {
    setGeneratingLink(invoiceId)
    try {
      const res = await fetch('/api/payments/stripe/connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ type: 'invoice', invoiceId }),
      })
      const data = await res.json()
      if (data.ok && data.url) {
        setGeneratedLinks(prev => ({ ...prev, [invoiceId]: data.url }))
        loadData()
      } else {
        setEmailFeedback({ id: invoiceId, type: 'error', text: data.error || 'Failed to generate link' })
      }
    } catch {
      setEmailFeedback({ id: invoiceId, type: 'error', text: 'Failed to generate payment link' })
    }
    setGeneratingLink(null)
  }

  function promptSendInvoiceEmail(invoiceId: string) {
    const inv = invoices.find(i => i.id === invoiceId)
    if (!inv) return
    const email = inv.contact_email || ''
    const fullName = inv.contact_name || ''
    const contactName = fullName.split(' ')[0] || ''
    setEmailConfirmInvoice(invoiceId)
    setEmailConfirmAddress(email)
    setEmailContactName(fullName)
    setEmailRecipientSearch('')
    setEmailRecipientDropdownOpen(false)
    setEmailCc('')
    setEmailBcc('')
    setShowCcBcc(false)
    setEmailSubject(`Invoice ${inv.invoice_number} - $${Number(inv.total).toFixed(2)}`)
    setEmailBody(contactName
      ? `Hi ${contactName},\n\nPlease find your invoice attached below. The total amount due is $${Number(inv.total).toFixed(2)}${inv.due_date ? ` by ${new Date(inv.due_date).toLocaleDateString()}` : ''}.\n\nPlease let me know if you have any questions.\n\nThank you!`
      : `Please find your invoice below. The total amount due is $${Number(inv.total).toFixed(2)}${inv.due_date ? ` by ${new Date(inv.due_date).toLocaleDateString()}` : ''}.\n\nPlease let me know if you have any questions.\n\nThank you!`
    )
  }

  async function confirmSendInvoiceEmail() {
    if (!emailConfirmInvoice || !emailConfirmAddress.trim()) return
    const invoiceId = emailConfirmInvoice
    setEmailConfirmInvoice(null)
    setSendingEmail(invoiceId)
    setEmailFeedback(null)
    try {
      const res = await fetch(`/api/payments/invoices/${invoiceId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email: emailConfirmAddress.trim(),
          subject: emailSubject.trim() || undefined,
          body: emailBody.trim() || undefined,
          cc: emailCc.trim() || undefined,
          bcc: emailBcc.trim() || undefined,
          autoGeneratePaymentLink: true,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        const sentViaText = data.sentVia ? ` (via ${data.sentVia})` : ''
        setEmailFeedback({ id: invoiceId, type: 'success', text: `Invoice emailed to ${emailConfirmAddress}${sentViaText}` })
        setInvoiceEmails(prev => { const next = { ...prev }; delete next[invoiceId]; return next })
        loadData()
      } else {
        setEmailFeedback({ id: invoiceId, type: 'error', text: data.error || 'Failed to send email' })
      }
    } catch {
      setEmailFeedback({ id: invoiceId, type: 'error', text: 'Failed to send email' })
    }
    setSendingEmail(null)
    setEmailConfirmAddress('')
  }

  async function toggleEmailHistory(invoiceId: string) {
    if (expandedInvoiceEmail === invoiceId) {
      setExpandedInvoiceEmail(null)
      return
    }
    setExpandedInvoiceEmail(invoiceId)
    setExpandedEmailBody(null)
    if (!invoiceEmails[invoiceId]) {
      setLoadingEmails(invoiceId)
      try {
        const res = await fetch(`/api/payments/invoices/${invoiceId}/emails`, { credentials: 'include' })
        const data = await res.json()
        if (data.ok) {
          setInvoiceEmails(prev => ({ ...prev, [invoiceId]: data.data || [] }))
        }
      } catch {}
      setLoadingEmails(null)
    }
  }

  function copyToClipboard(text: string, id: string) {
    navigator.clipboard.writeText(text).then(() => {
      setLinkCopied(id)
      setTimeout(() => setLinkCopied(null), 2000)
    })
  }

  const statusColors: Record<string, string> = {
    draft: 'bg-muted text-muted-foreground',
    sent: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    paid: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
    overdue: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    cancelled: 'bg-muted text-muted-foreground line-through',
  }

  const paymentStatusColors: Record<string, string> = {
    succeeded: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
    completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
    pending: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
    failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    refunded: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
    partially_refunded: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  }

  const emailStatusColors: Record<string, string> = {
    sent: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    delivered: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
    opened: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
    clicked: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
    bounced: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    queued: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
    failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  }

  return (
    <div className="p-3 sm:p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold">Payments</h1>
        {tab !== 'history' && (
          <Button type="button" size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="size-3.5 mr-1.5" /> {tab === 'products' ? 'New Product' : 'New Invoice'}
          </Button>
        )}
      </div>

      {/* Stripe Connection Status */}
      {stripeMessage && (
        <div className={`rounded-lg px-4 py-3 mb-4 flex items-center justify-between text-sm ${
          stripeMessage.type === 'success'
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400'
            : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'
        }`}>
          <span className="flex items-center gap-2">
            {stripeMessage.type === 'success' ? <Check className="size-4" /> : <XCircle className="size-4" />}
            {stripeMessage.text}
          </span>
          <button type="button" onClick={() => setStripeMessage(null)} className="ml-2 opacity-60 hover:opacity-100">
            <X className="size-4" />
          </button>
        </div>
      )}

      <div className="rounded-lg border bg-card mb-6">
        {stripeLoading ? (
          <div className="px-5 py-4 flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Checking Stripe connection...
          </div>
        ) : stripeConnection ? (
          <div className="px-5 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center shrink-0">
                <CreditCard className="size-5 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div>
                <p className="text-sm font-medium flex items-center gap-2">
                  {stripeConnection.businessName || stripeConnection.stripeAccountId}
                  <span className="text-[10px] bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 px-1.5 py-0.5 rounded font-medium">Connected</span>
                  {stripeConnection.livemode && (
                    <span className="text-[10px] bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 px-1.5 py-0.5 rounded font-medium">Live</span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">Account: {stripeConnection.stripeAccountId}</p>
              </div>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={disconnectStripe} disabled={disconnecting}>
              {disconnecting ? <Loader2 className="size-3 animate-spin mr-1" /> : <X className="size-3 mr-1" />}
              {disconnecting ? 'Disconnecting...' : 'Disconnect'}
            </Button>
          </div>
        ) : (
          <div className="px-5 py-4">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center shrink-0">
                  <CreditCard className="size-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium">Connect Stripe to accept payments</p>
                  <p className="text-xs text-muted-foreground">Link your Stripe account to generate payment links and accept payments.</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" onClick={() => window.location.href = '/api/payments/stripe/connect-oauth'}>
                  <Plug className="size-3.5 mr-1.5" /> Connect Stripe
                </Button>
              </div>
            </div>
            <div className="mt-3 pt-3 border-t">
              {showManualConnect ? (
                <div className="flex items-center gap-2">
                  <Input
                    value={manualAccountId}
                    onChange={e => setManualAccountId(e.target.value)}
                    placeholder="acct_1234567890"
                    className="h-8 text-xs flex-1 max-w-xs font-mono"
                    onKeyDown={e => { if (e.key === 'Enter') manualConnect() }}
                  />
                  <Button type="button" variant="outline" size="sm" onClick={manualConnect}
                    disabled={manualConnecting || !manualAccountId.trim()}>
                    {manualConnecting ? <Loader2 className="size-3 animate-spin" /> : 'Save'}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => { setShowManualConnect(false); setManualAccountId('') }}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <button type="button" onClick={() => setShowManualConnect(true)}
                  className="text-xs text-muted-foreground hover:text-foreground transition">
                  Or enter a Stripe account ID manually (for development/testing)
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-4 mb-6">
        {([
          { id: 'products' as Tab, label: 'Products & Services', icon: Package },
          { id: 'invoices' as Tab, label: 'Invoices', icon: FileText },
          { id: 'history' as Tab, label: 'Processed Payments', icon: History },
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-4">
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
            {newBillingType === 'recurring' && (
              <div className="col-span-2">
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Free Trial Period (days)</label>
                <Input type="number" value={newTrialDays} onChange={e => setNewTrialDays(e.target.value)} placeholder="e.g. 7, 14, 30" className="h-9 text-sm max-w-[200px]" min="0" max="365" />
                <p className="text-[10px] text-muted-foreground mt-1">Customers won&apos;t be charged until the trial ends. Leave blank for no trial.</p>
              </div>
            )}
            <div className="col-span-2">
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Terms & Conditions URL (optional)</label>
              <Input value={newTermsUrl} onChange={e => setNewTermsUrl(e.target.value)} placeholder="https://example.com/terms" className="h-9 text-sm" />
            </div>
            <div className="col-span-2 flex items-center gap-6">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={newRequiresShipping} onChange={e => setNewRequiresShipping(e.target.checked)} className="rounded border-border" />
                <span className="text-xs font-medium text-muted-foreground">Collect shipping address</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={newCollectPhone} onChange={e => setNewCollectPhone(e.target.checked)} className="rounded border-border" />
                <span className="text-xs font-medium text-muted-foreground">Collect phone number</span>
              </label>
            </div>
            {/* Link courses to this product */}
            <div className="col-span-2">
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Link Courses (optional)</label>
              <p className="text-[10px] text-muted-foreground mb-2">Buyers will be automatically enrolled in selected courses after purchase.</p>
              <button type="button" className="text-xs text-accent" onClick={async () => {
                if (availableCourses.length === 0) {
                  const res = await fetch('/api/courses/courses', { credentials: 'include' })
                  const d = await res.json()
                  if (d.ok) setAvailableCourses((d.data || []).filter((c: any) => c.is_published))
                }
              }}>
                {availableCourses.length > 0 ? '' : 'Load courses'}
              </button>
              {availableCourses.length > 0 && (
                <div className="space-y-1 border rounded-md p-2 max-h-32 overflow-y-auto">
                  {availableCourses.map(c => (
                    <label key={c.id} className="flex items-center gap-2 text-xs cursor-pointer px-1 py-0.5 rounded hover:bg-muted/50">
                      <input type="checkbox" checked={newCourseIds.includes(c.id)}
                        onChange={e => setNewCourseIds(prev => e.target.checked ? [...prev, c.id] : prev.filter(x => x !== c.id))}
                        className="rounded border-border" />
                      {c.title}
                    </label>
                  ))}
                </div>
              )}
              {newCourseIds.length > 0 && <p className="text-[10px] text-accent mt-1">{newCourseIds.length} course{newCourseIds.length > 1 ? 's' : ''} linked</p>}
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="relative" data-contact-picker>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Contact</label>
              {selectedContactId ? (
                <div className="flex items-center gap-2 h-9 rounded-md border bg-card px-3">
                  <span className="text-sm flex-1 truncate">
                    {contacts.find(c => c.id === selectedContactId)?.display_name || 'Selected'}
                    {(() => { const c = contacts.find(c => c.id === selectedContactId); return c?.primary_email ? ` (${c.primary_email})` : '' })()}
                  </span>
                  <button type="button" onClick={() => { setSelectedContactId(''); setContactSearch('') }}
                    className="text-muted-foreground hover:text-foreground shrink-0">
                    <X className="size-3.5" />
                  </button>
                </div>
              ) : (
                <>
                  <Input
                    value={contactSearch}
                    onChange={e => { setContactSearch(e.target.value); setContactDropdownOpen(true) }}
                    onFocus={() => setContactDropdownOpen(true)}
                    placeholder="Search contacts..."
                    className="h-9 text-sm"
                  />
                  {contactDropdownOpen && (
                    <div className="absolute z-30 top-full left-0 right-0 mt-1 bg-background border rounded-md shadow-lg max-h-48 overflow-y-auto">
                      {contacts
                        .filter(c => {
                          if (!contactSearch.trim()) return true
                          const q = contactSearch.toLowerCase()
                          return (c.display_name || '').toLowerCase().includes(q) ||
                            (c.primary_email || '').toLowerCase().includes(q)
                        })
                        .map(c => (
                          <button
                            key={c.id}
                            type="button"
                            className="w-full text-left px-3 py-2 hover:bg-muted transition flex items-center gap-2"
                            onClick={() => {
                              setSelectedContactId(c.id)
                              setContactSearch('')
                              setContactDropdownOpen(false)
                            }}
                          >
                            <div className="w-6 h-6 rounded-full bg-accent/10 flex items-center justify-center text-accent text-[10px] font-semibold shrink-0">
                              {c.display_name?.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase() || '?'}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium truncate">{c.display_name}</p>
                              {c.primary_email && <p className="text-[11px] text-muted-foreground truncate">{c.primary_email}</p>}
                            </div>
                          </button>
                        ))
                      }
                      {contacts.filter(c => {
                        if (!contactSearch.trim()) return true
                        const q = contactSearch.toLowerCase()
                        return (c.display_name || '').toLowerCase().includes(q) || (c.primary_email || '').toLowerCase().includes(q)
                      }).length === 0 && (
                        <div className="px-3 py-3 text-center">
                          <p className="text-xs text-muted-foreground mb-2">No contacts found</p>
                          <Button type="button" variant="outline" size="sm" onClick={() => {
                            setContactDropdownOpen(false)
                            window.open('/backend/customers/people/create', '_blank')
                          }}>
                            <Plus className="size-3 mr-1" /> Create Contact
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Due Date</label>
              <Input type="date" value={invoiceDueDate} onChange={e => setInvoiceDueDate(e.target.value)} className="h-9 text-sm" />
            </div>
          </div>
          {!selectedContactId && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Recipient Name</label>
                <Input value={invoiceRecipientName} onChange={e => setInvoiceRecipientName(e.target.value)}
                  placeholder="John Smith" className="h-9 text-sm" />
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Recipient Email</label>
                <Input type="email" value={invoiceRecipientEmail} onChange={e => setInvoiceRecipientEmail(e.target.value)}
                  placeholder="client@example.com" className="h-9 text-sm" />
              </div>
            </div>
          )}
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
          <div>
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Terms & Conditions URL (optional)</label>
            <Input value={invoiceTermsUrl} onChange={e => setInvoiceTermsUrl(e.target.value)} placeholder="https://example.com/terms" className="h-9 text-sm" />
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
              <div key={p.id}>
                {editingProduct?.id === p.id ? (
                  <div className="px-5 py-4 space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="col-span-2">
                        <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Name</label>
                        <Input value={editName} onChange={e => setEditName(e.target.value)} placeholder="Product name" className="h-9 text-sm" autoFocus />
                      </div>
                      <div className="col-span-2">
                        <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Description</label>
                        <Input value={editDescription} onChange={e => setEditDescription(e.target.value)} placeholder="Optional description" className="h-9 text-sm" />
                      </div>
                      <div>
                        <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Price ($)</label>
                        <Input type="number" value={editPrice} onChange={e => setEditPrice(e.target.value)} placeholder="0.00" className="h-9 text-sm" step="0.01" />
                      </div>
                      <div>
                        <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Billing</label>
                        <select value={editBillingType} onChange={e => setEditBillingType(e.target.value)}
                          className="w-full h-9 rounded-md border bg-card px-3 text-sm">
                          <option value="one_time">One-time</option>
                          <option value="recurring">Monthly recurring</option>
                        </select>
                      </div>
                      {editBillingType === 'recurring' && (
                        <div className="col-span-2">
                          <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Free Trial Period (days)</label>
                          <Input type="number" value={editTrialDays} onChange={e => setEditTrialDays(e.target.value)} placeholder="e.g. 7, 14, 30" className="h-9 text-sm max-w-[200px]" min="0" max="365" />
                          <p className="text-[10px] text-muted-foreground mt-1">Customers won&apos;t be charged until the trial ends.</p>
                        </div>
                      )}
                      <div className="col-span-2">
                        <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Terms & Conditions URL (optional)</label>
                        <Input value={editTermsUrl} onChange={e => setEditTermsUrl(e.target.value)} placeholder="https://example.com/terms" className="h-9 text-sm" />
                      </div>
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={cancelEditProduct}>Cancel</Button>
                      <Button type="button" size="sm" onClick={saveEditProduct} disabled={savingEdit || !editName.trim() || !editPrice.trim()}>
                        {savingEdit ? <Loader2 className="size-3 animate-spin mr-1" /> : <Check className="size-3 mr-1" />} Save
                      </Button>
                    </div>
                  </div>
                ) : (
                <div className="flex items-center gap-4 px-5 py-4">
                  <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
                    <DollarSign className="size-5 text-accent" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{p.name}</p>
                    {p.description && <p className="text-xs text-muted-foreground truncate">{p.description}</p>}
                  </div>
                  <div className="text-right shrink-0 mr-2">
                    <p className="text-sm font-semibold tabular-nums">${Number(p.price).toFixed(2)}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {p.billing_type === 'recurring' ? '/month' : 'one-time'}
                      {p.trial_days ? ` · ${p.trial_days}-day trial` : ''}
                    </p>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={async () => {
                    setGeneratingLink(p.id)
                    try {
                      const res = await fetch('/api/payments/stripe/connect', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                        body: JSON.stringify({ type: 'product', productId: p.id }),
                      })
                      const data = await res.json()
                      if (data.ok && data.url) {
                        setGeneratedLinks(prev => ({ ...prev, [p.id]: data.url }))
                      } else {
                        setEmailFeedback({ id: p.id, type: 'error', text: data.error || 'Failed to generate link' })
                      }
                    } catch {
                      setEmailFeedback({ id: p.id, type: 'error', text: 'Failed to generate link' })
                    }
                    setGeneratingLink(null)
                  }} disabled={generatingLink === p.id}>
                    {generatingLink === p.id ? <Loader2 className="size-3 animate-spin mr-1" /> : <Link2 className="size-3 mr-1" />}
                    {generatedLinks[p.id] ? 'Regenerate Link' : 'Payment Link'}
                  </Button>
                  <IconButton type="button" variant="ghost" size="sm" onClick={() => startEditProduct(p)}
                    aria-label="Edit product" className="text-muted-foreground hover:text-foreground">
                    <Pencil className="size-3.5" />
                  </IconButton>
                  <IconButton type="button" variant="ghost" size="sm" onClick={() => deleteProduct(p.id)}
                    aria-label="Delete product" className="text-muted-foreground hover:text-destructive">
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </div>
                )}
                {generatedLinks[p.id] && (
                  <div className="px-5 pb-4 -mt-1">
                    <div className="flex items-center gap-2 bg-muted/50 rounded-md px-3 py-2">
                      <input type="text" readOnly value={generatedLinks[p.id]} className="flex-1 bg-transparent text-xs font-mono text-muted-foreground outline-none truncate" />
                      <Button type="button" variant="ghost" size="sm" onClick={() => copyToClipboard(generatedLinks[p.id], p.id)} className="shrink-0 h-7">
                        {linkCopied === p.id ? <Check className="size-3 mr-1" /> : <Copy className="size-3 mr-1" />}
                        {linkCopied === p.id ? 'Copied!' : 'Copy'}
                      </Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => window.open(generatedLinks[p.id], '_blank')} className="shrink-0 h-7">
                        <ExternalLink className="size-3" />
                      </Button>
                    </div>
                  </div>
                )}
                {emailFeedback?.id === p.id && (
                  <div className={`px-5 pb-3 -mt-1 text-xs ${emailFeedback.type === 'success' ? 'text-emerald-600' : 'text-red-600'}`}>
                    {emailFeedback.text}
                  </div>
                )}
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
              <div key={inv.id}>
                {/* Invoice card — clean layout */}
                <div className="px-5 py-4">
                  {/* Row 1: Invoice info + amount + primary action */}
                  <div className="flex items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <p className="text-sm font-semibold">{inv.invoice_number}</p>
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${statusColors[inv.status] || ''}`}>
                          {inv.status}
                        </span>
                        {inv.paid_at && (
                          <span className="text-[10px] text-muted-foreground">
                            Paid {new Date(inv.paid_at).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        {inv.contact_name && <span>{inv.contact_name}</span>}
                        {!inv.contact_name && inv.contact_email && <span>{inv.contact_email}</span>}
                        {inv.due_date && <span>Due {new Date(inv.due_date).toLocaleDateString()}</span>}
                      </div>
                    </div>
                    <p className="text-base font-bold tabular-nums shrink-0">${Number(inv.total).toFixed(2)}</p>
                  </div>

                  {/* Row 2: Email sent badge */}
                  {inv.status !== 'draft' && invoiceEmails[inv.id]?.length > 0 && (() => {
                    const lastEmail = invoiceEmails[inv.id][0]
                    return (
                      <span className="inline-flex items-center gap-1 mt-2 text-[10px] font-medium bg-muted text-muted-foreground rounded px-2 py-0.5">
                        <Mail className="size-2.5" />
                        Email sent {new Date(lastEmail.sent_at).toLocaleDateString()}
                        {lastEmail.opened_at && (
                          <span className="inline-flex items-center gap-0.5 ml-1">
                            · <Eye className="size-2.5" /> Opened
                          </span>
                        )}
                      </span>
                    )
                  })()}

                  {/* Row 3: Actions — compact, context-appropriate */}
                  <div className="flex items-center gap-2 mt-3">
                    {/* Send / Resend email */}
                    <Button type="button" variant="outline" size="sm" onClick={() => promptSendInvoiceEmail(inv.id)}
                      disabled={sendingEmail === inv.id}>
                      {sendingEmail === inv.id ? <Loader2 className="size-3 animate-spin mr-1" /> : <Mail className="size-3 mr-1" />}
                      {inv.status === 'paid' ? 'Send Receipt' : inv.status === 'sent' ? 'Resend' : 'Email Invoice'}
                    </Button>

                    {/* Payment link — single button with copy or generate */}
                    {inv.stripe_payment_link || generatedLinks[inv.id] ? (
                      <Button type="button" variant="outline" size="sm" onClick={() => copyToClipboard(generatedLinks[inv.id] || inv.stripe_payment_link!, inv.id)}>
                        {linkCopied === inv.id ? <Check className="size-3 mr-1" /> : <Link2 className="size-3 mr-1" />}
                        {linkCopied === inv.id ? 'Copied!' : 'Copy Payment Link'}
                      </Button>
                    ) : inv.status !== 'paid' && (
                      <Button type="button" variant="outline" size="sm" onClick={() => generatePaymentLink(inv.id)}
                        disabled={generatingLink === inv.id}>
                        {generatingLink === inv.id ? <Loader2 className="size-3 animate-spin mr-1" /> : <Link2 className="size-3 mr-1" />}
                        Get Payment Link
                      </Button>
                    )}

                    {/* Status changes */}
                    {inv.status === 'sent' && (
                      <Button type="button" variant="outline" size="sm" onClick={() => updateInvoiceStatus(inv.id, 'paid')}>
                        <CheckCircle className="size-3 mr-1" /> Mark Paid
                      </Button>
                    )}

                    {/* More actions dropdown — click-based */}
                    <div className="relative ml-auto" data-more-menu>
                      <IconButton type="button" variant="ghost" size="sm" aria-label="More actions"
                        onClick={() => setOpenMoreMenu(openMoreMenu === inv.id ? null : inv.id)}>
                        <ChevronDown className={`size-3.5 text-muted-foreground transition ${openMoreMenu === inv.id ? 'rotate-180' : ''}`} />
                      </IconButton>
                      {openMoreMenu === inv.id && (
                        <div className="absolute right-0 top-full mt-1 bg-background border rounded-md shadow-lg py-1 z-20 min-w-[160px]">
                          {inv.status === 'sent' && (
                            <button type="button" className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted transition"
                              onClick={() => { updateInvoiceStatus(inv.id, 'draft'); setOpenMoreMenu(null) }}>
                              Revert to Draft
                            </button>
                          )}
                          {inv.status === 'paid' && (
                            <button type="button" className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted transition"
                              onClick={() => { updateInvoiceStatus(inv.id, 'sent'); setOpenMoreMenu(null) }}>
                              Revert to Sent
                            </button>
                          )}
                          {inv.stripe_payment_link && (
                            <button type="button" className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted transition"
                              onClick={() => { window.open(generatedLinks[inv.id] || inv.stripe_payment_link!, '_blank'); setOpenMoreMenu(null) }}>
                              Open Payment Link
                            </button>
                          )}
                          <button type="button" className="w-full text-left px-3 py-1.5 text-xs text-destructive hover:bg-muted transition"
                            onClick={() => { deleteInvoice(inv.id); setOpenMoreMenu(null) }}>
                            Delete Invoice
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Feedback message */}
                  {emailFeedback?.id === inv.id && (
                    <div className={`mt-2 text-xs ${emailFeedback.type === 'success' ? 'text-emerald-600' : 'text-red-600'}`}>
                      {emailFeedback.text}
                    </div>
                  )}
                </div>

                {/* Email History — expandable, only for sent/paid */}
                {(inv.status === 'sent' || inv.status === 'paid') && (
                <div className="px-5 pb-3 border-t">
                  <button
                    type="button"
                    onClick={() => toggleEmailHistory(inv.id)}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition pt-2"
                  >
                    <Mail className="size-3" />
                    Email History
                    {expandedInvoiceEmail === inv.id ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                  </button>
                  {expandedInvoiceEmail === inv.id && (
                    <div className="mt-2 rounded-md border bg-muted/30">
                      {loadingEmails === inv.id ? (
                        <div className="px-4 py-3 flex items-center gap-2 text-xs text-muted-foreground">
                          <Loader2 className="size-3 animate-spin" /> Loading email history...
                        </div>
                      ) : !invoiceEmails[inv.id] || invoiceEmails[inv.id].length === 0 ? (
                        <div className="px-4 py-3 text-xs text-muted-foreground">
                          No emails sent yet
                        </div>
                      ) : (
                        <div className="divide-y divide-border/50">
                          {invoiceEmails[inv.id].map(em => (
                            <div key={em.id} className="px-4 py-2.5">
                              <div className="flex items-center gap-2 mb-1">
                                {em.direction === 'outbound' ? (
                                  <ArrowUpRight className="size-3 text-blue-500 shrink-0" />
                                ) : (
                                  <ArrowDownLeft className="size-3 text-emerald-500 shrink-0" />
                                )}
                                <div className="flex-1 min-w-0">
                                  <span className="text-xs font-medium truncate block">
                                    {em.direction === 'outbound' ? `To: ${em.to_address}` : `From: ${em.from_address}`}
                                  </span>
                                  {em.cc && <span className="text-[10px] text-muted-foreground truncate block">CC: {em.cc}</span>}
                                  {em.bcc && <span className="text-[10px] text-muted-foreground truncate block">BCC: {em.bcc}</span>}
                                </div>
                                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${emailStatusColors[em.status] || 'bg-muted text-muted-foreground'}`}>
                                  {em.status}
                                </span>
                              </div>
                              <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                                <span>{new Date(em.sent_at || em.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                                {em.opened_at && (
                                  <span className="flex items-center gap-0.5" title={`Opened ${new Date(em.opened_at).toLocaleString()}`}>
                                    <Eye className="size-2.5" /> Opened {new Date(em.opened_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                  </span>
                                )}
                                {em.clicked_at && (
                                  <span className="flex items-center gap-0.5" title={`Clicked ${new Date(em.clicked_at).toLocaleString()}`}>
                                    <MousePointerClick className="size-2.5" /> Clicked {new Date(em.clicked_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                  </span>
                                )}
                              </div>
                              {em.body_html && (
                                <button
                                  type="button"
                                  onClick={() => setExpandedEmailBody(expandedEmailBody === em.id ? null : em.id)}
                                  className="text-[11px] text-muted-foreground hover:text-foreground mt-1 flex items-center gap-1"
                                >
                                  {expandedEmailBody === em.id ? 'Hide' : 'Preview'}
                                  {expandedEmailBody === em.id ? <ChevronUp className="size-2.5" /> : <ChevronDown className="size-2.5" />}
                                </button>
                              )}
                              {expandedEmailBody === em.id && em.body_html && (
                                <div
                                  className="mt-2 rounded border bg-white dark:bg-zinc-900 p-3 text-xs max-h-48 overflow-y-auto"
                                  dangerouslySetInnerHTML={{ __html: em.body_html }}
                                />
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                )}
              </div>
            ))}
          </div>
        )
      )}

      {/* Email Compose Dialog */}
      {emailConfirmInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-background rounded-xl border shadow-2xl w-full max-w-lg mx-4">
            <div className="flex items-center justify-between px-5 py-3 border-b">
              <h3 className="text-sm font-semibold">Compose Invoice Email</h3>
              <IconButton type="button" variant="ghost" size="sm" onClick={() => { setEmailConfirmInvoice(null); setEmailConfirmAddress('') }} aria-label="Close">
                <X className="size-4" />
              </IconButton>
            </div>
            <div className="p-5 space-y-3">
              <div className="relative" data-email-recipient-picker>
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">To</label>
                {emailConfirmAddress ? (
                  <div className="flex items-center gap-2 h-9 rounded-md border bg-card px-3">
                    <div className="w-5 h-5 rounded-full bg-accent/10 flex items-center justify-center text-accent text-[9px] font-semibold shrink-0">
                      {emailContactName?.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase() || '@'}
                    </div>
                    <span className="text-sm flex-1 truncate">
                      {emailContactName ? `${emailContactName} <${emailConfirmAddress}>` : emailConfirmAddress}
                    </span>
                    <button type="button" onClick={() => { setEmailConfirmAddress(''); setEmailContactName(''); setEmailRecipientSearch('') }}
                      className="text-muted-foreground hover:text-foreground shrink-0">
                      <X className="size-3.5" />
                    </button>
                  </div>
                ) : (
                  <>
                    <Input
                      value={emailRecipientSearch}
                      onChange={e => { setEmailRecipientSearch(e.target.value); setEmailRecipientDropdownOpen(true) }}
                      onFocus={() => setEmailRecipientDropdownOpen(true)}
                      placeholder="Search contacts or type email..."
                      className="h-9 text-sm"
                      autoFocus
                      onKeyDown={e => {
                        if (e.key === 'Enter' && emailRecipientSearch.includes('@')) {
                          setEmailConfirmAddress(emailRecipientSearch.trim())
                          setEmailContactName('')
                          setEmailRecipientSearch('')
                          setEmailRecipientDropdownOpen(false)
                        }
                      }}
                    />
                    {emailRecipientDropdownOpen && (
                      <div className="absolute z-30 top-full left-0 right-0 mt-1 bg-background border rounded-md shadow-lg max-h-48 overflow-y-auto">
                        {contacts
                          .filter(c => {
                            if (!c.primary_email) return false
                            if (!emailRecipientSearch.trim()) return true
                            const q = emailRecipientSearch.toLowerCase()
                            return (c.display_name || '').toLowerCase().includes(q) ||
                              (c.primary_email || '').toLowerCase().includes(q)
                          })
                          .map(c => (
                            <button
                              key={c.id}
                              type="button"
                              className="w-full text-left px-3 py-2 hover:bg-muted transition flex items-center gap-2"
                              onClick={() => {
                                setEmailConfirmAddress(c.primary_email || '')
                                setEmailContactName(c.display_name || '')
                                setEmailRecipientSearch('')
                                setEmailRecipientDropdownOpen(false)
                              }}
                            >
                              <div className="w-6 h-6 rounded-full bg-accent/10 flex items-center justify-center text-accent text-[10px] font-semibold shrink-0">
                                {c.display_name?.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase() || '?'}
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium truncate">{c.display_name}</p>
                                <p className="text-[11px] text-muted-foreground truncate">{c.primary_email}</p>
                              </div>
                            </button>
                          ))
                        }
                        {emailRecipientSearch.includes('@') && (
                          <button
                            type="button"
                            className="w-full text-left px-3 py-2 hover:bg-muted transition flex items-center gap-2 border-t"
                            onClick={() => {
                              setEmailConfirmAddress(emailRecipientSearch.trim())
                              setEmailContactName('')
                              setEmailRecipientSearch('')
                              setEmailRecipientDropdownOpen(false)
                            }}
                          >
                            <Mail className="size-4 text-muted-foreground" />
                            <span className="text-sm">Send to <strong>{emailRecipientSearch.trim()}</strong></span>
                          </button>
                        )}
                        {!emailRecipientSearch.includes('@') && contacts.filter(c => {
                          if (!c.primary_email) return false
                          if (!emailRecipientSearch.trim()) return true
                          const q = emailRecipientSearch.toLowerCase()
                          return (c.display_name || '').toLowerCase().includes(q) || (c.primary_email || '').toLowerCase().includes(q)
                        }).length === 0 && (
                          <div className="px-3 py-3 text-center">
                            <p className="text-xs text-muted-foreground mb-2">No contacts found — type a full email address</p>
                            <Button type="button" variant="outline" size="sm" onClick={() => {
                              setEmailRecipientDropdownOpen(false)
                              window.open('/backend/customers/people/create', '_blank')
                            }}>
                              <Plus className="size-3 mr-1" /> Create Contact
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
              {!showCcBcc ? (
                <button type="button" onClick={() => setShowCcBcc(true)}
                  className="text-[11px] text-muted-foreground hover:text-foreground transition">
                  + Add CC / BCC
                </button>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">CC</label>
                    <Input
                      value={emailCc}
                      onChange={e => setEmailCc(e.target.value)}
                      placeholder="cc@example.com, cc2@example.com"
                      className="h-9 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">BCC</label>
                    <Input
                      value={emailBcc}
                      onChange={e => setEmailBcc(e.target.value)}
                      placeholder="bcc@example.com"
                      className="h-9 text-sm"
                    />
                  </div>
                </div>
              )}
              <div>
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Subject</label>
                <Input
                  value={emailSubject}
                  onChange={e => setEmailSubject(e.target.value)}
                  placeholder="Invoice subject line"
                  className="h-9 text-sm"
                />
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Message</label>
                <textarea
                  value={emailBody}
                  onChange={e => setEmailBody(e.target.value)}
                  className="w-full rounded-md border bg-card px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-32"
                  placeholder="Your message to the recipient..."
                />
              </div>
              <div className="rounded-md bg-muted/50 px-3 py-2">
                <p className="text-[10px] text-muted-foreground">
                  The invoice table with line items, totals, and a Pay Now button will be included automatically below your message.
                </p>
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t">
                <Button type="button" variant="outline" size="sm" onClick={() => { setEmailConfirmInvoice(null); setEmailConfirmAddress('') }}>
                  Cancel
                </Button>
                <Button type="button" size="sm" onClick={confirmSendInvoiceEmail}
                  disabled={!emailConfirmAddress.trim() || !emailConfirmAddress.includes('@')}>
                  <Mail className="size-3 mr-1.5" /> Send Invoice
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Processed Payments */}
      {tab === 'history' && (
        <>
          <div className="flex gap-2 mb-4">
            {(['all', 'succeeded', 'pending', 'failed', 'refunded'] as const).map(s => (
              <button key={s} type="button" onClick={() => setHistoryStatus(s)}
                className={`text-xs font-medium px-3 py-1.5 rounded-full border transition ${
                  historyStatus === s
                    ? 'bg-foreground text-background border-foreground'
                    : 'bg-card text-muted-foreground border-border hover:text-foreground'
                }`}>
                {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
          {loading ? <div className="text-sm text-muted-foreground">Loading...</div> :
          records.length === 0 ? (
            <div className="rounded-lg border p-12 text-center">
              <Clock className="size-8 mx-auto mb-3 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">No payment records yet. Payments will appear here once customers start paying.</p>
            </div>
          ) : (
            <div className="rounded-lg border divide-y">
              {records.map(rec => {
                const isExpanded = expandedRecord === rec.id
                const hasActions = rec.status === 'succeeded' || rec.status === 'partially_refunded' || rec.stripe_subscription_id || rec.stripe_url
                return (
                <div key={rec.id}>
                  <button type="button"
                    className="w-full text-left px-5 py-4 hover:bg-muted/30 transition"
                    onClick={() => setExpandedRecord(isExpanded ? null : rec.id)}>
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
                        <DollarSign className="size-5 text-accent" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium">
                            {rec.contact_name || 'Unknown'}
                          </p>
                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${paymentStatusColors[rec.status] || 'bg-muted text-muted-foreground'}`}>
                            {rec.status === 'partially_refunded' ? 'partial refund' : rec.status}
                          </span>
                          {rec.stripe_subscription_id && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                              subscription
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {new Date(rec.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          {rec.invoice_number && <span className="ml-2">- {rec.invoice_number}</span>}
                          {Number(rec.refunded_amount) > 0 && (
                            <span className="ml-2 text-orange-600 dark:text-orange-400">
                              · ${Number(rec.refunded_amount).toFixed(2)} refunded
                            </span>
                          )}
                        </p>
                      </div>
                      <p className="text-sm font-semibold tabular-nums shrink-0">
                        ${Number(rec.amount).toFixed(2)} <span className="text-xs text-muted-foreground uppercase">{rec.currency}</span>
                      </p>
                      {hasActions && (
                        <ChevronDown className={`size-4 text-muted-foreground transition shrink-0 ${isExpanded ? 'rotate-180' : ''}`} />
                      )}
                    </div>
                  </button>

                  {/* Expanded actions */}
                  {isExpanded && (
                    <div className="px-5 pb-4 pt-1 flex items-center gap-2 border-t border-dashed ml-[4.25rem]">
                      {(rec.status === 'succeeded' || rec.status === 'partially_refunded') && (
                        <Button type="button" variant="outline" size="sm"
                          onClick={() => { setRefundRecord(rec); setRefundType('full'); setRefundAmount(''); setRefundFeedback(null) }}>
                          <RotateCcw className="size-3 mr-1.5" /> Issue Refund
                        </Button>
                      )}
                      {rec.stripe_subscription_id && rec.status === 'succeeded' && (
                        <Button type="button" variant="outline" size="sm"
                          className="text-red-600 border-red-200 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950/30"
                          onClick={() => { setCancelSubRecord(rec); setCancelAtPeriodEnd(true); setCancelSubFeedback(null) }}>
                          <Ban className="size-3 mr-1.5" /> Cancel Subscription
                        </Button>
                      )}
                      {rec.stripe_url && (
                        <a href={rec.stripe_url} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition px-3 py-1.5 rounded-md border hover:bg-muted/50">
                          <ExternalLink className="size-3" /> View in Stripe
                        </a>
                      )}
                    </div>
                  )}

                  {/* Inline feedback */}
                  {refundFeedback?.id === rec.id && (
                    <div className={`px-5 pb-3 ml-[4.25rem] text-xs ${refundFeedback.type === 'success' ? 'text-emerald-600' : 'text-red-600'}`}>
                      {refundFeedback.text}
                    </div>
                  )}
                  {cancelSubFeedback?.id === rec.id && (
                    <div className={`px-5 pb-3 ml-[4.25rem] text-xs ${cancelSubFeedback.type === 'success' ? 'text-emerald-600' : 'text-red-600'}`}>
                      {cancelSubFeedback.text}
                    </div>
                  )}
                </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {/* Refund Modal */}
      {refundRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-background rounded-xl border shadow-2xl w-full max-w-md mx-4">
            <div className="flex items-center justify-between px-5 py-3 border-b">
              <h3 className="text-sm font-semibold">Issue Refund</h3>
              <IconButton type="button" variant="ghost" size="sm" onClick={() => setRefundRecord(null)} aria-label="Close">
                <X className="size-4" />
              </IconButton>
            </div>
            <div className="p-5 space-y-4">
              <div className="rounded-md bg-muted/50 px-3 py-2">
                <p className="text-xs text-muted-foreground">
                  Payment of <strong>${Number(refundRecord.amount).toFixed(2)}</strong> from {refundRecord.contact_name || 'Unknown'}
                  {Number(refundRecord.refunded_amount) > 0 && (
                    <span> (${Number(refundRecord.refunded_amount).toFixed(2)} already refunded)</span>
                  )}
                </p>
              </div>
              <div className="flex gap-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="refundType" checked={refundType === 'full'} onChange={() => setRefundType('full')} />
                  <span className="text-sm">Full refund</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="refundType" checked={refundType === 'partial'} onChange={() => setRefundType('partial')} />
                  <span className="text-sm">Partial refund</span>
                </label>
              </div>
              {refundType === 'partial' && (
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Refund Amount ($)</label>
                  <Input type="number" value={refundAmount} onChange={e => setRefundAmount(e.target.value)}
                    placeholder="0.00" className="h-9 text-sm max-w-[200px]" step="0.01" min="0.01"
                    max={String(Number(refundRecord.amount) - Number(refundRecord.refunded_amount || 0))} autoFocus />
                </div>
              )}
              {refundFeedback && (
                <div className={`text-xs ${refundFeedback.type === 'success' ? 'text-emerald-600' : 'text-red-600'}`}>
                  {refundFeedback.text}
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2 border-t">
                <Button type="button" variant="outline" size="sm" onClick={() => setRefundRecord(null)}>Cancel</Button>
                <Button type="button" size="sm" onClick={issueRefund}
                  disabled={refunding || (refundType === 'partial' && (!refundAmount || Number(refundAmount) <= 0))}
                  className="bg-orange-600 hover:bg-orange-700 text-white">
                  {refunding ? <Loader2 className="size-3 animate-spin mr-1" /> : <RotateCcw className="size-3 mr-1" />}
                  {refunding ? 'Processing...' : 'Issue Refund'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Cancel Subscription Modal */}
      {cancelSubRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-background rounded-xl border shadow-2xl w-full max-w-md mx-4">
            <div className="flex items-center justify-between px-5 py-3 border-b">
              <h3 className="text-sm font-semibold">Cancel Subscription</h3>
              <IconButton type="button" variant="ghost" size="sm" onClick={() => setCancelSubRecord(null)} aria-label="Close">
                <X className="size-4" />
              </IconButton>
            </div>
            <div className="p-5 space-y-4">
              <div className="rounded-md bg-muted/50 px-3 py-2">
                <p className="text-xs text-muted-foreground">
                  Subscription for <strong>{cancelSubRecord.contact_name || 'Unknown'}</strong> — ${Number(cancelSubRecord.amount).toFixed(2)}/{cancelSubRecord.currency}
                </p>
              </div>
              <div className="space-y-2">
                <label className="flex items-start gap-2 cursor-pointer p-2 rounded-md hover:bg-muted/50">
                  <input type="radio" name="cancelType" checked={cancelAtPeriodEnd} onChange={() => setCancelAtPeriodEnd(true)} className="mt-0.5" />
                  <div>
                    <p className="text-sm font-medium">Cancel at end of billing period</p>
                    <p className="text-[11px] text-muted-foreground">Customer keeps access until their current period ends.</p>
                  </div>
                </label>
                <label className="flex items-start gap-2 cursor-pointer p-2 rounded-md hover:bg-muted/50">
                  <input type="radio" name="cancelType" checked={!cancelAtPeriodEnd} onChange={() => setCancelAtPeriodEnd(false)} className="mt-0.5" />
                  <div>
                    <p className="text-sm font-medium">Cancel immediately</p>
                    <p className="text-[11px] text-muted-foreground">Subscription ends right away. Consider issuing a prorated refund.</p>
                  </div>
                </label>
              </div>
              {cancelSubFeedback && (
                <div className={`text-xs ${cancelSubFeedback.type === 'success' ? 'text-emerald-600' : 'text-red-600'}`}>
                  {cancelSubFeedback.text}
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2 border-t">
                <Button type="button" variant="outline" size="sm" onClick={() => setCancelSubRecord(null)}>Keep Subscription</Button>
                <Button type="button" size="sm" onClick={cancelSubscription} disabled={cancellingSub}
                  className="bg-red-600 hover:bg-red-700 text-white">
                  {cancellingSub ? <Loader2 className="size-3 animate-spin mr-1" /> : <Ban className="size-3 mr-1" />}
                  {cancellingSub ? 'Cancelling...' : 'Cancel Subscription'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
