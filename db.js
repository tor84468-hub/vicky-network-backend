const { neon } = require("@neondatabase/serverless");

const sql = neon(process.env.DATABASE_URL);

async function initDatabase() {
  await sql`
    CREATE TABLE IF NOT EXISTS subscribers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      vicky_number TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      data_balance NUMERIC NOT NULL DEFAULT 0,
      call_balance NUMERIC NOT NULL DEFAULT 0,
      active_data_subscription JSONB,
      active_call_subscription JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS call_logs (
      id TEXT PRIMARY KEY,
      caller_id TEXT NOT NULL,
      caller_number TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      receiver_number TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      answered_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      duration_seconds INTEGER NOT NULL DEFAULT 0
    )
  `;
}

async function createCallLog(call) {
  await sql`
    INSERT INTO call_logs (
      id,
      caller_id,
      caller_number,
      receiver_id,
      receiver_number,
      status,
      created_at,
      answered_at,
      ended_at,
      duration_seconds
    )
    VALUES (
      ${call.id},
      ${call.caller_id},
      ${call.caller_number},
      ${call.receiver_id},
      ${call.receiver_number},
      ${call.status},
      ${call.created_at},
      ${call.answered_at || null},
      ${call.ended_at || null},
      ${call.duration_seconds || 0}
    )
  `;

  return getCallLog(call.id);
}

async function getCallLog(id) {
  const rows = await sql`
    SELECT *
    FROM call_logs
    WHERE id = ${id}
    LIMIT 1
  `;

  return rows[0] || null;
}

async function getActiveCall(id) {
  const rows = await sql`
    SELECT *
    FROM call_logs
    WHERE id = ${id}
      AND status IN ('ringing', 'connected')
    LIMIT 1
  `;

  return rows[0] || null;
}

async function getActiveCallForSubscriber(subscriberId) {
  const rows = await sql`
    SELECT *
    FROM call_logs
    WHERE (
      caller_id = ${subscriberId}
      OR receiver_id = ${subscriberId}
    )
    AND status IN ('ringing', 'connected')
    AND (
      status = 'connected'
      OR created_at > NOW() - INTERVAL '5 minutes'
    )
    ORDER BY created_at DESC
    LIMIT 1
  `;

  return rows[0] || null;
}

async function updateCallLog(id, data) {
  await sql`
    UPDATE call_logs
    SET
      status = ${data.status},
      answered_at = ${data.answered_at || null},
      ended_at = ${data.ended_at || null},
      duration_seconds = ${data.duration_seconds || 0}
    WHERE id = ${id}
  `;

  return getCallLog(id);
}

async function getCallHistory(subscriberId) {
  return await sql`
    SELECT *
    FROM call_logs
    WHERE caller_id = ${subscriberId}
       OR receiver_id = ${subscriberId}
    ORDER BY created_at DESC
  `;
}

async function getSubscribers() {
  return await sql`
    SELECT
      id,
      name,
      email,
      password,
      vicky_number,
      status,
      data_balance,
      call_balance,
      active_data_subscription,
      active_call_subscription,
      created_at
    FROM subscribers
    ORDER BY created_at ASC
  `;
}

async function getSubscriberById(id) {
  const rows = await sql`
    SELECT *
    FROM subscribers
    WHERE id = ${id}
    LIMIT 1
  `;
  return rows[0] || null;
}

async function getSubscriberByEmail(email) {
  const rows = await sql`
    SELECT *
    FROM subscribers
    WHERE LOWER(email) = LOWER(${email})
    LIMIT 1
  `;
  return rows[0] || null;
}

async function getSubscriberByNumber(number) {
  const rows = await sql`
    SELECT *
    FROM subscribers
    WHERE vicky_number = ${number}
    LIMIT 1
  `;
  return rows[0] || null;
}

async function createSubscriber(subscriber) {
  await sql`
    INSERT INTO subscribers (
      id,
      name,
      email,
      password,
      vicky_number,
      status,
      data_balance,
      call_balance,
      active_data_subscription,
      active_call_subscription
    )
    VALUES (
      ${subscriber.id},
      ${subscriber.name},
      ${subscriber.email},
      ${subscriber.password},
      ${subscriber.vicky_number},
      ${subscriber.status || "active"},
      ${subscriber.data_balance || 0},
      ${subscriber.call_balance || 0},
      ${subscriber.active_data_subscription
        ? JSON.stringify(subscriber.active_data_subscription)
        : null},
      ${subscriber.active_call_subscription
        ? JSON.stringify(subscriber.active_call_subscription)
        : null}
    )
  `;

  return getSubscriberById(subscriber.id);
}

async function updateSubscriber(id, data) {
  const current = await getSubscriberById(id);

  if (!current) return null;

  await sql`
    UPDATE subscribers
    SET
      name = ${data.name ?? current.name},
      email = ${data.email ?? current.email},
      password = ${data.password ?? current.password},
      status = ${data.status ?? current.status},
      data_balance = ${data.data_balance ?? current.data_balance},
      call_balance = ${data.call_balance ?? current.call_balance},
      active_data_subscription = ${
        data.active_data_subscription !== undefined
          ? data.active_data_subscription
            ? JSON.stringify(data.active_data_subscription)
            : null
          : current.active_data_subscription
      },
      active_call_subscription = ${
        data.active_call_subscription !== undefined
          ? data.active_call_subscription
            ? JSON.stringify(data.active_call_subscription)
            : null
          : current.active_call_subscription
      }
    WHERE id = ${id}
  `;

  return getSubscriberById(id);
}

module.exports = {
  sql,
  initDatabase,
  getSubscribers,
  getSubscriberById,
  getSubscriberByEmail,
  getSubscriberByNumber,
  createSubscriber,
  updateSubscriber,
  createCallLog,
  getCallLog,
  getActiveCall,
  getActiveCallForSubscriber,
  updateCallLog,
  getCallHistory
};
