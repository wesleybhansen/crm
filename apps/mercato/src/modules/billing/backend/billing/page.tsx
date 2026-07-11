'use client'

import { useState, useEffect } from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { translateWithFallback } from '@open-mercato/shared/lib/i18n/translate'
import { Button } from '@open-mercato/ui/primitives/button'
import { CreditCard, Plus, ArrowUpRight, ArrowDownRight, TrendingDown, Receipt } from 'lucide-react'

// House palette for tinted-icon stat tiles (matches the CRM dashboard).
const STAT_COLORS = {
  violet: { icon: 'text-[#7c3aed] dark:text-[#a78bfa]', tile: 'bg-[rgba(124,58,237,0.10)] dark:bg-[rgba(139,92,246,0.16)]' },
  blue: { icon: 'text-[#1d4ed8] dark:text-[#60a5fa]', tile: 'bg-[rgba(37,99,235,0.10)] dark:bg-[rgba(59,130,246,0.15)]' },
  green: { icon: 'text-[#047857] dark:text-[#34d399]', tile: 'bg-[rgba(16,185,129,0.10)] dark:bg-[rgba(16,185,129,0.14)]' },
  amber: { icon: 'text-[#b45309] dark:text-[#fbbf24]', tile: 'bg-[rgba(217,119,6,0.10)] dark:bg-[rgba(245,158,11,0.13)]' },
} as const

