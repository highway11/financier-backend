const express = require("express");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");
const nano = require("nano");
const { v4: uuidv4 } = require("uuid");
const moment = require("moment");
const { createRemoteJWKSet, jwtVerify } = require("jose");
const { cleanPayeeName, suggestPayee, getPlaidPayeeName } = require("./payeeClean");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET = process.env.PLAID_SECRET;
const PLAID_ENV = process.env.PLAID_ENV || "sandbox";
const PLAID_COUNTRY_CODES = (process.env.PLAID_COUNTRY_CODES || "CA").split(",");
const PLAID_WEBHOOK_URL = process.env.PLAID_WEBHOOK_URL || "";

// CouchDB admin credentials (read from Docker secret or env)
let ADMIN_PASSWORD = "";
const secretPath = "/run/secrets/admin_password";
try {
  if (fs.existsSync(secretPath)) {
    ADMIN_PASSWORD = fs.readFileSync(secretPath, "utf-8").trim();
  }
} catch (e) {
  console.warn("Could not read admin_password secret:", e.message);
}

const COUCHDB_URL = ADMIN_PASSWORD
  ? `http://admin:${ADMIN_PASSWORD}@couchdb:5984`
  : "http://couchdb:5984";

// Initialize Plaid client
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": PLAID_CLIENT_ID,
      "PLAID-SECRET": PLAID_SECRET,
    },
  },
});
const plaidClient = new PlaidApi(plaidConfig);

// Initialize CouchDB client
const couchdb = nano(COUCHDB_URL);
const plaidTokensDb = couchdb.db.use("plaid_tokens");

// Plaid webhook verification JWKS
const PLAID_JWKS_URL = "https://production.plaid.com/webhook_verification_key/get";
let plaidJWKS = null;

// ---------------------------------------------------------------------------
// Express App
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Auth Middleware — validates CouchDB session cookie
// ---------------------------------------------------------------------------

async function authenticateUser(req, res, next) {
  const cookie = req.headers.cookie;
  if (!cookie) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    const sessionRes = await fetch("http://couchdb:5984/_session", {
      headers: { Cookie: cookie },
    });
    const session = await sessionRes.json();

    if (!session.userCtx || !session.userCtx.name) {
      return res.status(401).json({ error: "Invalid session" });
    }

    const username = session.userCtx.name;
    const roles = session.userCtx.roles || [];

    // Find the user's per-user database name from their roles
    const userDbRole = roles.find((r) => r.startsWith("userdb-"));
    if (!userDbRole) {
      return res.status(403).json({ error: "No user database found" });
    }

    req.user = {
      name: username,
      dbName: userDbRole,
      roles: roles,
    };

    next();
  } catch (err) {
    console.error("Auth error:", err.message);
    return res.status(500).json({ error: "Authentication check failed" });
  }
}

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Get a user's CouchDB database instance.
 */
function getUserDb(dbName) {
  return couchdb.db.use(dbName);
}

/**
 * Get all existing payees from a user's budget.
 */
async function getExistingPayees(userDb, budgetId) {
  const prefix = `b_${budgetId}_payee_`;
  const result = await userDb.list({
    include_docs: true,
    startkey: prefix,
    endkey: prefix + "\uffff",
  });

  return result.rows
    .filter((r) => r.doc && !r.doc._deleted && !r.doc.internal)
    .map((r) => ({
      id: r.doc._id.slice(r.doc._id.lastIndexOf("_") + 1),
      name: r.doc.name,
      categorySuggest: r.doc.categorySuggest,
      _id: r.doc._id,
      _rev: r.doc._rev,
    }));
}

/**
 * Get all existing import mappings from a user's budget.
 */
async function getImportMappings(userDb, budgetId) {
  try {
    const doc = await userDb.get(`b_${budgetId}_import_mappings`);
    return doc.mappings || {};
  } catch (e) {
    return {};
  }
}

/**
 * Find or create a payee for a Plaid transaction.
 * Uses the same matching logic as the CSV import.
 */
