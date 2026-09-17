const crypto = require("crypto");
const db = require("../db");

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(JSON.stringify(data));
}

function body(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => data += chunk);
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function makeVickyNumber(subscribers) {
  let number;

  do {
    const part = Math.floor(10000000 + Math.random() * 90000000);
    number = String(part);
  } while (subscribers.some(s => s.vicky_number === number));

  return number;
}

function publicSubscriber(s) {
  return {
    id: s.id,
    name: s.name,
    email: s.email,
    vicky_number: s.vicky_number,
    status: s.status,
    data_balance_gb: Number(s.data_balance ?? s.data_balance_gb ?? 0),
    call_balance_minutes: Number(s.call_balance ?? s.call_balance_minutes ?? 0),
    active_data_subscription: s.active_data_subscription,
    active_call_subscription: s.active_call_subscription,
    created_at: s.created_at
  };
}


/* VICKY_CALL_SIGNALING */

/* VICKY_WEBRTC_SIGNALING */


let signalingTableReady = null;

async function ensureSignalingTable() {
  if (!signalingTableReady) {
    signalingTableReady = db.sql`
      CREATE TABLE IF NOT EXISTS call_signals (
        id TEXT PRIMARY KEY,
        call_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        type TEXT NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
  }

  await signalingTableReady;
}

async function sendCallSignal(req, res) {
  try {
    const data = await body(req);

    if (!data.call_id || !data.subscriber_id || !data.type || data.data === undefined) {
      return json(res, 400, {
        success: false,
        error: "call_id, subscriber_id, type and data are required"
      });
    }

    await ensureSignalingTable();

    const call = await db.getCallLog(data.call_id);

    if (!call) {
      return json(res, 404, {
        success: false,
        error: "Call not found"
      });
    }

    if (
      data.subscriber_id !== call.caller_id &&
      data.subscriber_id !== call.receiver_id
    ) {
      return json(res, 403, {
        success: false,
        error: "Not a participant in this call"
      });
    }

    const signalId = require("crypto").randomUUID();

    await db.sql`
      INSERT INTO call_signals (
        id,
        call_id,
        sender_id,
        type,
        data,
        created_at
      )
      VALUES (
        ${signalId},
        ${data.call_id},
        ${data.subscriber_id},
        ${data.type},
        ${JSON.stringify(data.data)}::jsonb,
        NOW()
      )
    `;

    return json(res, 200, {
      success: true,
      signal_id: signalId
    });

  } catch (err) {
    console.log("Send call signal error:", err.message);

    return json(res, 500, {
      success: false,
      error: "Failed to send call signal"
    });
  }
}

async function getCallSignals(req, res, callIdValue, subscriberId) {
  try {
    if (!subscriberId) {
      return json(res, 400, {
        success: false,
        error: "subscriber_id is required"
      });
    }

    await ensureSignalingTable();

    const call = await db.getCallLog(callIdValue);

    if (!call) {
      return json(res, 404, {
        success: false,
        error: "Call not found"
      });
    }

    if (
      subscriberId !== call.caller_id &&
      subscriberId !== call.receiver_id
    ) {
      return json(res, 403, {
        success: false,
        error: "Not a participant in this call"
      });
    }

    const signals = await db.sql`
      SELECT
        id,
        type,
        data,
        created_at
      FROM call_signals
      WHERE call_id = ${callIdValue}
        AND sender_id <> ${subscriberId}
      ORDER BY created_at ASC
      LIMIT 100
    `;

    if (signals.length > 0) {
      const ids = signals.map(x => x.id);

      await db.sql`
        DELETE FROM call_signals
        WHERE id = ANY(${ids})
      `;
    }

    return json(res, 200, {
      success: true,
      signals: signals.map(x => ({
        id: x.id,
        type: x.type,
        data: x.data,
        created_at: x.created_at
      }))
    });

  } catch (err) {
    console.log("Get call signals error:", err.message);

    return json(res, 500, {
      success: false,
      error: "Failed to get call signals"
    });
  }
}


const activeCalls = new Map();

function callId() {
  return require("crypto").randomUUID();
}

function cleanCall(call) {
  return {
    id: call.id,
    caller_id: call.caller_id,
    caller_number: call.caller_number,
    receiver_id: call.receiver_id,
    receiver_number: call.receiver_number,
    status: call.status,
    created_at: call.created_at,
    answered_at: call.answered_at || null,
    ended_at: call.ended_at || null
  };
}

/*
  POST /call/start

  Creates a Vicky-to-Vicky call request.
*/
async function cleanupStaleCalls() {
  try {
    const rows = await db.sql`
      SELECT *
      FROM call_logs
      WHERE status = 'ringing'
        AND created_at < NOW() - INTERVAL '5 minutes'
  `;

  for (const call of rows) {
    await db.updateCallLog(call.id, {
      status: "missed",
      answered_at: call.answered_at,
      ended_at: new Date().toISOString(),
      duration_seconds: 0
    });

    activeCalls.delete(call.id);
  }
  } catch (err) {
    console.log("Call cleanup error:", err.message);
  }
}

/*
  POST /call/start

  Creates a persistent Vicky-to-Vicky call request.
*/
async function startCall(req, res) {
  try {
    const data = await body(req);

    const caller_id = String(data.caller_id || "");
    const receiver_number = String(data.receiver_number || "");

    if (!caller_id || !receiver_number) {
      return json(res, 400, {
        success: false,
        error: "caller_id and receiver_number are required"
      });
    }

    const caller = await db.getSubscriberById(caller_id);
    const receiver = await db.getSubscriberByNumber(receiver_number);

    if (!caller) {
      return json(res, 404, {
        success: false,
        error: "Caller account not found"
      });
    }

    if (!receiver) {
      return json(res, 404, {
        success: false,
        error: "Vicky number not found"
      });
    }

    if (caller.id === receiver.id) {
      return json(res, 400, {
        success: false,
        error: "You cannot call yourself"
      });
    }

    await cleanupStaleCalls();

    const callerBusy = await db.getActiveCallForSubscriber(caller.id);
    const receiverBusy = await db.getActiveCallForSubscriber(receiver.id);

    console.log("CALL BUSY CHECK:", {
      caller_id: caller.id,
      caller_number: caller.vicky_number,
      callerBusy: callerBusy ? {
        id: callerBusy.id,
        status: callerBusy.status
      } : null,
      receiver_id: receiver.id,
      receiver_number: receiver.vicky_number,
      receiverBusy: receiverBusy ? {
        id: receiverBusy.id,
        status: receiverBusy.status
      } : null
    });

    if (callerBusy || receiverBusy) {
      return json(res, 409, {
        success: false,
        error: "One of the users is already on a call"
      });
    }

    const call = {
      id: callId(),
      caller_id: caller.id,
      caller_number: String(caller.vicky_number),
      receiver_id: receiver.id,
      receiver_number: String(receiver.vicky_number),
      status: "ringing",
      signals: [],
      created_at: new Date().toISOString()
    };

    await db.createCallLog(call);

    activeCalls.set(call.id, call);

    return json(res, 201, {
      success: true,
      call: cleanCall(call)
    });
  } catch (err) {
    return json(res, 500, {
      success: false,
      error: err.message
    });
  }
}

/*
  GET /call/incoming/:subscriber_id

  Returns the current persistent ringing call.
*/
async function incomingCall(req, res, subscriber_id) {
  try {
    await cleanupStaleCalls();

    const call = await db.sql`
      SELECT *
      FROM call_logs
      WHERE receiver_id = ${subscriber_id}
        AND status = 'ringing'
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const row = call[0] || null;

    return json(res, 200, {
      success: true,
      call: row ? cleanCall(row) : null
    });
  } catch (err) {
    return json(res, 500, {
      success: false,
      error: err.message
    });
  }
}

