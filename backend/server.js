require("dotenv").config();

const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const path = require("node:path");
const { randomBytes, randomUUID } = require("node:crypto");
const { calculateBill, centsToMoney, moneyToCents } = require("./billing");
const { DB_FILE, initializeDatabase, readDatabase, updateDatabase } = require("./store");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET || (
  process.env.NODE_ENV === "production" ? "" : randomBytes(32).toString("hex")
);
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "8h";
const COOKIE_NAME = "dinesync_session";
const SESSION_MAX_AGE = 8 * 60 * 60 * 1000;
const FRONTEND_DIST = path.resolve(__dirname, "..", "frontend", "dist");
const LOCAL_DEMO_AUTH = process.env.NODE_ENV === "development" && process.env.DINESYNC_DEMO_AUTH === "true";

if (process.env.NODE_ENV === "production") {
  if (!JWT_SECRET || JWT_SECRET === "replace-this-with-a-long-random-secret-before-deployment") {
    throw new Error("Set a unique JWT_SECRET before running DineSync in production.");
  }
  if (process.env.DINESYNC_DEMO_AUTH === "true") {
    throw new Error("DINESYNC_DEMO_AUTH cannot be enabled in production.");
  }
}

app.disable("x-powered-by");
if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);
app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

function setSessionCookie(response, token) {
  response.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_MAX_AGE
  });
}

