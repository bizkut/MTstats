//+------------------------------------------------------------------+
//|                                         TradesDataSenderEA.mq4 |
//|                      Copyright 2024, Trade Data Project        |
//|                                             https://example.com  |
//+------------------------------------------------------------------+
#property copyright "Copyright 2024, Trade Data Project"
#property link      "https://example.com/tradesdata"
#property version   "1.20_DBSync"
#property strict

//--- Input parameters
input string ServerBaseUrl = "http://127.0.0.1:3001/api/data"; // Base URL for the server API
input string AccountIdentifier = "MyMT4Account_1";         // Unique identifier for this account
input bool SendInitialOpenTrades = true;                   // Send all open trades on EA start
input bool SendInitialTradeHistory = true;                 // Send all historical trades on EA start (now uses smart sync)
input bool SendAccountSummaryUpdates = true;               // Send account summary periodically
input bool SendHeartbeats = true;                          // Send heartbeats periodically

input int DataSendInterval = 60; // General interval in seconds for heartbeat, summary, and initial data send attempts
                                 // OnTick events are sent immediately.

//--- Global variables for state management
datetime ExtLastHeartbeatSent = 0;
datetime ExtLastAccountSummarySent = 0;
bool ExtInitialSyncAttempted = false; // Flag to ensure initial sync (open + historical) is attempted once per EA session
bool ExtOpenTradesSent = false;       // Tracks if initial open trades batch was successful
bool ExtHistoricalTradesSynced = false; // Tracks if initial historical trades sync was successful

datetime ExtServerLatestHistCloseTime = 0; // Timestamp of the latest historical trade server knows about (from server)

// Structure to keep track of known open orders for detecting changes in OnTick
struct KnownOrderState {
    int    ticket;
    double sl;
    double tp;
    double lots;
    int    type;
    string symbol;
};
KnownOrderState ExtKnownOpenOrders[200]; // Array for known open orders
int ExtKnownOpenOrdersCount = 0;         // Count of known open orders
int ExtLastHistoryTotal = 0;             // Last known total of historical orders

//+------------------------------------------------------------------+
//| JSON String Escaping                                             |
//+------------------------------------------------------------------+
string EscapeJsonString(string text) {
    string result = "";
    int len = StringLen(text);
    for (int i = 0; i < len; i++) {
        char ch = StringGetCharacter(text, i);
        switch (ch) {
            case '\\': result += "\\\\"; break;
            case '"':  result += "\\\""; break;
            case 8:    result += "\\b";  break;  // Backspace
            case 12:   result += "\\f";  break;  // Form feed
            case 10:   result += "\\n";  break;  // Newline
            case 13:   result += "\\r";  break;  // Carriage return
            case 9:    result += "\\t";  break;  // Tab
            default:
                if (ch < 32 || ch == 127) {
                    string temp;
                    temp = "\\u00";
                    int h1 = ch / 16;
                    int h2 = ch % 16;
                    temp += (h1 < 10 ? (string)h1 : CharToStr((char)('A' + h1 - 10)));
                    temp += (h2 < 10 ? (string)h2 : CharToStr((char)('A' + h2 - 10)));
                    result += temp;
                } else {
                    result += CharToStr(ch);
                }
        }
    }
    return result;
}

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit() {
    EventSetTimer(1); // Timer event every 1 second
    Print("TradesDataSenderEA (DBSync): Initialized. Account: ", AccountIdentifier, ", Server: ", ServerBaseUrl);
    Print("Make sure '", ServerBaseUrl, "' is added to allowed URLs in Tools > Options > Expert Advisors.");

    ExtInitialSyncAttempted = false;
    ExtOpenTradesSent = false;
    ExtHistoricalTradesSynced = false;
    ExtServerLatestHistCloseTime = 0; // January 1, 1970

    ArrayResize(ExtKnownOpenOrders, 200);
    ExtKnownOpenOrdersCount = 0;
    ExtLastHistoryTotal = HistoryTotal();

    InitializeKnownOpenOrdersList();
    return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason) {
    EventKillTimer();
    Print("TradesDataSenderEA (DBSync): Deinitializing. Reason: ", reason);
    // No explicit disconnect needed for WebRequest
}

