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

// Workforce Partner PWA (Aug 26 meeting) — a real workforce_partner-role
// login gets this automatically (same as admin/super_admin), and anyone
// else (Liam himself is admin, not workforce_partner) gets it via the
// per-person can_use_wfp_pwa flag instead — Joy: "Liam and the Workforce
// Partners or whoever I give it to". Used both for the /wfp page shell
// (server.js) and as the underlying API gate on routes/centres.js and
// routes/educators.js, so a person who can open the app shell can
// actually call its APIs too — those two checks must never drift apart.
function requirePwaAccess(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Login required' });
  const allowedRole = ['admin', 'super_admin', 'workforce_partner'].includes(req.user.role);
  if (!allowedRole && !req.user.can_use_wfp_pwa) {
    return res.status(403).json({ error: 'You do not have access to this' });
  }
  next();
}

// Calibration panel (Sophia/Lorie/Adzi/Vicky), same per-person pattern as
// requireTrainingBuilder — super_admin (Joy) always has it, everyone else
// needs the grant regardless of role (an admin like Liam/Prince/Yuvraj, or
// qa_view's Jemina, is NOT automatically on the panel just by role).
function requireCalibrationAccess(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Login required' });
  if (req.user.role !== 'super_admin' && !req.user.can_calibrate_calls) {
    return res.status(403).json({ error: 'You do not have access to this' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, requireSuperAdmin, requireRole, requireTrainingBuilder, requireOutreachListBuilder, requirePwaAccess, requireCalibrationAccess };
