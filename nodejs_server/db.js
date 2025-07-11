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
            account_id TEXT PRIMARY KEY,
            name TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            last_heartbeat_at TIMESTAMPTZ
        );
    `;

    // Trades table - will be converted to hypertable
    const createTradesTable = `
        CREATE TABLE IF NOT EXISTS trades (
            ticket_id BIGINT NOT NULL,
            account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
            symbol TEXT NOT NULL,
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
            comment TEXT,
            server_event_time TIMESTAMPTZ DEFAULT NOW(), -- When the server processed this event
            -- Primary key includes the time partitioning column for TimescaleDB compatibility
            PRIMARY KEY (account_id, ticket_id, open_time)
        );
    `;

    // Account Summaries table - will be converted to hypertable
    const createAccountSummariesTable = `
        CREATE TABLE IF NOT EXISTS account_summaries (
            account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
            record_time TIMESTAMPTZ NOT NULL,
            balance DOUBLE PRECISION,
            equity DOUBLE PRECISION,
            profit DOUBLE PRECISION,
            margin DOUBLE PRECISION,
            free_margin DOUBLE PRECISION,
            margin_level DOUBLE PRECISION,
            currency TEXT,
            server_time_epoch BIGINT, -- from MQL4 AccountInfo
            -- Primary key includes the time partitioning column
            PRIMARY KEY (account_id, record_time)
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
        CREATE INDEX IF NOT EXISTS idx_trades_account_id_ticket_id_open_time ON trades (account_id, ticket_id, open_time DESC); -- Covered by PK
        CREATE INDEX IF NOT EXISTS idx_trades_close_time ON trades (close_time DESC NULLS LAST) WHERE close_time IS NOT NULL; -- For querying closed trades
        CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades (symbol);
        CREATE INDEX IF NOT EXISTS idx_trades_open_time_desc ON trades (open_time DESC); -- General index on hypertable time column
    `;
    const createSummariesIndexes = `
        CREATE INDEX IF NOT EXISTS idx_summaries_account_id_record_time_desc ON account_summaries (account_id, record_time DESC); -- Covered by PK
        CREATE INDEX IF NOT EXISTS idx_summaries_record_time_desc ON account_summaries (record_time DESC); -- General index on hypertable time column
    `;


    try {
        await query('CREATE EXTENSION IF NOT EXISTS timescaledb;'); // Ensure TimescaleDB extension is enabled
        console.log('[DB] TimescaleDB extension checked/enabled.');

        await query(createAccountsTable);
        console.log('[DB] "accounts" table schema checked/applied.');

        await query(createTradesTable);
        console.log('[DB] "trades" table schema checked/applied.');
        await query(createTradesHypertable); // This will create the hypertable if it doesn't exist
        console.log('[DB] "trades" hypertable status checked/applied.');
        await query(createTradesIndexes);
        console.log('[DB] Indexes for "trades" table checked/applied.');

        await query(createAccountSummariesTable);
        console.log('[DB] "account_summaries" table schema checked/applied.');
        await query(createAccountSummariesHypertable); // This will create the hypertable if it doesn't exist
        console.log('[DB] "account_summaries" hypertable status checked/applied.');
        await query(createSummariesIndexes);
        console.log('[DB] Indexes for "account_summaries" table checked/applied.');

        console.log('[DB] Database schema initialization process complete.');
    } catch (err) {
        console.error('[DB] Error during schema initialization:', err.stack);
        // If schema init fails, the app might not work correctly.
        // Depending on the error, it might be a transient issue or a schema definition problem.
        // For critical errors (e.g., cannot connect, fundamental DDL error), exiting might be appropriate.
        // For 'already exists' or similar, it might be fine. The `if_not_exists` helps.
        throw err; // Re-throw to allow startup process in server.js to handle it
    }
};

module.exports = {
    query,
    initializeSchema,
    pool // Export pool if direct access is needed, though query function is safer
};
