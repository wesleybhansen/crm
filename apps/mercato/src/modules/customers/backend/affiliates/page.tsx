'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { Switch } from '@open-mercato/ui/primitives/switch'
import { Label } from '@open-mercato/ui/primitives/label'
import {
  Users, Plus, Copy, Check, X, Link, ExternalLink, Search,
  UserPlus, MousePointerClick, Wallet, Eye,
  Loader2, BarChart3, Percent, Ban, CheckCircle, Clock, Archive, Pause, Play,
  Share2, DollarSign, Package, Settings, ChevronRight,
  Megaphone, ArrowRightLeft, Send, Globe, Sparkles,
} from 'lucide-react'

// ── Types ──

type TierRow = { name: string; minConversions: number; commissionRate: number }

type Campaign = {
  id: string
  name: string
  description: string | null
  product_ids: string[]
  commission_rate: number
  commission_type: string
  customer_discount: number
  customer_discount_type: string
  cookie_duration_days: number
  auto_approve: boolean
  stripe_coupon_id: string | null
  signup_page_enabled: boolean
  status: string
  created_at: string
  affiliate_count: number
  products_info: Array<{ id: string; name: string; price: number }>
  tiers?: TierRow[] | string | null
}

type Affiliate = {
  id: string; name: string; email: string; affiliate_code: string
  commission_rate: number; commission_type: string; status: string
  total_referrals: number; total_conversions: number; total_earned: number
  campaign_id: string | null; campaign_name: string | null
  stripe_promo_code: string | null; website: string | null
  created_at: string; approved_at: string | null
}

type Referral = {
  id: string; affiliate_id: string; referred_email: string | null
  referral_source: string | null; converted: boolean
  conversion_value: number | null; commission_amount: number | null
  referred_at: string; converted_at: string | null
  affiliate_name?: string
}

type Payout = {
  id: string; affiliate_id: string; amount: number
  period_start: string; period_end: string; status: string
  paid_at: string | null; created_at: string; affiliate_name?: string
}

type Product = { id: string; name: string; price: number; stripe_product_id: string | null }

type Tab = 'campaigns' | 'affiliates' | 'tracking' | 'payouts'

// ── Helpers ──
const fmt = (v: number | string | null) => `$${Number(v || 0).toFixed(2)}`
const fmtRate = (rate: number, type: string) => type === 'percentage' ? `${Number(rate).toFixed(0)}%` : fmt(rate)
const fmtDate = (d: string | null) => d ? new Date(d).toLocaleDateString() : '-'
const fmtDateTime = (d: string | null) => d ? new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'

// Parse the campaign's tiers jsonb (may arrive as array or JSON string).
const parseTierList = (raw: Campaign['tiers']): TierRow[] => {
  let value: unknown = raw
  if (typeof value === 'string') { try { value = JSON.parse(value) } catch { return [] } }
  if (!Array.isArray(value)) return []
  return (value as any[])
    .filter(t => t && Number.isFinite(Number(t.minConversions)) && Number(t.commissionRate) > 0)
    .map(t => ({ name: String(t.name || ''), minConversions: Math.max(0, Math.floor(Number(t.minConversions))), commissionRate: Number(t.commissionRate) }))
    .sort((a, b) => a.minConversions - b.minConversions)
}

// The affiliate's current tier: highest tier already reached by total_conversions.
const currentTier = (aff: Affiliate, campaigns: Campaign[]): TierRow | null => {
  if (!aff.campaign_id) return null
  const campaign = campaigns.find(c => c.id === aff.campaign_id)
  if (!campaign) return null
  const tiers = parseTierList(campaign.tiers)
  let match: TierRow | null = null
  for (const t of tiers) { if (t.minConversions <= aff.total_conversions) match = t }
  return match
}

// House palette tinted tiles (light/dark) for summary stat icons.
const STAT_COLORS = {
  violet: { icon: 'text-[#7c3aed] dark:text-[#a78bfa]', tile: 'bg-[rgba(124,58,237,0.10)] dark:bg-[rgba(139,92,246,0.16)]' },
  blue: { icon: 'text-[#1d4ed8] dark:text-[#60a5fa]', tile: 'bg-[rgba(37,99,235,0.10)] dark:bg-[rgba(59,130,246,0.15)]' },
  green: { icon: 'text-[#047857] dark:text-[#34d399]', tile: 'bg-[rgba(16,185,129,0.10)] dark:bg-[rgba(16,185,129,0.14)]' },
  amber: { icon: 'text-[#b45309] dark:text-[#fbbf24]', tile: 'bg-[rgba(217,119,6,0.10)] dark:bg-[rgba(245,158,11,0.13)]' },
} as const

// Semantic status -> chip variant. Active/paid = green, pending = amber,
// inactive/declined/archived = neutral/red.
type ChipVariant = 'green' | 'amber' | 'red' | 'neutral'
const affiliateStatusVariant = (status: string): ChipVariant => {
  switch (status) {
    case 'active': return 'green'
    case 'pending': return 'amber'
    case 'inactive': return 'red'
    default: return 'neutral'
  }
}
const payoutStatusVariant = (status: string): ChipVariant => {
  switch (status) {
    case 'paid': return 'green'
    case 'pending': return 'amber'
    case 'failed':
    case 'cancelled': return 'red'
    default: return 'neutral'
  }
}

// Colored count badge: distinct hue per metric, muted when zero.
const COUNT_BADGE = {
  violet: 'bg-[rgba(124,58,237,.09)] text-[#6d28d9] dark:bg-[rgba(139,92,246,.16)] dark:text-[#c4b5fd]',
  blue: 'bg-[rgba(37,99,235,.08)] text-[#1d4ed8] dark:bg-[rgba(59,130,246,.15)] dark:text-[#93c5fd]',
  green: 'bg-[rgba(16,185,129,.10)] text-[#047857] dark:bg-[rgba(16,185,129,.14)] dark:text-[#34d399]',
  amber: 'bg-[rgba(217,119,6,.10)] text-[#b45309] dark:bg-[rgba(245,158,11,.13)] dark:text-[#fbbf24]',
} as const
function CountBadge({ value, color }: { value: number; color: keyof typeof COUNT_BADGE }) {
  const muted = !value
  return (
    <span className={`inline-flex min-w-[1.75rem] justify-center items-center rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums ${muted ? 'text-muted-foreground/60' : COUNT_BADGE[color]}`}>
      {value}
    </span>
  )
}

