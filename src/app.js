const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const swaggerUi = require('swagger-ui-express');

const config = require('./config');
const logger = require('./utils/logger');
const requestId = require('./middlewares/requestId');
const { notFound, errorHandler } = require('./middlewares/errorHandler');
const routes = require('./routes');
const swaggerSpec = require('./docs/swagger');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      customProps: (req) => ({ requestId: req.id }),
      // Health probes are noisy; keep them out of the logs.
      autoLogging: { ignore: (req) => req.url.startsWith('/api/v1/health') },
    }),
  );

  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => {
        // Allow non-browser clients (no Origin header) and configured origins only.
        if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      credentials: true,
    }),
  );

  // Paystack signature checks need the raw body; the webhook route will mount
  // express.raw() on its own path before this parser when Module E is built.
  app.use(express.json({ limit: '1mb' }));

  app.use(
    rateLimit({
      windowMs: config.rateLimit.windowMinutes * 60 * 1000,
      max: config.rateLimit.max,
      standardHeaders: true,
      legacyHeaders: false,
      skip: () => config.isTest,
      handler: (req, res) =>
        res.status(429).json({
          success: false,
          error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down', details: null },
        }),
    }),
  );

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.use('/api/v1', routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
