const { Pool } = require('pg');

// Configuration for the database connection
// These will be picked up from environment variables in Docker Compose
const dbConfig = {
    user: process.env.DATABASE_USER || 'tradeuser',
    host: process.env.DATABASE_HOST || 'localhost', // 'timescaledb' in Docker
    database: process.env.DATABASE_NAME || 'tradesdb',
    password: process.env.DATABASE_PASSWORD || 'tradepassword',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    // ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false, // Example for production SSL
};

const pool = new Pool(dbConfig);

pool.on('connect', client => {
    console.log('[DB] New client connected to the database');
});

pool.on('error', (err, client) => {
    console.error('[DB] Unexpected error on idle client', err);
    // process.exit(-1); // Or handle more gracefully
});

console.log(`[DB] Pool configured for ${dbConfig.user}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);

// Function to query the database
const query = async (text, params) => {
    const start = Date.now();
    try {
        const res = await pool.query(text, params);
        const duration = Date.now() - start;
        // console.log('[DB] Executed query', { text, duration, rows: res.rowCount });
        return res;
    } catch (err) {
        console.error('[DB] Error executing query', { text, params }, err.stack);
        throw err;
    }
};

// Function to initialize the database schema
const initializeSchema = async () => {
    console.log('[DB] Initializing database schema...');

    const createAccountsTable = `
        CREATE TABLE IF NOT EXISTS accounts (
            account_id VARCHAR(255) PRIMARY KEY,
            name VARCHAR(255),
            created_at TIMESTAMPTZ DEFAULT NOW(),
            last_heartbeat_at TIMESTAMPTZ
        );
    `;

    // Trades table - will be converted to hypertable
    const createTradesTable = `
        CREATE TABLE IF NOT EXISTS trades (
            ticket_id BIGINT NOT NULL,
            account_id VARCHAR(255) NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
            symbol VARCHAR(50) NOT NULL,
            order_type INT NOT NULL, -- e.g., OP_BUY, OP_SELL
            lots DOUBLE PRECISION NOT NULL,
            open_price DOUBLE PRECISION NOT NULL,
            open_time TIMESTAMPTZ NOT NULL,
            close_price DOUBLE PRECISION,
            close_time TIMESTAMPTZ,
            stop_loss DOUBLE PRECISION,
            take_profit DOUBLE PRECISION,
            commission DOUBLE PRECISION,
            swap DOUBLE PRECISION,
            profit DOUBLE PRECISION,
            magic_number BIGINT,
            comment VARCHAR(255),
            server_event_time TIMESTAMPTZ DEFAULT NOW(), -- When the server processed this event
            PRIMARY KEY (account_id, ticket_id, open_time) -- open_time helps ensure uniqueness if ticket IDs reset or are not globally unique across time for an account
        );
    `;
    // Note: The primary key for trades is a bit tricky. (account_id, ticket_id) should be unique for *open* trades.
    // For *closed* trades, it's also unique. If a ticket can be reused (unlikely in MT4 for same account), open_time adds more safety.
    // For UPSERTs, (account_id, ticket_id) is usually the conflict target.

    // Account Summaries table - will be converted to hypertable
    const createAccountSummariesTable = `
        CREATE TABLE IF NOT EXISTS account_summaries (
            summary_id SERIAL PRIMARY KEY, -- Simple auto-incrementing ID
            account_id VARCHAR(255) NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
            record_time TIMESTAMPTZ NOT NULL,
            balance DOUBLE PRECISION,
            equity DOUBLE PRECISION,
            profit DOUBLE PRECISION,
            margin DOUBLE PRECISION,
            free_margin DOUBLE PRECISION,
            margin_level DOUBLE PRECISION,
            currency VARCHAR(10),
            server_time_epoch BIGINT, -- from MQL4 AccountInfo
            UNIQUE (account_id, record_time)
        );
    `;

    // TimescaleDB specific: Convert to hypertables
    const createTradesHypertable = `SELECT create_hypertable('trades', 'open_time', if_not_exists => TRUE);`;
    // Using close_time for partitioning historical trades might be better if queries often filter by close_time.
    // However, open_time is always present. Let's use open_time for trades table.
    // For summaries, record_time is natural.
    const createAccountSummariesHypertable = `SELECT create_hypertable('account_summaries', 'record_time', if_not_exists => TRUE);`;

    // Create indexes
    const createTradesIndexes = `
        CREATE INDEX IF NOT EXISTS idx_trades_account_ticket ON trades (account_id, ticket_id);
        CREATE INDEX IF NOT EXISTS idx_trades_close_time ON trades (close_time DESC NULLS LAST) WHERE close_time IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades (symbol);
    `;
    const createSummariesIndexes = `
        CREATE INDEX IF NOT EXISTS idx_summaries_account_time ON account_summaries (account_id, record_time DESC);
    `;


    try {
        await query('CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;'); // Ensure TimescaleDB extension is enabled
        console.log('[DB] TimescaleDB extension checked/enabled.');

        await query(createAccountsTable);
        console.log('[DB] "accounts" table checked/created.');

        await query(createTradesTable);
        console.log('[DB] "trades" table checked/created.');
        await query(createTradesHypertable);
        console.log('[DB] "trades" table converted to hypertable.');
        await query(createTradesIndexes);
        console.log('[DB] Indexes for "trades" table checked/created.');

        await query(createAccountSummariesTable);
        console.log('[DB] "account_summaries" table checked/created.');
        await query(createAccountSummariesHypertable);
        console.log('[DB] "account_summaries" table converted to hypertable.');
        await query(createSummariesIndexes);
        console.log('[DB] Indexes for "account_summaries" table checked/created.');

        console.log('[DB] Database schema initialization complete.');
    } catch (err) {
        console.error('[DB] Error initializing schema:', err.stack);
        // If schema init fails, the app might not work correctly. Consider exiting.
        // process.exit(1);
    }
};

module.exports = {
    query,
    initializeSchema,
    pool // Export pool if direct access is needed, though query function is safer
};