async function resolvePayee(userDb, budgetId, rawName, existingPayees, importMappings) {
  const cleaned = cleanPayeeName(rawName);

  // 1. Check saved import mappings first
  if (importMappings[rawName]) {
    const mappedPayee = existingPayees.find((p) => p.id === importMappings[rawName]);
    if (mappedPayee) {
      return { payeeId: mappedPayee.id, categorySuggest: mappedPayee.categorySuggest };
    }
  }

  // 2. Try to match against existing payees
  const matchedId = suggestPayee(cleaned, existingPayees);
  if (matchedId) {
    const matchedPayee = existingPayees.find((p) => p.id === matchedId);
    return { payeeId: matchedId, categorySuggest: matchedPayee?.categorySuggest || null };
  }

  // 3. Create a new payee
  const newPayeeId = uuidv4();
  const newPayeeDoc = {
    _id: `b_${budgetId}_payee_${newPayeeId}`,
    name: cleaned,
    autosuggest: true,
    internal: false,
    categorySuggest: null,
  };

  await userDb.insert(newPayeeDoc);

  // Add to in-memory list so subsequent transactions in same batch can match
  existingPayees.push({
    id: newPayeeId,
    name: cleaned,
    categorySuggest: null,
    _id: newPayeeDoc._id,
  });

  return { payeeId: newPayeeId, categorySuggest: null };
}

/**
 * Find an existing Financier transaction by its plaid_transaction_id.
 */
async function findTransactionByPlaidId(userDb, budgetId, plaidTransactionId) {
  const prefix = `b_${budgetId}_transaction_`;
  const result = await userDb.list({
    include_docs: true,
    startkey: prefix,
    endkey: prefix + "\uffff",
  });

  for (const row of result.rows) {
    if (row.doc && row.doc.plaid_transaction_id === plaidTransactionId) {
      return row.doc;
    }
  }
  return null;
}

/**
 * Sync transactions for a single Plaid Item.
 */
async function syncItemTransactions(itemDoc) {
  const userDb = getUserDb(itemDoc.user_db);
  const budgetId = itemDoc.budget_id;
  const accessToken = itemDoc.access_token;

  // Load existing payees and mappings for this budget
  const existingPayees = await getExistingPayees(userDb, budgetId);
  const importMappings = await getImportMappings(userDb, budgetId);

  // Build a map of Plaid account_id → Financier account_id
  const accountMap = {};
  for (const acc of itemDoc.accounts || []) {
    if (acc.financier_account_id) {
      accountMap[acc.account_id] = acc.financier_account_id;
    }
  }

  let cursor = itemDoc.cursor || "";
  let hasMore = true;
  let totalAdded = 0;
  let totalModified = 0;
  let totalRemoved = 0;

  while (hasMore) {
    const syncResponse = await plaidClient.transactionsSync({
      access_token: accessToken,
      cursor: cursor,
      count: 500,
    });

    const { added, modified, removed, next_cursor, has_more } = syncResponse.data;

    // Process ADDED transactions
    for (const txn of added) {
      // Skip pending transactions — they'll come back as posted later
      if (txn.pending) continue;

      const financierAccountId = accountMap[txn.account_id];
      if (!financierAccountId) continue; // Account not mapped

      // Check for existing transaction with this plaid_transaction_id (dedup)
      const existing = await findTransactionByPlaidId(userDb, budgetId, txn.transaction_id);
      if (existing) continue;

      const rawName = getPlaidPayeeName(txn);
      const { payeeId, categorySuggest } = await resolvePayee(
        userDb, budgetId, rawName, existingPayees, importMappings
      );

      // Plaid: positive = money leaving (debit), negative = money entering (credit)
      // Financier: negative = outflow, positive = inflow
      const value = Math.round(txn.amount * -100);

      const transDoc = {
        _id: `b_${budgetId}_transaction_${uuidv4()}`,
        value: value,
        date: txn.date, // Already YYYY-MM-DD
        account: financierAccountId,
        payee: payeeId,
        memo: txn.name || null, // Raw bank description in memo
        cleared: true,
        reconciled: false,
        flag: null,
        category: categorySuggest || null,
        transfer: null,
        splits: [],
        checkNumber: null,
        plaid_transaction_id: txn.transaction_id,
      };

      await userDb.insert(transDoc);
      totalAdded++;
    }

    // Process MODIFIED transactions
    for (const txn of modified) {
      if (txn.pending) continue;

      const existing = await findTransactionByPlaidId(userDb, budgetId, txn.transaction_id);
      if (!existing) continue; // Can't modify what doesn't exist

      const financierAccountId = accountMap[txn.account_id];
      if (!financierAccountId) continue;

      // Update mutable fields
      existing.value = Math.round(txn.amount * -100);
      existing.date = txn.date;
      existing.memo = txn.name || existing.memo;

      await userDb.insert(existing);
      totalModified++;
    }

    // Process REMOVED transactions
    for (const txn of removed) {
      const existing = await findTransactionByPlaidId(userDb, budgetId, txn.transaction_id);
      if (!existing) continue;

      existing._deleted = true;
      await userDb.insert(existing);
      totalRemoved++;
    }

    cursor = next_cursor;
    hasMore = has_more;
  }

  // Update the stored cursor and last_synced in plaid_tokens DB
  const updatedItem = await plaidTokensDb.get(itemDoc._id);
  updatedItem.cursor = cursor;
  updatedItem.last_synced = new Date().toISOString();
  await plaidTokensDb.insert(updatedItem);

  // Update the user-visible metadata doc
  try {
    const metaDocId = `b_${budgetId}_plaid_link_${itemDoc.item_id}`;
    const metaDoc = await userDb.get(metaDocId);
    metaDoc.last_synced = new Date().toISOString();
    metaDoc.status = "active";
    metaDoc.last_error = null;
    await userDb.insert(metaDoc);
  } catch (e) {
    console.warn("Could not update plaid_link metadata:", e.message);
  }

  return { added: totalAdded, modified: totalModified, removed: totalRemoved };
}

