#!/usr/bin/env node
/**
 * edm-mail — MCP server for the OVH Exchange mailbox
 * attilio.cianci@edminformatica.com (IMAP 993 + SMTP 587, basic auth).
 *
 * Credentials & host come from env (loaded from ./.env by start.sh):
 *   EDM_USER, EDM_PASS          (required)
 *   EDM_IMAP_HOST=ex.mail.ovh.net  EDM_IMAP_PORT=993
 *   EDM_SMTP_HOST=ex.mail.ovh.net  EDM_SMTP_PORT=587
 *   EDM_FROM_NAME               (optional display name on outgoing mail)
 *
 * Design: no persistent connection. Each tool opens IMAP/SMTP, does its work,
 * disconnects. OVH Exchange login is fast (~300ms), so per-call connect is fine
 * and avoids stale-socket headaches across long idle periods.
 *
 * Sending is gated: mail_send returns a DRY-RUN preview unless confirm:true is
 * passed — enforces the global "mai inviare email senza conferma" rule.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { simpleParser } from "mailparser";
import { z } from "zod";

const USER = process.env.EDM_USER;
const PASS = process.env.EDM_PASS;
const IMAP_HOST = process.env.EDM_IMAP_HOST || "ex.mail.ovh.net";
const IMAP_PORT = Number(process.env.EDM_IMAP_PORT || 993);
const SMTP_HOST = process.env.EDM_SMTP_HOST || "ex.mail.ovh.net";
const SMTP_PORT = Number(process.env.EDM_SMTP_PORT || 587);
const FROM_NAME = process.env.EDM_FROM_NAME || "";
const TRASH = "Deleted Items";
const SENT_FOLDER = process.env.EDM_SENT_FOLDER || "Sent Items";

if (!USER || !PASS) {
  console.error("[edm-mail] missing EDM_USER / EDM_PASS in environment");
  process.exit(1);
}

// ---- IMAP helper: connect, run fn, always disconnect ----
async function withImap(fn) {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: USER, pass: PASS },
    logger: false,
    socketTimeout: 30000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }
}

function envelopeSummary(msg) {
  const e = msg.envelope || {};
  const addr = (a) => (a && a.length ? a.map((x) => (x.name ? `${x.name} <${x.address}>` : x.address)).join(", ") : "");
  return {
    uid: msg.uid,
    seq: msg.seq,
    date: e.date ? new Date(e.date).toISOString() : null,
    from: addr(e.from),
    to: addr(e.to),
    cc: addr(e.cc),
    subject: e.subject || "(no subject)",
    seen: (msg.flags && (msg.flags.has ? msg.flags.has("\\Seen") : Array.from(msg.flags).includes("\\Seen"))) || false,
    flagged: (msg.flags && (msg.flags.has ? msg.flags.has("\\Flagged") : Array.from(msg.flags).includes("\\Flagged"))) || false,
  };
}

const server = new McpServer({ name: "edm-mail", version: "1.0.0" });

// ---- mail_list_folders ----
server.tool(
  "mail_list_folders",
  "List all mailbox folders (INBOX, Sent Items, Drafts, etc.) with message counts.",
  {},
  async () => {
    const out = await withImap(async (c) => {
      const folders = await c.list();
      const rows = [];
      for (const f of folders) {
        let total = null, unseen = null;
        try {
          const st = await c.status(f.path, { messages: true, unseen: true });
          total = st.messages; unseen = st.unseen;
        } catch { /* some special folders reject STATUS */ }
        rows.push({ path: f.path, specialUse: f.specialUse || null, messages: total, unseen });
      }
      return rows;
    });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  },
);

// ---- mail_list ----
server.tool(
  "mail_list",
  "List the most recent messages in a folder (newest first). Returns envelope summaries (uid, from, subject, date, seen).",
  {
    folder: z.string().default("INBOX").describe("Folder path, e.g. INBOX or 'Sent Items'"),
    limit: z.number().int().min(1).max(100).default(25),
    unseenOnly: z.boolean().default(false),
  },
  async ({ folder, limit, unseenOnly }) => {
    const out = await withImap(async (c) => {
      const lock = await c.getMailboxLock(folder);
      try {
        let uids;
        if (unseenOnly) {
          uids = await c.search({ seen: false }, { uid: true });
        } else {
          const mbox = c.mailbox;
          const total = mbox.exists;
          if (!total) return [];
          // sequence range for the last `limit` messages
          const start = Math.max(1, total - limit + 1);
          uids = [];
          for await (const m of c.fetch(`${start}:*`, { uid: true })) uids.push(m.uid);
        }
        uids = uids.slice(-limit);
        const rows = [];
        if (uids.length) {
          for await (const m of c.fetch(uids, { envelope: true, flags: true, uid: true }, { uid: true })) {
            rows.push(envelopeSummary(m));
          }
        }
        rows.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
        return rows;
      } finally {
        lock.release();
      }
    });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  },
);

