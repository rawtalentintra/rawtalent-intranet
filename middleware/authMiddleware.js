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

// Build Training is granted per-person (e.g. Sophia), not per-role — an
// admin flag rather than a role, since opening it to every admin isn't
// what was asked for. super_admin still has it regardless, same as every
// other admin-panel feature.
function requireTrainingBuilder(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Login required' });
  if (req.user.role !== 'super_admin' && !req.user.can_build_training) {
    return res.status(403).json({ error: 'You do not have access to this' });
  }
  next();
}

// Educator Outreach list builder (Decision Area 1, 2026-08-22) — granted
// per-person (e.g. Adzi/Laurie/Vicky), not per-role, same pattern as
// requireTrainingBuilder. Unlike that one, admin (not just super_admin)
// always has access here too — Outreach sits alongside Micropods/Leads,
// which admin already has unconditionally.
function requireOutreachListBuilder(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Login required' });
  if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && !req.user.can_create_outreach_lists) {
    return res.status(403).json({ error: 'You do not have access to this' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, requireSuperAdmin, requireRole, requireTrainingBuilder, requireOutreachListBuilder };
