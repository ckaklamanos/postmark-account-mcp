#!/usr/bin/env node
// Read-only Postmark MCP that works across ALL servers of one or MORE Postmark accounts.
// Accounts: JSON file { "<name>": "<account-token>", ... }
//   path = $POSTMARK_ACCOUNTS_FILE or ~/.config/postmark-account-mcp/accounts.json
//   (fallback: single account from $POSTMARK_ACCOUNT_TOKEN, named "default")
// Server tokens are discovered via GET /servers. The file is re-read on every cache refresh,
// so new accounts appear without restarting.
// Deliberately exposes NO send / create / update / delete operations.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = "https://api.postmarkapp.com";
const ACCOUNTS_FILE = process.env.POSTMARK_ACCOUNTS_FILE || join(homedir(), ".config", "postmark-account-mcp", "accounts.json");

function loadAccounts() {
  let fromFile = null;
  try {
    const raw = JSON.parse(readFileSync(ACCOUNTS_FILE, "utf8"));
    const obj = raw.accounts && typeof raw.accounts === "object" ? raw.accounts : raw;
    fromFile = Object.entries(obj)
      .filter(([, t]) => typeof t === "string" && t.trim())
      .map(([name, token]) => ({ name, token: token.trim() }));
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`Cannot read ${ACCOUNTS_FILE}: ${e.message}`);
  }
  if (fromFile && fromFile.length) return fromFile;
  if (process.env.POSTMARK_ACCOUNT_TOKEN) return [{ name: "default", token: process.env.POSTMARK_ACCOUNT_TOKEN }];
  throw new Error(`No Postmark accounts configured. Create ${ACCOUNTS_FILE} as {"name": "account-token", ...} or set POSTMARK_ACCOUNT_TOKEN.`);
}

// ---------- HTTP ----------
async function pm(path, { accountToken, token, query } = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const headers = { Accept: "application/json" };
  if (accountToken) headers["X-Postmark-Account-Token"] = accountToken;
  else headers["X-Postmark-Server-Token"] = token;
  const res = await fetch(url, { method: "GET", headers });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const msg = body && body.Message ? body.Message : text.slice(0, 300);
    throw new Error(`Postmark ${res.status} on ${path}: ${msg}`);
  }
  return body;
}

// ---------- Server discovery (cached 5 min) ----------
let cache = { at: 0, servers: [], errors: [] };
async function getServers(force = false) {
  if (!force && Date.now() - cache.at < 5 * 60 * 1000 && (cache.servers.length || cache.errors.length)) return cache;
  const accounts = loadAccounts();
  const servers = [], errors = [];
  await Promise.all(accounts.map(async (acc) => {
    try {
      for (let offset = 0; ; offset += 500) {
        const r = await pm("/servers", { accountToken: acc.token, query: { count: 500, offset } });
        for (const s of r.Servers) servers.push({ account: acc.name, id: s.ID, name: s.Name, token: (s.ApiTokens || [])[0] });
        if (offset + r.Servers.length >= r.TotalCount || r.Servers.length === 0) break;
      }
    } catch (e) { errors.push({ account: acc.name, error: e.message }); }
  }));
  servers.sort((a, b) => a.account.localeCompare(b.account) || a.name.localeCompare(b.name));
  cache = { at: Date.now(), servers, errors };
  return cache;
}

const label = (s) => `${s.account}/${s.name} (${s.id})`;
const match = (list, q, key) => {
  if (q === undefined || q === null || String(q).trim() === "") return list;
  const v = String(q).trim().toLowerCase();
  const exact = list.filter((x) => String(x[key === "name" ? "id" : key]).toLowerCase() === v || x[key].toLowerCase() === v);
  return exact.length ? exact : list.filter((x) => x[key].toLowerCase().includes(v));
};

// account / server: partial, case-insensitive; server also accepts numeric ID or "account/server".
async function resolveServers(account, server) {
  const { servers: all, errors } = await getServers();
  let list = all.filter((s) => s.token);
  if (server && String(server).includes("/") && !account) {
    const [a, ...rest] = String(server).split("/");
    account = a; server = rest.join("/");
  }
  list = match(list, account, "account");
  if (!list.length) throw new Error(`No account matches "${account}". Accounts: ${[...new Set(all.map((s) => s.account))].join(", ")}${errors.length ? ` (failed: ${errors.map((e) => e.account).join(", ")})` : ""}`);
  const before = list;
  list = match(list, server, "name");
  if (!list.length) throw new Error(`No server matches "${server}". Available: ${before.map(label).join(", ")}`);
  return list;
}

