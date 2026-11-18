import { useEffect, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, Search, ShieldCheck, Sparkles, Star } from 'lucide-react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, formatNaira } from '../api'
import { useAuth } from '../useAuth'
import { EmptyState, Loading, Notice, PageHeading, ProductCard } from '../components'

const categories = ['fashion', 'beauty', 'home', 'art', 'accessories', 'food']

function ProductGrid({ products, addToCart }) {
  if (!products.length) {
    return <EmptyState title="Nothing here yet" action={<Link className="button button-outline" to="/">Explore all products</Link>}>
      Try another search or check back soon for new finds.
    </EmptyState>
  }
  return <div className="product-grid">{products.map((product) => <ProductCard key={product.id} product={product} onAdd={addToCart} />)}</div>
}

export function Storefront() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [filters, setFilters] = useState({
    q: searchParams.get('q') || '',
    category: searchParams.get('category') || '',
    sort: searchParams.get('sort') || 'newest',
  })
  const [products, setProducts] = useState([])
  const [cursor, setCursor] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function loadProducts(nextFilters = filters, nextCursor = null, append = false) {
    setLoading(true)
    setError('')
    const query = new URLSearchParams({ limit: '20', sort: nextFilters.sort })
    if (nextFilters.q.trim()) query.set('q', nextFilters.q.trim())
    if (nextFilters.category) query.set('category', nextFilters.category)
    if (nextCursor) query.set('cursor', nextCursor)
    try {
      const { data } = await api(`/products?${query}`)
      setProducts((current) => append ? [...current, ...data.products] : data.products)
      setCursor(data.nextCursor)
    } catch (requestError) {
      setError(requestError.message)
      if (!append) setProducts([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadProducts(filters)
    // The initial filter comes from the current URL. Search interactions call loadProducts directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function search(event) {
    event.preventDefault()
    const next = { ...filters, q: event.currentTarget.elements.q.value }
    setFilters(next)
    navigate(`/?${new URLSearchParams({ ...(next.q ? { q: next.q } : {}), ...(next.category ? { category: next.category } : {}), sort: next.sort })}`, { replace: true })
    loadProducts(next)
  }

  function selectCategory(category) {
    const next = { ...filters, category: filters.category === category ? '' : category }
    setFilters(next)
    loadProducts(next)
  }

  async function addToCart(product) {
    if (!user) {
      navigate('/login', { state: { from: '/' } })
      return
    }
    if (product.variants.length > 0) {
      navigate(`/products/${product.slug}`)
      return
    }
    try {
      await api('/cart/items', { method: 'POST', body: { productId: product.id, quantity: 1 } })
      setNotice(`${product.name} added to your cart.`)
    } catch (requestError) {
      setError(requestError.message)
    }
  }

  return (
    <>
      <section className="hero-panel">
        <div className="hero-copy">
          <span className="eyebrow eyebrow-light"><Sparkles size={14} /> A little more local</span>
          <h1>Good things,<br /><em>made closer.</em></h1>
          <p>Discover thoughtful finds from independent Nigerian makers and small businesses.</p>
          <form className="hero-search" onSubmit={search}>
            <Search size={19} />
            <input name="q" defaultValue={filters.q} placeholder="What are you looking for?" aria-label="Search products" />
            <button type="submit" className="button button-accent">Search</button>
          </form>
          <div className="hero-proof"><ShieldCheck size={16} /> Secure payments <span>·</span> Local makers <span>·</span> Fair prices</div>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="hero-shape shape-large" />
          <div className="hero-shape shape-small" />
          <div className="hero-sticker"><span>MADE</span><strong>with<br />meaning</strong><span>IN NIGERIA</span></div>
          <div className="hero-leaf leaf-one" />
          <div className="hero-leaf leaf-two" />
        </div>
      </section>

      <section className="category-section">
        <div className="section-title-row">
          <div><span className="eyebrow">Take a look around</span><h2>Shop by mood</h2></div>
          <span className="muted small">Find your next favourite</span>
        </div>
        <div className="category-list">
          {categories.map((category, index) => (
            <button className={`category-chip category-chip-${index} ${filters.category === category ? 'selected' : ''}`} key={category} onClick={() => selectCategory(category)}>
              <span>{['✳', '✿', '⌂', '◈', '✴', '❋'][index]}</span>{category}
            </button>
          ))}
        </div>
      </section>

      <section className="catalog-section">
        <div className="section-title-row catalog-heading">
          <div><span className="eyebrow">The good stuff</span><h2>{filters.category ? `Shop ${filters.category}` : 'Made for you'}</h2></div>
          <label className="sort-control">Sort by
            <select value={filters.sort} onChange={(event) => {
              const next = { ...filters, sort: event.target.value }
              setFilters(next)
              loadProducts(next)
            }}>
              <option value="newest">Newest</option>
              <option value="rating">Top rated</option>
              <option value="price_asc">Price: low to high</option>
              <option value="price_desc">Price: high to low</option>
            </select>
            <ArrowDown size={14} />
          </label>
        </div>
        {notice && <Notice tone="success">{notice}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        {loading && products.length === 0 ? <Loading label="Finding good things…" /> : error && products.length === 0 ? <button className="button button-outline load-more" onClick={() => loadProducts(filters)}>Try again</button> : <ProductGrid products={products} addToCart={addToCart} />}
        {cursor && <button className="button button-outline load-more" onClick={() => loadProducts(filters, cursor, true)} disabled={loading}>
          {loading ? 'Loading…' : <>Show me more <ArrowRight size={16} /></>}
        </button>}
      </section>

      <section className="maker-banner">
        <div className="maker-mark">KM</div>
        <div><span className="eyebrow eyebrow-light">For the doers</span><h2>Your craft deserves<br />a bigger stage.</h2><p>Meet the people behind the products. Start your store on KoboMarket.</p></div>
        <Link to={user ? '/vendor' : '/register'} className="button button-accent">Become a seller <ArrowUpRight size={16} /></Link>
      </section>
    </>
  )
}

export function ProductDetails() {
  const { slug } = useParams()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [product, setProduct] = useState(null)
  const [reviews, setReviews] = useState([])
  const [variantId, setVariantId] = useState('')
  const [quantity, setQuantity] = useState(1)
  const [rating, setRating] = useState(5)
  const [reviewText, setReviewText] = useState('')
  const [loadedSlug, setLoadedSlug] = useState('')
  const loading = loadedSlug !== slug
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    Promise.all([api(`/products/${encodeURIComponent(slug)}`), api(`/products/${encodeURIComponent(slug)}/reviews`)])
      .then(([productResponse, reviewResponse]) => {
        setProduct(productResponse.data.product)
        setReviews(reviewResponse.data.reviews || [])
        setVariantId(productResponse.data.product.variants?.[0]?.id || '')
        setError('')
        setLoadedSlug(slug)
      })
      .catch((requestError) => {
        setError(requestError.message)
        setProduct(null)
        setLoadedSlug(slug)
      })
  }, [slug])

  async function addToCart() {
    if (!user) {
      navigate('/login', { state: { from: `/products/${slug}` } })
      return
    }
    try {
      await api('/cart/items', {
        method: 'POST',
        body: { productId: product.id, ...(product.variants.length ? { variantId } : {}), quantity },
      })
      setNotice('Added to your cart. Good choice.')
    } catch (requestError) {
      setError(requestError.message)
    }
  }

  async function submitReview(event) {
    event.preventDefault()
    try {
      await api(`/products/${product.id}/reviews`, {
        method: 'POST',
        body: { rating, ...(reviewText.trim() ? { comment: reviewText.trim() } : {}) },
      })
      const { data } = await api(`/products/${product.id}/reviews`)
      setReviews(data.reviews || [])
      setReviewText('')
      setNotice('Thanks for sharing your experience.')
    } catch (requestError) {
      setError(requestError.message)
    }
  }

  if (loading) return <Loading label="Loading product…" />
  if (error && !product) return <div className="content-wrap"><Notice tone="error">{error}</Notice><Link to="/" className="back-link"><ArrowLeft size={16} /> Back to browsing</Link></div>
  if (!product) return null

  const image = product.images?.[0]
  const selectedVariant = product.variants.find((variant) => variant.id === variantId)
  const currentPrice = selectedVariant?.priceKobo ?? product.priceKobo
  const currentStock = selectedVariant?.stock ?? product.stock

  return (
    <div className="content-wrap product-detail">
      <Link to="/" className="back-link"><ArrowLeft size={16} /> Back to browsing</Link>
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}
      <div className="detail-layout">
        <div className="detail-image">{image ? <img src={image} alt={product.name} /> : <span className="detail-placeholder">✳</span>}</div>
        <div className="detail-copy">
          <span className="eyebrow">{product.category}</span>
          <h1>{product.name}</h1>
          <div className="detail-rating"><span><Star size={15} fill="currentColor" /> {Number(product.rating?.average || 0).toFixed(1)}</span> · {product.rating?.count || 0} reviews</div>
          <div className="detail-price">{formatNaira(currentPrice)}</div>
          <p className="detail-description">{product.description || 'Made with care. Ready to find a new home.'}</p>
          <Link className="maker-link" to={`/stores/${product.vendorId}`}><span className="maker-link-mark">{product.name.charAt(0)}</span><span><small>Thoughtfully made by</small><strong>Visit this maker’s store</strong></span><ArrowUpRight size={16} /></Link>
          {product.variants.length > 0 && <label className="field-label">Choose an option
            <select value={variantId} onChange={(event) => setVariantId(event.target.value)}>
              {product.variants.map((variant) => (
                <option key={variant.id} value={variant.id}>
                  {Object.values(variant.attributes || {}).join(' / ') || variant.sku || 'Option'} — {formatNaira(variant.priceKobo)}
                </option>
              ))}
            </select>
          </label>}
          <p className="availability">{currentStock > 0 ? `${currentStock} available` : 'Currently out of stock'}</p>
          <div className="purchase-row">
            <label className="quantity-field">Qty
              <input type="number" min="1" max={Math.min(currentStock, 99)} value={quantity} onChange={(event) => setQuantity(Math.max(1, Number(event.target.value)))} />
            </label>
            <button className="button button-primary" onClick={addToCart} disabled={currentStock < 1}>Add to cart <ArrowUpRight size={17} /></button>
          </div>
          <div className="detail-reassurance"><ShieldCheck size={17} /> Payments are handled securely by KoboMarket.</div>
        </div>
      </div>
      <section className="reviews-section">
        <PageHeading eyebrow="Buyer notes" title="Made an impression?" description="Reviews are available to buyers with a completed order." />
        {user && <form className="review-form" onSubmit={submitReview}>
          <label className="field-label">Your rating
            <select value={rating} onChange={(event) => setRating(Number(event.target.value))}>{[5, 4, 3, 2, 1].map((value) => <option key={value} value={value}>{value} stars</option>)}</select>
          </label>
          <label className="field-label">Your note
            <textarea value={reviewText} onChange={(event) => setReviewText(event.target.value)} placeholder="What should other shoppers know?" rows="3" maxLength="2000" />
          </label>
          <button className="button button-outline" type="submit">Share review</button>
        </form>}
        <div className="review-list">
          {reviews.length ? reviews.map((review) => <article className="review-card" key={review.id}>
            <div className="review-stars">{'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}</div>
            <p>{review.comment || review.title || 'A KoboMarket purchase'}</p>
            <span className="muted small">{review.buyerName || 'Verified buyer'}</span>
          </article>) : <p className="muted">No reviews yet.</p>}
        </div>
      </section>
    </div>
  )
}

export function StoreDetails() {
  const { id } = useParams()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [vendor, setVendor] = useState(null)
  const [products, setProducts] = useState([])
  const [loadedId, setLoadedId] = useState('')
  const [error, setError] = useState('')
  const loading = loadedId !== id

  useEffect(() => {
    Promise.all([
      api(`/vendors/${encodeURIComponent(id)}`),
      api(`/products?vendor=${encodeURIComponent(id)}&limit=50`),
    ])
      .then(([vendorResponse, productResponse]) => {
        setVendor(vendorResponse.data.vendor)
        setProducts(productResponse.data.products)
        setError('')
        setLoadedId(id)
      })
      .catch((requestError) => {
        setError(requestError.message)
        setLoadedId(id)
      })
  }, [id])

  async function addToCart(product) {
    if (!user) {
      navigate('/login', { state: { from: `/stores/${id}` } })
      return
    }
    if (product.variants.length > 0) {
      navigate(`/products/${product.slug}`)
      return
    }
    try {
      await api('/cart/items', { method: 'POST', body: { productId: product.id, quantity: 1 } })
    } catch (requestError) {
      setError(requestError.message)
    }
  }

  if (loading) return <Loading label="Opening this maker’s store…" />
  if (error || !vendor) return <div className="content-wrap"><Notice tone="error">{error || 'Store not found.'}</Notice><Link to="/" className="back-link"><ArrowLeft size={16} /> Back to browsing</Link></div>

  return <div className="content-wrap store-page">
    <Link to="/" className="back-link"><ArrowLeft size={16} /> Back to browsing</Link>
    <section className="public-store-hero">
      <div className="public-store-mark">{vendor.storeName.charAt(0).toUpperCase()}</div>
      <div><span className="eyebrow eyebrow-light">Meet the maker</span><h1>{vendor.storeName}</h1><p>{vendor.description || 'A local maker sharing their work on KoboMarket.'}</p></div>
      <span className="store-open-badge"><ShieldCheck size={15} /> Approved store</span>
    </section>
    {error && <Notice tone="error">{error}</Notice>}
    <PageHeading eyebrow="From this maker" title="The collection" description={`${products.length} product${products.length === 1 ? '' : 's'} available`} />
    <ProductGrid products={products} addToCart={addToCart} />
  </div>
}