// ---- mail_search ----
server.tool(
  "mail_search",
  "Search messages in a folder by sender, subject, free text, date range, or seen state. Returns matching envelope summaries.",
  {
    folder: z.string().default("INBOX"),
    from: z.string().optional().describe("Substring match on sender address/name"),
    subject: z.string().optional(),
    text: z.string().optional().describe("Free-text search across the whole message"),
    since: z.string().optional().describe("ISO date, e.g. 2026-05-01 — messages on/after this date"),
    before: z.string().optional().describe("ISO date — messages before this date"),
    seen: z.boolean().optional().describe("true=only read, false=only unread"),
    limit: z.number().int().min(1).max(100).default(30),
  },
  async ({ folder, from, subject, text, since, before, seen, limit }) => {
    const out = await withImap(async (c) => {
      const lock = await c.getMailboxLock(folder);
      try {
        const query = {};
        if (from) query.from = from;
        if (subject) query.subject = subject;
        if (text) query.body = text;
        if (since) query.since = new Date(since);
        if (before) query.before = new Date(before);
        if (seen === true) query.seen = true;
        if (seen === false) query.seen = false;
        if (Object.keys(query).length === 0) query.all = true;
        let uids = await c.search(query, { uid: true });
        uids = uids.slice(-limit);
        const rows = [];
        if (uids.length) {
          for await (const m of c.fetch(uids, { envelope: true, flags: true, uid: true }, { uid: true })) {
            rows.push(envelopeSummary(m));
          }
        }
        rows.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
        return rows;
      } finally {
        lock.release();
      }
    });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  },
);

// ---- mail_read ----
server.tool(
  "mail_read",
  "Read the full content of a message by UID: headers, plain-text body, and attachment metadata. Optionally mark it as read.",
  {
    folder: z.string().default("INBOX"),
    uid: z.number().int().describe("Message UID (from mail_list / mail_search)"),
    markSeen: z.boolean().default(false),
  },
  async ({ folder, uid, markSeen }) => {
    const out = await withImap(async (c) => {
      const lock = await c.getMailboxLock(folder);
      try {
        const msg = await c.fetchOne(uid, { source: true, envelope: true, flags: true }, { uid: true });
        if (!msg || !msg.source) throw new Error(`UID ${uid} not found in ${folder}`);
        const parsed = await simpleParser(msg.source);
        if (markSeen) {
          try { await c.messageFlagsAdd(uid, ["\\Seen"], { uid: true }); } catch { /* ignore */ }
        }
        return {
          uid,
          subject: parsed.subject || "(no subject)",
          from: parsed.from?.text || "",
          to: parsed.to?.text || "",
          cc: parsed.cc?.text || "",
          date: parsed.date ? parsed.date.toISOString() : null,
          text: parsed.text || "",
          html: parsed.text ? undefined : (parsed.html || undefined),
          attachments: (parsed.attachments || []).map((a) => ({
            filename: a.filename, contentType: a.contentType, size: a.size,
          })),
        };
      } finally {
        lock.release();
      }
    });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  },
);

// ---- mail_mark ----
server.tool(
  "mail_mark",
  "Set or clear flags on a message: mark as read/unread or flagged/unflagged.",
  {
    folder: z.string().default("INBOX"),
    uid: z.number().int(),
    seen: z.boolean().optional().describe("true=mark read, false=mark unread"),
    flagged: z.boolean().optional().describe("true=flag, false=unflag"),
  },
  async ({ folder, uid, seen, flagged }) => {
    const out = await withImap(async (c) => {
      const lock = await c.getMailboxLock(folder);
      try {
        const done = [];
        if (seen === true) { await c.messageFlagsAdd(uid, ["\\Seen"], { uid: true }); done.push("seen"); }
        if (seen === false) { await c.messageFlagsRemove(uid, ["\\Seen"], { uid: true }); done.push("unseen"); }
        if (flagged === true) { await c.messageFlagsAdd(uid, ["\\Flagged"], { uid: true }); done.push("flagged"); }
        if (flagged === false) { await c.messageFlagsRemove(uid, ["\\Flagged"], { uid: true }); done.push("unflagged"); }
        return { uid, applied: done };
      } finally {
        lock.release();
      }
    });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  },
);