// AMS-style compact sparkline with a soft colored area fill (color via currentColor).
function Sparkline({ data, className = '' }: { data: number[]; className?: string }) {
  const w = 84, h = 26, max = Math.max(...data, 1), n = Math.max(data.length - 1, 1)
  const pts = data.map((v, i) => `${(2 + (i * (w - 4)) / n).toFixed(1)},${(h - 4 - (v * (h - 8)) / max).toFixed(1)}`).join(' ')
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className={`shrink-0 ${className}`}>
      <polygon points={`${pts} ${w - 2},${h} 2,${h}`} className="fill-current opacity-[.12]" />
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Weekly buckets (oldest -> newest) derived client-side from rows already in memory.
function weeklySums(rows: Array<{ date: string; value: number }>, weeks = 8): number[] {
  const now = Date.now()
  const out = new Array(weeks).fill(0)
  for (const r of rows) {
    const t = new Date(r.date).getTime()
    if (Number.isNaN(t)) continue
    const diff = Math.floor((now - t) / (7 * 24 * 60 * 60 * 1000))
    if (diff >= 0 && diff < weeks) out[weeks - 1 - diff] += r.value
  }
  return out
}

function StatTile({ icon: Icon, label, value, color, series, note }: {
  icon: any; label: string; value: string; color: keyof typeof STAT_COLORS; series?: number[]; note?: string
}) {
  const c = STAT_COLORS[color]
  return (
    <div className="rounded-[14px] border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className={`size-9 rounded-lg flex items-center justify-center ${c.tile}`}>
          <Icon className={`size-4 ${c.icon}`} />
        </div>
        {series && series.length > 0 && <Sparkline data={series} className={`${c.icon} opacity-90`} />}
      </div>
      <p className="text-2xl font-bold tabular-nums tracking-tight">{value}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
      {note && <p className="text-[11px] text-[#b45309] dark:text-[#fbbf24] mt-0.5">{note}</p>}
    </div>
  )
}

type CreditPackage = {
  id: string
  name: string
  credit_amount: string
  price: string
}

type Transaction = {
  id: string
  amount: string
  type: string
  description: string
  service: string | null
  created_at: string
}

export default function BillingPage() {
  const t = useT()
  const translate = (key: string, fallback: string) => translateWithFallback(t, key, fallback)
  const [balance, setBalance] = useState(0)
  const [packages, setPackages] = useState<CreditPackage[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [txTotal, setTxTotal] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      fetch('/api/billing/balance').then((r) => r.json()),
      fetch('/api/billing/transactions').then((r) => r.json()),
    ]).then(([balanceData, txData]) => {
      if (balanceData.ok) {
        setBalance(balanceData.data.balance || 0)
        setPackages(balanceData.data.packages || [])
      }
      if (txData.ok) {
        setTransactions(txData.data || [])
        if (typeof txData.pagination?.total === 'number') setTxTotal(txData.pagination.total)
      }
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  if (loading) return <div className="p-6 text-muted-foreground">Loading...</div>

  // Weekly series derived from transactions already fetched. The endpoint is
  // paginated, so only show a series when ALL transactions are loaded (honest data only).
  const haveAllTx = txTotal !== null && txTotal <= transactions.length
  const usageWeekly = haveAllTx ? weeklySums(transactions
    .filter(tx => parseFloat(tx.amount) < 0)
    .map(tx => ({ date: tx.created_at, value: Math.abs(parseFloat(tx.amount)) }))) : undefined
  const usageTotal = usageWeekly
    ? usageWeekly.reduce((a, b) => a + b, 0)
    : transactions.reduce((sum, tx) => {
        const amt = parseFloat(tx.amount)
        return amt < 0 ? sum + Math.abs(amt) : sum
      }, 0)
  const txWeekly = haveAllTx ? weeklySums(transactions.map(tx => ({ date: tx.created_at, value: 1 }))) : undefined

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-xl font-semibold mb-6">{translate('billing.balance.title', 'Credit Balance')}</h1>

      {/* Balance + usage stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <StatTile icon={CreditCard} label="Current balance" value={`$${balance.toFixed(2)}`} color="green"
          note={balance < 5 ? translate('billing.balance.lowBalance', 'Low balance, add credits to keep sending') : undefined} />
        <StatTile icon={TrendingDown} label={haveAllTx ? 'Credits used, last 8 weeks' : 'Used in recent transactions'}
          value={`$${usageTotal.toFixed(2)}`} color="amber" series={usageWeekly} />
        <StatTile icon={Receipt} label="Transactions" value={String(txTotal ?? transactions.length)} color="blue" series={txWeekly} />
      </div>

      {/* Credit Packages */}
      <h2 className="font-mono text-[10px] uppercase tracking-[.09em] text-muted-foreground mb-3">
        {translate('billing.packages.title', 'Credit Packages')}
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        {packages.map((pkg) => (
          <div key={pkg.id} className="rounded-[14px] border border-border bg-card p-5 hover:border-accent/50 transition cursor-pointer">
            <p className="font-semibold text-lg text-foreground">{pkg.name}</p>
            <p className="text-2xl font-bold tabular-nums mt-2">${parseFloat(pkg.price).toFixed(2)}</p>
            <p className="text-sm text-muted-foreground mt-1">${parseFloat(pkg.credit_amount).toFixed(2)} in credits</p>
            <Button type="button" size="sm" className="mt-4 w-full">
              <Plus className="size-3 mr-1" /> Buy
            </Button>
          </div>
        ))}
      </div>

      {/* Transaction History */}
      <h2 className="font-mono text-[10px] uppercase tracking-[.09em] text-muted-foreground mb-3">
        {translate('billing.transactions.title', 'Transaction History')}
      </h2>
      {transactions.length === 0 ? (
        <div className="rounded-[14px] border border-border p-8 text-center text-muted-foreground text-sm">
          {translate('billing.transactions.empty', 'No transactions yet')}
        </div>
      ) : (
        <div className="rounded-[14px] border border-border divide-y divide-border">
          {transactions.map((tx) => {
            const isCredit = parseFloat(tx.amount) > 0
            return (
              <div key={tx.id} className="flex items-center gap-4 px-4 py-3">
                <div className={`size-8 rounded-full flex items-center justify-center ${
                  isCredit ? 'bg-[rgba(16,185,129,.10)] text-[#047857] dark:bg-[rgba(16,185,129,.14)] dark:text-[#34d399]' : 'bg-[rgba(239,68,68,.10)] text-[#b91c1c] dark:bg-[rgba(239,68,68,.13)] dark:text-[#f87171]'
                }`}>
                  {isCredit ? <ArrowUpRight className="size-4" /> : <ArrowDownRight className="size-4" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">{tx.description}</p>
                  {tx.service && <p className="text-xs text-muted-foreground">{tx.service}</p>}
                </div>
                <div className={`text-sm font-medium tabular-nums ${isCredit ? 'text-[#047857] dark:text-[#34d399]' : 'text-[#b91c1c] dark:text-[#f87171]'}`}>
                  {isCredit ? '+' : ''}{parseFloat(tx.amount).toFixed(4)}
                </div>
                <div className="text-xs text-muted-foreground whitespace-nowrap">
                  {new Date(tx.created_at).toLocaleDateString()}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
