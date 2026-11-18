const { formatNaira } = require('../../utils/money');

const toVariantView = (v) => ({
  id: v.id,
  sku: v.sku,
  attributes: v.attributes,
  priceKobo: v.priceKobo,
  priceDisplay: formatNaira(v.priceKobo),
  stock: v.stock,
});

/** What the API shows about a product. Money is integer kobo; priceDisplay is for humans only. */
function toProductView(p) {
  return {
    id: p.id,
    vendorId: p.vendorId,
    name: p.name,
    slug: p.slug,
    description: p.description,
    category: p.category,
    images: p.images,
    tags: p.tags,
    priceKobo: p.priceKobo,
    priceDisplay: formatNaira(p.priceKobo),
    stock: p.stock,
    variants: p.variants.map(toVariantView),
    isActive: p.isActive,
    rating: { average: p.ratingAvg, count: p.ratingCount },
    createdAt: p.createdAt,
  };
}

module.exports = { toProductView };
