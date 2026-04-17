// adminPrivilege.js
// Middleware to enforce admin privilege and reason-based access

module.exports = function adminPrivilege(requiredMode = 'any') {
  return (req, res, next) => {
    // Example: req.admin = { id, role, mode } set by auth middleware
    if (!req.admin || req.admin.role !== 'admin') {
      return res.status(403).json({ error: 'Admin privilege required' });
    }
    // Optional: enforce operational mode (dashboard, support, safety, repair, etc.)
    if (requiredMode !== 'any' && req.admin.mode !== requiredMode) {
      return res.status(403).json({ error: `Admin mode '${requiredMode}' required` });
    }
    next();
  };
};