//+------------------------------------------------------------------+
//| Timer function - Handles periodic tasks                          |
//+------------------------------------------------------------------+
void OnTimer() {
    // --- Attempt to send initial data if not yet sent ---
    if (!ExtInitialSyncAttempted || (!ExtOpenTradesSent && SendInitialOpenTrades) || (!ExtHistoricalTradesSynced && SendInitialTradeHistory)) {
        Print("TradesDataSenderEA Timer: Attempting initial data sync process.");
        ExtInitialSyncAttempted = true; // Mark that we've started the attempt for this session

        // 1. Fetch last sync time for historical trades (only if not already successfully synced)
        if (SendInitialTradeHistory && !ExtHistoricalTradesSynced && ExtServerLatestHistCloseTime == 0) {
            if (!FetchLastSyncTimes()) {
                Print("TradesDataSenderEA Timer: Failed to fetch last sync times. Will retry.");
                // Don't proceed with history send if this fails, but open trades can still be attempted.
            }
        }

        // 2. Send All Open Trades (if enabled and not yet successful)
        if (SendInitialOpenTrades && !ExtOpenTradesSent) {
            if (SendAllOpenTradesBatch()) {
                ExtOpenTradesSent = true; // Mark as successful
                Print("TradesDataSenderEA Timer: Initial open trades batch sent successfully.");
            } else {
                Print("TradesDataSenderEA Timer: Failed to send initial open trades batch. Will retry.");
            }
        }

        // 3. Send Historical Trades (if enabled, last sync time fetched, and not yet successful)
        if (SendInitialTradeHistory && !ExtHistoricalTradesSynced && (ExtServerLatestHistCloseTime > 0 || ExtServerLatestHistCloseTime == 0 && SendInitialTradeHistory)) { // Also send if ExtServerLatestHistCloseTime is 0 meaning full history needed
             if (SendAllHistoricalTradesBatch()) { // This function now uses ExtServerLatestHistCloseTime
                ExtHistoricalTradesSynced = true; // Mark as successful
                Print("TradesDataSenderEA Timer: Historical trades sync completed successfully.");
            } else {
                Print("TradesDataSenderEA Timer: Failed to send historical trades batch. Will retry.");
            }
        }

        // After any send attempt, refresh the known orders list for OnTick accuracy
        if (ExtOpenTradesSent && ExtHistoricalTradesSynced) { // Or if one is disabled and other is successful
             Print("TradesDataSenderEA Timer: Initial data sync process fully complete.");
             InitializeKnownOpenOrdersList(); // Refresh local state based on what should now be on server
        } else if ((!SendInitialOpenTrades || ExtOpenTradesSent) && (!SendInitialTradeHistory || ExtHistoricalTradesSynced)) {
             // This case handles if one or both are disabled, or enabled and successful
             Print("TradesDataSenderEA Timer: Initial data sync requirements met (some tasks might have been disabled).");
             InitializeKnownOpenOrdersList();
        }
    }

    // --- Heartbeat ---
    if (SendHeartbeats && (TimeCurrent() - ExtLastHeartbeatSent >= DataSendInterval)) {
        string heartbeatPayload = "{\"accountId\":\"" + AccountIdentifier + "\",\"timestamp\":" + GetCurrentMillisecondTimestamp() + "}";
        if (PostJsonData("/heartbeat", heartbeatPayload)) {
            ExtLastHeartbeatSent = TimeCurrent();
            // Print("TradesDataSenderEA Timer: Heartbeat sent successfully.");
        } else {
            Print("TradesDataSenderEA Timer: Failed to send heartbeat.");
            // Consider implications: if server is down, should we stop other sends? For now, continue.
        }
    }

    // --- Periodic Account Summary ---
    if (SendAccountSummaryUpdates && (TimeCurrent() - ExtLastAccountSummarySent >= DataSendInterval)) {
        SendAccountSummary(); // Contains its own PostJsonData call and ExtLastAccountSummarySent update
    }
}


