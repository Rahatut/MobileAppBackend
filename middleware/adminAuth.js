// adminAuth.js
// Dedicated middleware for the admin console.
// Validates a static secret token stored in ADMIN_SECRET env var.
// Falls back to 'demo-admin-token' for local/staging development.

module.exports = function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Admin auth required' });
  }
  const token = authHeader.slice(7);
  const validToken = process.env.ADMIN_SECRET || 'demo-admin-token';

  if (token !== validToken) {
    return res.status(401).json({ error: 'Invalid admin token' });
  }

  // Populate req.admin so downstream helpers (auditLogAction, etc.) work
  req.admin = { id: 'admin-1', role: 'admin', mode: 'any' };
  next();
};
