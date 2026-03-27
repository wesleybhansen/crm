'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Users, Plus, Copy, Check, ArrowLeft, Trophy, DollarSign, X } from 'lucide-react'

type Affiliate = {
  id: string
  name: string
  email: string
  affiliate_code: string
  commission_rate: number
  commission_type: string
  status: string
  total_referrals: number
  total_conversions: number
  total_earned: number
  contact_id: string | null
  created_at: string
}

type Referral = {
  id: string
  affiliate_id: string
  referred_contact_id: string | null
  referred_email: string | null
  referral_source: string | null
  converted: boolean
  conversion_value: number | null
  commission_amount: number | null
  referred_at: string
  converted_at: string | null
}

type Payout = {
  id: string
  affiliate_id: string
  amount: number
  period_start: string
  period_end: string
  status: string
  paid_at: string | null
  created_at: string
}

type ViewMode = 'list' | 'leaderboard' | 'create' | 'detail'

export default function AffiliatesPage() {
  const [affiliates, setAffiliates] = useState<Affiliate[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<ViewMode>('list')
  const [selectedAffiliate, setSelectedAffiliate] = useState<Affiliate | null>(null)
  const [referrals, setReferrals] = useState<Referral[]>([])
  const [payouts, setPayouts] = useState<Payout[]>([])
  const [copiedCode, setCopiedCode] = useState<string | null>(null)

  // Create form state
  const [formName, setFormName] = useState('')
  const [formEmail, setFormEmail] = useState('')
  const [formRate, setFormRate] = useState('10')
  const [formType, setFormType] = useState('percentage')
  const [creating, setCreating] = useState(false)

  // Payout form state
  const [showPayoutForm, setShowPayoutForm] = useState(false)
  const [payoutAmount, setPayoutAmount] = useState('')
  const [payoutStart, setPayoutStart] = useState('')
  const [payoutEnd, setPayoutEnd] = useState('')
  const [creatingPayout, setCreatingPayout] = useState(false)

  const loadAffiliates = useCallback(async () => {
    try {
      const res = await fetch('/api/affiliates')
      const data = await res.json()
      if (data.ok) setAffiliates(data.data)
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadAffiliates()
  }, [loadAffiliates])

  const loadDetail = async (affiliate: Affiliate) => {
    setSelectedAffiliate(affiliate)
    setView('detail')
    try {
      const res = await fetch(`/api/affiliates/${affiliate.id}`)
      const data = await res.json()
      if (data.ok) {
        setReferrals(data.data.referrals)
        setPayouts(data.data.payouts)
      }
    } catch {
      // silent
    }
  }

  const handleCreate = async () => {
    if (!formName || !formEmail) return
    setCreating(true)
    try {
      const res = await fetch('/api/affiliates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName,
          email: formEmail,
          commissionRate: parseFloat(formRate) || 10,
          commissionType: formType,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setFormName('')
        setFormEmail('')
        setFormRate('10')
        setFormType('percentage')
        setView('list')
        loadAffiliates()
      }
    } catch {
      // silent
    } finally {
      setCreating(false)
    }
  }

  const handleDeactivate = async (id: string) => {
    await fetch(`/api/affiliates?id=${id}`, { method: 'DELETE' })
    loadAffiliates()
    if (selectedAffiliate?.id === id) {
      setView('list')
      setSelectedAffiliate(null)
    }
  }

  const handleCreatePayout = async () => {
    if (!selectedAffiliate || !payoutAmount || !payoutStart || !payoutEnd) return
    setCreatingPayout(true)
    try {
      const res = await fetch(`/api/affiliates/${selectedAffiliate.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: parseFloat(payoutAmount),
          periodStart: payoutStart,
          periodEnd: payoutEnd,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setPayoutAmount('')
        setPayoutStart('')
        setPayoutEnd('')
        setShowPayoutForm(false)
        loadDetail(selectedAffiliate)
      }
    } catch {
      // silent
    } finally {
      setCreatingPayout(false)
    }
  }

  const copyReferralLink = (code: string) => {
    const link = `${window.location.origin}/api/affiliates/ref/${code}`
    navigator.clipboard.writeText(link)
    setCopiedCode(code)
    setTimeout(() => setCopiedCode(null), 2000)
  }

  const copyDashboardLink = (code: string) => {
    const link = `${window.location.origin}/api/affiliates/dashboard/${code}`
    navigator.clipboard.writeText(link)
    setCopiedCode('dash-' + code)
    setTimeout(() => setCopiedCode(null), 2000)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }

  // Create view
  if (view === 'create') {
    return (
      <div className="max-w-xl mx-auto py-8 px-4">
        <button onClick={() => setView('list')} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-6">
          <ArrowLeft className="size-4" /> Back to affiliates
        </button>
        <h1 className="text-xl font-semibold mb-6">Add New Affiliate</h1>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <Input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="Affiliate name" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <Input value={formEmail} onChange={(e) => setFormEmail(e.target.value)} placeholder="affiliate@example.com" type="email" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Commission Rate</label>
              <Input value={formRate} onChange={(e) => setFormRate(e.target.value)} placeholder="10" type="number" step="0.01" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Commission Type</label>
              <select
                value={formType}
                onChange={(e) => setFormType(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="percentage">Percentage (%)</option>
                <option value="flat">Flat ($)</option>
              </select>
            </div>
          </div>
          <Button onClick={handleCreate} disabled={creating || !formName || !formEmail} className="w-full">
            {creating ? 'Creating...' : 'Create Affiliate'}
          </Button>
        </div>
      </div>
    )
  }

  // Detail view
  if (view === 'detail' && selectedAffiliate) {
    return (
      <div className="max-w-4xl mx-auto py-8 px-4">
        <button onClick={() => { setView('list'); setSelectedAffiliate(null) }} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-6">
          <ArrowLeft className="size-4" /> Back to affiliates
        </button>

        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold">{selectedAffiliate.name}</h1>
            <p className="text-sm text-gray-500">{selectedAffiliate.email}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => copyReferralLink(selectedAffiliate.affiliate_code)}>
              {copiedCode === selectedAffiliate.affiliate_code ? <Check className="size-4 mr-1" /> : <Copy className="size-4 mr-1" />}
              {copiedCode === selectedAffiliate.affiliate_code ? 'Copied!' : 'Referral Link'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => copyDashboardLink(selectedAffiliate.affiliate_code)}>
              {copiedCode === 'dash-' + selectedAffiliate.affiliate_code ? <Check className="size-4 mr-1" /> : <Copy className="size-4 mr-1" />}
              {copiedCode === 'dash-' + selectedAffiliate.affiliate_code ? 'Copied!' : 'Dashboard Link'}
            </Button>
            {selectedAffiliate.status === 'active' && (
              <Button variant="outline" size="sm" onClick={() => handleDeactivate(selectedAffiliate.id)} className="text-red-600 hover:text-red-700">
                Deactivate
              </Button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
          <div className="bg-white rounded-lg border p-4">
            <div className="text-xs text-gray-500 uppercase tracking-wide">Code</div>
            <div className="text-lg font-mono font-semibold mt-1">{selectedAffiliate.affiliate_code}</div>
          </div>
          <div className="bg-white rounded-lg border p-4">
            <div className="text-xs text-gray-500 uppercase tracking-wide">Referrals</div>
            <div className="text-lg font-semibold mt-1">{selectedAffiliate.total_referrals}</div>
          </div>
          <div className="bg-white rounded-lg border p-4">
            <div className="text-xs text-gray-500 uppercase tracking-wide">Conversions</div>
            <div className="text-lg font-semibold mt-1">{selectedAffiliate.total_conversions}</div>
          </div>
          <div className="bg-white rounded-lg border p-4">
            <div className="text-xs text-gray-500 uppercase tracking-wide">Total Earned</div>
            <div className="text-lg font-semibold text-green-600 mt-1">${Number(selectedAffiliate.total_earned).toFixed(2)}</div>
          </div>
        </div>

        {/* Referrals */}
        <div className="bg-white rounded-lg border mb-6">
          <div className="px-4 py-3 border-b font-medium">Referrals ({referrals.length})</div>
          {referrals.length === 0 ? (
            <div className="px-4 py-8 text-center text-gray-400">No referrals yet</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-gray-50">
                    <th className="text-left px-4 py-2 font-medium text-gray-500">Email</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-500">Date</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-500">Status</th>
                    <th className="text-right px-4 py-2 font-medium text-gray-500">Value</th>
                    <th className="text-right px-4 py-2 font-medium text-gray-500">Commission</th>
                  </tr>
                </thead>
                <tbody>
                  {referrals.map((r) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="px-4 py-2">{r.referred_email || 'Anonymous'}</td>
                      <td className="px-4 py-2 text-gray-500">{new Date(r.referred_at).toLocaleDateString()}</td>
                      <td className="px-4 py-2">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${r.converted ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                          {r.converted ? 'Converted' : 'Pending'}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right">{r.conversion_value ? `$${Number(r.conversion_value).toFixed(2)}` : '-'}</td>
                      <td className="px-4 py-2 text-right">{r.commission_amount ? `$${Number(r.commission_amount).toFixed(2)}` : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Payouts */}
        <div className="bg-white rounded-lg border">
          <div className="px-4 py-3 border-b flex items-center justify-between">
            <span className="font-medium">Payouts ({payouts.length})</span>
            <Button size="sm" onClick={() => setShowPayoutForm(!showPayoutForm)}>
              {showPayoutForm ? <X className="size-4 mr-1" /> : <DollarSign className="size-4 mr-1" />}
              {showPayoutForm ? 'Cancel' : 'Create Payout'}
            </Button>
          </div>
          {showPayoutForm && (
            <div className="px-4 py-3 border-b bg-gray-50 space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Amount ($)</label>
                  <Input value={payoutAmount} onChange={(e) => setPayoutAmount(e.target.value)} type="number" step="0.01" placeholder="0.00" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Period Start</label>
                  <Input value={payoutStart} onChange={(e) => setPayoutStart(e.target.value)} type="date" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Period End</label>
                  <Input value={payoutEnd} onChange={(e) => setPayoutEnd(e.target.value)} type="date" />
                </div>
              </div>
              <Button size="sm" onClick={handleCreatePayout} disabled={creatingPayout || !payoutAmount || !payoutStart || !payoutEnd}>
                {creatingPayout ? 'Creating...' : 'Submit Payout'}
              </Button>
            </div>
          )}
          {payouts.length === 0 && !showPayoutForm ? (
            <div className="px-4 py-8 text-center text-gray-400">No payouts yet</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-gray-50">
                    <th className="text-left px-4 py-2 font-medium text-gray-500">Amount</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-500">Period</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-500">Status</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-500">Paid At</th>
                  </tr>
                </thead>
                <tbody>
                  {payouts.map((p) => (
                    <tr key={p.id} className="border-b last:border-0">
                      <td className="px-4 py-2 font-medium">${Number(p.amount).toFixed(2)}</td>
                      <td className="px-4 py-2 text-gray-500">
                        {new Date(p.period_start).toLocaleDateString()} - {new Date(p.period_end).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${p.status === 'paid' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                          {p.status.charAt(0).toUpperCase() + p.status.slice(1)}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-gray-500">{p.paid_at ? new Date(p.paid_at).toLocaleDateString() : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    )
  }

  // Leaderboard view
  if (view === 'leaderboard') {
    const sorted = [...affiliates].sort((a, b) => Number(b.total_earned) - Number(a.total_earned))
    return (
      <div className="max-w-3xl mx-auto py-8 px-4">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Trophy className="size-5 text-yellow-500" /> Affiliate Leaderboard
          </h1>
          <Button variant="outline" size="sm" onClick={() => setView('list')}>
            <ArrowLeft className="size-4 mr-1" /> List View
          </Button>
        </div>
        <div className="bg-white rounded-lg border">
          {sorted.length === 0 ? (
            <div className="px-4 py-12 text-center text-gray-400">No affiliates yet</div>
          ) : (
            <div className="divide-y">
              {sorted.map((affiliate, index) => (
                <div
                  key={affiliate.id}
                  className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 cursor-pointer"
                  onClick={() => loadDetail(affiliate)}
                >
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${index === 0 ? 'bg-yellow-100 text-yellow-700' : index === 1 ? 'bg-gray-100 text-gray-600' : index === 2 ? 'bg-orange-100 text-orange-700' : 'bg-gray-50 text-gray-400'}`}>
                    {index + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{affiliate.name}</div>
                    <div className="text-xs text-gray-500">{affiliate.total_conversions} conversions from {affiliate.total_referrals} referrals</div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold text-green-600">${Number(affiliate.total_earned).toFixed(2)}</div>
                    <div className="text-xs text-gray-400">{affiliate.commission_type === 'percentage' ? `${Number(affiliate.commission_rate).toFixed(0)}%` : `$${Number(affiliate.commission_rate).toFixed(2)} flat`}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  // List view (default)
  return (
    <div className="max-w-5xl mx-auto py-8 px-4">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Users className="size-5" /> Affiliates
        </h1>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setView('leaderboard')}>
            <Trophy className="size-4 mr-1" /> Leaderboard
          </Button>
          <Button size="sm" onClick={() => setView('create')}>
            <Plus className="size-4 mr-1" /> Add Affiliate
          </Button>
        </div>
      </div>

      {affiliates.length === 0 ? (
        <div className="bg-white rounded-lg border px-4 py-16 text-center">
          <Users className="size-10 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500 mb-4">No affiliates yet. Add your first affiliate to start tracking referrals.</p>
          <Button onClick={() => setView('create')}>
            <Plus className="size-4 mr-1" /> Add Affiliate
          </Button>
        </div>
      ) : (
        <div className="bg-white rounded-lg border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left px-4 py-3 font-medium text-gray-500">Name</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Email</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Code</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">Rate</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">Referrals</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">Conversions</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">Earned</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Status</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody>
              {affiliates.map((affiliate) => (
                <tr key={affiliate.id} className="border-b last:border-0 hover:bg-gray-50 cursor-pointer" onClick={() => loadDetail(affiliate)}>
                  <td className="px-4 py-3 font-medium">{affiliate.name}</td>
                  <td className="px-4 py-3 text-gray-500">{affiliate.email}</td>
                  <td className="px-4 py-3">
                    <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">{affiliate.affiliate_code}</code>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {affiliate.commission_type === 'percentage'
                      ? `${Number(affiliate.commission_rate).toFixed(0)}%`
                      : `$${Number(affiliate.commission_rate).toFixed(2)}`}
                  </td>
                  <td className="px-4 py-3 text-right">{affiliate.total_referrals}</td>
                  <td className="px-4 py-3 text-right">{affiliate.total_conversions}</td>
                  <td className="px-4 py-3 text-right font-medium text-green-600">${Number(affiliate.total_earned).toFixed(2)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${affiliate.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {affiliate.status.charAt(0).toUpperCase() + affiliate.status.slice(1)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="p-1 hover:bg-gray-100 rounded"
                      title="Copy referral link"
                      onClick={() => copyReferralLink(affiliate.affiliate_code)}
                    >
                      {copiedCode === affiliate.affiliate_code ? <Check className="size-4 text-green-600" /> : <Copy className="size-4 text-gray-400" />}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