//+------------------------------------------------------------------+
//| Initialize/Refresh Known Open Orders List                        |
//+------------------------------------------------------------------+
void InitializeKnownOpenOrdersList() {
    ExtKnownOpenOrdersCount = 0; // Reset
    for (int i = OrdersTotal() - 1; i >= 0; i--) {
        if (OrderSelect(i, SELECT_BY_POS, MODE_TRADES)) {
            if (ExtKnownOpenOrdersCount < ArraySize(ExtKnownOpenOrders)) {
                ExtKnownOpenOrders[ExtKnownOpenOrdersCount].ticket = OrderTicket();
                ExtKnownOpenOrders[ExtKnownOpenOrdersCount].sl = OrderStopLoss();
                ExtKnownOpenOrders[ExtKnownOpenOrdersCount].tp = OrderTakeProfit();
                ExtKnownOpenOrders[ExtKnownOpenOrdersCount].lots = OrderLots();
                ExtKnownOpenOrders[ExtKnownOpenOrdersCount].type = OrderType();
                ExtKnownOpenOrders[ExtKnownOpenOrdersCount].symbol = OrderSymbol();
                ExtKnownOpenOrdersCount++;
            } else {
                Print("TradesDataSenderEA: InitializeKnownOpenOrdersList: Known open orders array is full. Max: ", ArraySize(ExtKnownOpenOrders));
                break;
            }
        }
    }
    Print("TradesDataSenderEA: Known open orders list refreshed. Count: ", ExtKnownOpenOrdersCount);
}

