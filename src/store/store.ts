import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SessionRef = { agent_id: string; session_id: string; cwd: string };

/** (gateway, conversation_id) -> selected agent and bound session. */
export type Binding = { gateway: string; conversation_id: string; agent_id: string; session: SessionRef | null };

export type OutboxFile = { path: string; name: string; mime: string };

/** A notify waiting for `delivered`. Files are re-sent as blobs on every attempt. */
export type OutboxEntry = {
  notify_id: string;
  gateway: string;
  conversation_id?: string;
  session?: SessionRef;
  text?: string;
  switched: boolean;
  files: OutboxFile[];
  created_at: number;
};

/** Connector state in SQLite (node:sqlite): bindings, notify outbox, kv. Statements are prepared once. */
export class Store {
  #db: DatabaseSync;
  #q: ReturnType<typeof prepare>;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      pragma journal_mode = wal;
      create table if not exists bindings (
        gateway text not null, conversation_id text not null, agent_id text not null,
        session_id text, cwd text, updated_at integer not null,
        primary key (gateway, conversation_id));
      create table if not exists outbox (
        notify_id text primary key, gateway text not null, body text not null, created_at integer not null);
      create table if not exists kv (key text primary key, value text not null);
    `);
    this.#q = prepare(this.#db);
  }

  close(): void {
    this.#db.close();
  }

  getBinding(gateway: string, conversation_id: string): Binding | undefined {
    const row = this.#q.getBinding.get(gateway, conversation_id);
    return row ? toBinding(row) : undefined;
  }

  setBinding(b: Binding): void {
    this.#q.setBinding.run(b.gateway, b.conversation_id, b.agent_id, b.session?.session_id ?? null, b.session?.cwd ?? null, Date.now());
  }

  bindingsForGateway(gateway: string): Binding[] {
    return this.#q.bindingsForGateway.all(gateway).map(toBinding);
  }

  bindingsForSession(agent_id: string, session_id: string): Binding[] {
    return this.#q.bindingsForSession.all(agent_id, session_id).map(toBinding);
  }

  addOutbox(e: OutboxEntry): void {
    const { notify_id, gateway, created_at, ...body } = e;
    this.#q.addOutbox.run(notify_id, gateway, JSON.stringify(body), created_at);
  }

  listOutbox(gateway?: string): OutboxEntry[] {
    const rows = gateway ? this.#q.listOutboxFor.all(gateway) : this.#q.listOutbox.all();
    return rows.map(toOutbox);
  }

  deleteOutbox(notify_id: string): boolean {
    return Number(this.#q.deleteOutbox.run(notify_id).changes) > 0;
  }

  kvGet<T>(key: string): T | undefined {
    const row = this.#q.kvGet.get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  kvSet(key: string, value: unknown): void {
    this.#q.kvSet.run(key, JSON.stringify(value));
  }
}

function prepare(db: DatabaseSync) {
  return {
    getBinding: db.prepare("select * from bindings where gateway = ? and conversation_id = ?"),
    setBinding: db.prepare(
      `insert into bindings (gateway, conversation_id, agent_id, session_id, cwd, updated_at) values (?, ?, ?, ?, ?, ?)
       on conflict (gateway, conversation_id) do update set agent_id = excluded.agent_id,
         session_id = excluded.session_id, cwd = excluded.cwd, updated_at = excluded.updated_at`,
    ),
    bindingsForGateway: db.prepare("select * from bindings where gateway = ? order by updated_at"),
    bindingsForSession: db.prepare("select * from bindings where agent_id = ? and session_id = ? order by gateway, conversation_id"),
    addOutbox: db.prepare("insert into outbox (notify_id, gateway, body, created_at) values (?, ?, ?, ?)"),
    listOutboxFor: db.prepare("select * from outbox where gateway = ? order by created_at, rowid"),
    listOutbox: db.prepare("select * from outbox order by created_at, rowid"),
    deleteOutbox: db.prepare("delete from outbox where notify_id = ?"),
    kvGet: db.prepare("select value from kv where key = ?"),
    kvSet: db.prepare("insert into kv (key, value) values (?, ?) on conflict (key) do update set value = excluded.value"),
  };
}

type Row = Record<string, unknown>;

function toBinding(r: Row): Binding {
  const session = r.session_id ? { agent_id: String(r.agent_id), session_id: String(r.session_id), cwd: String(r.cwd) } : null;
  return { gateway: String(r.gateway), conversation_id: String(r.conversation_id), agent_id: String(r.agent_id), session };
}

function toOutbox(r: Row): OutboxEntry {
  const body = JSON.parse(String(r.body)) as Omit<OutboxEntry, "notify_id" | "gateway" | "created_at">;
  return { ...body, notify_id: String(r.notify_id), gateway: String(r.gateway), created_at: Number(r.created_at) };
}