async function authenticate(request, response, next) {
  const token = request.cookies[COOKIE_NAME];
  if (!token) return response.status(401).json({ error: "Please sign in to continue." });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const database = await readDatabase();
    if (database.revokedTokens?.some(session => session.id === payload.jti)) {
      response.clearCookie(COOKIE_NAME, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/" });
      return response.status(401).json({ error: "Your session has ended. Please sign in again." });
    }
    const user = database.users.find(candidate => candidate.id === payload.sub);
    if (!user || user.role !== payload.role) {
      response.clearCookie(COOKIE_NAME, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/" });
      return response.status(401).json({ error: "Your session is no longer valid. Please sign in again." });
    }
    request.user = publicUser(user);
    return next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      response.clearCookie(COOKIE_NAME, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/" });
      return response.status(401).json({ error: "Your session expired. Please sign in again." });
    }
    return next(error);
  }
}

function requireAdmin(request, response, next) {
  if (request.user.role !== "admin") return response.status(403).json({ error: "Administrator access is required." });
  return next();
}

function getActiveOrder(database, tableId) {
  return database.orders.find(order => order.tableId === tableId && order.status === "active");
}

function getState(database) {
  const tables = database.tables.map(table => {
    const activeOrder = getActiveOrder(database, table.id);
    return {
      ...table,
      activeOrder: activeOrder ? { ...activeOrder, bill: calculateBill(activeOrder) } : null
    };
  });
  const activeOrders = database.orders.filter(order => order.status === "active");
  const floorCounts = new Map();
  for (const order of activeOrders) {
    const table = database.tables.find(candidate => candidate.id === order.tableId);
    if (table) floorCounts.set(table.floor, (floorCounts.get(table.floor) || 0) + 1);
  }
  const topFloor = [...floorCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const liveRevenueCents = activeOrders.reduce((sum, order) => sum + moneyToCents(calculateBill(order).total), 0);
  return {
    tables,
    analytics: {
      occupancy: database.tables.length
        ? Math.round((database.tables.filter(table => table.status === "occupied").length / database.tables.length) * 100)
        : 0,
      liveRevenue: centsToMoney(liveRevenueCents),
      pendingCleanups: database.tables.filter(table => table.status === "dirty").length,
      topFloor: topFloor ? topFloor[0] : "—",
      topFloorOrders: topFloor ? topFloor[1] : 0
    }
  };
}

function getTable(database, id) {
  return database.tables.find(table => table.id === id);
}

function validPrice(value) {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 && moneyToCents(price) > 0;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Try again in 15 minutes." }
});

app.post("/api/auth/login", loginLimiter, async (request, response, next) => {
  try {
    const email = String(request.body?.email || "").trim().toLowerCase();
    const password = String(request.body?.password || "");
    if (!email || !password) return response.status(400).json({ error: "Enter your email and password." });
    const database = await readDatabase();
    const user = LOCAL_DEMO_AUTH
      ? database.users.find(candidate => candidate.role === "captain")
      : database.users.find(candidate => candidate.email === email);
    if (!user || (!LOCAL_DEMO_AUTH && !(await bcrypt.compare(password, user.passwordHash)))) {
      return response.status(401).json({ error: "Email or password is incorrect." });
    }
    const token = jwt.sign({ role: user.role }, JWT_SECRET, { subject: user.id, jwtid: randomUUID(), expiresIn: JWT_EXPIRES_IN });
    setSessionCookie(response, token);
    return response.json({ user: publicUser(user) });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/auth/me", authenticate, (request, response) => response.json({ user: request.user }));
app.post("/api/auth/logout", async (request, response, next) => {
  const token = request.cookies[COOKIE_NAME];
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (payload.jti) {
        const now = Math.floor(Date.now() / 1000);
        await updateDatabase(database => {
          database.revokedTokens = (database.revokedTokens || []).filter(session => session.expiresAt > now);
          database.revokedTokens.push({ id: payload.jti, expiresAt: payload.exp });
        });
      }
    } catch (error) {
      if (!(error instanceof jwt.JsonWebTokenError)) return next(error);
    }
  }
  response.clearCookie(COOKIE_NAME, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/" });
  return response.status(204).end();
});

app.use("/api", authenticate);

app.get("/api/state", async (request, response, next) => {
  try {
    return response.json(getState(await readDatabase()));
  } catch (error) {
    return next(error);
  }
});

app.get("/api/export", requireAdmin, async (request, response, next) => {
  try {
    const database = await readDatabase();
    response.setHeader("Content-Disposition", 'attachment; filename="dinesync-database.json"');
    response.setHeader("Cache-Control", "no-store");
    return response.json({ tables: database.tables, orders: database.orders });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/tables", requireAdmin, async (request, response, next) => {
  try {
    const tableNumber = String(request.body?.tableNumber || "").trim();
    const capacity = Number(request.body?.capacity);
    const floor = String(request.body?.floor || "").trim();
    if (!tableNumber || tableNumber.length > 16 || !floor || floor.length > 40 || !Number.isInteger(capacity) || capacity <= 0) {
      return response.status(400).json({ error: "Enter a table number, floor, and positive whole-number capacity." });
    }
    const table = await updateDatabase(database => {
      if (database.tables.some(candidate => candidate.tableNumber.toLowerCase() === tableNumber.toLowerCase())) {
        throw httpError(409, "That table number already exists.");
      }
      const now = new Date().toISOString();
      const newTable = { id: randomUUID(), tableNumber, capacity, floor, status: "available", createdAt: now, updatedAt: now };
      database.tables.push(newTable);
      return newTable;
    });
    return response.status(201).json({ table });
  } catch (error) {
    return next(error);
  }
});

app.patch("/api/tables/:id", requireAdmin, async (request, response, next) => {
  try {
    const tableNumber = String(request.body?.tableNumber || "").trim();
    const capacity = Number(request.body?.capacity);
    const floor = String(request.body?.floor || "").trim();
    if (!tableNumber || tableNumber.length > 16 || !floor || floor.length > 40 || !Number.isInteger(capacity) || capacity <= 0) {
      return response.status(400).json({ error: "Enter a table number, floor, and positive whole-number capacity." });
    }
    const table = await updateDatabase(database => {
      const existing = getTable(database, request.params.id);
      if (!existing) throw httpError(404, "Table not found.");
      if (database.tables.some(candidate => candidate.id !== existing.id && candidate.tableNumber.toLowerCase() === tableNumber.toLowerCase())) {
        throw httpError(409, "That table number already exists.");
      }
      Object.assign(existing, { tableNumber, capacity, floor, updatedAt: new Date().toISOString() });
      return existing;
    });
    return response.json({ table });
  } catch (error) {
    return next(error);
  }
});

app.delete("/api/tables/:id", requireAdmin, async (request, response, next) => {
  try {
    await updateDatabase(database => {
      const table = getTable(database, request.params.id);
      if (!table) throw httpError(404, "Table not found.");
      if (getActiveOrder(database, table.id)) throw httpError(409, "Tables with active orders cannot be deleted.");
      database.tables = database.tables.filter(candidate => candidate.id !== table.id);
    });
    return response.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/tables/:id/clean", async (request, response, next) => {
  try {
    const table = await updateDatabase(database => {
      const current = getTable(database, request.params.id);
      if (!current) throw httpError(404, "Table not found.");
      if (current.status !== "dirty") throw httpError(409, "Only dirty tables can be marked available.");
      current.status = "available";
      current.updatedAt = new Date().toISOString();
      return current;
    });
    return response.json({ table });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/orders", async (request, response, next) => {
  try {
    const tableId = String(request.body?.tableId || "");
    const order = await updateDatabase(database => {
      const table = getTable(database, tableId);
      if (!table) throw httpError(404, "Table not found.");
      if (table.status !== "available") throw httpError(409, "Only available tables can start a new order.");
      const now = new Date().toISOString();
      const newOrder = {
        id: randomUUID(),
        tableId: table.id,
        status: "active",
        items: [],
        createdAt: now,
        updatedAt: now,
        settledAt: null,
        bill: null
      };
      database.orders.push(newOrder);
      table.status = "occupied";
      table.updatedAt = now;
      return newOrder;
    });
    return response.status(201).json({ order });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/orders/:id/items", async (request, response, next) => {
  try {
    const name = String(request.body?.name || "").trim();
    const category = String(request.body?.category || "").toLowerCase();
    const price = Number(request.body?.price);
    if (!name || name.length > 60 || !["food", "beverage"].includes(category) || !validPrice(price)) {
      return response.status(400).json({ error: "Enter an item name, a valid category, and a price greater than zero." });
    }
    const result = await updateDatabase(database => {
      const order = database.orders.find(candidate => candidate.id === request.params.id);
      if (!order) throw httpError(404, "Order not found.");
      if (order.status !== "active") throw httpError(409, "This order is settled and read-only.");
      const item = { id: randomUUID(), name, category, price: centsToMoney(moneyToCents(price)), createdAt: new Date().toISOString() };
      order.items.push(item);
      order.updatedAt = item.createdAt;
      return { item, bill: calculateBill(order) };
    });
    return response.status(201).json(result);
  } catch (error) {
    return next(error);
  }
});

app.post("/api/orders/:id/transfer", async (request, response, next) => {
  try {
    const targetTableId = String(request.body?.targetTableId || "");
    const order = await updateDatabase(database => {
      const currentOrder = database.orders.find(candidate => candidate.id === request.params.id);
      if (!currentOrder) throw httpError(404, "Order not found.");
      if (currentOrder.status !== "active") throw httpError(409, "This order is settled and read-only.");
      const target = getTable(database, targetTableId);
      if (!target) throw httpError(404, "Target table not found.");
      if (target.id === currentOrder.tableId) throw httpError(400, "Choose a different target table.");
      if (target.status !== "available") throw httpError(409, "Target Table Occupied");
      const source = getTable(database, currentOrder.tableId);
      const now = new Date().toISOString();
      if (source) {
        source.status = "available";
        source.updatedAt = now;
      }
      target.status = "occupied";
      target.updatedAt = now;
      currentOrder.tableId = target.id;
      currentOrder.updatedAt = now;
      return currentOrder;
    });
    return response.json({ order });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/orders/:id/settle", async (request, response, next) => {
  try {
    const order = await updateDatabase(database => {
      const currentOrder = database.orders.find(candidate => candidate.id === request.params.id);
      if (!currentOrder) throw httpError(404, "Order not found.");
      if (currentOrder.status !== "active") throw httpError(409, "This order is settled and read-only.");
      const table = getTable(database, currentOrder.tableId);
      if (!table) throw httpError(500, "The order's table could not be found.");
      const now = new Date().toISOString();
      currentOrder.bill = calculateBill(currentOrder);
      currentOrder.status = "settled";
      currentOrder.settledAt = now;
      currentOrder.updatedAt = now;
      table.status = "dirty";
      table.updatedAt = now;
      return currentOrder;
    });
    return response.json({ order });
  } catch (error) {
    return next(error);
  }
});

app.use("/api", (request, response) => response.status(404).json({ error: "Route not found." }));

if (require("node:fs").existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST, { index: false }));
  app.get("*", (request, response) => response.sendFile(path.join(FRONTEND_DIST, "index.html")));
}

app.use((error, request, response, next) => {
  console.error("Request failed:", error);
  if (response.headersSent) return next(error);
  const statusCode = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 600
    ? error.statusCode
    : 500;
  return response.status(statusCode).json({
    error: statusCode === 500 ? "The request could not be completed." : error.message
  });
});

if (require.main === module) {
  initializeDatabase().then(() => {
    app.listen(PORT, () => {
      console.log(`DineSync API is running at http://localhost:${PORT}`);
      console.log(`Database: ${process.env.SUPABASE_URL ? "Supabase" : DB_FILE}`);
    });
  }).catch(error => {
    console.error("DineSync failed to initialize:", error.message);
    process.exitCode = 1;
  });
}

module.exports = app;