//+------------------------------------------------------------------+
//| OnTick function - Handles live trade events                      |
//+------------------------------------------------------------------+
void OnTick() {
    // Ensure initial sync has been attempted before processing live ticks,
    // or if initial sync is disabled.
    bool initialSyncCompleteOrNotNeeded = ExtInitialSyncAttempted || (!SendInitialOpenTrades && !SendInitialTradeHistory);
    if (!initialSyncCompleteOrNotNeeded) {
         // If SendInitialOpenTrades or SendInitialTradeHistory is true, but ExtInitialSyncAttempted is false,
         // it means OnTimer hasn't run yet to attempt the sync.
         // It's better to wait for OnTimer to complete the initial sync logic first.
         // However, InitializeKnownOpenOrdersList in OnInit provides a basic state.
         // For maximum data integrity, one might choose to queue OnTick events or simply
         // rely on the server to handle potential out-of-order or duplicate data if OnTick
         // fires before the initial batch sync fully completes and is acknowledged.
         // Given current logic, OnTick will proceed with its locally known state.
    }

    // --- Detect Closed Orders (from history) ---
    if (HistoryTotal() > ExtLastHistoryTotal) {
        for (int i = ExtLastHistoryTotal; i < HistoryTotal(); i++) {
            if (OrderSelect(i, SELECT_BY_POS, MODE_HISTORY)) {
                if (OrderType() == OP_BUY || OrderType() == OP_SELL) {
                    int knownIndex = FindKnownOrderIndex(OrderTicket());
                    string orderJson = FormatOrderRecordJson(OrderTicket(), MODE_HISTORY);
                    string liveEventPayload = "{\"accountId\":\"" + AccountIdentifier +
                                              "\",\"timestamp\":" + GetCurrentMillisecondTimestamp() +
                                              ",\"eventType\":\"ORDER_CLOSED\",\"data\":" + orderJson + "}";
                    PostJsonData("/live-trade-event", liveEventPayload);
                    if (knownIndex != -1) {
                        RemoveKnownOrder(OrderTicket());
                    } else {
                         Print("TradesDataSenderEA OnTick: Detected close for untracked order (already closed or EA started late) #", OrderTicket());
                    }
                }
            }
        }
    }
    ExtLastHistoryTotal = HistoryTotal();

    // --- Detect New or Modified Open Orders ---
    bool currentTickKnownOrderFound[200]; // Temp array for this tick's findings
    if(ExtKnownOpenOrdersCount > 0) ArrayInitialize(currentTickKnownOrderFound, false);

    for (int i = 0; i < OrdersTotal(); i++) {
        if (OrderSelect(i, SELECT_BY_POS, MODE_TRADES)) {
            int orderTicket = OrderTicket();
            int knownIndex = FindKnownOrderIndex(orderTicket);
            string orderJson = FormatOrderRecordJson(orderTicket, MODE_TRADES);
            string eventTypeStr = "";

            if (knownIndex == -1) { // New open order
                eventTypeStr = "ORDER_OPENED";
                AddKnownOrder(OrderTicket(), OrderStopLoss(), OrderTakeProfit(), OrderLots(), OrderType(), OrderSymbol());
                 // Mark as found if added (index will be ExtKnownOpenOrdersCount-1)
                if(ExtKnownOpenOrdersCount > 0 && (ExtKnownOpenOrdersCount-1) < ArraySize(currentTickKnownOrderFound)) {
                    currentTickKnownOrderFound[ExtKnownOpenOrdersCount-1] = true;
                }
            } else { // Existing open order, check for modifications
                if(knownIndex < ArraySize(currentTickKnownOrderFound)) currentTickKnownOrderFound[knownIndex] = true;

                string sym = ExtKnownOpenOrders[knownIndex].symbol;
                int symDigits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
                bool slModified = NormalizeDouble(ExtKnownOpenOrders[knownIndex].sl, symDigits) != NormalizeDouble(OrderStopLoss(), symDigits);
                bool tpModified = NormalizeDouble(ExtKnownOpenOrders[knownIndex].tp, symDigits) != NormalizeDouble(OrderTakeProfit(), symDigits);
                bool lotsModified = (MathAbs(ExtKnownOpenOrders[knownIndex].lots - OrderLots()) > (MarketInfo(sym, MODE_LOTSTEP) * 0.1));

                if (slModified || tpModified || lotsModified) {
                    eventTypeStr = "ORDER_MODIFIED";
                    ExtKnownOpenOrders[knownIndex].sl = OrderStopLoss();
                    ExtKnownOpenOrders[knownIndex].tp = OrderTakeProfit();
                    ExtKnownOpenOrders[knownIndex].lots = OrderLots();
                }
            }

            if (eventTypeStr != "") {
                string liveEventPayload = "{\"accountId\":\"" + AccountIdentifier +
                                          "\",\"timestamp\":" + GetCurrentMillisecondTimestamp() +
                                          ",\"eventType\":\"" + eventTypeStr + "\",\"data\":" + orderJson + "}";
                PostJsonData("/live-trade-event", liveEventPayload);
            }
        }
    }

    // --- Check for orders that vanished from open pool without hitting history yet (e.g. pending deleted) ---
    for (int k = ExtKnownOpenOrdersCount - 1; k >= 0; k--) {
        if (k < ArraySize(currentTickKnownOrderFound) && !currentTickKnownOrderFound[k]) {
            if (!OrderSelect(ExtKnownOpenOrders[k].ticket, SELECT_BY_TICKET, MODE_TRADES)) {
                Print("TradesDataSenderEA OnTick: Known open order #", ExtKnownOpenOrders[k].ticket, " vanished. Assuming closed/deleted.");
                // Format a basic JSON for the vanished order, actual close details might be unknown here
                string vanishedOrderJson = "{\"ticket\":"+(string)ExtKnownOpenOrders[k].ticket + ",\"symbol\":\""+ExtKnownOpenOrders[k].symbol+"\"}";
                string liveEventPayload = "{\"accountId\":\"" + AccountIdentifier +
                                          "\",\"timestamp\":" + GetCurrentMillisecondTimestamp() +
                                          ",\"eventType\":\"ORDER_VANISHED\",\"data\":" + vanishedOrderJson + "}";
                PostJsonData("/live-trade-event", liveEventPayload);
                RemoveKnownOrderFromArray(k); // Remove from internal tracking
            }
        }
    }
}


