/**
 * Validate req.body / req.query / req.params with Zod schemas.
 *
 *   router.post('/register', validate({ body: registerSchema }), controller.register);
 *
 * Parsed (and coerced/stripped) values replace the originals so controllers
 * only ever see validated data. ZodError is handled by the central error handler.
 */
module.exports = function validate(schemas) {
  return (req, res, next) => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params);
      if (schemas.query) {
        // Express 4 allows reassigning req.query; keep parsed copy on req.validatedQuery as well.
        req.validatedQuery = schemas.query.parse(req.query);
        req.query = req.validatedQuery;
      }
      if (schemas.body) req.body = schemas.body.parse(req.body);
      next();
    } catch (err) {
      next(err);
    }
  };
};