// Run fn on each server; collect results and per-server errors.
async function forEachServer({ account, server }, fn) {
  const targets = await resolveServers(account, server);
  const out = await Promise.all(
    targets.map(async (s) => {
      try { return { account: s.account, server: s.name, server_id: s.id, ...(await fn(s)) }; }
      catch (e) { return { account: s.account, server: s.name, server_id: s.id, error: e.message }; }
    })
  );
  return out;
}

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: e.message || String(e) }] });
const wrap = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };

const accountArg = z.string().optional()
  .describe("Account name from the accounts file (partial, case-insensitive). Omit for ALL accounts.");
const serverArg = z.string().optional()
  .describe("Server name (partial, case-insensitive), numeric ID, or \"account/server\". Omit for ALL servers.");
const dateArg = (what) => z.string().optional().describe(`${what} date, YYYY-MM-DD (or YYYY-MM-DDThh:mm:ss)`);
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

// ---------- MCP ----------
const mcp = new McpServer({ name: "postmark-account", version: "1.1.0" });

mcp.registerTool("list_servers", {
  title: "List Postmark accounts & servers",
  description: "List all configured accounts and their servers (name, ID, message streams). Tokens are never returned. Re-reads the accounts file.",
  inputSchema: {
    account: accountArg,
    include_streams: z.boolean().optional().describe("Also list each server's message streams (default true)"),
  },
  annotations: RO,
}, wrap(async ({ account, include_streams = true }) => {
  const { servers, errors } = await getServers(true);
  const list = match(servers, account, "account");
  const rows = await Promise.all(list.map(async (s) => {
    const row = { account: s.account, name: s.name, id: s.id, has_token: !!s.token };
    if (include_streams && s.token) {
      try {
        const r = await pm("/message-streams", { token: s.token });
        row.streams = r.MessageStreams.map((m) => ({ id: m.ID, type: m.MessageStreamType, name: m.Name, archived: !!m.ArchivedAt }));
      } catch (e) { row.streams_error = e.message; }
    }
    return row;
  }));
  return errors.length ? { servers: rows, account_errors: errors } : rows;
}));

mcp.registerTool("search_messages", {
  title: "Search outbound messages",
  description: "Search outbound messages across all servers (or one). Returns ID, status, recipients, subject, time. Use get_message_details for the delivery event timeline.",
  inputSchema: {
    account: accountArg,
    server: serverArg,
    recipient: z.string().optional().describe("Recipient email (to/cc/bcc)"),
    fromemail: z.string().optional().describe("Sender email"),
    subject: z.string().optional(),
    tag: z.string().optional(),
    status: z.enum(["queued", "sent", "processed"]).optional(),
    stream: z.string().optional().describe("Message stream ID, e.g. outbound"),
    fromdate: dateArg("From"),
    todate: dateArg("To"),
    count: z.number().int().min(1).max(500).optional().describe("Max per server (default 25)"),
    offset: z.number().int().min(0).optional(),
  },
  annotations: RO,
}, wrap(async (a) => forEachServer(a, async (s) => {
  const r = await pm("/messages/outbound", {
    token: s.token,
    query: {
      count: a.count ?? 25, offset: a.offset ?? 0, recipient: a.recipient, fromemail: a.fromemail,
      subject: a.subject, tag: a.tag, status: a.status, messagestream: a.stream,
      fromdate: a.fromdate, todate: a.todate,
    },
  });
  return {
    total: r.TotalCount,
    messages: r.Messages.map((m) => ({
      id: m.MessageID, received_at: m.ReceivedAt, status: m.Status, stream: m.MessageStream,
      from: m.From, to: (m.Recipients || []).join(", "), subject: m.Subject, tag: m.Tag || undefined,
    })),
  };
})));