//+------------------------------------------------------------------+
//| Send All Currently Open Trades (Batch)                           |
//+------------------------------------------------------------------+
bool SendAllOpenTradesBatch() {
    Print("TradesDataSenderEA: Preparing batch of currently open trades...");
    string tradesJsonArray = "[";
    int openTradesCount = 0;
    for (int i = 0; i < OrdersTotal(); i++) {
        if (OrderSelect(i, SELECT_BY_POS, MODE_TRADES)) {
            if (openTradesCount > 0) tradesJsonArray += ",";
            tradesJsonArray += FormatOrderRecordJson(OrderTicket(), MODE_TRADES);
            openTradesCount++;
        }
    }
    tradesJsonArray += "]";

    // Even if openTradesCount is 0, send an empty array so server can reconcile.
    string batchPayload = "{\"accountId\":\"" + AccountIdentifier +
                          "\",\"timestamp\":" + GetCurrentMillisecondTimestamp() +
                          ",\"trades\":" + tradesJsonArray + "}";

    bool success = PostJsonData("/batch-open-trades", batchPayload);
    if(success) Print("TradesDataSenderEA: Batch of ", openTradesCount, " open trades sent (or empty array if none open).");
    else Print("TradesDataSenderEA: Failed to send batch of open trades.");
    return success;
}

//+------------------------------------------------------------------+
//| Send All Historical Trades (Batch) - Smart Sync                  |
//+------------------------------------------------------------------+
bool SendAllHistoricalTradesBatch() {
    Print("TradesDataSenderEA: Preparing batch of historical trades (since server time: ", TimeToString(ExtServerLatestHistCloseTime) ,")...");
    string tradesJsonArray = "[";
    int historicalTradesSentCount = 0;
    int tradesSkippedCount = 0;

    for (int i = 0; i < HistoryTotal(); i++) {
        if (OrderSelect(i, SELECT_BY_POS, MODE_HISTORY)) {
            if (OrderType() == OP_BUY || OrderType() == OP_SELL) { // Only actual trades
                if (OrderCloseTime() > ExtServerLatestHistCloseTime) {
                    if (historicalTradesSentCount > 0) tradesJsonArray += ",";
                    tradesJsonArray += FormatOrderRecordJson(OrderTicket(), MODE_HISTORY);
                    historicalTradesSentCount++;
                } else {
                    tradesSkippedCount++;
                }
            }
        }
    }
    tradesJsonArray += "]";

    if (historicalTradesSentCount == 0) {
        Print("TradesDataSenderEA: No *new* historical trades to send. Skipped: ", tradesSkippedCount);
        return true; // Nothing new to send is a success for sync purposes
    }

    string batchPayload = "{\"accountId\":\"" + AccountIdentifier +
                          "\",\"timestamp\":" + GetCurrentMillisecondTimestamp() +
                          ",\"trades\":" + tradesJsonArray + "}";
    bool success = PostJsonData("/batch-historical-trades", batchPayload);
    if(success) Print("TradesDataSenderEA: Batch of ", historicalTradesSentCount, " new historical trades sent. Skipped: ", tradesSkippedCount);
    else Print("TradesDataSenderEA: Failed to send batch of new historical trades.");
    return success;
}

//+------------------------------------------------------------------+
//| Send Account Summary                                             |
//+------------------------------------------------------------------+
void SendAccountSummary() {
    string summaryDataJson = "{";
    summaryJson += "\"balance\":" + DoubleToString(AccountBalance(), 2) + ",";
    summaryJson += "\"equity\":" + DoubleToString(AccountEquity(), 2) + ",";
    summaryJson += "\"profit\":" + DoubleToString(AccountProfit(), 2) + ",";
    summaryJson += "\"margin\":" + DoubleToString(AccountMargin(), 2) + ",";
    summaryJson += "\"marginFree\":" + DoubleToString(AccountFreeMargin(), 2) + ",";
    summaryJson += "\"marginLevel\":" + DoubleToString(AccountMarginLevel(), 2) + ",";
    summaryJson += "\"currency\":\"" + EscapeJsonString(AccountCurrency()) + "\",";
    summaryDataJson += "\"serverTimeEpoch\":" + (string)TimeCurrent(); // MT4 Server Time (UTC) as epoch
    summaryDataJson += "}";

    string payload = "{\"accountId\":\"" + AccountIdentifier +
                     "\",\"timestamp\":" + GetCurrentMillisecondTimestamp() +
                     ",\"summary\":" + summaryDataJson + "}";

    if (PostJsonData("/account-summary", payload)) {
        ExtLastAccountSummarySent = TimeCurrent();
        // Print("TradesDataSenderEA: Account summary sent successfully.");
    } else {
        Print("TradesDataSenderEA: Failed to send account summary.");
    }
}

