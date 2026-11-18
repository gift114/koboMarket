import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, BadgeCheck, PackagePlus, Pencil, RefreshCw, Store, Trash2, X } from 'lucide-react'
import { api, formatNaira } from '../api'
import { useAuth } from '../useAuth'
import { EmptyState, Loading, Notice, PageHeading, StatusBadge } from '../components'

const emptyProduct = { name: '', description: '', category: '', price: '', stock: '1', image: '' }

const toForm = (product) => ({
  name: product.name,
  description: product.description || '',
  category: product.category,
  price: (product.priceKobo / 100).toFixed(2),
  stock: String(product.stock),
  image: product.images?.[0] || '',
})

export function VendorPage() {
  const { setUser } = useAuth()
  const formRef = useRef(null)
  const [vendor, setVendor] = useState(null)
  const [products, setProducts] = useState([])
  const [form, setForm] = useState({ storeName: '', description: '', bankName: '', accountNumber: '', accountName: '' })
  const [productForm, setProductForm] = useState(emptyProduct)
  const [editing, setEditing] = useState(null) // the product being edited, or null when listing a new one
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const loadVendor = useCallback(async () => {
    try {
      const { data } = await api('/vendors/me')
      setVendor(data.vendor)
      setError('')
      if (data.vendor.status === 'approved') {
        const [profileResponse, productsResponse] = await Promise.all([
          api('/users/me'),
          // The seller's own catalogue: includes paused (inactive) products.
          api('/products/mine?limit=50'),
        ])
        setUser(profileResponse.data.user)
        setProducts(productsResponse.data.products)
      }
    } catch (requestError) {
      if (requestError.code !== 'NO_APPLICATION') setError(requestError.message)
    } finally {
      setLoading(false)
    }
  }, [setUser])

  // oxlint-disable-next-line react/set-state-in-effect -- This effect synchronizes seller data with the API.
  useEffect(() => { loadVendor() }, [loadVendor])

  async function apply(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const { data } = await api('/vendors/apply', {
        method: 'POST',
        body: {
          storeName: form.storeName,
          description: form.description,
          bankDetails: { bankName: form.bankName, accountNumber: form.accountNumber, accountName: form.accountName },
        },
      })
      setVendor(data.vendor)
      setNotice('Application received. We’ll let you know when it has been reviewed.')
    } catch (requestError) { setError(requestError.message) } finally { setBusy(false) }
  }

  function startEdit(product) {
    setEditing(product)
    setProductForm(toForm(product))
    setError('')
    setNotice('')
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function cancelEdit() {
    setEditing(null)
    setProductForm(emptyProduct)
  }

  async function createProduct() {
    await api('/products', {
      method: 'POST',
      body: {
        name: productForm.name,
        description: productForm.description,
        category: productForm.category,
        priceKobo: Math.round(Number(productForm.price) * 100),
        stock: Number(productForm.stock),
        images: productForm.image.trim() ? [productForm.image.trim()] : [],
      },
    })
    setProductForm(emptyProduct)
    setNotice('Your product is now listed.')
  }

  async function updateProduct() {
    const f = productForm
    const hasVariants = editing.variants?.length > 0
    const patch = {}

    if (f.name.trim() !== editing.name) patch.name = f.name.trim()
    if (f.description.trim() !== (editing.description || '')) patch.description = f.description.trim()
    if (f.category.trim().toLowerCase() !== editing.category) patch.category = f.category.trim()

    // With variants, price and stock come from the variants and the API refuses them here.
    if (!hasVariants) {
      const priceKobo = Math.round(Number(f.price) * 100)
      if (priceKobo !== editing.priceKobo) patch.priceKobo = priceKobo
      const stock = Number(f.stock)
      if (stock !== editing.stock) patch.stock = stock
    }

    // Only the first image is editable here; any extra images are kept as they are.
    const image = f.image.trim()
    if (image !== (editing.images?.[0] || '')) {
      patch.images = [image, ...(editing.images || []).slice(1)].filter(Boolean)
    }

    if (Object.keys(patch).length === 0) {
      setNotice('No changes to save.')
      return
    }
    await api(`/products/${editing.id}`, { method: 'PATCH', body: patch })
    setEditing(null)
    setProductForm(emptyProduct)
    setNotice('Product updated.')
  }

  async function submitProduct(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (editing) await updateProduct()
      else await createProduct()
      await loadVendor()
    } catch (requestError) { setError(requestError.message) } finally { setBusy(false) }
  }

  async function setProductActive(product) {
    setError('')
    try {
      await api(`/products/${product.id}`, { method: 'PATCH', body: { isActive: !product.isActive } })
      await loadVendor()
    } catch (requestError) { setError(requestError.message) }
  }

  async function removeProduct(product) {
    if (!window.confirm(`Remove "${product.name}" from your store?`)) return
    setError('')
    try {
      await api(`/products/${product.id}`, { method: 'DELETE' })
      setProducts((current) => current.filter((entry) => entry.id !== product.id))
      if (editing?.id === product.id) cancelEdit()
      setNotice('Product removed. It is kept in order history.')
    } catch (requestError) { setError(requestError.message) }
  }

  if (loading) return <Loading label="Opening your seller space…" />
  const isApproved = vendor?.status === 'approved'
  const editingVariants = editing?.variants?.length > 0

  return <div className="content-wrap account-page">
    <PageHeading eyebrow="The maker's corner" title="Seller space" description="Set up your store, share your products, and grow at your own pace." />
    {error && <Notice tone="error">{error}</Notice>}{notice && <Notice tone="success">{notice}</Notice>}
    {!vendor && !error && <section className="panel-card apply-card">
      <div className="panel-intro"><span className="feature-icon"><Store size={20} /></span><div><h2>Open your KoboMarket store</h2><p className="muted">Tell us a little about your shop. An admin will review your application.</p></div></div>
      <form className="form-grid" onSubmit={apply}>
        <label className="field-label">Store name<input value={form.storeName} onChange={(event) => setForm({ ...form, storeName: event.target.value })} required minLength="3" maxLength="80" /></label>
        <label className="field-label">About your store<input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} maxLength="1000" /></label>
        <div className="form-divider full-span">Payout details <span>Your account number is masked after submission.</span></div>
        <label className="field-label">Bank name<input value={form.bankName} onChange={(event) => setForm({ ...form, bankName: event.target.value })} required /></label>
        <label className="field-label">Account name<input value={form.accountName} onChange={(event) => setForm({ ...form, accountName: event.target.value })} required /></label>
        <label className="field-label">10-digit account number<input inputMode="numeric" pattern="[0-9]{10}" maxLength="10" value={form.accountNumber} onChange={(event) => setForm({ ...form, accountNumber: event.target.value })} required /></label>
        <button className="button button-primary full-span" disabled={busy}>{busy ? 'Sending application…' : 'Submit application'} <ArrowUpRight size={16} /></button>
      </form>
    </section>}
    {!vendor && error && <section className="panel-card"><p>We couldn’t load your seller application.</p><button className="button button-outline" onClick={loadVendor}>Try again</button></section>}
    {vendor && !isApproved && <section className="panel-card vendor-status-card">
      <div className="status-card-top"><span className="feature-icon"><Store size={20} /></span><StatusBadge status={vendor.status} /></div>
      <h2>{vendor.storeName}</h2>
      <p className="muted">{vendor.status === 'pending' ? 'Your application is in the queue. We’ll review it as soon as we can.' : 'Your application needs a little update before you can open your store.'}</p>
      {vendor.rejectionReason && <Notice tone="warning">Review note: {vendor.rejectionReason}</Notice>}
      <p className="small muted">Payout account · {vendor.bankDetails?.bankName} · {vendor.bankDetails?.accountNumberMasked}</p>
      {vendor.status === 'rejected' && <button className="button button-outline" onClick={() => setVendor(null)}>Update and reapply</button>}
    </section>}
    {isApproved && <>
      <div className="store-dashboard-header"><div className="store-avatar">{vendor.storeName.charAt(0).toUpperCase()}</div><div><div className="store-name-line"><h2>{vendor.storeName}</h2><StatusBadge status="approved" /></div><p className="muted">{vendor.description || 'Your store is open for business.'}</p></div><span className="seller-welcome"><BadgeCheck size={16} /> Verified seller</span></div>
      <div className="seller-grid">
        <section className="panel-card" ref={formRef}>
          <div className="section-title-row">
            <div><span className="eyebrow">{editing ? 'Editing' : 'New arrival'}</span><h2>{editing ? 'Edit product' : 'List a product'}</h2></div>
            {editing ? <button type="button" className="text-button" onClick={cancelEdit}><X size={15} /> Cancel</button> : <PackagePlus size={19} />}
          </div>
          <form className="form-stack" onSubmit={submitProduct}>
            <label className="field-label">Product name<input value={productForm.name} onChange={(event) => setProductForm({ ...productForm, name: event.target.value })} required minLength="3" maxLength="120" /></label>
            <label className="field-label">Description<textarea value={productForm.description} onChange={(event) => setProductForm({ ...productForm, description: event.target.value })} rows="3" maxLength="5000" /></label>
            <div className="form-grid">
              <label className="field-label">Category<input value={productForm.category} onChange={(event) => setProductForm({ ...productForm, category: event.target.value })} placeholder="e.g. fashion" required minLength="2" /></label>
              <label className="field-label">Price in naira<input type="number" min="0.01" step="0.01" value={productForm.price} onChange={(event) => setProductForm({ ...productForm, price: event.target.value })} required disabled={editingVariants} /></label>
              <label className="field-label">Available stock<input type="number" min="0" step="1" value={productForm.stock} onChange={(event) => setProductForm({ ...productForm, stock: event.target.value })} required disabled={editingVariants} /></label>
              <label className="field-label">Image URL <span className="muted">(optional)</span><input type="url" value={productForm.image} onChange={(event) => setProductForm({ ...productForm, image: event.target.value })} /></label>
            </div>
            {editingVariants && <span className="field-hint">This product has size/colour options, so its price and stock come from those options and can’t be changed here.</span>}
            <button className="button button-primary button-wide" disabled={busy}>
              {busy ? (editing ? 'Saving…' : 'Publishing…') : (editing ? 'Save changes' : 'Publish product')} <ArrowUpRight size={16} />
            </button>
          </form>
        </section>
        <section className="panel-card seller-products">
          <div className="section-title-row"><div><span className="eyebrow">Your catalogue</span><h2>Products <span className="count-pill">{products.length}</span></h2></div><button className="icon-button" onClick={loadVendor} aria-label="Refresh products"><RefreshCw size={16} /></button></div>
          {!products.length ? <EmptyState title="Your first listing starts here">Add a product to introduce your store to shoppers.</EmptyState> : <div className="seller-product-list">
            {products.map((product) => <article className={`seller-product-row ${editing?.id === product.id ? 'editing-row' : ''}`} key={product.id}>
              <div className="seller-product-image">{product.images?.[0] ? <img src={product.images[0]} alt="" /> : <Store size={18} />}</div>
              <div className="seller-product-info"><strong>{product.name}</strong><span>{formatNaira(product.priceKobo)} · {product.stock} in stock</span></div>
              <StatusBadge status={product.isActive ? 'active' : 'inactive'} />
              <div className="seller-product-actions">
                <button className="text-button" onClick={() => startEdit(product)}><Pencil size={13} /> Edit</button>
                <button className="text-button" onClick={() => setProductActive(product)}>{product.isActive ? 'Pause' : 'Publish'}</button>
                <button className="icon-button danger-button" onClick={() => removeProduct(product)} aria-label={`Remove ${product.name}`}><Trash2 size={15} /></button>
              </div>
            </article>)}
          </div>}
        </section>
      </div>
    </>}
  </div>
}