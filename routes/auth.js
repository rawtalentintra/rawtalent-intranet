const express = require('express');
const passport = require('passport');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../services/activityLog');

router.post('/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return res.status(500).json({ error: 'Server error' });
    if (!user) return res.status(401).json({ error: info?.message || 'Invalid credentials' });
    req.logIn(user, async (err) => {
      if (err) return res.status(500).json({ error: 'Login failed' });
      try {
        await getDb().execute({ sql: "UPDATE users SET last_login = now() WHERE id = ?", args: [user.id] });
        res.json({ success: true, user: { email: user.email, name: user.name, role: user.role } });
      } catch (err) {
        res.status(500).json({ error: 'Server error' });
      }
    });
  })(req, res, next);
});

if (process.env.GOOGLE_CLIENT_ID) {
  router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
  router.get('/google/callback',
    passport.authenticate('google', { failureRedirect: '/login.html?error=1' }),
    async (req, res) => {
      try {
        await getDb().execute({ sql: "UPDATE users SET last_login = now() WHERE id = ?", args: [req.user.id] });
      } catch (err) {
        console.error('Google login last_login update error:', err.message);
      }
      res.redirect('/');
    }
  );
}

router.post('/logout', (req, res) => {
  req.logout((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    res.json({ success: true });
  });
});

router.get('/me', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
  const info = { email: req.user.email, name: req.user.name, role: req.user.role, canBuildTraining: !!req.user.can_build_training };
  if (req.session.impersonatorId) {
    try {
      const origRes = await getDb().execute({ sql: 'SELECT name, email FROM users WHERE id = ?', args: [req.session.impersonatorId] });
      const original = origRes.rows[0];
      info.impersonating = true;
      info.impersonatorName = original?.name || original?.email || null;
    } catch { info.impersonating = true; }
  }
  res.json(info);
});

// Not gated by role — if a super_admin is impersonating a plain "user"
// account, requireAdmin would otherwise lock them out of the one route that
// lets them return to their own account. The impersonatorId marker on the
// session itself is the authorization check.
router.post('/stop-impersonating', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
  const impersonatorId = req.session.impersonatorId;
  if (!impersonatorId) return res.status(400).json({ error: 'Not currently logged in as another user' });

  try {
    const db = getDb();
    const originalRes = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [impersonatorId] });
    const original = originalRes.rows[0];
    if (!original) return res.status(404).json({ error: 'Original account not found' });

    const impersonatedEmail = req.user.email;

    req.login(original, (err) => {
      if (err) return res.status(500).json({ error: 'Failed to return to your account' });
      delete req.session.impersonatorId;
      req.session.save(async (saveErr) => {
        if (saveErr) return res.status(500).json({ error: 'Failed to return to your account' });
        await logActivity('session', impersonatedEmail, 'impersonation-end', `${original.email} returned from impersonating ${impersonatedEmail}`, original.email);
        res.json({ success: true, user: { email: original.email, name: original.name, role: original.role } });
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/change-password', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both fields are required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });

  try {
    const db = getDb();
    const userRes = await db.execute({ sql: 'SELECT password_hash FROM users WHERE id = ?', args: [req.user.id] });
    const user = userRes.rows[0];
    if (!user || !user.password_hash) {
      return res.status(400).json({ error: 'Password change is not available for Google sign-in accounts' });
    }
    const match = await bcrypt.compare(currentPassword, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(newPassword, 12);
    await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE id = ?', args: [hash, req.user.id] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