// ---------------------------------------------------------------------------
// API Endpoints
// ---------------------------------------------------------------------------

/**
 * GET /status — Health check
 */
app.get("/status", (req, res) => {
  res.json({ status: "ok", plaid_env: PLAID_ENV });
});

const crypto = require("crypto");

/**
 * POST /create_link_token — Create a Plaid Link token for the frontend
 */
app.post("/create_link_token", authenticateUser, async (req, res) => {
  try {
    const clientUserId = crypto
      .createHash("sha256")
      .update(req.user.name)
      .digest("hex");

    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: clientUserId },
      client_name: "Financier",
      products: ["transactions"],
      country_codes: PLAID_COUNTRY_CODES,
      language: "en",
      webhook: PLAID_WEBHOOK_URL || undefined,
    });

    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error("create_link_token error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to create link token" });
  }
});

/**
 * POST /exchange_token — Exchange public_token for access_token after Plaid Link
 * Body: { public_token, budgetId, accountMappings: [{ plaid_account_id, financier_account_id }] }
 */
app.post("/exchange_token", authenticateUser, async (req, res) => {
  const { public_token, budgetId, accountMappings } = req.body;

  if (!public_token || !budgetId) {
    return res.status(400).json({ error: "Missing public_token or budgetId" });
  }

  try {
    // Exchange the public token
    const exchangeRes = await plaidClient.itemPublicTokenExchange({
      public_token: public_token,
    });
    const { access_token, item_id } = exchangeRes.data;

    // Get account details from Plaid
    const accountsRes = await plaidClient.accountsGet({ access_token });
    const plaidAccounts = accountsRes.data.accounts;
    const institution = accountsRes.data.item?.institution_id || null;

    // Get institution name
    let institutionName = "Unknown Bank";
    if (institution) {
      try {
        const instRes = await plaidClient.institutionsGetById({
          institution_id: institution,
          country_codes: PLAID_COUNTRY_CODES,
        });
        institutionName = instRes.data.institution.name;
      } catch (e) {
        console.warn("Could not fetch institution name:", e.message);
      }
    }

    // Build account list with mappings
    const accounts = plaidAccounts.map((pa) => {
      const mapping = (accountMappings || []).find((m) => m.plaid_account_id === pa.account_id);
      return {
        account_id: pa.account_id,
        name: pa.name,
        official_name: pa.official_name,
        type: pa.type,
        subtype: pa.subtype,
        mask: pa.mask,
        financier_account_id: mapping?.financier_account_id || null,
      };
    });

    // Store access token securely in admin-only plaid_tokens DB
    const tokenDoc = {
      _id: `plaid_item_${item_id}`,
      access_token: access_token,
      item_id: item_id,
      user_db: req.user.dbName,
      budget_id: budgetId,
      accounts: accounts,
      cursor: "",
      last_synced: null,
      webhook_url: PLAID_WEBHOOK_URL,
      created_at: new Date().toISOString(),
    };

    await plaidTokensDb.insert(tokenDoc);

    // Store harmless metadata in user's DB (will sync to browser)
    const userDb = getUserDb(req.user.dbName);
    const metaDoc = {
      _id: `b_${budgetId}_plaid_link_${item_id}`,
      institution_name: institutionName,
      accounts: accounts.map((a) => ({
        account_id: a.account_id,
        name: a.name,
        official_name: a.official_name,
        type: a.type,
        subtype: a.subtype,
        mask: a.mask,
        financier_account_id: a.financier_account_id,
      })),
      last_synced: null,
      status: "active",
      last_error: null,
    };

    await userDb.insert(metaDoc);

    res.json({
      success: true,
      item_id: item_id,
      institution_name: institutionName,
      accounts: accounts,
    });
  } catch (err) {
    console.error("exchange_token error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to exchange token" });
  }
});

