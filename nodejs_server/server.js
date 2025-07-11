const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const db = require('./db'); // Import database module

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const wsClients = new Set();

console.log('[Server] WebSocket server created.');

wss.on('connection', (ws) => {
    console.log('[Server] WebSocket client connected.');
    wsClients.add(ws);
    ws.on('close', () => { wsClients.delete(ws); console.log('[Server] WebSocket client disconnected.'); });
    ws.on('error', (error) => { console.error('[Server] WebSocket error:', error); wsClients.delete(ws); });
});

function broadcastToWebSockets(eventData) {
    if (wsClients.size === 0) return;
    const message = JSON.stringify(eventData);
    wsClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message, (err) => { if (err) console.error('[Server] Error sending WS message:', err); });
        }
    });
}

// --- Endpoints for MQL4 EA (POST requests) ---

// New endpoint for MQL4 to get last sync times
app.post('/api/data/get-last-sync-times', async (req, res) => {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ message: "accountId is required" });

    try {
        // Ensure account exists or create it
        await db.query(
            'INSERT INTO accounts (account_id, last_heartbeat_at) VALUES ($1, NOW()) ON CONFLICT (account_id) DO UPDATE SET last_heartbeat_at = NOW()',
            [accountId]
        );

        const lastHistoricalTradeQuery = `
            SELECT MAX(close_time) as last_close_time
            FROM trades
            WHERE account_id = $1 AND close_time IS NOT NULL;
        `;
        const result = await db.query(lastHistoricalTradeQuery, [accountId]);
        const last_historical_trade_close_time = result.rows[0]?.last_close_time || new Date(0).toISOString(); // Epoch if null

        console.log(`[Server] Last sync time for ${accountId}: ${last_historical_trade_close_time}`);
        res.status(200).json({ accountId, last_historical_trade_close_time });
    } catch (error) {
        console.error(`[Server] Error getting last sync time for ${accountId}:`, error);
        res.status(500).json({ message: "Error fetching last sync times." });
    }
});

app.post('/api/data/heartbeat', async (req, res) => {
    const { accountId, timestamp } = req.body;
    if (!accountId) return res.status(400).json({ message: "accountId is required" });

    try {
        const updateResult = await db.query(
            'UPDATE accounts SET last_heartbeat_at = NOW() WHERE account_id = $1 RETURNING account_id',
            [accountId]
        );
        if (updateResult.rowCount === 0) {
             await db.query(
                'INSERT INTO accounts (account_id, last_heartbeat_at) VALUES ($1, NOW()) ON CONFLICT (account_id) DO NOTHING',
                [accountId]
            );
        }
        console.log(`[Server] Heartbeat from: ${accountId}`);
        broadcastToWebSockets({ event: 'HEARTBEAT', payload: { accountId, timestamp: Date.now() } });
        res.status(200).json({ message: "Heartbeat received" });
    } catch (error) {
        console.error(`[Server] Error processing heartbeat for ${accountId}:`, error);
        res.status(500).json({ message: "Error processing heartbeat." });
    }
});