// ---- mail_move ----
server.tool(
  "mail_move",
  "Move a message to another folder by UID.",
  {
    folder: z.string().default("INBOX"),
    uid: z.number().int(),
    target: z.string().describe("Destination folder path, e.g. 'Junk Email' or a custom folder"),
  },
  async ({ folder, uid, target }) => {
    const out = await withImap(async (c) => {
      const lock = await c.getMailboxLock(folder);
      try {
        await c.messageMove(uid, target, { uid: true });
        return { uid, movedTo: target };
      } finally {
        lock.release();
      }
    });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  },
);

// ---- mail_trash (move to Deleted Items — trash > rm) ----
server.tool(
  "mail_trash",
  "Move a message to 'Deleted Items' (soft delete, never hard-deletes).",
  {
    folder: z.string().default("INBOX"),
    uid: z.number().int(),
  },
  async ({ folder, uid }) => {
    const out = await withImap(async (c) => {
      const lock = await c.getMailboxLock(folder);
      try {
        await c.messageMove(uid, TRASH, { uid: true });
        return { uid, movedTo: TRASH };
      } finally {
        lock.release();
      }
    });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  },
);

// ---- mail_send (confirm-gated) ----
server.tool(
  "mail_send",
  "Send an email from the edminformatica mailbox. SAFETY: without confirm:true this returns a DRY-RUN preview and sends nothing. Always show the preview to the user and get explicit confirmation before calling again with confirm:true.",
  {
    to: z.string().describe("Recipient(s), comma-separated"),
    subject: z.string(),
    text: z.string().describe("Plain-text body"),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    html: z.string().optional(),
    attachments: z.array(z.object({
      path: z.string().describe("Local file path to attach"),
      filename: z.string().optional().describe("Override the attached file name"),
    })).optional().describe("File attachments, each by local path"),
    confirm: z.boolean().default(false).describe("Must be true to actually send. Leave false to preview."),
  },
  async ({ to, subject, text, cc, bcc, html, attachments, confirm }) => {
    const from = FROM_NAME ? `${FROM_NAME} <${USER}>` : USER;
    const atts = (attachments || []).map((a) => ({
      path: a.path,
      filename: a.filename || a.path.split("/").pop(),
    }));
    if (!confirm) {
      const preview = { dryRun: true, from, to, cc: cc || null, bcc: bcc || null, subject, body: text,
        attachments: atts.map((a) => a.filename) };
      return { content: [{ type: "text", text:
        "DRY RUN — nothing sent. Confirm with the user, then call mail_send again with confirm:true.\n\n" +
        JSON.stringify(preview, null, 2) }] };
    }
    const transport = nodemailer.createTransport({
      host: SMTP_HOST, port: SMTP_PORT, secure: false, requireTLS: true,
      auth: { user: USER, pass: PASS },
    });
    const mailOpts = { from, to, cc, bcc, subject, text, html,
      attachments: atts.length ? atts : undefined };
    const info = await transport.sendMail(mailOpts);
    // SMTP delivers but does NOT file a copy in Sent — IMAP-APPEND a copy so it shows up in "Sent Items".
    let savedToSent = false;
    try {
      const raw = await new MailComposer({ ...mailOpts, messageId: info.messageId }).compile().build();
      await withImap(async (c) => { await c.append(SENT_FOLDER, raw, ["\\Seen"]); });
      savedToSent = true;
    } catch (e) {
      console.error("[edm-mail] append to Sent failed:", e?.message || e);
    }
    return { content: [{ type: "text", text: JSON.stringify({ sent: true, savedToSent, messageId: info.messageId, accepted: info.accepted, rejected: info.rejected }, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[edm-mail] MCP server ready (IMAP " + IMAP_HOST + ", SMTP " + SMTP_HOST + ")");