/*
  POST /call/answer

  Accept an incoming persistent call.
*/
async function answerCall(req, res) {
  try {
    const data = await body(req);
    const callIdValue = String(data.call_id || "");
    const subscriber_id = String(data.subscriber_id || "");
const call = await db.getActiveCall(callIdValue);
if (!call) {
      return json(res, 404, {
        success: false,
        error: "Call not found"
      });
    }

    if (call.status !== "ringing") {
      return json(res, 409, {
        success: false,
        error: "Call is no longer ringing"
      });
    }

    if (subscriber_id !== call.receiver_id) {
      return json(res, 403, {
        success: false,
        error: "Not authorized to answer this call"
      });
    }

    const answered_at = new Date().toISOString();

    const updated = await db.updateCallLog(call.id, {
      status: "connected",
      answered_at,
      ended_at: null,
      duration_seconds: 0
    });

    activeCalls.set(call.id, {
      ...call,
      status: "connected",
      answered_at
    });

    return json(res, 200, {
      success: true,
      call: cleanCall(updated)
    });
  } catch (err) {
    return json(res, 500, {
      success: false,
      error: err.message
    });
  }
}

/*
  POST /call/decline

  Decline an incoming persistent call.
*/
async function declineCall(req, res) {
  try {
    const data = await body(req);
    const callIdValue = String(data.call_id || "");
    const subscriber_id = String(data.subscriber_id || "");

    const call = await db.getActiveCall(callIdValue);

    if (!call) {
      return json(res, 404, {
        success: false,
        error: "Call not found"
      });
    }

    if (subscriber_id !== call.receiver_id) {
      return json(res, 403, {
        success: false,
        error: "Not authorized"
      });
    }

    const ended_at = new Date().toISOString();

    const updated = await db.updateCallLog(call.id, {
      status: "declined",
      answered_at: call.answered_at,
      ended_at,
      duration_seconds: 0
    });

    activeCalls.delete(call.id);

    return json(res, 200, {
      success: true,
      call: cleanCall(updated)
    });
  } catch (err) {
    return json(res, 500, {
      success: false,
      error: err.message
    });
  }
}