//+------------------------------------------------------------------+
//| Fetch Last Sync Times from Server                                |
//+------------------------------------------------------------------+
bool FetchLastSyncTimes() {
    string payload = "{\"accountId\":\"" + AccountIdentifier + "\"}";
    string url = ServerBaseUrl + "/get-last-sync-times";
    char postData[];
    char responseData[];
    string responseHeaders;

    int len = StringToCharArray(payload, postData);
    ArrayResize(postData, len + 1); postData[len] = 0;

    string headers = "Content-Type: application/json\r\nAccept: application/json\r\n";
    ResetLastError();
    int resHttpCode = WebRequest("POST", url, headers, 5000, postData, responseData, responseHeaders);

    if (resHttpCode == 200) {
        string responseStr = CharArrayToString(responseData);
        Print("TradesDataSenderEA: Received last sync times response: ", responseStr);
        // Basic JSON parsing - MQL4 has no built-in JSON parser.
        // Example response: {"accountId":"MyAcc","last_historical_trade_close_time":"2023-01-01T10:00:00.000Z"}
        // This is a simplified parser. A robust one would be much more complex.
        int timePos = StringFind(responseStr, "\"last_historical_trade_close_time\":\"");
        if (timePos > -1) {
            timePos += StringLen("\"last_historical_trade_close_time\":\"");
            int endPos = StringFind(responseStr, "\"", timePos);
            if (endPos > timePos) {
                string timeStr = StringSubstr(responseStr, timePos, endPos - timePos);
                ExtServerLatestHistCloseTime = StringToTime(timeStr); // Converts ISO 8601 like string to datetime
                if (ExtServerLatestHistCloseTime == 0 && timeStr != "1970-01-01T00:00:00.000Z" && timeStr != "0" && StringLen(timeStr) > 10) { // StringToTime can return 0 on failure
                     Print("TradesDataSenderEA: Warning - Failed to parse last_historical_trade_close_time string: '", timeStr, "'. Using 0.");
                     ExtServerLatestHistCloseTime = 0; // Default to epoch if parsing fails for a non-epoch string
                } else if (ExtServerLatestHistCloseTime == D'1970.01.01 00:00:00') { // StringToTime might return this for "0" or epoch string
                     ExtServerLatestHistCloseTime = 0; // Standardize to 0 for epoch
                }
                Print("TradesDataSenderEA: Server's latest historical trade close time set to: ", TimeToString(ExtServerLatestHistCloseTime));
                return true;
            }
        }
        Print("TradesDataSenderEA: Could not parse last_historical_trade_close_time from server response: ", responseStr);
        ExtServerLatestHistCloseTime = 0; // Default if parsing fails
        return false; // Parsing failed but HTTP was OK, treat as need full sync for safety or re-evaluate. For now, let's say it is not a success for sync point.
    } else {
        Print("TradesDataSenderEA: Failed to fetch last sync times. HTTP Status: ", resHttpCode, ", Error: ", GetLastError());
        ExtServerLatestHistCloseTime = 0; // Default if HTTP fails
        return false;
    }
}


//+------------------------------------------------------------------+
//| Post JSON Data using WebRequest                                  |
//+------------------------------------------------------------------+
bool PostJsonData(string endpointPath, string jsonDataPayload) {
    string url = ServerBaseUrl + endpointPath;
    char postData[];
    char resultData[];
    string resultHeaders;

    int payloadLength = StringToCharArray(jsonDataPayload, postData, 0, StringLen(jsonDataPayload));
    ArrayResize(postData, payloadLength + 1);
    postData[payloadLength] = 0;

    string headers = "Content-Type: application/json\r\nAccept: application/json\r\n";

    ResetLastError();
    int timeout = 10000; // Increased timeout for potentially larger batches
    int res = WebRequest("POST", url, headers, timeout, postData, resultData, resultHeaders);

    if (res == -1) {
        Print("TradesDataSenderEA: WebRequest error ", GetLastError(), " for URL: ", url);
        return false;
    } else {
        // string serverResponse = CharArrayToString(resultData); // Can be very long for batches
        // Print("TradesDataSenderEA: WebRequest to ", url, " completed. HTTP Status: ", res, ". Response: ", serverResponse);
        if (res >= 200 && res < 300) {
            return true;
        } else {
            Print("TradesDataSenderEA: WebRequest to ", url, " returned HTTP Error Status: ", res, " Response: ", CharArrayToString(resultData));
            return false;
        }
    }
}

