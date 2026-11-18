const { z } = require('zod');
const { SORT_NAMES } = require('./product.query');

const objectId = z
  .string()
  .regex(/^[a-fA-F0-9]{24}$/, 'must be a valid id')
  .transform((v) => v.toLowerCase());

const kobo = z.number().int().min(1).max(100_000_000_000); // up to N1bn, integers only
const stock = z.number().int().min(0).max(1_000_000);

const variant = z
  .object({
    id: objectId.optional(), // keep an existing variant (and its id); omit to add a new one
    sku: z.string().trim().min(1).max(60).optional(),
    attributes: z.record(z.string().trim().min(1).max(30), z.string().trim().min(1).max(60)).default({}),
    priceKobo: kobo,
    stock,
  })
  .strict()
  .refine((v) => Object.keys(v.attributes).length <= 5, { message: 'at most 5 attributes per variant', path: ['attributes'] });

const fields = {
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().max(5000),
  category: z.string().trim().toLowerCase().min(2).max(40),
  images: z.array(z.string().url().max(500)).max(8),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(30)).max(10),
  priceKobo: kobo,
  stock,
  variants: z.array(variant).max(50),
  isActive: z.boolean(),
};

const createBody = z
  .object({
    name: fields.name,
    description: fields.description.default(''),
    category: fields.category,
    images: fields.images.default([]),
    tags: fields.tags.default([]),
    priceKobo: fields.priceKobo.optional(),
    stock: fields.stock.optional(),
    variants: fields.variants.default([]),
    isActive: fields.isActive.default(true),
  })
  .strict();

const updateBody = z
  .object({
    name: fields.name,
    description: fields.description,
    category: fields.category,
    images: fields.images,
    tags: fields.tags,
    priceKobo: fields.priceKobo,
    stock: fields.stock,
    variants: fields.variants,
    isActive: fields.isActive,
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Send at least one field to change' });

const idParams = z.object({ id: objectId });
const slugParams = z.object({ slug: z.string().trim().toLowerCase().min(1).max(160) });

const listQuery = z
  .object({
    q: z.string().trim().min(1).max(100).optional(),
    category: z.string().trim().toLowerCase().min(1).max(40).optional(),
    tag: z.string().trim().toLowerCase().min(1).max(30).optional(),
    vendor: objectId.optional(),
    minPrice: z.coerce.number().int().min(0).optional(),
    maxPrice: z.coerce.number().int().min(0).optional(),
    minRating: z.coerce.number().min(0).max(5).optional(),
    sort: z.enum(SORT_NAMES).default('newest'),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(300).optional(),
  })
  .refine((q) => q.minPrice === undefined || q.maxPrice === undefined || q.minPrice <= q.maxPrice, {
    message: 'minPrice cannot be greater than maxPrice',
    path: ['minPrice'],
  });

const mineQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: objectId.optional(),
});

module.exports = { createBody, updateBody, idParams, slugParams, listQuery, mineQuery, objectId };