/**
 * POST /update_mappings — Update account mappings for an existing Plaid Item
 * Body: { itemId, accountMappings: [{ plaid_account_id, financier_account_id }] }
 */
app.post("/update_mappings", authenticateUser, async (req, res) => {
  const { itemId, accountMappings } = req.body;

  if (!itemId || !accountMappings) {
    return res.status(400).json({ error: "Missing itemId or accountMappings" });
  }

  try {
    // Update plaid_tokens DB
    const tokenDoc = await plaidTokensDb.get(`plaid_item_${itemId}`);

    // Verify this item belongs to the requesting user
    if (tokenDoc.user_db !== req.user.dbName) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Update account mappings
    for (const mapping of accountMappings) {
      const account = tokenDoc.accounts.find((a) => a.account_id === mapping.plaid_account_id);
      if (account) {
        account.financier_account_id = mapping.financier_account_id;
      }
    }

    await plaidTokensDb.insert(tokenDoc);

    // Update user-visible metadata
    const userDb = getUserDb(req.user.dbName);
    try {
      const metaDoc = await userDb.get(`b_${tokenDoc.budget_id}_plaid_link_${itemId}`);
      for (const mapping of accountMappings) {
        const account = metaDoc.accounts.find((a) => a.account_id === mapping.plaid_account_id);
        if (account) {
          account.financier_account_id = mapping.financier_account_id;
        }
      }
      await userDb.insert(metaDoc);
    } catch (e) {
      console.warn("Could not update plaid_link metadata:", e.message);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("update_mappings error:", err.message);
    res.status(500).json({ error: "Failed to update mappings" });
  }
});

/**
 * POST /sync — Trigger a transaction sync
 * Body: { budgetId, itemId? }
 */
app.post("/sync", authenticateUser, async (req, res) => {
  const { budgetId, itemId } = req.body;

  if (!budgetId) {
    return res.status(400).json({ error: "Missing budgetId" });
  }

  try {
    // Find all Plaid items for this user/budget
    const allItems = await plaidTokensDb.list({ include_docs: true });
    const userItems = allItems.rows
      .filter((r) => r.doc && r.doc.user_db === req.user.dbName && r.doc.budget_id === budgetId)
      .map((r) => r.doc);

    if (itemId) {
      // Sync specific item
      const item = userItems.find((i) => i.item_id === itemId);
      if (!item) {
        return res.status(404).json({ error: "Plaid item not found" });
      }

      const result = await syncItemTransactions(item);
      return res.json({ success: true, items: [{ item_id: itemId, ...result }] });
    }

    // Sync all items
    const results = [];
    for (const item of userItems) {
      try {
        const result = await syncItemTransactions(item);
        results.push({ item_id: item.item_id, ...result });
      } catch (err) {
        console.error(`Sync error for item ${item.item_id}:`, err.message);

        // Update error status in user's metadata
        const userDb = getUserDb(req.user.dbName);
        try {
          const metaDoc = await userDb.get(`b_${budgetId}_plaid_link_${item.item_id}`);
          metaDoc.status = "error";
          metaDoc.last_error = err.message;
          await userDb.insert(metaDoc);
        } catch (e) { /* ignore */ }

        results.push({ item_id: item.item_id, error: err.message });
      }
    }

    res.json({ success: true, items: results });
  } catch (err) {
    console.error("sync error:", err.message);
    res.status(500).json({ error: "Sync failed" });
  }
});

/**
 * GET /accounts — List linked Plaid accounts for a budget
 * Query: ?budgetId=xxx
 */
app.get("/accounts", authenticateUser, async (req, res) => {
  const { budgetId } = req.query;

  if (!budgetId) {
    return res.status(400).json({ error: "Missing budgetId query parameter" });
  }

  try {
    const allItems = await plaidTokensDb.list({ include_docs: true });
    const userItems = allItems.rows
      .filter((r) => r.doc && r.doc.user_db === req.user.dbName && r.doc.budget_id === budgetId)
      .map((r) => ({
        item_id: r.doc.item_id,
        accounts: r.doc.accounts,
        last_synced: r.doc.last_synced,
        // Do NOT expose access_token
      }));

    // Enrich with metadata from user DB
    const userDb = getUserDb(req.user.dbName);
    const enriched = [];
    for (const item of userItems) {
      try {
        const metaDoc = await userDb.get(`b_${budgetId}_plaid_link_${item.item_id}`);
        enriched.push({
          ...item,
          institution_name: metaDoc.institution_name,
          status: metaDoc.status,
          last_error: metaDoc.last_error,
        });
      } catch (e) {
        enriched.push({ ...item, institution_name: "Unknown", status: "unknown" });
      }
    }

    res.json({ accounts: enriched });
  } catch (err) {
    console.error("accounts error:", err.message);
    res.status(500).json({ error: "Failed to list accounts" });
  }
});

/**
 * POST /unlink — Remove a linked Plaid account
 * Body: { itemId, budgetId }
 */
app.post("/unlink", authenticateUser, async (req, res) => {
  const { itemId, budgetId } = req.body;

  if (!itemId) {
    return res.status(400).json({ error: "Missing itemId" });
  }

  try {
    const tokenDoc = await plaidTokensDb.get(`plaid_item_${itemId}`);

    // Verify ownership
    if (tokenDoc.user_db !== req.user.dbName) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Tell Plaid to remove the item
    try {
      await plaidClient.itemRemove({ access_token: tokenDoc.access_token });
    } catch (e) {
      console.warn("Plaid item/remove failed (may already be removed):", e.message);
    }

    // Delete from plaid_tokens DB
    await plaidTokensDb.destroy(tokenDoc._id, tokenDoc._rev);

    // Delete metadata from user's DB
    if (budgetId) {
      const userDb = getUserDb(req.user.dbName);
      try {
        const metaDoc = await userDb.get(`b_${budgetId}_plaid_link_${itemId}`);
        await userDb.destroy(metaDoc._id, metaDoc._rev);
      } catch (e) {
        console.warn("Could not delete plaid_link metadata:", e.message);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("unlink error:", err.message);
    res.status(500).json({ error: "Failed to unlink account" });
  }
});

/**
 * POST /webhook — Receive Plaid webhook notifications
 * Plaid sends these when new transactions are available.
 */
app.post("/webhook", async (req, res) => {
  // Always respond 200 quickly to avoid Plaid retries
  res.status(200).json({ received: true });

  const { webhook_type, webhook_code, item_id } = req.body;

  console.log(`Webhook received: ${webhook_type}/${webhook_code} for item ${item_id}`);

  // We primarily care about TRANSACTIONS webhooks
  if (webhook_type !== "TRANSACTIONS") {
    return;
  }

  // SYNC_UPDATES_AVAILABLE means new transactions are ready
  if (webhook_code === "SYNC_UPDATES_AVAILABLE" || webhook_code === "INITIAL_UPDATE" || webhook_code === "HISTORICAL_UPDATE") {
    try {
      const tokenDoc = await plaidTokensDb.get(`plaid_item_${item_id}`);
      const result = await syncItemTransactions(tokenDoc);
      console.log(`Webhook sync complete for ${item_id}:`, result);
    } catch (err) {
      console.error(`Webhook sync failed for ${item_id}:`, err.message);
    }
  }
});

// ---------------------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Plaid sync service listening on port ${PORT}`);
  console.log(`Plaid environment: ${PLAID_ENV}`);
  console.log(`Webhook URL: ${PLAID_WEBHOOK_URL || "(not set)"}`);
});