//+------------------------------------------------------------------+
//| Format an Order Record to JSON                                   |
//+------------------------------------------------------------------+
string FormatOrderRecordJson(int ticket, int pool_mode) { // Changed ENUM_ORDER_SELECT_MODE to int pool_mode
    if (!OrderSelect(ticket, SELECT_BY_TICKET, pool_mode)) { // Use pool_mode here
        Print("TradesDataSenderEA: FormatOrderRecordJson: Failed to select order #", ticket, " in pool_mode ", pool_mode);
        return "null"; // Return JSON null on failure
    }

    string orderSymbol = OrderSymbol();
    int symDigits = (int)SymbolInfoInteger(orderSymbol, SYMBOL_DIGITS);

    string json = "{";
    json += "\"ticket\":"        + (string)OrderTicket() + ",";
    json += "\"symbol\":\""      + EscapeJsonString(orderSymbol) + "\",";
    json += "\"type\":"          + (string)OrderType() + ",";
    json += "\"typeName\":\""    + EnumOrderTypeToString(OrderType()) + "\",";
    json += "\"lots\":"          + DoubleToString(OrderLots(), MarketLotsDigits(orderSymbol)) + ",";
    json += "\"openPrice\":"     + DoubleToString(OrderOpenPrice(), symDigits) + ",";
    json += "\"openTimeEpoch\":" + (string)OrderOpenTime() + ",";
    json += "\"openTimeString\":\""+ TimeToString(OrderOpenTime(), TIME_DATE|TIME_SECONDS|TIME_MILLISECONDS) + "\",";
    json += "\"stopLoss\":"      + DoubleToString(OrderStopLoss(), symDigits) + ",";
    json += "\"takeProfit\":"    + DoubleToString(OrderTakeProfit(), symDigits) + ",";

    if (pool_mode == MODE_TRADES) { // Check against pool_mode
        json += "\"currentPrice\":"  + DoubleToString(OrderType() == OP_BUY ? SymbolInfoDouble(orderSymbol, SYMBOL_ASK) : SymbolInfoDouble(orderSymbol, SYMBOL_BID), symDigits) + ",";
        json += "\"closePrice\":null,";
        json += "\"closeTimeEpoch\":null,";
        json += "\"closeTimeString\":\"\",";
    } else { // MODE_HISTORY
        json += "\"currentPrice\":null,";
        json += "\"closePrice\":"    + DoubleToString(OrderClosePrice(), symDigits) + ",";
        json += "\"closeTimeEpoch\":"+ (string)OrderCloseTime() + ",";
        json += "\"closeTimeString\":\""+ TimeToString(OrderCloseTime(), TIME_DATE|TIME_SECONDS|TIME_MILLISECONDS) + "\",";
    }

    json += "\"commission\":"    + DoubleToString(OrderCommission(), 2) + ",";
    json += "\"swap\":"          + DoubleToString(OrderSwap(), 2) + ",";
    json += "\"profit\":"        + DoubleToString(OrderProfit(), 2) + ",";
    json += "\"comment\":\""     + EscapeJsonString(OrderComment()) + "\",";
    json += "\"magicNumber\":"   + (string)OrderMagicNumber();
    json += "}";

    return json;
}

//+------------------------------------------------------------------+
//| Get Current Millisecond Timestamp (long)                         |
//+------------------------------------------------------------------+
long GetCurrentMillisecondTimestamp() {
    // MQL4 TimeCurrent() is server time, TimeLocal() is PC time.
    // For milliseconds, best effort:
    return (long)TimeCurrent() * 1000 + (TimeLocal() % 1000);
}