/*
  POST /call/end

  End a connected/ringing persistent call.
*/
async function endCall(req, res) {
  try {
    const data = await body(req);
    const callIdValue = String(data.call_id || "");
    const subscriber_id = String(data.subscriber_id || "");

    const call = await db.getActiveCall(callIdValue);

    if (!call) {
      return json(res, 404, {
        success: false,
        error: "Call not found"
      });
    }

    if (
      subscriber_id !== call.caller_id &&
      subscriber_id !== call.receiver_id
    ) {
      return json(res, 403, {
        success: false,
        error: "Not authorized"
      });
    }

    const ended_at = new Date().toISOString();

    const start = call.answered_at
      ? new Date(call.answered_at).getTime()
      : new Date(call.created_at).getTime();

    const duration = Math.max(
      0,
      Math.floor(
        (new Date(ended_at).getTime() - start) / 1000
      )
    );

    const updated = await db.updateCallLog(call.id, {
      status: "ended",
      answered_at: call.answered_at,
      ended_at,
      duration_seconds: duration
    });

    activeCalls.delete(call.id);

    return json(res, 200, {
      success: true,
      call: cleanCall(updated)
    });
  } catch (err) {
    return json(res, 500, {
      success: false,
      error: err.message
    });
  }
}

const handler = async (req, res) => {
  await db.initDatabase();
  // Normalize Vercel function paths to the original API routes.
  const originalUrl = req.url || "/";
  if (originalUrl.startsWith("/api/")) {
    req.url = originalUrl.slice(4);
  } else {
    req.url = originalUrl;
  }

  // Direct Vercel health endpoint
  if (req.method === "GET" && req.url.endsWith("/health")) {
    return json(res, 200, {
      success: true,
      service: "Vicky Network backend",
      status: "running",
      platform: "vercel"
    });
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    });
    return res.end();
  }

  try {
    // Health
    
  
if (req.method === "POST" && req.url === "/call/signal") {
  return sendCallSignal(req, res);
}

if (
  req.method === "GET" &&
  req.url.startsWith("/call/signals/")
) {
  const parts = req.url.split("/call/signals/")[1].split("?");
  const callIdValue = decodeURIComponent(parts[0]);

  const query = new URL(
    req.url,
    "http://localhost"
  ).searchParams;

  const subscriberId = query.get("subscriber_id");

  return getCallSignals(
    req,
    res,
    callIdValue,
    subscriberId
  );
}
if (req.method === "POST" && req.url === "/call/start") {
    return startCall(req, res);
  }

  if (
    req.method === "GET" &&
    req.url.startsWith("/call/incoming/")
  ) {
    const subscriber_id =
      decodeURIComponent(
        req.url.split("/call/incoming/")[1].split("?")[0]
      );

    return incomingCall(req, res, subscriber_id);
  }

  if (req.method === "POST" && req.url === "/call/answer") {
    return answerCall(req, res);
  }

  if (req.method === "POST" && req.url === "/call/decline") {
    return declineCall(req, res);
  }

  if (req.method === "POST" && req.url === "/call/end") {
    return endCall(req, res);
  }

if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, {
        success: true,
        network: "Vicky Network",
        service: "subscriber-backend",
        status: "running"
      });
    }

    // Register
    if (req.method === "POST" && req.url === "/subscriber/register") {
      const data = await body(req);

      if (!data.name || !data.email || !data.password) {
        return json(res, 400, {
          success: false,
          error: "Name, email and password are required"
        });
      }

      const email = String(data.email).toLowerCase();
      const existing = await db.getSubscriberByEmail(email);

      if (existing) {
        return json(res, 409, {
          success: false,
          error: "Email already registered"
        });
      }

      const subscribers = await db.getSubscribers();
      const vicky_number = makeVickyNumber(subscribers);

      const subscriber = {
        id: crypto.randomUUID(),
        name: String(data.name),
        email,
        password: String(data.password),
        vicky_number,
        status: "active",
        data_balance: 0,
        call_balance: 0,
        active_data_subscription: null,
        active_call_subscription: null,
        created_at: new Date().toISOString()
      };

      const created = await db.createSubscriber(subscriber);

      return json(res, 201, {
        success: true,
        message: "Vicky Network subscriber created",
        subscriber: publicSubscriber(created)
      });
    }

    // Login
    if (req.method === "POST" && req.url === "/subscriber/login") {
      const data = await body(req);

      const subscriber = await db.getSubscriberByEmail(
        String(data.email || "").toLowerCase()
      );

      if (subscriber && subscriber.password !== String(data.password || "")) {
        return json(res, 401, {
          success: false,
          error: "Invalid email or password"
        });
      }

      if (!subscriber) {
        return json(res, 401, {
          success: false,
          error: "Invalid email or password"
        });
      }

      return json(res, 200, {
        success: true,
        subscriber: publicSubscriber(subscriber)
      });
    }

    // Get subscriber
    if (req.method === "GET" && req.url.startsWith("/subscriber/")) {
      const id = req.url.split("/")[2];
      const subscriber = await db.getSubscriberById(id);

      if (!subscriber) {
        return json(res, 404, {
          success: false,
          error: "Subscriber not found"
        });
      }

      return json(res, 200, {
        success: true,
        subscriber: publicSubscriber(subscriber)
      });
    }

    // Development subscription endpoint
    if (req.method === "POST" && req.url === "/subscriber/test-subscription") {
      const data = await body(req);
      const subscriber = await db.getSubscriberById(data.subscriber_id);

      if (!subscriber) {
        return json(res, 404, {
          success: false,
          error: "Subscriber not found"
        });
      }

      const amount = Number(data.amount || 0);
      const now = new Date().toISOString();

      const updates = {};

      if (data.type === "data") {
        updates.data_balance = Number(subscriber.data_balance || 0) + amount;
        updates.active_data_subscription = {
          name: data.plan || "Data Bundle",
          amount,
          activated_at: now
        };
      }

      if (data.type === "calls") {
        updates.call_balance = Number(subscriber.call_balance || 0) + amount;
        updates.active_call_subscription = {
          name: data.plan || "Call Bundle",
          amount,
          activated_at: now
        };
      }

      const updated = await db.updateSubscriber(
        subscriber.id,
        updates
      );

      return json(res, 200, {
        success: true,
        message: "Subscription activated",
        subscriber: publicSubscriber(updated)
      });
    }

    return json(res, 404, {
      success: false,
      error: "Route not found"
    });

  } catch (error) {
    return json(res, 500, {
      success: false,
      error: error.message
    });
  }
};




module.exports = handler;
