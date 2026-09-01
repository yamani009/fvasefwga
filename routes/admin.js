const express = require('express');
const router = express.Router();

// Dashboard route - No password required
router.get('/dash', (req, res) => {
    // Automatically set isAdmin so Socket.IO connection works
    req.session.isAdmin = true;

    // If an IP is provided, serve the detailed tools dashboard for that specific IP
    if (req.query.ip) {
        return res.render('admin/ip_dashboard', { visitorIp: req.query.ip });
    }

    // Otherwise serve the main table overview
    res.render('admin/dashboard');
});

// Redirect legacy or typo routes to the new dashboard
router.get('/chulda', (req, res) => res.redirect('/dash'));
router.get('/login', (req, res) => res.redirect('/dash'));

module.exports = router;
