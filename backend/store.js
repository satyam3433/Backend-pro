const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const bcrypt = require("bcryptjs");

const DATA_DIR = process.env.DINESYNC_DATA_DIR
  ? path.resolve(process.env.DINESYNC_DATA_DIR)
  : path.resolve(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
let localUpdateQueue = Promise.resolve();

function seedDatabase() {
  const now = new Date().toISOString();
  const tables = [
    ["T01", 2, "Main Floor"],
    ["T02", 2, "Main Floor"],
    ["T03", 4, "Main Floor"],
    ["T04", 4, "Main Floor"],
    ["T05", 4, "Garden"],
    ["T06", 6, "Garden"],
    ["T07", 6, "Rooftop"],
    ["T08", 2, "Rooftop"]
  ].map(([tableNumber, capacity, floor], index) => ({
    id: `table-${index + 1}`,
    tableNumber,
    capacity,
    floor,
    status: index === 1 || index === 4 ? "occupied" : index === 6 ? "dirty" : "available",
    createdAt: now,
    updatedAt: now
  }));
  const orders = [
    {
      id: "order-sample-1",
      tableId: "table-2",
      status: "active",
      createdAt: now,
      updatedAt: now,
      settledAt: null,
      bill: null,
      items: [
        { id: randomUUID(), name: "Paneer tikka", category: "food", price: 320, createdAt: now },
        { id: randomUUID(), name: "Masala chai", category: "beverage", price: 90, createdAt: now }
      ]
    },
    {
      id: "order-sample-2",
      tableId: "table-5",
      status: "active",
      createdAt: now,
      updatedAt: now,
      settledAt: null,
      bill: null,
      items: [
        { id: randomUUID(), name: "Mushroom pasta", category: "food", price: 440, createdAt: now },
        { id: randomUUID(), name: "Fresh lime soda", category: "beverage", price: 130, createdAt: now }
      ]
    }
  ];
  return { tables, orders, users: [], revokedTokens: [] };
}

async function readDatabase() {
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

async function writeDatabase(database) {
  const temporaryFile = `${DB_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, `${JSON.stringify(database, null, 2)}\n`);
  fs.renameSync(temporaryFile, DB_FILE);
}

async function updateDatabase(update) {
  const operation = localUpdateQueue.then(async () => {
    const database = await readDatabase();
    const result = await update(database);
    await writeDatabase(database);
    return result;
  });
  localUpdateQueue = operation.catch(() => {});
  return operation;
}

async function initializeDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let database;
  if (!fs.existsSync(DB_FILE)) {
    database = seedDatabase();
    await writeDatabase(database);
  } else {
    database = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  }
  if (!database || !Array.isArray(database.tables) || !Array.isArray(database.orders)) {
    throw new Error(`Invalid database file at ${DB_FILE}. Restore a valid JSON export before starting DineSync.`);
  }

  const bootstrapAccounts = [
    {
      role: "admin",
      name: "Restaurant Admin",
      email: String(process.env.ADMIN_EMAIL || "admin@dinesync.local").trim().toLowerCase(),
      password: process.env.ADMIN_PASSWORD || "",
      passwordVariable: "ADMIN_PASSWORD"
    },
    {
      role: "captain",
      name: "Floor Captain",
      email: String(process.env.CAPTAIN_EMAIL || "captain@dinesync.local").trim().toLowerCase(),
      password: process.env.CAPTAIN_PASSWORD || "",
      passwordVariable: "CAPTAIN_PASSWORD"
    }
  ];
  await updateDatabase(async database => {
    if (!Array.isArray(database.users)) database.users = [];
    if (!Array.isArray(database.revokedTokens)) database.revokedTokens = [];
    for (const account of bootstrapAccounts) {
      if (database.users.some(user => user.role === account.role)) continue;
      if (!account.password) {
        throw new Error(`Set ${account.passwordVariable} before creating the first ${account.role} account. Copy .env.example to .env for local setup.`);
      }
      if (account.password.length < 12) {
        throw new Error(`${account.passwordVariable} must contain at least 12 characters.`);
      }
      database.users.push({
        id: randomUUID(),
        name: account.name,
        email: account.email,
        passwordHash: await bcrypt.hash(account.password, 12),
        role: account.role,
        createdAt: new Date().toISOString()
      });
    }
  });
}

module.exports = { DB_FILE, DATA_DIR, initializeDatabase, readDatabase, updateDatabase, writeDatabase };
