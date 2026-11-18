import { useCallback, useEffect, useState } from 'react'
import { Activity, AlertTriangle, ArrowDown, ArrowDownLeft, ArrowUpRight, BadgeCheck, CheckCircle2, RefreshCw, ShieldCheck, Store, Trash2, Users, Wallet as WalletIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api, formatNaira, idempotencyKey } from '../api'
import { useAuth } from '../useAuth'
import { EmptyState, Loading, Notice, PageHeading, StatusBadge } from '../components'

export function CartPage() {
  const [cart, setCart] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function loadCart() {
    try {
      const { data } = await api('/cart')
      setCart(data.cart)
      setError('')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setLoading(false)
    }
  }

  // oxlint-disable-next-line react/set-state-in-effect -- This effect synchronizes the cart with the API.
  useEffect(() => { loadCart() }, [])

  if (loading) return <Loading label="Opening your bag…" />
  if (error && !cart) return <div className="content-wrap account-page">
    <PageHeading eyebrow="Your picks" title="Your bag" />
    <Notice tone="error">{error}</Notice>
    <button className="button button-outline" onClick={loadCart}>Try again</button>
  </div>

  async function update(item, quantity) {
    try {
      const { data } = await api(`/cart/items/${item.id}`, { method: 'PATCH', body: { quantity } })
      setCart(data.cart)
      setError('')
    } catch (requestError) { setError(requestError.message) }
  }

  async function remove(item) {
    try {
      const { data } = await api(`/cart/items/${item.id}`, { method: 'DELETE' })
      setCart(data.cart)
      setError('')
    } catch (requestError) { setError(requestError.message) }
  }

  return <div className="content-wrap account-page">
    <PageHeading eyebrow="Your picks" title="Your bag" description={`${cart?.itemCount || 0} items, priced at today's prices`} action={<Link to="/" className="button button-outline">Keep browsing</Link>} />
    {error && <Notice tone="error">{error}</Notice>}
    {!cart?.items?.length ? <EmptyState title="Your bag is taking a breather" action={<Link className="button button-primary" to="/">Find something lovely</Link>}>Add a few favourites and they’ll show up here.</EmptyState> : <>
      {cart.hasIssues && <Notice tone="warning">Some prices or stock levels changed since you added these items. Please review before continuing.</Notice>}
      <div className="cart-layout">
        <div className="cart-items">
          {cart.items.map((item) => <article className={`cart-item ${!item.available ? 'cart-item-unavailable' : ''}`} key={item.id}>
            <Link to={item.slug ? `/products/${item.slug}` : '/'} className="cart-image">{item.image ? <img src={item.image} alt="" /> : <span>✳</span>}</Link>
            <div className="cart-item-copy">
              <Link to={item.slug ? `/products/${item.slug}` : '/'} className="cart-item-name">{item.name || 'Unavailable item'}</Link>
              {item.attributes && <span className="muted small">{Object.values(item.attributes).join(' · ')}</span>}
              {item.issue && <span className="issue-label">{item.issue.replaceAll('_', ' ').toLowerCase()}</span>}
              {item.priceChanged && <span className="issue-label">Price updated · was {formatNaira(item.addedPriceKobo)}</span>}
              <div className="cart-line-bottom">
                <strong>{formatNaira(item.currentPriceKobo || 0)}</strong>
                <div className="quantity-stepper">
                  <button type="button" aria-label="Decrease quantity" disabled={item.quantity <= 1} onClick={() => update(item, item.quantity - 1)}>−</button>
                  <span>{item.quantity}</span>
                  <button type="button" aria-label="Increase quantity" disabled={!item.available || item.quantity >= item.availableStock} onClick={() => update(item, item.quantity + 1)}>+</button>
                </div>
                <button className="text-button remove-button" onClick={() => remove(item)}><Trash2 size={14} /> Remove</button>
              </div>
            </div>
          </article>)}
        </div>
        <aside className="order-summary">
          <span className="eyebrow">The numbers</span><h2>Bag summary</h2>
          <div className="summary-row"><span>Items</span><span>{cart.itemCount || 0}</span></div>
          <div className="summary-row"><span>Subtotal</span><strong>{formatNaira(cart.totalKobo)}</strong></div>
          <div className="summary-total"><span>Total</span><strong>{formatNaira(cart.totalKobo)}</strong></div>
          <Notice tone="info">Online checkout is not available yet. The API does not have order or escrow checkout endpoints at this stage.</Notice>
          <button type="button" className="button button-primary button-wide" disabled>Checkout coming soon</button>
          <p className="muted small summary-note">Only items currently in stock are included in the subtotal.</p>
        </aside>
      </div>
    </>}
  </div>
}