export default function AffiliatesPage() {
  const [tab, setTab] = useState<Tab>('campaigns')
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [affiliates, setAffiliates] = useState<Affiliate[]>([])
  const [allReferrals, setAllReferrals] = useState<Referral[]>([])
  const [allPayouts, setAllPayouts] = useState<Payout[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('')

  // Campaign create
  const [showCreateCampaign, setShowCreateCampaign] = useState(false)
  const [cName, setCName] = useState('')
  const [cDesc, setCDesc] = useState('')
  const [cProducts, setCProducts] = useState<string[]>([])
  const [cRate, setCRate] = useState('10')
  const [cRateType, setCRateType] = useState('percentage')
  const [cDiscount, setCDiscount] = useState('0')
  const [cDiscountType, setCDiscountType] = useState('percentage')
  const [cCookieDays, setCCookieDays] = useState('30')
  const [cAutoApprove, setCAutoApprove] = useState(false)
  const [cTerms, setCTerms] = useState('')
  const [creatingCampaign, setCreatingCampaign] = useState(false)

  // Add affiliate
  const [showAddAffiliate, setShowAddAffiliate] = useState(false)
  const [aName, setAName] = useState('')
  const [aEmail, setAEmail] = useState('')
  const [aPhone, setAPhone] = useState('')
  const [aCampaignId, setACampaignId] = useState('')
  const [creatingAffiliate, setCreatingAffiliate] = useState(false)

  // Payout
  const [showPayoutForm, setShowPayoutForm] = useState(false)
  const [pAffId, setPAffId] = useState('')
  const [pAmount, setPAmount] = useState('')
  const [creatingPayout, setCreatingPayout] = useState(false)
  const [generatingPayouts, setGeneratingPayouts] = useState(false)
  const [genMinAmount, setGenMinAmount] = useState('0')

  // Tier editing
  const [editingTiersId, setEditingTiersId] = useState<string | null>(null)
  const [tierDraft, setTierDraft] = useState<TierRow[]>([])
  const [savingTiers, setSavingTiers] = useState(false)

  // Detail
  const [detailAff, setDetailAff] = useState<Affiliate | null>(null)
  const [detailReferrals, setDetailReferrals] = useState<Referral[]>([])
  const [detailPayouts, setDetailPayouts] = useState<Payout[]>([])

  // ── Load data ──
  const loadAll = useCallback(async () => {
    try {
      const [campRes, affRes] = await Promise.all([
        fetch('/api/affiliates/campaigns', { credentials: 'include' }),
        fetch('/api/affiliates', { credentials: 'include' }),
      ])
      const campData = await campRes.json()
      const affData = await affRes.json()
      if (campData.ok) {
        setCampaigns(campData.data || [])
        // Products come bundled in the campaigns response
        if (campData.products) setProducts(campData.products)
      }
      if (affData.ok) setAffiliates(affData.data || [])
    } catch { /* silent */ }
    setLoading(false)
  }, [])

  const loadReferralsAndPayouts = useCallback(async (affs: Affiliate[]) => {
    const refs: Referral[] = []; const pays: Payout[] = []
    for (const aff of affs) {
      try {
        const res = await fetch(`/api/affiliates/${aff.id}`, { credentials: 'include' })
        const d = await res.json()
        if (d.ok) {
          for (const r of (d.data.referrals || [])) refs.push({ ...r, affiliate_name: aff.name })
          for (const p of (d.data.payouts || [])) pays.push({ ...p, affiliate_name: aff.name })
        }
      } catch { /* skip */ }
    }
    refs.sort((a, b) => new Date(b.referred_at).getTime() - new Date(a.referred_at).getTime())
    pays.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    setAllReferrals(refs); setAllPayouts(pays)
  }, [])

  useEffect(() => { loadAll() }, [loadAll])
  useEffect(() => { if (affiliates.length > 0) loadReferralsAndPayouts(affiliates) }, [affiliates, loadReferralsAndPayouts])

  const loadDetail = async (aff: Affiliate) => {
    setDetailAff(aff)
    try {
      const res = await fetch(`/api/affiliates/${aff.id}`, { credentials: 'include' })
      const d = await res.json()
      if (d.ok) { setDetailReferrals(d.data.referrals || []); setDetailPayouts(d.data.payouts || []) }
    } catch { /* silent */ }
  }

  // ── Actions ──
  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text); setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 2000)
  }

  const handleCreateCampaign = async () => {
    if (!cName.trim() || !cProducts.length) return
    setCreatingCampaign(true)
    try {
      const res = await fetch('/api/affiliates/campaigns', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: cName, description: cDesc, productIds: cProducts, commissionRate: parseFloat(cRate), commissionType: cRateType, customerDiscount: parseFloat(cDiscount), customerDiscountType: cDiscountType, cookieDays: parseInt(cCookieDays), autoApprove: cAutoApprove, termsText: cTerms || undefined }),
      })
      const data = await res.json()
      if (data.ok) {
        setCName(''); setCDesc(''); setCProducts([]); setCRate('10'); setCDiscount('0'); setCTerms('')
        setShowCreateCampaign(false); loadAll()
      } else alert(data.error || 'Failed')
    } catch { alert('Failed to create campaign') }
    setCreatingCampaign(false)
  }

  const handleAddAffiliate = async () => {
    if (!aName.trim() || !aEmail.trim()) return
    setCreatingAffiliate(true)
    try {
      const res = await fetch('/api/affiliates', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: aName, email: aEmail, phone: aPhone || undefined, campaignId: aCampaignId || undefined }),
      })
      const data = await res.json()
      if (data.ok) {
        setAName(''); setAEmail(''); setAPhone(''); setACampaignId(''); setShowAddAffiliate(false); loadAll()
      } else alert(data.error || 'Failed')
    } catch { alert('Failed to add affiliate') }
    setCreatingAffiliate(false)
  }

  const handleApprove = async (id: string) => {
    await fetch(`/api/affiliates?id=${id}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'active' }) })
    loadAll()
  }

  const handleDeactivate = async (id: string) => {
    if (!confirm('Deactivate this affiliate? They will stop earning commissions.')) return
    await fetch(`/api/affiliates?id=${id}`, { method: 'DELETE', credentials: 'include' })
    loadAll(); if (detailAff?.id === id) setDetailAff(null)
  }

  const handleArchive = async (id: string) => {
    if (!confirm('Archive this affiliate? They will be hidden from the active list.')) return
    await fetch(`/api/affiliates?id=${id}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'archived' }) })
    loadAll(); if (detailAff?.id === id) setDetailAff(null)
  }

  const handleCreatePayout = async () => {
    if (!pAffId || !pAmount) return
    setCreatingPayout(true)
    try {
      const res = await fetch(`/api/affiliates/${pAffId}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: parseFloat(pAmount) }) })
      const data = await res.json()
      if (data.ok) { setPAmount(''); setPAffId(''); setShowPayoutForm(false); loadAll() }
      else alert(data.error || 'Failed')
    } catch { alert('Failed') }
    setCreatingPayout(false)
  }

  const handleMarkPaid = async (payoutId: string, affiliateId: string) => {
    await fetch(`/api/affiliates/${affiliateId}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payoutId, action: 'mark_paid' }) })
    loadReferralsAndPayouts(affiliates)
  }

  const handleGeneratePayouts = async () => {
    setGeneratingPayouts(true)
    try {
      const res = await fetch('/api/affiliates/payouts/generate', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minAmount: parseFloat(genMinAmount) || 0 }),
      })
      const data = await res.json()
      if (data.ok) {
        const count = data.data?.count || 0
        alert(count > 0 ? `Created ${count} pending payout${count > 1 ? 's' : ''}.` : 'No unpaid balances found. Every affiliate is settled up.')
        loadAll(); loadReferralsAndPayouts(affiliates)
      } else alert(data.error || 'Failed')
    } catch { alert('Failed to generate payouts') }
    setGeneratingPayouts(false)
  }

  const handleReverseReferral = async (r: Referral) => {
    if (!confirm('Reverse this conversion? The commission will be removed from the affiliate\'s totals.')) return
    try {
      const res = await fetch(`/api/affiliates/${r.affiliate_id}`, {
        method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referralId: r.id, action: 'reverse' }),
      })
      const data = await res.json()
      if (data.ok) { loadAll(); loadReferralsAndPayouts(affiliates) }
      else alert(data.error || 'Failed')
    } catch { alert('Failed to reverse referral') }
  }

  const openTierEditor = (c: Campaign) => {
    setEditingTiersId(c.id)
    setTierDraft(parseTierList(c.tiers))
  }

  const handleSaveTiers = async () => {
    if (!editingTiersId) return
    setSavingTiers(true)
    try {
      const cleaned = tierDraft
        .filter(t => Number(t.commissionRate) > 0 && Number(t.minConversions) >= 0)
        .map(t => ({ name: t.name.trim() || `Tier ${t.minConversions}+`, minConversions: Math.floor(Number(t.minConversions)), commissionRate: Number(t.commissionRate) }))
      const res = await fetch(`/api/affiliates/campaigns?id=${editingTiersId}`, {
        method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tiers: cleaned }),
      })
      const data = await res.json()
      if (data.ok) { setEditingTiersId(null); setTierDraft([]); loadAll() }
      else alert(data.error || 'Failed')
    } catch { alert('Failed to save tiers') }
    setSavingTiers(false)
  }

  const refLink = (code: string) => `${window.location.origin}/api/affiliates/ref/${code}`
  const dashLink = (code: string) => `${window.location.origin}/api/affiliates/dashboard/${code}`
  const signupLink = (campaignId: string) => `${window.location.origin}/api/affiliates/signup?campaign=${campaignId}`

  // ── Computed ──
  const totalRevenue = affiliates.reduce((s, a) => s + Number(a.total_earned), 0)
  const totalReferrals = affiliates.reduce((s, a) => s + a.total_referrals, 0)
  const totalConversions = affiliates.reduce((s, a) => s + a.total_conversions, 0)
  const pendingPayouts = allPayouts.filter(p => p.status === 'pending').reduce((s, p) => s + Number(p.amount), 0)
  const pendingApprovals = affiliates.filter(a => a.status === 'pending').length

  const filteredAffiliates = affiliates.filter(a => {
    if (statusFilter && a.status !== statusFilter) return false
    if (!statusFilter && a.status === 'archived') return false // hide archived by default
    if (!search) return true
    const q = search.toLowerCase()
    return a.name.toLowerCase().includes(q) || a.email.toLowerCase().includes(q) || a.affiliate_code.toLowerCase().includes(q)
  })

  if (loading) return <div className="flex items-center justify-center py-24"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>

  const tabs: { id: Tab; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: 'campaigns', label: 'Campaigns', icon: <Megaphone className="size-3.5" /> },
    { id: 'affiliates', label: 'Affiliates', icon: <Users className="size-3.5" />, badge: pendingApprovals || undefined },
    { id: 'tracking', label: 'Tracking', icon: <MousePointerClick className="size-3.5" /> },
    { id: 'payouts', label: 'Payouts', icon: <Wallet className="size-3.5" /> },
  ]

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold">Affiliates</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-6">Create campaigns, enroll affiliates, and track referral sales.</p>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
        {[
          { label: 'Affiliates', value: String(affiliates.length), icon: <Users className="size-4" />, color: 'violet' as const },
          { label: 'Active', value: String(affiliates.filter(a => a.status === 'active').length), icon: <CheckCircle className="size-4" />, color: 'green' as const },
          { label: 'Referrals', value: String(totalReferrals), icon: <MousePointerClick className="size-4" />, color: 'blue' as const },
          { label: 'Earnings', value: fmt(totalRevenue), icon: <Wallet className="size-4" />, color: 'amber' as const },
          { label: 'Pending Pay', value: fmt(pendingPayouts), icon: <Clock className="size-4" />, color: 'amber' as const },
        ].map(m => {
          const c = STAT_COLORS[m.color]
          return (
            <div key={m.label} className="bg-card rounded-xl border px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{m.label}</span>
                <span className={`size-7 rounded-lg flex items-center justify-center ${c.tile}`}>
                  <span className={c.icon}>{m.icon}</span>
                </span>
              </div>
              <p className="text-xl font-bold">{m.value}</p>
            </div>
          )
        })}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b mb-6">
        {tabs.map(t => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${tab === t.id ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {t.icon} {t.label}
            {t.badge ? <span className="ml-1 bg-[rgba(217,119,6,.10)] text-[#b45309] dark:text-[#fbbf24] border border-[rgba(217,119,6,.26)] dark:border-[rgba(245,158,11,.30)] text-[10px] font-bold px-1.5 py-0.5 rounded-full">{t.badge}</span> : null}
          </button>
        ))}
      </div>

      {/* ═══ CAMPAIGNS TAB ═══ */}
      {tab === 'campaigns' && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-muted-foreground">Each campaign links products to a commission structure and optional customer discount.</p>
            <Button type="button" size="sm" onClick={() => setShowCreateCampaign(true)}>
              <Plus className="size-4 mr-1.5" /> New Campaign
            </Button>
          </div>

          {campaigns.length === 0 ? (
            <div className="rounded-xl border-muted-foreground/20 p-12 text-center">
              <Megaphone className="size-10 mx-auto text-muted-foreground/20 mb-4" />
              <h2 className="text-lg font-semibold mb-2">Create your first campaign</h2>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto mb-6">
                A campaign ties your products to a commission structure. Affiliates join a campaign and promote the products in it.
              </p>
              <Button type="button" onClick={() => setShowCreateCampaign(true)}>
                <Plus className="size-4 mr-2" /> Create Campaign
              </Button>
            </div>
          ) : (
            <div className="grid gap-4">
              {campaigns.filter(c => c.status !== 'archived').map(c => {
                const productNames = c.products_info?.map(p => p.name).join(', ') || 'No products'
                return (
                  <div key={c.id} className="bg-card rounded-xl border p-5 hover:border-accent/40 transition-colors">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-semibold">{c.name}</h3>
                          <Badge variant={c.status === 'active' ? 'green' : 'secondary'}>
                            {c.status}
                          </Badge>
                        </div>
                        {c.description && <p className="text-xs text-muted-foreground">{c.description}</p>}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {c.signup_page_enabled && (
                          <IconButton variant="ghost" size="sm" type="button" aria-label="Copy signup link" onClick={() => copy(signupLink(c.id), `signup-${c.id}`)}>
                            {copiedKey === `signup-${c.id}` ? <Check className="size-4 text-emerald-500" /> : <Link className="size-4" />}
                          </IconButton>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground mb-4">
                      <span className="flex items-center gap-1"><Package className="size-3" /> {productNames}</span>
                      <span className="flex items-center gap-1"><Percent className="size-3" /> {fmtRate(c.commission_rate, c.commission_type)} commission</span>
                      {parseTierList(c.tiers).length > 0 && (
                        <span className="flex items-center gap-1"><BarChart3 className="size-3" /> {parseTierList(c.tiers).map(t => `${t.commissionRate}% at ${t.minConversions}+`).join(', ')}</span>
                      )}
                      {Number(c.customer_discount) > 0 && <span className="flex items-center gap-1"><Sparkles className="size-3" /> {fmtRate(c.customer_discount, c.customer_discount_type)} customer discount</span>}
                      <span className="flex items-center gap-1"><Users className="size-3" /> {c.affiliate_count} affiliates</span>
                      <span className="flex items-center gap-1"><Clock className="size-3" /> {c.cookie_duration_days}d cookie</span>
                    </div>

                    {/* Tier editor */}
                    {editingTiersId === c.id && (
                      <div className="rounded-lg border bg-muted/30 p-4 mb-4">
                        <div className="flex items-center justify-between mb-3">
                          <div>
                            <p className="text-xs font-semibold">Commission Tiers</p>
                            <p className="text-[10px] text-muted-foreground">Affiliates earn the rate of the highest tier they have reached. Tier rates are a percent of each sale.</p>
                          </div>
                        </div>
                        <div className="space-y-2 mb-3">
                          {tierDraft.map((t, i) => (
                            <div key={i} className="flex items-center gap-2">
                              <Input value={t.name} onChange={e => setTierDraft(prev => prev.map((row, j) => j === i ? { ...row, name: e.target.value } : row))}
                                placeholder="Tier name (e.g. Silver)" className="h-8 text-xs flex-1" />
                              <div className="flex items-center gap-1">
                                <span className="text-[10px] text-muted-foreground whitespace-nowrap">min conv.</span>
                                <Input type="number" min="0" value={String(t.minConversions)} onChange={e => setTierDraft(prev => prev.map((row, j) => j === i ? { ...row, minConversions: parseInt(e.target.value) || 0 } : row))}
                                  className="h-8 text-xs w-20" />
                              </div>
                              <div className="flex items-center gap-1">
                                <Input type="number" min="0" step="0.5" value={String(t.commissionRate)} onChange={e => setTierDraft(prev => prev.map((row, j) => j === i ? { ...row, commissionRate: parseFloat(e.target.value) || 0 } : row))}
                                  className="h-8 text-xs w-20" />
                                <span className="text-[10px] text-muted-foreground">%</span>
                              </div>
                              <IconButton variant="ghost" size="xs" type="button" aria-label="Remove tier" onClick={() => setTierDraft(prev => prev.filter((_, j) => j !== i))}>
                                <X className="size-3.5" />
                              </IconButton>
                            </div>
                          ))}
                          {tierDraft.length === 0 && <p className="text-xs text-muted-foreground py-2">No tiers yet. Without tiers, every affiliate earns the campaign or personal rate.</p>}
                        </div>
                        <div className="flex items-center gap-2">
                          <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => setTierDraft(prev => [...prev, { name: '', minConversions: prev.length ? (prev[prev.length - 1].minConversions + 5) : 0, commissionRate: Number(c.commission_rate) || 10 }])}>
                            <Plus className="size-3 mr-1" /> Add Tier
                          </Button>
                          <div className="ml-auto flex items-center gap-2">
                            <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setEditingTiersId(null); setTierDraft([]) }}>Cancel</Button>
                            <Button type="button" size="sm" className="h-7 text-xs" onClick={handleSaveTiers} disabled={savingTiers}>
                              {savingTiers ? <Loader2 className="size-3 mr-1 animate-spin" /> : <Check className="size-3 mr-1" />} Save Tiers
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="flex items-center gap-2 pt-3 border-t">
                      <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setACampaignId(c.id); setShowAddAffiliate(true); setTab('affiliates') }}>
                        <UserPlus className="size-3 mr-1" /> Add Affiliate
                      </Button>
                      <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => editingTiersId === c.id ? setEditingTiersId(null) : openTierEditor(c)}>
                        <BarChart3 className="size-3 mr-1" /> {parseTierList(c.tiers).length > 0 ? 'Edit Tiers' : 'Add Tiers'}
                      </Button>
                      {c.signup_page_enabled && (
                        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => copy(signupLink(c.id), `signup2-${c.id}`)}>
                          <Send className="size-3 mr-1" /> {copiedKey === `signup2-${c.id}` ? 'Copied!' : 'Copy Signup Link'}
                        </Button>
                      )}
                      {c.signup_page_enabled && (
                        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => window.open(signupLink(c.id), '_blank')}>
                          <Globe className="size-3 mr-1" /> Preview Page
                        </Button>
                      )}
                      <Button type="button" variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground ml-auto" onClick={async () => {
                        if (!confirm('Archive this campaign?')) return
                        await fetch(`/api/affiliates/campaigns?id=${c.id}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'archived' }) })
                        loadAll()
                      }}>
                        <Archive className="size-3 mr-1" /> Archive
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Archived campaigns */}
          {campaigns.filter(c => c.status === 'archived').length > 0 && (
            <details className="mt-6">
              <summary className="text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground transition-colors py-2">
                Archived campaigns ({campaigns.filter(c => c.status === 'archived').length})
              </summary>
              <div className="grid gap-3 mt-3">
                {campaigns.filter(c => c.status === 'archived').map(c => (
                  <div key={c.id} className="bg-muted/30 rounded-lg border border p-4 opacity-60">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="font-medium text-sm">{c.name}</h3>
                        <p className="text-xs text-muted-foreground">{c.products_info?.map((p: any) => p.name).join(', ') || 'No products'} · {c.affiliate_count} affiliates</p>
                      </div>
                      <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={async () => {
                        await fetch(`/api/affiliates/campaigns?id=${c.id}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'active' }) })
                        loadAll()
                      }}>
                        Restore
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* ═══ AFFILIATES TAB ═══ */}
      {tab === 'affiliates' && (
        <div>
          <div className="flex items-center gap-3 mb-4">
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..." className="pl-9 h-9 text-sm" />
            </div>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="pending">Pending</option>
              <option value="inactive">Paused</option>
            </select>
            <Button type="button" size="sm" onClick={() => setShowAddAffiliate(true)}>
              <UserPlus className="size-4 mr-1.5" /> Add Affiliate
            </Button>
          </div>

          {/* Pending approvals banner */}
          {pendingApprovals > 0 && (
            <div className="bg-[rgba(217,119,6,.10)] border border-[rgba(217,119,6,.26)] dark:border-[rgba(245,158,11,.30)] rounded-lg px-4 py-3 mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Clock className="size-4 text-[#b45309] dark:text-[#fbbf24]" />
                <span className="text-sm font-medium text-[#b45309] dark:text-[#fbbf24]">{pendingApprovals} affiliate{pendingApprovals > 1 ? 's' : ''} awaiting approval</span>
              </div>
            </div>
          )}

          {filteredAffiliates.length === 0 ? (
            <div className="rounded-lg border p-12 text-center text-sm text-muted-foreground">No affiliates found.</div>
          ) : (
            <div className="bg-card rounded-lg border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Affiliate</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Campaign</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Code</th>
                    <th className="text-right px-4 py-3 font-medium text-muted-foreground">Referrals</th>
                    <th className="text-right px-4 py-3 font-medium text-muted-foreground">Conv.</th>
                    <th className="text-right px-4 py-3 font-medium text-muted-foreground">Earned</th>
                    <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
                    <th className="text-right px-4 py-3 font-medium text-muted-foreground w-32">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAffiliates.map(aff => (
                    <tr key={aff.id} className="border-b last:border-0 hover:bg-muted/30 cursor-pointer transition-colors" onClick={() => loadDetail(aff)}>
                      <td className="px-4 py-3">
                        <p className="font-medium">{aff.name}</p>
                        <p className="text-xs text-muted-foreground">{aff.email}</p>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {aff.campaign_name || '-'}
                        {(() => {
                          const tier = currentTier(aff, campaigns)
                          return tier ? (
                            <span className="block mt-0.5">
                              <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${COUNT_BADGE.violet}`}>
                                {tier.name || `Tier ${tier.minConversions}+`} · {tier.commissionRate}%
                              </span>
                            </span>
                          ) : null
                        })()}
                      </td>
                      <td className="px-4 py-3">
                        <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{aff.stripe_promo_code || aff.affiliate_code}</code>
                      </td>
                      <td className="px-4 py-3 text-right"><CountBadge value={aff.total_referrals} color="blue" /></td>
                      <td className="px-4 py-3 text-right"><CountBadge value={aff.total_conversions} color="green" /></td>
                      <td className="px-4 py-3 text-right font-medium text-[#047857] dark:text-[#34d399]">{fmt(aff.total_earned)}</td>
                      <td className="px-4 py-3 text-center">
                        <Badge variant={affiliateStatusVariant(aff.status)}>
                          {aff.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          {aff.status === 'pending' && (
                            <Button type="button" variant="default" size="sm" className="h-7 text-xs" onClick={() => handleApprove(aff.id)}>
                              <CheckCircle className="size-3 mr-1" /> Approve
                            </Button>
                          )}
                          {aff.status === 'active' && (
                            <>
                              <IconButton variant="ghost" size="xs" type="button" title="Copy referral link" aria-label="Copy referral link" onClick={() => copy(refLink(aff.affiliate_code), `ref-${aff.id}`)}>
                                {copiedKey === `ref-${aff.id}` ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
                              </IconButton>
                              <IconButton variant="ghost" size="xs" type="button" title="Open affiliate dashboard" aria-label="Open dashboard" onClick={() => window.open(dashLink(aff.affiliate_code), '_blank')}>
                                <ExternalLink className="size-3.5" />
                              </IconButton>
                            </>
                          )}
                          {aff.status === 'active' && (
                            <IconButton variant="ghost" size="xs" type="button" title="Pause affiliate" aria-label="Pause" onClick={() => handleDeactivate(aff.id)}>
                              <Pause className="size-3.5 text-muted-foreground" />
                            </IconButton>
                          )}
                          {aff.status === 'inactive' && (
                            <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => handleApprove(aff.id)}>
                              <Play className="size-3 mr-1" /> Resume
                            </Button>
                          )}
                          {(aff.status === 'active' || aff.status === 'inactive') && (
                            <IconButton variant="ghost" size="xs" type="button" title="Archive affiliate" aria-label="Archive" onClick={() => handleArchive(aff.id)}>
                              <Archive className="size-3.5 text-muted-foreground" />
                            </IconButton>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Archived affiliates */}
          {affiliates.filter(a => a.status === 'archived').length > 0 && (
            <details className="mt-6">
              <summary className="text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground transition-colors py-2">
                Archived affiliates ({affiliates.filter(a => a.status === 'archived').length})
              </summary>
              <div className="space-y-2 mt-3">
                {affiliates.filter(a => a.status === 'archived').map(aff => (
                  <div key={aff.id} className="flex items-center justify-between bg-muted/30 rounded-lg border border px-4 py-3 opacity-60">
                    <div>
                      <p className="text-sm font-medium">{aff.name}</p>
                      <p className="text-xs text-muted-foreground">{aff.email} · {aff.total_conversions} conversions · {fmt(aff.total_earned)} earned</p>
                    </div>
                    <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => handleApprove(aff.id)}>
                      Restore
                    </Button>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* ═══ TRACKING TAB ═══ */}
      {tab === 'tracking' && (
        <div>
          {allReferrals.length === 0 ? (
            <div className="rounded-lg border p-12 text-center text-sm text-muted-foreground">
              <MousePointerClick className="size-8 mx-auto text-muted-foreground/30 mb-3" />
              No referrals yet. Referrals appear when someone clicks an affiliate link or uses a promo code at checkout.
            </div>
          ) : (
            <div className="bg-card rounded-lg border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Customer</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Affiliate</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Source</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Date</th>
                    <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
                    <th className="text-right px-4 py-3 font-medium text-muted-foreground">Sale</th>
                    <th className="text-right px-4 py-3 font-medium text-muted-foreground">Commission</th>
                    <th className="text-right px-4 py-3 font-medium text-muted-foreground w-24"></th>
                  </tr>
                </thead>
                <tbody>
                  {allReferrals.map(r => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="px-4 py-3">{r.referred_email || <span className="text-muted-foreground">Anonymous</span>}</td>
                      <td className="px-4 py-3 text-muted-foreground">{r.affiliate_name}</td>
                      <td className="px-4 py-3"><Badge variant="secondary" className="text-[10px]">{r.referral_source || 'link'}</Badge></td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">{fmtDateTime(r.referred_at)}</td>
                      <td className="px-4 py-3 text-center">
                        <Badge variant={r.converted ? 'green' : 'secondary'}>
                          {r.converted ? 'Converted' : 'Pending'}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right">{r.conversion_value ? fmt(r.conversion_value) : '-'}</td>
                      <td className="px-4 py-3 text-right font-medium">{r.commission_amount ? fmt(r.commission_amount) : '-'}</td>
                      <td className="px-4 py-3 text-right">
                        {r.converted && (
                          <Button type="button" variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" title="Un-convert this referral and remove the commission, e.g. after a refund" onClick={() => handleReverseReferral(r)}>
                            <ArrowRightLeft className="size-3 mr-1" /> Reverse
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ═══ PAYOUTS TAB ═══ */}
      {tab === 'payouts' && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-4">
              <div className="bg-card rounded-lg border px-4 py-2">
                <span className="text-[10px] text-muted-foreground uppercase">Pending</span>
                <p className="text-lg font-bold text-[#b45309] dark:text-[#fbbf24]">{fmt(pendingPayouts)}</p>
              </div>
              <div className="bg-card rounded-lg border px-4 py-2">
                <span className="text-[10px] text-muted-foreground uppercase">Total Paid</span>
                <p className="text-lg font-bold text-[#047857] dark:text-[#34d399]">{fmt(allPayouts.filter(p => p.status === 'paid').reduce((s, p) => s + Number(p.amount), 0))}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground uppercase whitespace-nowrap">Min $</span>
                <Input value={genMinAmount} onChange={e => setGenMinAmount(e.target.value)} type="number" step="0.01" min="0" className="h-8 w-20 text-xs" title="Skip affiliates whose unpaid balance is below this amount" />
              </div>
              <Button type="button" variant="outline" size="sm" onClick={handleGeneratePayouts} disabled={generatingPayouts} title="Create a pending payout for every affiliate with an unpaid earned balance">
                {generatingPayouts ? <Loader2 className="size-4 mr-1.5 animate-spin" /> : <Sparkles className="size-4 mr-1.5" />} Generate Payouts
              </Button>
              <Button type="button" size="sm" onClick={() => setShowPayoutForm(true)}>
                <DollarSign className="size-4 mr-1.5" /> Create Payout
              </Button>
            </div>
          </div>

          {allPayouts.length === 0 ? (
            <div className="rounded-lg border p-12 text-center text-sm text-muted-foreground">
              <Wallet className="size-8 mx-auto text-muted-foreground/30 mb-3" />
              No payouts yet.
            </div>
          ) : (
            <div className="bg-card rounded-lg border overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b bg-muted/30">
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Affiliate</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Amount</th>
                  <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Created</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground w-28">Actions</th>
                </tr></thead>
                <tbody>
                  {allPayouts.map(p => (
                    <tr key={p.id} className="border-b last:border-0">
                      <td className="px-4 py-3 font-medium">{p.affiliate_name}</td>
                      <td className="px-4 py-3 text-right font-semibold">{fmt(p.amount)}</td>
                      <td className="px-4 py-3 text-center">
                        <Badge variant={payoutStatusVariant(p.status)}>{p.status}</Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">{fmtDate(p.created_at)}</td>
                      <td className="px-4 py-3 text-right">
                        {p.status === 'pending' && (
                          <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => handleMarkPaid(p.id, p.affiliate_id)}>
                            <CheckCircle className="size-3 mr-1" /> Mark Paid
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ═══ DETAIL SLIDE-OVER ═══ */}
      {detailAff && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => setDetailAff(null)} />
          <div className="fixed right-0 top-0 bottom-0 w-full max-w-lg bg-background border-l shadow-xl z-50 overflow-y-auto">
            <div className="sticky top-0 bg-background/95 backdrop-blur border-b px-6 py-4 flex items-center justify-between z-10">
              <div>
                <h2 className="font-semibold">{detailAff.name}</h2>
                <p className="text-xs text-muted-foreground">{detailAff.email} · {detailAff.campaign_name || 'No campaign'}</p>
              </div>
              <IconButton variant="ghost" size="sm" type="button" aria-label="Close" onClick={() => setDetailAff(null)}><X className="size-4" /></IconButton>
            </div>
            <div className="px-6 py-5">
              {/* Stats */}
              <div className="grid grid-cols-2 gap-3 mb-5">
                {[
                  { label: 'Referral Code', value: detailAff.stripe_promo_code || detailAff.affiliate_code, mono: true },
                  (() => {
                    const tier = currentTier(detailAff, campaigns)
                    return tier
                      ? { label: 'Current Tier', value: `${tier.name || `Tier ${tier.minConversions}+`} · ${tier.commissionRate}%` }
                      : { label: 'Commission', value: fmtRate(detailAff.commission_rate, detailAff.commission_type) }
                  })(),
                  { label: 'Referrals / Conv.', value: `${detailAff.total_referrals} / ${detailAff.total_conversions}` },
                  { label: 'Total Earned', value: fmt(detailAff.total_earned), green: true },
                ].map(s => (
                  <div key={s.label} className="bg-muted/50 rounded-lg p-3">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{s.label}</p>
                    <p className={`text-sm font-bold mt-1 ${s.mono ? 'font-mono' : ''} ${s.green ? 'text-[#047857] dark:text-[#34d399]' : ''}`}>{s.value}</p>
                  </div>
                ))}
              </div>

              {/* Links */}
              <div className="space-y-2 mb-5">
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1 block">Referral Link</label>
                  <div className="flex items-center gap-2">
                    <Input readOnly value={refLink(detailAff.affiliate_code)} className="h-8 text-xs font-mono flex-1" />
                    <Button type="button" variant="outline" size="sm" className="h-8 shrink-0" onClick={() => copy(refLink(detailAff.affiliate_code), 'det-ref')}>
                      {copiedKey === 'det-ref' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    </Button>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => window.open(dashLink(detailAff.affiliate_code), '_blank')}>
                    <ExternalLink className="size-3 mr-1" /> Affiliate Dashboard
                  </Button>
                  <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => copy(dashLink(detailAff.affiliate_code), 'det-dash')}>
                    <Copy className="size-3 mr-1" /> {copiedKey === 'det-dash' ? 'Copied!' : 'Copy Dashboard Link'}
                  </Button>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 mb-5 pb-5 border-b">
                {detailAff.status === 'pending' && (
                  <Button type="button" size="sm" onClick={() => { handleApprove(detailAff.id); setDetailAff(null) }}>
                    <CheckCircle className="size-3.5 mr-1.5" /> Approve
                  </Button>
                )}
                {detailAff.status === 'active' && (
                  <Button type="button" variant="outline" size="sm" onClick={() => handleDeactivate(detailAff.id)}>
                    <Pause className="size-3.5 mr-1.5" /> Pause
                  </Button>
                )}
                {detailAff.status === 'inactive' && (
                  <Button type="button" variant="outline" size="sm" onClick={() => { handleApprove(detailAff.id); setDetailAff(null) }}>
                    <CheckCircle className="size-3.5 mr-1.5" /> Reactivate
                  </Button>
                )}
                {(detailAff.status === 'active' || detailAff.status === 'inactive') && (
                  <Button type="button" variant="outline" size="sm" className="text-muted-foreground" onClick={() => handleArchive(detailAff.id)}>
                    <Archive className="size-3.5 mr-1.5" /> Archive
                  </Button>
                )}
              </div>

              {/* Referrals */}
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Referrals ({detailReferrals.length})</h3>
              {detailReferrals.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No referrals yet</p>
              ) : (
                <div className="space-y-2 mb-6">
                  {detailReferrals.slice(0, 20).map(r => (
                    <div key={r.id} className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
                      <div className={`size-2 rounded-full shrink-0 ${r.converted ? 'bg-[#047857] dark:bg-[#34d399]' : 'bg-muted-foreground/30'}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">{r.referred_email || 'Anonymous'}</p>
                        <p className="text-[10px] text-muted-foreground">{fmtDateTime(r.referred_at)}</p>
                      </div>
                      {r.converted && <p className="text-xs font-medium text-[#047857] dark:text-[#34d399]">{fmt(r.commission_amount)}</p>}
                    </div>
                  ))}
                </div>
              )}

              {/* Payouts */}
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Payouts ({detailPayouts.length})</h3>
              {detailPayouts.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No payouts yet</p>
              ) : (
                <div className="space-y-2">
                  {detailPayouts.map(p => (
                    <div key={p.id} className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
                      <div className="flex-1"><p className="text-xs font-medium">{fmt(p.amount)}</p><p className="text-[10px] text-muted-foreground">{fmtDate(p.created_at)}</p></div>
                      <Badge variant={payoutStatusVariant(p.status)}>{p.status}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* ═══ CREATE CAMPAIGN MODAL ═══ */}
      {showCreateCampaign && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => setShowCreateCampaign(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-background rounded-xl border shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto p-6">
              <div className="flex items-center justify-between mb-5">
                <h3 className="font-semibold text-lg">Create Campaign</h3>
                <IconButton variant="ghost" size="sm" type="button" aria-label="Close" onClick={() => setShowCreateCampaign(false)}><X className="size-4" /></IconButton>
              </div>
              <div className="space-y-5">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Campaign Name *</label>
                  <Input value={cName} onChange={e => setCName(e.target.value)} placeholder="e.g. Summer Referral Program" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Description</label>
                  <Input value={cDesc} onChange={e => setCDesc(e.target.value)} placeholder="Brief description for affiliates" />
                </div>

                {/* Product selection */}
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Products *</label>
                  {products.length === 0 ? (
                    <p className="text-xs text-muted-foreground bg-muted/50 rounded-lg p-3">No products found. Create products in the Payments section first.</p>
                  ) : (
                    <div className="space-y-1.5 max-h-40 overflow-y-auto border rounded-lg p-2">
                      {products.map(p => (
                        <label key={p.id} className="flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-muted/50 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={cProducts.includes(p.id)}
                            onChange={e => setCProducts(prev => e.target.checked ? [...prev, p.id] : prev.filter(x => x !== p.id))}
                            className="rounded border-border"
                          />
                          <span className="text-sm flex-1">{p.name}</span>
                          <span className="text-xs text-muted-foreground">{fmt(p.price)}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>

                {/* Commission */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Affiliate Commission</label>
                    <div className="relative">
                      <Input value={cRate} onChange={e => setCRate(e.target.value)} type="number" step="0.01" className="pr-8" />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{cRateType === 'percentage' ? '%' : '$'}</span>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Type</label>
                    <select value={cRateType} onChange={e => setCRateType(e.target.value)} className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm">
                      <option value="percentage">Percentage</option>
                      <option value="flat">Flat Rate</option>
                    </select>
                  </div>
                </div>

                {/* Customer discount */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Customer Discount</label>
                    <div className="relative">
                      <Input value={cDiscount} onChange={e => setCDiscount(e.target.value)} type="number" step="0.01" className="pr-8" />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{cDiscountType === 'percentage' ? '%' : '$'}</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1">0 = no discount. Creates a Stripe coupon.</p>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Discount Type</label>
                    <select value={cDiscountType} onChange={e => setCDiscountType(e.target.value)} className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm">
                      <option value="percentage">Percentage</option>
                      <option value="flat">Fixed Amount</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Cookie Duration (days)</label>
                  <Input value={cCookieDays} onChange={e => setCCookieDays(e.target.value)} type="number" className="w-24" />
                  <p className="text-[10px] text-muted-foreground mt-1">How long after clicking a referral link the affiliate still earns credit for a sale. Standard is 30 days.</p>
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Terms & Conditions (optional)</label>
                  <Textarea
                    value={cTerms}
                    onChange={e => setCTerms(e.target.value)}
                    placeholder="Enter the terms affiliates must agree to before joining. E.g. commission payout schedule, prohibited promotion methods, brand guidelines, termination policy..."
                    className="text-sm"
                    rows={4}
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">Affiliates will be required to accept these terms before signing up.</p>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-xs font-medium">Auto-approve affiliates</Label>
                    <p className="text-[10px] text-muted-foreground">Skip manual review for new signups</p>
                  </div>
                  <Switch checked={cAutoApprove} onCheckedChange={setCAutoApprove} />
                </div>

                <Button type="button" onClick={handleCreateCampaign} disabled={creatingCampaign || !cName.trim() || !cProducts.length} className="w-full">
                  {creatingCampaign ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Megaphone className="size-4 mr-2" />}
                  {creatingCampaign ? 'Creating...' : 'Create Campaign'}
                </Button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ═══ ADD AFFILIATE MODAL ═══ */}
      {showAddAffiliate && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => setShowAddAffiliate(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-background rounded-xl border shadow-xl w-full max-w-md p-6">
              <div className="flex items-center justify-between mb-5">
                <h3 className="font-semibold text-lg">Add Affiliate</h3>
                <IconButton variant="ghost" size="sm" type="button" aria-label="Close" onClick={() => setShowAddAffiliate(false)}><X className="size-4" /></IconButton>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Campaign</label>
                  <select value={aCampaignId} onChange={e => setACampaignId(e.target.value)} className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm">
                    <option value="">No campaign</option>
                    {campaigns.filter(c => c.status === 'active').map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Name *</label>
                  <Input value={aName} onChange={e => setAName(e.target.value)} placeholder="Jane Smith" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Email *</label>
                  <Input value={aEmail} onChange={e => setAEmail(e.target.value)} placeholder="jane@example.com" type="email" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Phone</label>
                  <Input value={aPhone} onChange={e => setAPhone(e.target.value)} placeholder="+1 (555) 000-0000" type="tel" />
                </div>
                <Button type="button" onClick={handleAddAffiliate} disabled={creatingAffiliate || !aName.trim() || !aEmail.trim()} className="w-full">
                  {creatingAffiliate ? <Loader2 className="size-4 mr-2 animate-spin" /> : <UserPlus className="size-4 mr-2" />}
                  {creatingAffiliate ? 'Adding...' : 'Add Affiliate'}
                </Button>
                <p className="text-[10px] text-muted-foreground text-center">Affiliate will be auto-approved and receive a unique referral code{aCampaignId ? ' and Stripe discount code' : ''}.</p>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ═══ PAYOUT MODAL ═══ */}
      {showPayoutForm && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => setShowPayoutForm(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-background rounded-xl border shadow-xl w-full max-w-md p-6">
              <div className="flex items-center justify-between mb-5">
                <h3 className="font-semibold text-lg">Create Payout</h3>
                <IconButton variant="ghost" size="sm" type="button" aria-label="Close" onClick={() => setShowPayoutForm(false)}><X className="size-4" /></IconButton>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Affiliate *</label>
                  <select value={pAffId} onChange={e => setPAffId(e.target.value)} className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm">
                    <option value="">Select affiliate...</option>
                    {affiliates.filter(a => a.status === 'active').map(a => <option key={a.id} value={a.id}>{a.name} — earned {fmt(a.total_earned)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Amount *</label>
                  <div className="relative"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                    <Input value={pAmount} onChange={e => setPAmount(e.target.value)} type="number" step="0.01" placeholder="0.00" className="pl-7" />
                  </div>
                </div>
                <Button type="button" onClick={handleCreatePayout} disabled={creatingPayout || !pAffId || !pAmount} className="w-full">
                  {creatingPayout ? <Loader2 className="size-4 mr-2 animate-spin" /> : <DollarSign className="size-4 mr-2" />}
                  {creatingPayout ? 'Creating...' : 'Create Payout'}
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
