function requireAuth(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Login required' });
  if (!req.user.active) return res.status(403).json({ error: 'Account disabled' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Login required' });
  if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Login required' });
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
}

// General-purpose role gate for roles that don't fit the admin/super_admin
// binary — e.g. 'qa_view', a narrow role scoped to specific admin-panel
// features (articles, FAQ management, call quality) without the broad
// access requireAdmin grants everywhere else. Kept separate from
// requireAdmin/requireSuperAdmin so those two stay simple binary checks
// wherever they're already used.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Login required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have access to this' });
    }
    next();
  };
}

module.exports = { requireAuth, requireAdmin, requireSuperAdmin, requireRole };
