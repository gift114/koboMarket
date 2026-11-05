const swaggerJsdoc = require('swagger-jsdoc');

// OpenAPI 3 definition. Each module adds its own paths with JSDoc @openapi blocks
// in its routes file; shared pieces (error shape, auth, Idempotency-Key) live here.
const spec = swaggerJsdoc({
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'KoboMarket API',
      version: '0.1.0',
      description:
        'Multi-vendor marketplace with wallets and escrow. All money values are integers in kobo (100 kobo = N1).',
    },
    servers: [{ url: '/api/v1', description: 'API v1' }],
    tags: [
      { name: 'Health' },
      { name: 'Auth' },
      { name: 'Users' },
      { name: 'Vendors' },
      { name: 'Products' },
      { name: 'Cart' },
      { name: 'Wallet' },
      { name: 'Orders' },
      { name: 'Disputes' },
      { name: 'Payouts' },
      { name: 'Notifications' },
      { name: 'Admin' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      parameters: {
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
          description:
            'Unique key per logical request. Same key + same body returns the original response; same key + different body returns 409.',
          schema: { type: 'string', minLength: 8, maxLength: 128 },
        },
      },
      schemas: {
        ErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'VALIDATION_ERROR' },
                message: { type: 'string', example: 'Validation failed' },
                details: { nullable: true },
              },
            },
          },
        },
      },
    },
  },
  apis: ['./src/routes/*.js', './src/modules/**/*.routes.js'],
});

module.exports = spec;
