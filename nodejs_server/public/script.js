document.addEventListener('DOMContentLoaded', () => {
    const accountIdSelect = document.getElementById('accountIdSelect');
    const summaryContent = document.getElementById('summaryContent');
    const openTradesTableBody = document.getElementById('openTradesTable').getElementsByTagName('tbody')[0];
    const closedTradesTableBody = document.getElementById('closedTradesTable').getElementsByTagName('tbody')[0];
    const openTradesCountSpan = document.getElementById('openTradesCount');
    const closedTradesCountSpan = document.getElementById('closedTradesCount');
    const lastUpdatedSpan = document.getElementById('lastUpdated');

    let openTradesBySymbolChart = null;
    let closedTradesProfitChart = null;
    let selectedAccountId = null;
    let ws = null; // WebSocket connection

    // Store local copies of data to allow incremental updates
    let localDataStore = {
        openTrades: [],
        closedTrades: [],
        summary: {}
    };

    const REFRESH_ACCOUNTS_INTERVAL = 60000; // Refresh account list every 60 seconds

    async function fetchAccounts() {
        try {
            const response = await fetch('/api/accounts');
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const accounts = await response.json();

            const currentSelectedValue = accountIdSelect.value;
            accountIdSelect.innerHTML = '<option value="">-- Select Account --</option>';

            if (accounts.length === 0) {
                accountIdSelect.innerHTML = '<option value="">-- No active accounts --</option>';
            } else {
                accounts.forEach(accId => {
                    const option = document.createElement('option');
                    option.value = accId;
                    option.textContent = accId;
                    accountIdSelect.appendChild(option);
                });
                if (currentSelectedValue && accounts.includes(currentSelectedValue)) {
                    accountIdSelect.value = currentSelectedValue;
                } else if (accounts.length > 0) {
                    accountIdSelect.value = accounts[0];
                }
            }

            if (accountIdSelect.value && accountIdSelect.value !== selectedAccountId) {
                 handleAccountChange(accountIdSelect.value);
            } else if (!accountIdSelect.value) {
                clearDisplay();
                selectedAccountId = null;
            }

        } catch (error) {
            console.error('Error fetching accounts:', error);
            accountIdSelect.innerHTML = '<option value="">-- Error loading accounts --</option>';
            clearDisplay();
        }
    }

    async function fetchInitialDataForAccount(accountId) {
        if (!accountId) {
            clearDisplay();
            localDataStore = { openTrades: [], closedTrades: [], summary: {} }; // Reset local store
            return;
        }
        console.log(`[HTTP] Fetching initial data for ${accountId}`);
        try {
            const response = await fetch(`/api/data/${accountId}`);
            if (!response.ok) {
                if (response.status === 404) console.warn(`No initial data for account ${accountId}.`);
                else throw new Error(`HTTP error! status: ${response.status}`);
                localDataStore = { openTrades: [], closedTrades: [], summary: {} }; // Reset on error/404
            } else {
                const data = await response.json();
                localDataStore = { // Store fetched data locally
                    openTrades: data.openTrades || [],
                    closedTrades: data.closedTrades || [],
                    summary: data.summary || {}
                };
            }
            updateFullDisplay(); // Update UI with this initial/reset data
            lastUpdatedSpan.textContent = `Initial load: ${new Date().toLocaleTimeString()}`;
        } catch (error) {
            console.error('Error fetching initial data for account:', accountId, error);
            localDataStore = { openTrades: [], closedTrades: [], summary: {} };
            updateFullDisplay(); // Show empty state
            summaryContent.innerHTML = '<p>Error loading initial data. Check console.</p>';
        }
    }

    function updateFullDisplay() {
        updateSummaryDisplay(localDataStore.summary);
        updateOpenTradesTable(localDataStore.openTrades);
        updateClosedTradesTable(localDataStore.closedTrades);
        updateCharts(localDataStore.openTrades, localDataStore.closedTrades);
    }

    function updateSummaryDisplay(summaryData) {
        if (summaryData && Object.keys(summaryData).length > 0) {
            summaryContent.innerHTML = `
                <p>Balance: <span>${summaryData.balance?.toFixed(2) || 'N/A'} ${summaryData.currency || ''}</span></p>
                <p>Equity: <span>${summaryData.equity?.toFixed(2) || 'N/A'} ${summaryData.currency || ''}</span></p>
                <p>Profit: <span>${summaryData.profit?.toFixed(2) || 'N/A'} ${summaryData.currency || ''}</span></p>
                <p>Margin: <span>${summaryData.margin?.toFixed(2) || 'N/A'}</span></p>
                <p>Free Margin: <span>${summaryData.marginFree?.toFixed(2) || 'N/A'}</span></p>
                <p>Margin Level: <span>${summaryData.marginLevel?.toFixed(2) || 'N/A'}%</span></p>
                <p>Server Time: <span>${summaryData.serverTimeEpoch ? new Date(summaryData.serverTimeEpoch * 1000).toLocaleString() : (summaryData.serverTime || 'N/A')}</span></p>
            `;
        } else {
            summaryContent.innerHTML = '<p>No summary data available.</p>';
        }
    }

    function updateOpenTradesTable(trades) {
        openTradesTableBody.innerHTML = '';
        openTradesCountSpan.textContent = trades.length;
        trades.forEach(trade => addTradeToTable(trade, openTradesTableBody, true));
    }

    function updateClosedTradesTable(trades) {
        closedTradesTableBody.innerHTML = '';
        closedTradesCountSpan.textContent = trades.length;
        trades.forEach(trade => addTradeToTable(trade, closedTradesTableBody, false));
    }

    function addTradeToTable(trade, tableBody, isOpenTrade) {
        const row = tableBody.insertRow(isOpenTrade ? 0 : -1); // Add new open trades at top, closed at bottom
        row.setAttribute('data-ticket', trade.ticket);
        row.insertCell().textContent = trade.ticket;
        row.insertCell().textContent = trade.symbol;
        row.insertCell().textContent = trade.typeName || trade.type;
        row.insertCell().textContent = trade.lots?.toFixed(2);
        row.insertCell().textContent = trade.openPrice?.toFixed(trade.symbol?.includes("JPY") ? 3 : 5);
        row.insertCell().textContent = trade.openTimeString || (trade.openTimeEpoch ? new Date(trade.openTimeEpoch * 1000).toLocaleString() : 'N/A');
        if (isOpenTrade) {
            row.insertCell().textContent = trade.stopLoss?.toFixed(trade.symbol?.includes("JPY") ? 3 : 5) || '0.00';
            row.insertCell().textContent = trade.takeProfit?.toFixed(trade.symbol?.includes("JPY") ? 3 : 5) || '0.00';
            row.insertCell().textContent = trade.currentPrice?.toFixed(trade.symbol?.includes("JPY") ? 3 : 5) || 'N/A';
        } else { // Closed trade
            row.insertCell().textContent = trade.closePrice?.toFixed(trade.symbol?.includes("JPY") ? 3 : 5);
            row.insertCell().textContent = trade.closeTimeString || (trade.closeTimeEpoch ? new Date(trade.closeTimeEpoch * 1000).toLocaleString() : 'N/A');
        }
        row.insertCell().textContent = trade.profit?.toFixed(2);
        row.insertCell().textContent = trade.comment;
    }

    function removeTradeFromTable(ticket, tableBody) {
        const row = tableBody.querySelector(`tr[data-ticket='${ticket}']`);
        if (row) row.remove();
    }

    function updateOrAddTradeInTable(trade, tableBody, isOpenTrade) {
        removeTradeFromTable(trade.ticket, tableBody);
        addTradeToTable(trade, tableBody, isOpenTrade);
    }

    function clearDisplay(clearAccountSelector = true) {
        if(clearAccountSelector && accountIdSelect) accountIdSelect.innerHTML = '<option value="">-- Select Account --</option>';
        if(summaryContent) summaryContent.innerHTML = '<p>Select an account to view data.</p>';
        if(openTradesTableBody) openTradesTableBody.innerHTML = '';
        if(closedTradesTableBody) closedTradesTableBody.innerHTML = '';
        if(openTradesCountSpan) openTradesCountSpan.textContent = '0';
        if(closedTradesCountSpan) closedTradesCountSpan.textContent = '0';
        if(lastUpdatedSpan) lastUpdatedSpan.textContent = '';
        if (openTradesBySymbolChart) openTradesBySymbolChart.destroy();
        if (closedTradesProfitChart) closedTradesProfitChart.destroy();
        openTradesBySymbolChart = null;
        closedTradesProfitChart = null;
        localDataStore = { openTrades: [], closedTrades: [], summary: {} };
    }

    function setupWebSocket() {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
        // Use wss:// if site is HTTPS, ws:// otherwise
        const wsProtocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
        const wsUrl = `${wsProtocol}${window.location.host}`; // Assumes WS server is on same host/port

        ws = new WebSocket(wsUrl);
        console.log(`[WS] Attempting to connect to ${wsUrl}`);

        ws.onopen = () => {
            console.log('[WS] Connected to server.');
            lastUpdatedSpan.textContent = `Live updates active. Last event: ${new Date().toLocaleTimeString()}`;
            // Optionally, send subscription message if server requires it:
            // if (selectedAccountId) ws.send(JSON.stringify({ type: 'subscribe', accountId: selectedAccountId }));
        };

        ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                console.log('[WS] Received:', message);
                lastUpdatedSpan.textContent = `Live update: ${new Date().toLocaleTimeString()}`;

                if (message.payload?.accountId !== selectedAccountId && message.event !== 'NEW_ACCOUNT_DETECTED') {
                    // console.log(`[WS] Ignoring event for non-selected account: ${message.payload?.accountId}`);
                    return;
                }

                switch (message.event) {
                    case 'HEARTBEAT': // Example, can be ignored or used to show "connected" status
                        // localDataStore.summary.lastSeen = message.payload.lastSeen; // Update if needed
                        break;
                    case 'BATCH_OPEN_TRADES_UPDATE':
                        localDataStore.openTrades = message.payload.trades || [];
                        updateOpenTradesTable(localDataStore.openTrades);
                        updateCharts(localDataStore.openTrades, localDataStore.closedTrades);
                        break;
                    case 'BATCH_CLOSED_TRADES_UPDATE':
                        localDataStore.closedTrades = message.payload.trades || [];
                        updateClosedTradesTable(localDataStore.closedTrades);
                        updateCharts(localDataStore.openTrades, localDataStore.closedTrades);
                        break;
                    case 'LIVE_TRADE_EVENT':
                        handleLiveTradeEvent(message.payload); // payload here is {accountId, eventType, trade, timestamp}
                        break;
                    case 'ACCOUNT_SUMMARY_UPDATE':
                        localDataStore.summary = message.payload.summary || {};
                        updateSummaryDisplay(localDataStore.summary);
                        break;
                    case 'NEW_ACCOUNT_DETECTED':
                        // If a new account is detected by the server, refresh the dropdown
                        // To avoid rapid refreshes if many accounts connect, could debounce this
                        console.log("[WS] New account detected on server, refreshing account list.");
                        fetchAccounts();
                        break;
                    default:
                        console.warn('[WS] Unknown event type:', message.event);
                }
            } catch (error) {
                console.error('[WS] Error processing message:', error, event.data);
            }
        };

        ws.onerror = (error) => {
            console.error('[WS] Error:', error);
            lastUpdatedSpan.textContent = 'WebSocket Error. See console.';
        };

        ws.onclose = () => {
            console.log('[WS] Disconnected from server.');
            lastUpdatedSpan.textContent = 'Disconnected. Attempting to reconnect...';
            // Simple reconnection attempt
            setTimeout(setupWebSocket, 5000); // Try to reconnect every 5 seconds
        };
    }

    function handleLiveTradeEvent(payload) {
        const { eventType, trade } = payload; // trade is the actual trade data
        if (!trade || !trade.ticket) return;

        switch (eventType) {
            case 'ORDER_OPENED':
                localDataStore.openTrades = localDataStore.openTrades.filter(t => t.ticket !== trade.ticket); // Remove if exists
                localDataStore.openTrades.unshift(trade); // Add to top
                if(localDataStore.openTrades.length > 2000) localDataStore.openTrades.pop(); // Limit size
                updateOrAddTradeInTable(trade, openTradesTableBody, true);
                break;
            case 'ORDER_MODIFIED':
                const openIdx = localDataStore.openTrades.findIndex(t => t.ticket === trade.ticket);
                if (openIdx !== -1) localDataStore.openTrades[openIdx] = trade;
                else localDataStore.openTrades.unshift(trade); // Add if not found (e.g. pending order update)
                updateOrAddTradeInTable(trade, openTradesTableBody, true);
                break;
            case 'ORDER_CLOSED':
                localDataStore.openTrades = localDataStore.openTrades.filter(t => t.ticket !== trade.ticket);
                removeTradeFromTable(trade.ticket, openTradesTableBody);

                localDataStore.closedTrades = localDataStore.closedTrades.filter(t => t.ticket !== trade.ticket); // Remove if exists
                localDataStore.closedTrades.unshift(trade); // Add to top
                if(localDataStore.closedTrades.length > 2000) localDataStore.closedTrades.pop(); // Limit size
                updateOrAddTradeInTable(trade, closedTradesTableBody, false);
                break;
            case 'ORDER_VANISHED':
                localDataStore.openTrades = localDataStore.openTrades.filter(t => t.ticket !== trade.ticket);
                removeTradeFromTable(trade.ticket, openTradesTableBody);
                break;
        }
        openTradesCountSpan.textContent = localDataStore.openTrades.length;
        closedTradesCountSpan.textContent = localDataStore.closedTrades.length;
        updateCharts(localDataStore.openTrades, localDataStore.closedTrades);
    }

    function updateCharts(openTrades, closedTrades) {
        const openTradesSymbolCounts = openTrades.reduce((acc, trade) => {
            acc[trade.symbol] = (acc[trade.symbol] || 0) + 1;
            return acc;
        }, {});

        const openTradesChartCtx = document.getElementById('openTradesBySymbolChart').getContext('2d');
        if (openTradesBySymbolChart) openTradesBySymbolChart.destroy();
        openTradesBySymbolChart = new Chart(openTradesChartCtx, {
            type: 'pie',
            data: { labels: Object.keys(openTradesSymbolCounts), datasets: [{ data: Object.values(openTradesSymbolCounts), backgroundColor: randomColorArray(Object.keys(openTradesSymbolCounts).length) }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { title: { display: true, text: 'Open Trades Distribution by Symbol (Count)' } } }
        });

        const lastNClosedTrades = closedTrades.slice(0, 20).reverse();
        const closedTradesProfitData = lastNClosedTrades.map(trade => trade.profit);
        const closedTradesProfitLabels = lastNClosedTrades.map(trade => `${trade.symbol} #${trade.ticket}`);

        const closedTradesProfitCtx = document.getElementById('closedTradesProfitChart').getContext('2d');
        if (closedTradesProfitChart) closedTradesProfitChart.destroy();
        closedTradesProfitChart = new Chart(closedTradesProfitCtx, {
            type: 'bar',
            data: {
                labels: closedTradesProfitLabels,
                datasets: [{ label: 'P/L', data: closedTradesProfitData, backgroundColor: closedTradesProfitData.map(p => p >= 0 ? 'rgba(75, 192, 192, 0.6)' : 'rgba(255, 99, 132, 0.6)') }]
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { title: { display: true, text: 'P/L of Last 20 Closed Trades' }, legend: { display: false } }, scales: { y: { beginAtZero: true } } }
        });
    }

    function randomColorArray(count) {
        const colors = [];
        for (let i = 0; i < count; i++) colors.push(`hsl(${Math.random() * 360}, 70%, 70%)`);
        return colors;
    }

    function handleAccountChange(newAccountId) {
        selectedAccountId = newAccountId;
        if (selectedAccountId) {
            fetchInitialDataForAccount(selectedAccountId); // Fetch initial data for the new account
            // If WS is open and supports per-account subscription, you might send a message here
            // ws.send(JSON.stringify({ type: 'subscribe', accountId: selectedAccountId }));
        } else {
            clearDisplay();
        }
    }

    accountIdSelect.addEventListener('change', (event) => handleAccountChange(event.target.value));

    // Initial load
    fetchAccounts(); // Fetches accounts, and if one is auto-selected, calls handleAccountChange -> fetchInitialDataForAccount
    setupWebSocket(); // Setup WebSocket connection
    setInterval(fetchAccounts, REFRESH_ACCOUNTS_INTERVAL); // Periodically refresh account list
});