mcp.registerTool("get_message_details", {
  title: "Message delivery timeline",
  description: "Full details + event timeline (Delivered, Bounced, Opened, Clicked, ...) of one outbound message. If server is omitted, all servers are tried.",
  inputSchema: {
    message_id: z.string().describe("Postmark MessageID"),
    account: accountArg,
    server: serverArg,
    include_body: z.boolean().optional().describe("Include text/html body (default false)"),
  },
  annotations: RO,
}, wrap(async ({ message_id, account, server, include_body = false }) => {
  const targets = await resolveServers(account, server);
  for (const s of targets) {
    try {
      const d = await pm(`/messages/outbound/${encodeURIComponent(message_id)}/details`, { token: s.token });
      const res = {
        account: s.account, server: s.name, server_id: s.id, id: d.MessageID, status: d.Status, stream: d.MessageStream,
        received_at: d.ReceivedAt, from: d.From, to: d.Recipients, cc: d.Cc, subject: d.Subject, tag: d.Tag,
        events: (d.MessageEvents || []).map((e) => ({ type: e.Type, at: e.ReceivedAt, recipient: e.Recipient, details: e.Details })),
      };
      if (include_body) { res.text_body = d.TextBody; res.html_body = d.HtmlBody; }
      return res;
    } catch (e) {
      if (!/\b(404|422)\b/.test(e.message)) throw e;
    }
  }
  throw new Error(`Message ${message_id} not found in ${targets.length} server(s)`);
}));

mcp.registerTool("search_bounces", {
  title: "Search bounces",
  description: "Search bounces across all servers (or one).",
  inputSchema: {
    account: accountArg,
    server: serverArg,
    email: z.string().optional().describe("Filter by email (partial match)"),
    type: z.string().optional().describe("Bounce type, e.g. HardBounce, SoftBounce, SpamComplaint"),
    inactive: z.boolean().optional().describe("Only bounces that deactivated the address"),
    fromdate: dateArg("From"),
    todate: dateArg("To"),
    count: z.number().int().min(1).max(500).optional().describe("Max per server (default 25)"),
  },
  annotations: RO,
}, wrap(async (a) => forEachServer(a, async (s) => {
  const r = await pm("/bounces", {
    token: s.token,
    query: { count: a.count ?? 25, offset: 0, emailFilter: a.email, type: a.type, inactive: a.inactive, fromdate: a.fromdate, todate: a.todate },
  });
  return {
    total: r.TotalCount,
    bounces: r.Bounces.map((b) => ({
      id: b.ID, type: b.Type, email: b.Email, at: b.BouncedAt, description: b.Description,
      details: b.Details, inactive: b.Inactive, can_activate: b.CanActivate, subject: b.Subject, message_id: b.MessageID, stream: b.MessageStream,
    })),
  };
})));

mcp.registerTool("list_suppressions", {
  title: "List suppressions",
  description: "Suppressed recipients per server/stream (hard bounces, spam complaints, manual). Omit server for all servers; omit stream for all streams.",
  inputSchema: {
    account: accountArg,
    server: serverArg,
    stream: z.string().optional().describe("Message stream ID (default: every stream of the server)"),
    email: z.string().optional().describe("Exact email to check"),
  },
  annotations: RO,
}, wrap(async (a) => forEachServer(a, async (s) => {
  let streams = a.stream ? [a.stream] : null;
  if (!streams) {
    const r = await pm("/message-streams", { token: s.token });
    streams = r.MessageStreams.map((m) => m.ID);
  }
  const result = {};
  for (const st of streams) {
    const r = await pm(`/message-streams/${encodeURIComponent(st)}/suppressions/dump`, { token: s.token, query: { EmailAddress: a.email } });
    result[st] = (r.Suppressions || []).map((x) => ({ email: x.EmailAddress, reason: x.SuppressionReason, origin: x.Origin, at: x.CreatedAt }));
  }
  return { suppressions: result };
})));

mcp.registerTool("delivery_stats", {
  title: "Delivery stats",
  description: "Outbound overview per server: sent, bounced, bounce rate, spam complaints, opens, clicks.",
  inputSchema: {
    account: accountArg,
    server: serverArg,
    fromdate: dateArg("From"),
    todate: dateArg("To"),
    stream: z.string().optional(),
    tag: z.string().optional(),
  },
  annotations: RO,
}, wrap(async (a) => forEachServer(a, async (s) => {
  const r = await pm("/stats/outbound", { token: s.token, query: { fromdate: a.fromdate, todate: a.todate, messagestream: a.stream, tag: a.tag } });
  return {
    sent: r.Sent, bounced: r.Bounced, bounce_rate: r.BounceRate, smtp_api_errors: r.SMTPApiErrors,
    spam_complaints: r.SpamComplaints, spam_rate: r.SpamComplaintsRate, opens: r.Opens, unique_opens: r.UniqueOpens,
    tracked: r.Tracked, total_clicks: r.TotalClicks, unique_links_clicked: r.UniqueLinksClicked,
  };
})));

await mcp.connect(new StdioServerTransport());