export function WalletPage() {
  const [wallet, setWallet] = useState(null)
  const [transactions, setTransactions] = useState([])
  const [cursor, setCursor] = useState(null)
  const [amount, setAmount] = useState('')
  const [payment, setPayment] = useState(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function loadWallet(nextCursor = null, append = false) {
    try {
      const [walletResponse, txResponse] = await Promise.all([
        api('/wallet'),
        api(`/wallet/transactions?limit=20${nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : ''}`),
      ])
      setWallet(walletResponse.data.wallet)
      setTransactions((current) => append ? [...current, ...txResponse.data.transactions] : txResponse.data.transactions)
      setCursor(txResponse.data.nextCursor)
      setError('')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setLoading(false)
    }
  }

  // oxlint-disable-next-line react/set-state-in-effect -- This effect synchronizes the wallet with the API.
  useEffect(() => { loadWallet() }, [])

  if (loading) return <Loading label="Checking your wallet…" />
  if (error && !wallet) return <div className="content-wrap account-page">
    <PageHeading eyebrow="Your money, your rules" title="Wallet" />
    <Notice tone="error">{error}</Notice>
    <button className="button button-outline" onClick={() => loadWallet()}>Try again</button>
  </div>

  async function fund(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const amountKobo = Math.round(Number(amount) * 100)
      const { data } = await api('/wallet/fund', {
        method: 'POST',
        body: { amountKobo },
        headers: { 'Idempotency-Key': idempotencyKey() },
      })
      setPayment(data.payment)
      if (data.payment.authorizationUrl?.includes('/api/v1/dev/mock-payments/')) {
        setNotice('Development mock payment is ready. Complete it below to credit your wallet.')
      } else if (data.payment.authorizationUrl) {
        window.location.assign(data.payment.authorizationUrl)
      } else {
        setNotice('Payment started. Refresh this page after completing payment.')
      }
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  async function completeMockPayment(outcome = 'success') {
    if (!payment) return
    const reference = payment.reference
    setBusy(true)
    setError('')
    try {
      await api(`/dev/mock-payments/${encodeURIComponent(reference)}/pay`, {
        method: 'POST',
        body: { outcome },
        auth: false,
      })
      const { data } = await api(`/wallet/fund/${encodeURIComponent(reference)}`)
      setPayment(data.payment)
      setNotice(data.payment.status === 'SUCCEEDED' ? 'Payment confirmed. Your wallet is topped up.' : `Payment status: ${data.payment.status.toLowerCase()}.`)
      await loadWallet()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  return <div className="content-wrap account-page">
    <PageHeading eyebrow="Your money, your rules" title="Wallet" description="A clear view of your KoboMarket balance and activity." />
    {error && <Notice tone="error">{error}</Notice>}{notice && <Notice tone="success">{notice}</Notice>}
    <div className="wallet-grid">
      <section className="balance-card">
        <div className="balance-card-top"><span className="balance-icon"><WalletIcon size={20} /></span><StatusBadge status={wallet?.status} /></div>
        <span className="balance-label">Available balance</span>
        <strong className="balance-amount">{wallet?.balanceDisplay || formatNaira(wallet?.balanceKobo)}</strong>
        <span className="balance-foot">All amounts are shown in Nigerian naira.</span>
      </section>
      <section className="panel-card funding-card">
        <span className="eyebrow">Add funds</span><h2>Top up your wallet</h2>
        <p className="muted">Payments are verified before your wallet is credited.</p>
        <form className="fund-form" onSubmit={fund}>
          <label className="field-label">Amount in naira
            <div className="currency-input"><span>₦</span><input type="number" step="0.01" min="1" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="5,000.00" required /></div>
          </label>
          <button className="button button-primary button-wide" disabled={busy}>{busy ? 'Starting payment…' : 'Continue to payment'} <ArrowUpRight size={16} /></button>
        </form>
        {payment?.authorizationUrl?.includes('/api/v1/dev/mock-payments/') && payment.status === 'PENDING' && <div className="mock-payment">
          <p className="small"><strong>Development payment</strong><br />Reference: {payment.reference}</p>
          <button className="button button-accent button-wide" onClick={() => completeMockPayment()} disabled={busy}>{busy ? 'Confirming…' : 'Simulate successful payment'}</button>
          <button className="text-button" onClick={() => completeMockPayment('failed')} disabled={busy}>Simulate a declined payment</button>
        </div>}
      </section>
    </div>
    <section className="panel-card transactions-card">
      <div className="section-title-row"><div><span className="eyebrow">The details</span><h2>Recent activity</h2></div><button className="icon-button" onClick={() => loadWallet()} aria-label="Refresh wallet"><RefreshCw size={16} /></button></div>
      {transactions.length ? <div className="transaction-list">{transactions.map((transaction) => <article className="transaction-row" key={transaction.id}>
        <span className={`transaction-icon transaction-${transaction.direction}`}>{transaction.direction === 'credit' ? <ArrowDownLeft size={18} /> : <ArrowUpRight size={18} />}</span>
        <div className="transaction-info"><strong>{transaction.description || transaction.type.replaceAll('_', ' ').toLowerCase()}</strong><span>{new Date(transaction.createdAt).toLocaleString('en-NG')} · {transaction.reference}</span></div>
        <strong className={transaction.direction === 'credit' ? 'amount-positive' : 'amount-negative'}>{transaction.direction === 'credit' ? '+' : '−'}{formatNaira(transaction.amountKobo)}</strong>
      </article>)}</div> : <EmptyState title="No activity yet">When you fund your wallet, your transactions will show up here.</EmptyState>}
      {cursor && <button className="button button-outline load-more" onClick={() => loadWallet(cursor, true)}>Load older activity <ArrowDown size={15} /></button>}
    </section>
  </div>
}

export function ProfilePage() {
  const { setUser } = useAuth()
  const [profile, setProfile] = useState(null)
  const [values, setValues] = useState({ fullName: '', phone: '' })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    api('/users/me').then(({ data }) => {
      setProfile(data.user)
      setValues({ fullName: data.user.fullName || '', phone: data.user.phone || '' })
    }).catch((requestError) => setError(requestError.message)).finally(() => setLoading(false))
  }, [])

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const { data } = await api('/users/me', { method: 'PATCH', body: values })
      setProfile(data.user)
      setUser(data.user)
      setNotice('Your profile has been updated.')
    } catch (requestError) { setError(requestError.message) } finally { setBusy(false) }
  }

  if (loading) return <Loading label="Opening your profile…" />
  return <div className="content-wrap narrow-content account-page">
    <PageHeading eyebrow="Your account" title="Profile" description="Keep your contact details up to date." />
    {error && <Notice tone="error">{error}</Notice>}{notice && <Notice tone="success">{notice}</Notice>}
    {profile && <section className="panel-card">
      <form className="form-stack" onSubmit={submit}>
        <label className="field-label">Full name<input value={values.fullName} onChange={(event) => setValues({ ...values, fullName: event.target.value })} required /></label>
        <label className="field-label">Email address<input value={profile.email} disabled /><span className="field-hint">Email address cannot be changed here.</span></label>
        <label className="field-label">Phone number<input value={values.phone} onChange={(event) => setValues({ ...values, phone: event.target.value })} /></label>
        <div className="profile-roles"><span>Account roles</span>{profile.roles?.map((role) => <StatusBadge key={role} status={role} />)}</div>
        <button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
      </form>
    </section>}
  </div>
}

