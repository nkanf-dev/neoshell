import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { nanoid } from "nanoid";

import { agentEventSchema, type AgentEvent, type Conversation, type Message } from "@neoshell/shared";

const DEFAULT_CONVERSATION_TITLE = "New conversation";

type UserRecord = {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
};

type SessionRecord = {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
  last_seen_at: string;
};

export class SqliteStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        title_source TEXT NOT NULL DEFAULT 'manual',
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.ensureConversationColumn("title_source", "TEXT NOT NULL DEFAULT 'manual'");
    this.ensureConversationColumn("archived_at", "TEXT");
  }

  private ensureConversationColumn(name: string, sql: string) {
    const columns = this.db
      .prepare("PRAGMA table_info(conversations)")
      .all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === name)) {
      return;
    }
    this.db.exec(`ALTER TABLE conversations ADD COLUMN ${name} ${sql};`);
  }

  findUserByUsername(username: string): UserRecord | undefined {
    return this.db.prepare("SELECT * FROM users WHERE username = ?").get(username) as
      | UserRecord
      | undefined;
  }

  findUserById(id: string): UserRecord | undefined {
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRecord | undefined;
  }

  createUser(username: string, passwordHash: string): UserRecord {
    const record: UserRecord = {
      id: nanoid(),
      username,
      password_hash: passwordHash,
      created_at: new Date().toISOString()
    };
    this.db
      .prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(record.id, record.username, record.password_hash, record.created_at);
    return record;
  }

  updateUserPassword(id: string, passwordHash: string): void {
    this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, id);
  }

  createSession(userId: string, tokenHash: string, expiresAt: string): SessionRecord {
    const record: SessionRecord = {
      id: nanoid(),
      user_id: userId,
      token_hash: tokenHash,
      expires_at: expiresAt,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString()
    };
    this.db
      .prepare(
        "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        record.id,
        record.user_id,
        record.token_hash,
        record.expires_at,
        record.created_at,
        record.last_seen_at
      );
    return record;
  }

  findSessionByTokenHash(tokenHash: string): SessionRecord | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(tokenHash) as
      | SessionRecord
      | undefined;
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  touchSession(id: string): void {
    this.db
      .prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  createConversation(userId: string, title: string): Conversation {
    const conversation: Conversation = {
      id: nanoid(),
      title,
      titleSource: title === DEFAULT_CONVERSATION_TITLE ? "initial" : "manual",
      archivedAt: null,
      lastRunStatus: "unknown",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.db
      .prepare(
        "INSERT INTO conversations (id, user_id, title, title_source, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        conversation.id,
        userId,
        conversation.title,
        conversation.titleSource,
        conversation.archivedAt,
        conversation.createdAt,
        conversation.updatedAt
      );
    return conversation;
  }

  listConversations(userId: string): Conversation[] {
    return this.db
      .prepare(
        `SELECT
           c.id,
           c.title,
           c.title_source as titleSource,
           c.archived_at as archivedAt,
           c.created_at as createdAt,
           c.updated_at as updatedAt,
           COALESCE((
             SELECT CASE
               WHEN e.type = 'run_failed' THEN 'failed'
               WHEN e.type = 'run_completed' THEN 'completed'
               ELSE 'unknown'
             END
             FROM events e
             WHERE e.conversation_id = c.id
               AND e.type IN ('run_completed', 'run_failed')
             ORDER BY e.created_at DESC
             LIMIT 1
           ), 'unknown') as lastRunStatus
         FROM conversations c
         WHERE c.user_id = ?
         ORDER BY CASE WHEN c.archived_at IS NULL THEN 0 ELSE 1 END ASC, c.updated_at DESC`
      )
      .all(userId) as Conversation[];
  }

  getConversation(userId: string, conversationId: string): Conversation | undefined {
    return this.db
      .prepare(
        `SELECT
           c.id,
           c.title,
           c.title_source as titleSource,
           c.archived_at as archivedAt,
           c.created_at as createdAt,
           c.updated_at as updatedAt,
           COALESCE((
             SELECT CASE
               WHEN e.type = 'run_failed' THEN 'failed'
               WHEN e.type = 'run_completed' THEN 'completed'
               ELSE 'unknown'
             END
             FROM events e
             WHERE e.conversation_id = c.id
               AND e.type IN ('run_completed', 'run_failed')
             ORDER BY e.created_at DESC
             LIMIT 1
           ), 'unknown') as lastRunStatus
         FROM conversations c
         WHERE c.user_id = ? AND c.id = ?`
      )
      .get(userId, conversationId) as Conversation | undefined;
  }

  findConversationById(conversationId: string): Conversation | undefined {
    return this.db
      .prepare(
        `SELECT
           c.id,
           c.title,
           c.title_source as titleSource,
           c.archived_at as archivedAt,
           c.created_at as createdAt,
           c.updated_at as updatedAt,
           COALESCE((
             SELECT CASE
               WHEN e.type = 'run_failed' THEN 'failed'
               WHEN e.type = 'run_completed' THEN 'completed'
               ELSE 'unknown'
             END
             FROM events e
             WHERE e.conversation_id = c.id
               AND e.type IN ('run_completed', 'run_failed')
             ORDER BY e.created_at DESC
             LIMIT 1
           ), 'unknown') as lastRunStatus
         FROM conversations c
         WHERE c.id = ?`
      )
      .get(conversationId) as Conversation | undefined;
  }

  updateConversationTimestamp(conversationId: string): void {
    this.db
      .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), conversationId);
  }

  updateConversation(input: {
    conversationId: string;
    title?: string;
    titleSource?: Conversation["titleSource"];
    archivedAt?: string | null;
  }): Conversation | undefined {
    const existing = this.findConversationById(input.conversationId);
    if (!existing) {
      return undefined;
    }

    const title = input.title ?? existing.title;
    const titleSource = input.titleSource ?? existing.titleSource;
    const archivedAt = input.archivedAt === undefined ? existing.archivedAt : input.archivedAt;
    const updatedAt = new Date().toISOString();

    this.db
      .prepare("UPDATE conversations SET title = ?, title_source = ?, archived_at = ?, updated_at = ? WHERE id = ?")
      .run(title, titleSource, archivedAt, updatedAt, input.conversationId);

    return this.findConversationById(input.conversationId);
  }

  saveMessage(input: {
    id?: string;
    conversationId: string;
    role: Message["role"];
    content: string;
    createdAt?: string;
  }): Message {
    const message: Message = {
      id: input.id ?? nanoid(),
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      createdAt: input.createdAt ?? new Date().toISOString()
    };
    this.db
      .prepare(
        "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(message.id, message.conversationId, message.role, message.content, message.createdAt);
    this.updateConversationTimestamp(input.conversationId);
    return message;
  }

  listMessages(conversationId: string): Message[] {
    return this.db
      .prepare(
        "SELECT id, conversation_id as conversationId, role, content, created_at as createdAt FROM messages WHERE conversation_id = ? ORDER BY created_at ASC"
      )
      .all(conversationId) as Message[];
  }

  saveEvent(conversationId: string, event: AgentEvent): void {
    this.db
      .prepare(
        "INSERT INTO events (id, conversation_id, run_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(nanoid(), conversationId, event.runId, event.type, JSON.stringify(event), event.at);
    this.updateConversationTimestamp(conversationId);
  }

  listEvents(conversationId: string): AgentEvent[] {
    const rows = this.db
      .prepare("SELECT payload FROM events WHERE conversation_id = ? ORDER BY created_at ASC")
      .all(conversationId) as Array<{ payload: string }>;
    return rows.map((row) => agentEventSchema.parse(JSON.parse(row.payload) as unknown));
  }

  resetConversation(conversationId: string): Conversation | undefined {
    const existing = this.findConversationById(conversationId);
    if (!existing) {
      return undefined;
    }

    this.db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(conversationId);
    this.db.prepare("DELETE FROM events WHERE conversation_id = ?").run(conversationId);
    this.updateConversationTimestamp(conversationId);
    return this.findConversationById(conversationId);
  }

  deleteConversation(conversationId: string): void {
    this.db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(conversationId);
    this.db.prepare("DELETE FROM events WHERE conversation_id = ?").run(conversationId);
    this.db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
  }

  close(): void {
    this.db.close();
  }
}