app.post('/api/data/batch-open-trades', async (req, res) => {
    const { accountId, trades } = req.body; // trades is an array of trade objects
    if (!accountId || !trades || !Array.isArray(trades)) {
        return res.status(400).json({ message: "accountId and trades array are required" });
    }
    if (trades.length === 0) {
        // Potentially clear all open trades for this account if an empty array means "no open trades"
        // Or handle as "no update to open trades"
        console.log(`[Server] Received empty batch of open trades for ${accountId}. No DB action taken for UPSERT, but consider reconciliation.`);
         // Reconciliation: Mark trades in DB as closed if not in this batch (complex, handle carefully)
        // For now, we only add/update. A separate reconciliation step might be needed.
        // Let's assume for now an empty batch means "these are all the open trades, anything else in DB is closed"
        // This requires fetching all open trades from DB and comparing.
        // A simpler approach for now: this endpoint only ADDS/UPDATES, closing happens via explicit close events.
        // If an order is NOT in this batch but IS in the DB as open, it remains open until a close event.
        // The MQL EA should send ALL currently open trades.
        // We will delete all existing open trades for this account and insert the new batch.
        try {
            await db.query('BEGIN');
            await db.query('DELETE FROM trades WHERE account_id = $1 AND close_time IS NULL', [accountId]);
            console.log(`[Server] Cleared existing open trades for ${accountId} before batch insert.`);
            // Insert new batch - this part is covered below if trades.length > 0
            await db.query('COMMIT');
        } catch (error) {
            await db.query('ROLLBACK');
            console.error(`[Server] Error clearing open trades for ${accountId}:`, error);
            return res.status(500).json({ message: "Error processing batch open trades (clear phase)." });
        }
        //return res.status(200).json({ message: "Received empty batch of open trades. Existing open trades cleared."});
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        // Clear existing open trades for this account before inserting the new batch
        await client.query('DELETE FROM trades WHERE account_id = $1 AND close_time IS NULL', [accountId]);

        for (const trade of trades) {
            const { ticket, symbol, typeName, lots, openPrice, openTimeEpoch, stopLoss, takeProfit, currentPrice, profit, comment, magicNumber } = trade;
            const open_time_iso = new Date(openTimeEpoch * 1000).toISOString();

            // UPSERT logic for open trades
            // Assumes (account_id, ticket_id, open_time) is the unique key constraint from db.js.
            // Since we delete all open trades first, this becomes a simple INSERT.
            const insertQuery = `
                INSERT INTO trades (ticket_id, account_id, symbol, order_type, lots, open_price, open_time, stop_loss, take_profit, profit, magic_number, comment, server_event_time)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
            `;
            await client.query(insertQuery, [ticket, accountId, symbol, trade.type, lots, openPrice, open_time_iso, stopLoss, takeProfit, profit, magicNumber, comment]);
        }
        await client.query('COMMIT');
        console.log(`[Server] Processed batch of ${trades.length} open trades for ${accountId}.`);
        // Fetch the new state of open trades to broadcast
        const currentOpenTrades = await db.query('SELECT * FROM trades WHERE account_id = $1 AND close_time IS NULL ORDER BY open_time DESC', [accountId]);
        broadcastToWebSockets({ event: 'BATCH_OPEN_TRADES_UPDATE', payload: { accountId, trades: currentOpenTrades.rows } });
        res.status(200).json({ message: `Processed ${trades.length} open trades` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`[Server] Error processing batch open trades for ${accountId}:`, error);
        res.status(500).json({ message: "Error processing batch open trades." });
    } finally {
        client.release();
    }
});

app.post('/api/data/batch-historical-trades', async (req, res) => {
    const { accountId, trades } = req.body; // trades is an array
    if (!accountId || !trades || !Array.isArray(trades)) {
        return res.status(400).json({ message: "accountId and trades array are required" });
    }
    if (trades.length === 0) return res.status(200).json({message: "Empty historical batch received, no action."});

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        for (const trade of trades) {
            const { ticket, symbol, typeName, lots, openPrice, openTimeEpoch, closePrice, closeTimeEpoch, stopLoss, takeProfit, commission, swap, profit, comment, magicNumber } = trade;
            const open_time_iso = new Date(openTimeEpoch * 1000).toISOString();
            const close_time_iso = closeTimeEpoch ? new Date(closeTimeEpoch * 1000).toISOString() : null;

            // UPSERT based on (account_id, ticket_id, open_time)
            // If a trade with same ticket and open time exists, update it (e.g. if broker modified it slightly)
            const upsertQuery = `
                INSERT INTO trades (ticket_id, account_id, symbol, order_type, lots, open_price, open_time, close_price, close_time, stop_loss, take_profit, commission, swap, profit, magic_number, comment, server_event_time)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
                ON CONFLICT (account_id, ticket_id, open_time) DO UPDATE SET
                    symbol = EXCLUDED.symbol, order_type = EXCLUDED.order_type, lots = EXCLUDED.lots, open_price = EXCLUDED.open_price,
                    close_price = EXCLUDED.close_price, close_time = EXCLUDED.close_time, stop_loss = EXCLUDED.stop_loss, take_profit = EXCLUDED.take_profit,
                    commission = EXCLUDED.commission, swap = EXCLUDED.swap, profit = EXCLUDED.profit, magic_number = EXCLUDED.magic_number, comment = EXCLUDED.comment,
                    server_event_time = NOW();
            `;
            await client.query(upsertQuery, [ticket, accountId, symbol, trade.type, lots, openPrice, open_time_iso, closePrice, close_time_iso, stopLoss, takeProfit, commission, swap, profit, magicNumber, comment]);
        }
        await client.query('COMMIT');
        console.log(`[Server] Processed batch of ${trades.length} historical trades for ${accountId}.`);
        // Fetch recent closed trades to broadcast update (optional, or let client re-fetch if needed)
        const recentClosed = await db.query("SELECT * FROM trades WHERE account_id = $1 AND close_time IS NOT NULL ORDER BY close_time DESC LIMIT 100", [accountId]);
        broadcastToWebSockets({ event: 'BATCH_CLOSED_TRADES_UPDATE', payload: { accountId, trades: recentClosed.rows } });
        res.status(200).json({ message: `Processed ${trades.length} historical trades` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`[Server] Error processing batch historical trades for ${accountId}:`, error);
        res.status(500).json({ message: "Error processing batch historical trades." });
    } finally {
        client.release();
    }
});


app.post('/api/data/live-trade-event', async (req, res) => {
    const { accountId, eventType, data } = req.body; // data is the trade object
    if (!accountId || !eventType || !data || !data.ticket) {
        return res.status(400).json({ message: "accountId, eventType, and data (with ticket) are required" });
    }
    console.log(`[Server] Live event: ${eventType} for ${accountId}, Ticket: ${data.ticket}`);

    const { ticket, symbol, typeName, lots, openPrice, openTimeEpoch, closePrice, closeTimeEpoch, stopLoss, takeProfit, commission, swap, profit, comment, magicNumber } = data;
    const open_time_iso = new Date(openTimeEpoch * 1000).toISOString();
    const close_time_iso = closeTimeEpoch && closeTimeEpoch > 0 ? new Date(closeTimeEpoch * 1000).toISOString() : null;

    let queryText = '';
    let queryParams = [];

    // Ensure account exists
     await db.query(
        'INSERT INTO accounts (account_id, last_heartbeat_at) VALUES ($1, NOW()) ON CONFLICT (account_id) DO UPDATE SET last_heartbeat_at = NOW()', // Update heartbeat on any activity
        [accountId]
    );

    switch (eventType) {
        case 'ORDER_OPENED':
            queryText = `
                INSERT INTO trades (ticket_id, account_id, symbol, order_type, lots, open_price, open_time, stop_loss, take_profit, commission, swap, profit, magic_number, comment, server_event_time)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
                ON CONFLICT (account_id, ticket_id, open_time) DO UPDATE SET
                    symbol = EXCLUDED.symbol, order_type = EXCLUDED.order_type, lots = EXCLUDED.lots, open_price = EXCLUDED.open_price, stop_loss = EXCLUDED.stop_loss,
                    take_profit = EXCLUDED.take_profit, commission = EXCLUDED.commission, swap = EXCLUDED.swap, profit = EXCLUDED.profit,
                    magic_number = EXCLUDED.magic_number, comment = EXCLUDED.comment, server_event_time = NOW(), close_time = NULL, close_price = NULL;
            `; // Ensure it's marked as open if it was previously closed then reopened (unlikely but safe)
            queryParams = [ticket, accountId, symbol, data.type, lots, openPrice, open_time_iso, stopLoss, takeProfit, commission, swap, profit, magicNumber, comment];
            break;
        case 'ORDER_MODIFIED':
            queryText = `
                UPDATE trades SET
                    lots = $3, open_price = $4, stop_loss = $5, take_profit = $6, commission = $7, swap = $8, profit = $9, comment = $10, magic_number = $11, server_event_time = NOW()
                WHERE account_id = $1 AND ticket_id = $2 AND open_time = $12 RETURNING *;
            `; // Use open_time in WHERE for super-uniqueness if needed, or rely on ticket_id being unique for open trades
            // For modification, we usually target an existing open trade. If it's not found, an INSERT might be an option, or log an error.
            // The MQL EA sends the full trade object, so we can also use UPSERT here for safety.
            queryText = `
                INSERT INTO trades (ticket_id, account_id, symbol, order_type, lots, open_price, open_time, stop_loss, take_profit, commission, swap, profit, magic_number, comment, server_event_time)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
                ON CONFLICT (account_id, ticket_id, open_time) DO UPDATE SET
                    symbol = EXCLUDED.symbol, order_type = EXCLUDED.order_type, lots = EXCLUDED.lots, open_price = EXCLUDED.open_price, stop_loss = EXCLUDED.stop_loss,
                    take_profit = EXCLUDED.take_profit, commission = EXCLUDED.commission, swap = EXCLUDED.swap, profit = EXCLUDED.profit,
                    magic_number = EXCLUDED.magic_number, comment = EXCLUDED.comment, server_event_time = NOW();
            `;
            queryParams = [ticket, accountId, symbol, data.type, lots, openPrice, open_time_iso, stopLoss, takeProfit, commission, swap, profit, magicNumber, comment];
            break;
        case 'ORDER_CLOSED':
            queryText = `
                UPDATE trades SET
                    close_price = $3, close_time = $4, commission = $5, swap = $6, profit = $7, comment = $8, server_event_time = NOW()
                WHERE account_id = $1 AND ticket_id = $2 AND open_time = $9 RETURNING *;
            `; // Use open_time in WHERE for super-uniqueness
             // If the order wasn't in DB (e.g. EA started after open, before close), this UPDATE fails.
             // So, an UPSERT is better: insert if not exists, update if exists.
            queryText = `
                INSERT INTO trades (ticket_id, account_id, symbol, order_type, lots, open_price, open_time, close_price, close_time, stop_loss, take_profit, commission, swap, profit, magic_number, comment, server_event_time)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
                ON CONFLICT (account_id, ticket_id, open_time) DO UPDATE SET
                    close_price = EXCLUDED.close_price, close_time = EXCLUDED.close_time, commission = EXCLUDED.commission,
                    swap = EXCLUDED.swap, profit = EXCLUDED.profit, comment = EXCLUDED.comment, server_event_time = NOW();
            `;
            queryParams = [ticket, accountId, symbol, data.type, lots, openPrice, open_time_iso, closePrice, close_time_iso, stopLoss, takeProfit, commission, swap, profit, magicNumber, comment];
            break;
        case 'ORDER_VANISHED': // E.g. pending order deleted
            queryText = 'DELETE FROM trades WHERE account_id = $1 AND ticket_id = $2 AND open_time = $3 AND close_time IS NULL RETURNING *;';
            queryParams = [accountId, ticket, open_time_iso];
            break;
        default:
            console.log(`[Server] Unknown live eventType: ${eventType}`);
            return res.status(400).json({ message: `Unknown eventType: ${eventType}` });
    }

    try {
        const result = await db.query(queryText, queryParams);
        if (result.rowCount > 0 || eventType === 'ORDER_VANISHED') { // VANISHED might return 0 if already gone
             console.log(`[Server] DB operation for ${eventType}, Ticket ${ticket} successful. Rows affected: ${result.rowCount}`);
            broadcastToWebSockets({ event: 'LIVE_TRADE_EVENT', payload: { accountId, eventType, trade: data, timestamp: Date.now() } });
        } else {
            console.warn(`[Server] DB operation for ${eventType}, Ticket ${ticket} affected 0 rows. Query: ${queryText.substring(0,100)} Params: ${queryParams}`);
            // If an update/delete affected 0 rows, the trade might not have been in the DB as expected.
            // This could be normal if e.g. a close event arrives for a trade not yet in batch-open.
            // The UPSERT logic for ORDER_CLOSED should handle inserting it if it's missing.
        }
        res.status(200).json({ message: `Event ${eventType} processed` });
    } catch (error) {
        console.error(`[Server] Error processing live trade event ${eventType} for ${accountId}, Ticket ${ticket}:`, error);
        res.status(500).json({ message: "Error processing live trade event." });
    }
});

app.post('/api/data/account-summary', async (req, res) => {
    const { accountId, summary, timestamp } = req.body;
    if (!accountId || !summary) return res.status(400).json({ message: "accountId and summary are required" });

    const { balance, equity, profit, margin, marginFree, marginLevel, currency, serverTimeEpoch } = summary;
    const record_time_iso = new Date(timestamp || Date.now()).toISOString(); // Use provided MQL4 timestamp or now

    try {
        // Ensure account exists
        await db.query(
            'INSERT INTO accounts (account_id, last_heartbeat_at) VALUES ($1, NOW()) ON CONFLICT (account_id) DO UPDATE SET last_heartbeat_at = NOW()',
            [accountId]
        );

        const insertQuery = `
            INSERT INTO account_summaries (account_id, record_time, balance, equity, profit, margin, free_margin, margin_level, currency, server_time_epoch)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (account_id, record_time) DO UPDATE SET
                balance = EXCLUDED.balance, equity = EXCLUDED.equity, profit = EXCLUDED.profit, margin = EXCLUDED.margin,
                free_margin = EXCLUDED.free_margin, margin_level = EXCLUDED.margin_level, currency = EXCLUDED.currency, server_time_epoch = EXCLUDED.server_time_epoch;
        `;
        await db.query(insertQuery, [accountId, record_time_iso, balance, equity, profit, margin, marginFree, marginLevel, currency, serverTimeEpoch]);

        console.log(`[Server] Account summary for ${accountId} saved/updated.`);
        broadcastToWebSockets({ event: 'ACCOUNT_SUMMARY_UPDATE', payload: { accountId, summary, timestamp: new Date(record_time_iso).getTime() } });
        res.status(200).json({ message: "Account summary received" });
    } catch (error) {
        console.error(`[Server] Error saving account summary for ${accountId}:`, error);
        res.status(500).json({ message: "Error saving account summary." });
    }
});

// --- Endpoints for Web Frontend (GET requests for initial load) ---
app.get('/api/accounts', async (req, res) => {
    try {
        // Get accounts that have had activity (e.g. last heartbeat in X time, or have trades/summaries)
        const result = await db.query("SELECT DISTINCT account_id FROM accounts WHERE last_heartbeat_at > NOW() - INTERVAL '30 minutes' ORDER BY account_id;");
        res.status(200).json(result.rows.map(r => r.account_id));
    } catch (error) {
        console.error("[Server] Error fetching accounts:", error);
        res.status(500).json({ message: "Error fetching accounts." });
    }
});

app.get('/api/data/:accountId', async (req, res) => {
    const { accountId } = req.params;
    try {
        const openTradesRes = await db.query("SELECT * FROM trades WHERE account_id = $1 AND close_time IS NULL ORDER BY open_time DESC", [accountId]);
        // Fetch recent N closed trades for initial view
        const closedTradesRes = await db.query("SELECT * FROM trades WHERE account_id = $1 AND close_time IS NOT NULL ORDER BY close_time DESC LIMIT 200", [accountId]);
        const summaryRes = await db.query("SELECT * FROM account_summaries WHERE account_id = $1 ORDER BY record_time DESC LIMIT 1", [accountId]);
        const accountRes = await db.query("SELECT last_heartbeat_at FROM accounts WHERE account_id = $1", [accountId]);

        if (accountRes.rowCount === 0 && openTradesRes.rowCount === 0 && summaryRes.rowCount === 0) {
             return res.status(404).json({ message: "Account data not found" });
        }

        res.status(200).json({
            openTrades: openTradesRes.rows,
            closedTrades: closedTradesRes.rows.reverse(), // Reverse to show oldest of recent first
            summary: summaryRes.rows[0] || {},
            lastSeen: accountRes.rows[0]?.last_heartbeat_at || null
        });
    } catch (error) {
        console.error(`[Server] Error fetching data for account ${accountId}:`, error);
        res.status(500).json({ message: "Error fetching account data." });
    }
});

app.use(express.static('public'));

async function startServer() {
    try {
        await db.initializeSchema(); // Initialize DB schema on startup
        server.listen(PORT, () => {
            console.log(`[Server] HTTP and WebSocket server listening on http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error('[Server] Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