export function AdminPage() {
  const [vendors, setVendors] = useState([])
  const [statusFilter, setStatusFilter] = useState('pending')
  const [vendorCursor, setVendorCursor] = useState(null)
  const [vendorLoading, setVendorLoading] = useState(true)
  const [overviewLoading, setOverviewLoading] = useState(true)
  const [overview, setOverview] = useState(null)
  const [busyId, setBusyId] = useState('')
  const [vendorError, setVendorError] = useState('')
  const [overviewError, setOverviewError] = useState('')
  const [notice, setNotice] = useState('')
  const [rejection, setRejection] = useState({})

  const loadVendors = useCallback(async (status, cursor = null, append = false) => {
    setVendorLoading(true)
    try {
      const query = new URLSearchParams({ limit: '30' })
      if (status !== 'all') query.set('status', status)
      if (cursor) query.set('cursor', cursor)
      const { data } = await api(`/admin/vendors?${query}`)
      setVendors((current) => append ? [...current, ...(data.vendors || [])] : (data.vendors || []))
      setVendorCursor(data.nextCursor)
      setVendorError('')
    } catch (requestError) { setVendorError(requestError.message) } finally { setVendorLoading(false) }
  }, [])

  const loadOverview = useCallback(async () => {
    setOverviewLoading(true)
    try {
      const [revenueResponse, escrowResponse, reconciliationResponse, topVendorsResponse, usersResponse] = await Promise.all([
        api('/admin/reports/revenue-by-day?days=30'),
        api('/admin/reports/escrow'),
        api('/admin/reports/reconciliation'),
        api('/admin/reports/top-vendors'),
        api('/admin/users?limit=8'),
      ])
      setOverview({
        revenue: revenueResponse.data,
        escrow: escrowResponse.data,
        reconciliation: reconciliationResponse.data,
        topVendors: topVendorsResponse.data.vendors,
        users: usersResponse.data.users,
      })
      setOverviewError('')
    } catch (requestError) { setOverviewError(requestError.message) } finally { setOverviewLoading(false) }
  }, [])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Load data when the admin page opens.
    loadVendors('pending')
    loadOverview()
  }, [loadOverview, loadVendors])

  async function review(vendor, decision) {
    setBusyId(vendor.id)
    setVendorError('')
    setNotice('')
    try {
      await api(`/admin/vendors/${vendor.id}/${decision}`, {
        method: 'PATCH',
        ...(decision === 'reject' ? { body: { reason: rejection[vendor.id] || '' } } : {}),
      })
      setNotice(`${vendor.storeName} ${decision === 'approve' ? 'approved' : 'rejected'}.`)
      await Promise.all([loadVendors(statusFilter), loadOverview()])
    } catch (requestError) { setVendorError(requestError.message) } finally { setBusyId('') }
  }

  const refresh = () => Promise.all([loadVendors(statusFilter), loadOverview()])
  const filters = [
    { value: 'pending', label: 'Pending' },
    { value: 'approved', label: 'Approved' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'all', label: 'All applications' },
  ]

  if (vendorLoading && overviewLoading && !overview && vendors.length === 0) return <Loading label="Loading marketplace activity…" />

  return <div className="content-wrap account-page">
    <PageHeading eyebrow="Marketplace operations" title="Admin dashboard" description="Review seller applications, monitor platform health, and see recent account activity." action={<button className="button button-outline" onClick={refresh} disabled={vendorLoading || overviewLoading}><RefreshCw size={15} /> Refresh</button>} />
    {notice && <Notice tone="success">{notice}</Notice>}

    {overviewError && <Notice tone="error">Couldn’t load all platform reports: {overviewError}</Notice>}
    {overviewLoading && !overview ? <Loading label="Loading reports…" /> : overview && <section className="admin-overview-grid" aria-label="Platform overview">
      <article className="panel-card admin-stat-card">
        <span className="admin-stat-icon"><Activity size={17} /></span><span className="eyebrow">Commission · last 30 days</span>
        <strong>{formatNaira(overview.revenue.totalKobo)}</strong><span className="muted small">{overview.revenue.byDay.reduce((sum, day) => sum + day.transactions, 0)} transactions</span>
      </article>
      <article className="panel-card admin-stat-card">
        <span className="admin-stat-icon"><ShieldCheck size={17} /></span><span className="eyebrow">Escrow held</span>
        <strong>{formatNaira(overview.escrow.escrowAccountKobo)}</strong><span className="muted small">{overview.escrow.inSync ? 'Ledger is in sync' : 'Balance needs attention'}</span>
      </article>
      <article className="panel-card admin-stat-card">
        <span className={`admin-stat-icon ${overview.reconciliation.ok ? 'admin-stat-good' : 'admin-stat-alert'}`}>
          {overview.reconciliation.ok ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
        </span><span className="eyebrow">Ledger reconciliation</span>
        <strong>{overview.reconciliation.ok ? 'Healthy' : `${overview.reconciliation.discrepancies.length} issue${overview.reconciliation.discrepancies.length === 1 ? '' : 's'}`}</strong>
        <span className="muted small">{overview.reconciliation.checksRun} checks run</span>
      </article>
      <article className="panel-card admin-stat-card">
        <span className="admin-stat-icon"><Store size={17} /></span><span className="eyebrow">Top vendor this month</span>
        <strong>{overview.topVendors[0]?.storeName || 'No settled sales yet'}</strong>
        {overview.topVendors[0] && <span className="muted small">{formatNaira(overview.topVendors[0].earnedKobo)} earned</span>}
      </article>
    </section>}

    {overview?.reconciliation?.discrepancies?.length > 0 && <section className="panel-card admin-issues">
      <h2>Reconciliation issues</h2>
      {overview.reconciliation.discrepancies.map((issue) => <p key={issue.rule}><AlertTriangle size={15} /> <strong>{issue.rule}</strong> · {issue.rows.length} affected record{issue.rows.length === 1 ? '' : 's'}</p>)}
    </section>}

    <section className="panel-card admin-applications">
      <div className="section-title-row admin-section-heading">
        <div><span className="eyebrow">Seller management</span><h2>Vendor applications</h2></div>
        <span className="count-pill">{vendors.length}{vendorCursor ? '+' : ''} shown</span>
      </div>
      {vendorError && <Notice tone="error">{vendorError}</Notice>}
      <div className="admin-filter-row" role="group" aria-label="Filter vendor applications">
        {filters.map((filter) => <button
          key={filter.value}
          type="button"
          className={`admin-filter-button ${statusFilter === filter.value ? 'admin-filter-active' : ''}`}
          aria-pressed={statusFilter === filter.value}
          onClick={() => {
            setStatusFilter(filter.value)
            setVendorCursor(null)
            loadVendors(filter.value)
          }}
        >{filter.label}</button>)}
      </div>
      {vendorLoading && !vendors.length ? <Loading label="Loading vendor applications…" /> : vendors.length ? <>
        <div className="admin-vendor-list">{vendors.map((vendor) => <article className="panel-card admin-vendor-card" key={vendor.id}>
          <div className="admin-vendor-head">
            <div className="store-avatar">{vendor.storeName.charAt(0).toUpperCase()}</div>
            <div><h2>{vendor.storeName}</h2><span className="muted small">Applied {new Date(vendor.createdAt).toLocaleDateString('en-NG')} · Account {vendor.userId}</span></div>
            <StatusBadge status={vendor.status} />
          </div>
          <p>{vendor.description || 'No store description provided.'}</p>
          <div className="payout-details"><strong>Payout details</strong><span>{vendor.bankDetails?.bankName} · {vendor.bankDetails?.accountName} · {vendor.bankDetails?.accountNumberMasked}</span></div>
          {vendor.reviewedAt && <p className="admin-review-meta">Reviewed {new Date(vendor.reviewedAt).toLocaleString('en-NG')}{vendor.rejectionReason ? ` · ${vendor.rejectionReason}` : ''}</p>}
          {vendor.status === 'pending' && <div className="review-actions">
            <label className="field-label">Reason if rejecting
              <input value={rejection[vendor.id] || ''} onChange={(event) => setRejection({ ...rejection, [vendor.id]: event.target.value })} placeholder="Share a short reason" maxLength="300" />
            </label>
            <div className="button-row"><button className="button button-outline danger-outline" onClick={() => review(vendor, 'reject')} disabled={busyId === vendor.id || (rejection[vendor.id] || '').trim().length < 3}>Reject</button><button className="button button-primary" onClick={() => review(vendor, 'approve')} disabled={busyId === vendor.id}>{busyId === vendor.id ? 'Saving…' : 'Approve seller'} <BadgeCheck size={16} /></button></div>
          </div>}
        </article>)}</div>
        {vendorCursor && <button className="button button-outline load-more" onClick={() => loadVendors(statusFilter, vendorCursor, true)} disabled={vendorLoading}>{vendorLoading ? 'Loading…' : 'Load more applications'} <ArrowDown size={15} /></button>}
      </> : !vendorError && <EmptyState title={statusFilter === 'pending' ? 'All caught up' : 'No applications found'}>{statusFilter === 'pending' ? 'There are no pending vendor applications.' : 'No vendor applications match this filter.'}</EmptyState>}
    </section>

    <section className="panel-card admin-recent-users">
      <div className="section-title-row admin-section-heading"><div><span className="eyebrow">Account activity</span><h2>Recently registered users</h2></div><Users size={19} /></div>
      {overview?.users?.length ? <div className="admin-user-list">{overview.users.map((user) => <article className="admin-user-row" key={user.id}>
        <div><strong>{user.fullName}</strong><span>{user.email}</span></div>
        <span className="muted small">{new Date(user.createdAt).toLocaleDateString('en-NG')}</span>
        <div className="admin-user-badges">{user.roles.map((role) => <StatusBadge key={role} status={role} />)}<StatusBadge status={user.status} /></div>
      </article>)}</div> : !overviewLoading && !overviewError && <EmptyState title="No user activity yet">New account registrations will appear here.</EmptyState>}
    </section>
  </div>
}
