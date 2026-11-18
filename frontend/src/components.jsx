import { Link } from 'react-router-dom'
import { ArrowUpRight, Image as ImageIcon, Star } from 'lucide-react'
import { formatNaira } from './api'

export function PageHeading({ eyebrow, title, description, action }) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {action}
    </div>
  )
}

export function Notice({ children, tone = 'info' }) {
  return <div className={`notice notice-${tone}`} role="status">{children}</div>
}

export function Loading({ label = 'Loading…' }) {
  return <div className="loading"><span className="spinner" />{label}</div>
}

export function EmptyState({ title, children, action }) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><ImageIcon size={24} /></span>
      <h3>{title}</h3>
      {children && <p className="muted">{children}</p>}
      {action}
    </div>
  )
}

export function ProductCard({ product, onAdd }) {
  const image = product.images?.[0]
  return (
    <article className="product-card">
      <Link className="product-image" to={`/products/${product.slug}`} aria-label={`View ${product.name}`}>
        {image ? <img src={image} alt={product.name} loading="lazy" /> : <ImageIcon size={34} />}
        <span className="image-label">{product.category}</span>
      </Link>
      <div className="product-info">
        <Link className="product-name" to={`/products/${product.slug}`}>{product.name}</Link>
        <div className="product-meta">
          <span className="rating"><Star size={14} fill="currentColor" /> {Number(product.rating?.average || 0).toFixed(1)} <span>({product.rating?.count || 0})</span></span>
          <span className="stock-label">{product.stock > 0 ? 'In stock' : 'Sold out'}</span>
        </div>
        <div className="product-bottom">
          <strong>{product.priceDisplay || formatNaira(product.priceKobo)}</strong>
          <button
            type="button"
            className="icon-button"
            onClick={() => onAdd?.(product)}
            aria-label={`Add ${product.name} to cart`}
            disabled={!product.stock || !onAdd}
          >
            <ArrowUpRight size={17} />
          </button>
        </div>
      </div>
    </article>
  )
}

export function StatusBadge({ status }) {
  const normalized = String(status || 'unknown').toLowerCase()
  return <span className={`status-badge status-${normalized}`}>{normalized.replaceAll('_', ' ')}</span>
}