//+------------------------------------------------------------------+
//| Helper functions for managing known orders list (for OnTick)     |
//+------------------------------------------------------------------+
int FindKnownOrderIndex(int ticket) {
    for (int i = 0; i < ExtKnownOpenOrdersCount; i++) {
        if (ExtKnownOpenOrders[i].ticket == ticket) return i;
    }
    return -1;
}

void AddKnownOrder(int ticket, double sl, double tp, double lots, int orderTypeVal, string symbolStr) {
    if (FindKnownOrderIndex(ticket) != -1) return;

    if (ExtKnownOpenOrdersCount < ArraySize(ExtKnownOpenOrders)) {
        ExtKnownOpenOrders[ExtKnownOpenOrdersCount].ticket = ticket;
        ExtKnownOpenOrders[ExtKnownOpenOrdersCount].sl = sl;
        ExtKnownOpenOrders[ExtKnownOpenOrdersCount].tp = tp;
        ExtKnownOpenOrders[ExtKnownOpenOrdersCount].lots = lots;
        ExtKnownOpenOrders[ExtKnownOpenOrdersCount].type = orderTypeVal;
        ExtKnownOpenOrders[ExtKnownOpenOrdersCount].symbol = symbolStr;
        ExtKnownOpenOrdersCount++;
        Print("TradesDataSenderEA: Added to known orders list: #", ticket, " ", symbolStr, ". Count: ", ExtKnownOpenOrdersCount);
    } else {
        Print("TradesDataSenderEA: Known open orders list is full. Cannot add ticket: ", ticket);
    }
}

void RemoveKnownOrderFromArray(int index) {
    if (index < 0 || index >= ExtKnownOpenOrdersCount) return;
    Print("TradesDataSenderEA: Removing from known orders list by index ", index, ", ticket ", ExtKnownOpenOrders[index].ticket);
    for (int i = index; i < ExtKnownOpenOrdersCount - 1; i++) {
        ExtKnownOpenOrders[i] = ExtKnownOpenOrders[i+1];
    }
    if (ExtKnownOpenOrdersCount > 0) {
      ExtKnownOpenOrdersCount--;
    }
}

void RemoveKnownOrder(int ticket) {
    int index = FindKnownOrderIndex(ticket);
    if (index != -1) {
        RemoveKnownOrderFromArray(index);
    }
}

int MarketLotsDigits(string symbol) {
    double lotStep = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
    if (lotStep == 1.0) return 0;
    if (lotStep == 0.1) return 1;
    if (lotStep == 0.01) return 2;
    if (lotStep == 0.001) return 3;
    // Default for forex usually 2 decimal places for lots (e.g. 0.01)
    return 2;
}

// MQL4 does not have MarketInfo(symbol, SYMBOL_VOLUME_STEP) like MT5.
// It's MarketInfo(symbol, MODE_LOTSTEP).
double MarketLotsStep(string symbol) {
    return MarketInfo(symbol, MODE_LOTSTEP);
}

// Convert OrderType integer to a string
string EnumOrderTypeToString(int orderType) {
    switch(orderType) {
        case OP_BUY:       return "OP_BUY";
        case OP_SELL:      return "OP_SELL";
        case OP_BUYLIMIT:  return "OP_BUYLIMIT";
        case OP_SELLLIMIT: return "OP_SELLLIMIT";
        case OP_BUYSTOP:   return "OP_BUYSTOP";
        case OP_SELLSTOP:  return "OP_SELLSTOP";
        // MT4 specific pending order types that result in market orders
        // These might not be seen directly as "open" trades in OrdersTotal() with these types,
        // but rather the resulting OP_BUY or OP_SELL.
        // However, they can appear in history if deleted before execution.
        case OP_BALANCE:   return "OP_BALANCE";   // Balance operation
        case OP_CREDIT:    return "OP_CREDIT";    // Credit operation
        default:           return "UNKNOWN_ORDER_TYPE (" + IntegerToString(orderType) + ")";
    }
}
//+------------------------------------------------------------------+
