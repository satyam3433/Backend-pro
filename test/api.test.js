const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const TEST_PASSWORD = "DineSync_Test_Password_2026!";

async function findAvailablePort() {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(child, baseUrl, logs) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Test server exited unexpectedly: ${logs.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/auth/me`);
      if (response.status === 401) return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Test server did not start: ${logs.join("")}`);
}

async function request(baseUrl, method, route, body, cookie) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();
  return { response, data };
}

test("JWT login protects admin operations and preserves order workflows", async () => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dinesync-test-"));
  const port = await findAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["backend/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      DINESYNC_DATA_DIR: dataDirectory,
      PORT: String(port),
      JWT_SECRET: "test-only-signing-secret-for-dinesync",
      ADMIN_PASSWORD: TEST_PASSWORD,
      CAPTAIN_PASSWORD: "Captain_Test_Password_2026!"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = [];
  child.stdout.on("data", chunk => logs.push(chunk.toString()));
  child.stderr.on("data", chunk => logs.push(chunk.toString()));

  try {
    await waitForServer(child, baseUrl, logs);
    const unauthenticated = await request(baseUrl, "GET", "/api/state");
    assert.equal(unauthenticated.response.status, 401);

    const invalidLogin = await request(baseUrl, "POST", "/api/auth/login", {
      email: "admin@dinesync.local",
      password: "wrong-password"
    });
    assert.equal(invalidLogin.response.status, 401);

    const login = await request(baseUrl, "POST", "/api/auth/login", {
      email: "admin@dinesync.local",
      password: TEST_PASSWORD
    });
    assert.equal(login.response.status, 200);
    assert.equal(login.data.user.role, "admin");
    assert.equal(login.response.headers.get("set-cookie").toLowerCase().includes("httponly"), true);
    assert.equal(login.response.headers.get("set-cookie").toLowerCase().includes("samesite=strict"), true);
    const cookie = login.response.headers.get("set-cookie").split(";")[0];

    const session = await request(baseUrl, "GET", "/api/auth/me", undefined, cookie);
    assert.equal(session.response.status, 200);
    assert.equal(session.data.user.email, "admin@dinesync.local");

    const initial = await request(baseUrl, "GET", "/api/state", undefined, cookie);
    assert.equal(initial.response.status, 200);
    assert.equal(initial.data.tables.length, 8);

    const captainLogin = await request(baseUrl, "POST", "/api/auth/login", {
      email: "captain@dinesync.local",
      password: "Captain_Test_Password_2026!"
    });
    const captainCookie = captainLogin.response.headers.get("set-cookie").split(";")[0];
    assert.equal(captainLogin.data.user.role, "captain");
    assert.equal((await request(baseUrl, "POST", "/api/tables", {
      tableNumber: "CAPTAIN-01",
      capacity: 2,
      floor: "Test Floor"
    }, captainCookie)).response.status, 403);
    assert.equal((await request(baseUrl, "GET", "/api/state", undefined, captainCookie)).response.status, 200);

    const createTable = async tableNumber => request(baseUrl, "POST", "/api/tables", {
      tableNumber,
      capacity: 2,
      floor: "Test Floor"
    }, cookie);
    const sourceResult = await createTable("TEST-01");
    const targetResult = await createTable("TEST-02");
    const occupiedResult = await createTable("TEST-03");
    assert.equal(sourceResult.response.status, 201);
    assert.equal(targetResult.response.status, 201);
    assert.equal(occupiedResult.response.status, 201);
    const source = sourceResult.data.table;
    const target = targetResult.data.table;
    const occupied = occupiedResult.data.table;
    assert.equal((await createTable("test-01")).response.status, 409);

    const startOrder = async tableId => request(baseUrl, "POST", "/api/orders", { tableId }, cookie);
    const orderResult = await startOrder(source.id);
    const occupiedOrderResult = await startOrder(occupied.id);
    assert.equal(orderResult.response.status, 201);
    assert.equal(occupiedOrderResult.response.status, 201);
    const orderId = orderResult.data.order.id;
    assert.equal((await startOrder(source.id)).response.status, 409);
    assert.equal((await request(baseUrl, "DELETE", `/api/tables/${source.id}`, undefined, cookie)).response.status, 409);

    const addItem = (name, category, price) => request(baseUrl, "POST", `/api/orders/${orderId}/items`, {
      name,
      category,
      price
    }, cookie);
    assert.equal((await addItem("Invalid zero", "food", 0)).response.status, 400);
    assert.equal((await addItem("Rounds to zero", "food", 0.001)).response.status, 400);
    assert.equal((await addItem("Invalid negative", "food", -1)).response.status, 400);
    assert.equal((await addItem("Invalid category", "other", 10)).response.status, 400);
    await addItem("Food", "food", 100);
    await addItem("Drink", "beverage", 50);

    const state = await request(baseUrl, "GET", "/api/state", undefined, cookie);
    const activeOrder = state.data.tables.find(table => table.id === source.id).activeOrder;
    assert.deepEqual(activeOrder.bill, { subtotal: 150, gst: 14, serviceCharge: 15, total: 179 });

    const blockedTransfer = await request(baseUrl, "POST", `/api/orders/${occupiedOrderResult.data.order.id}/transfer`, {
      targetTableId: source.id
    }, cookie);
    assert.equal(blockedTransfer.response.status, 409);
    assert.equal(blockedTransfer.data.error, "Target Table Occupied");

    const transfer = await request(baseUrl, "POST", `/api/orders/${orderId}/transfer`, { targetTableId: target.id }, cookie);
    assert.equal(transfer.response.status, 200);
    assert.equal(transfer.data.order.tableId, target.id);
    const afterTransfer = await request(baseUrl, "GET", "/api/state", undefined, cookie);
    assert.equal(afterTransfer.data.tables.find(table => table.id === source.id).status, "available");
    assert.equal(afterTransfer.data.tables.find(table => table.id === target.id).status, "occupied");

    const settled = await request(baseUrl, "POST", `/api/orders/${orderId}/settle`, {}, cookie);
    assert.equal(settled.response.status, 200);
    assert.equal(settled.data.order.status, "settled");
    assert.deepEqual(settled.data.order.bill, { subtotal: 150, gst: 14, serviceCharge: 15, total: 179 });
    assert.equal((await addItem("Locked item", "food", 20)).response.status, 409);

    const afterSettlement = await request(baseUrl, "GET", "/api/state", undefined, cookie);
    assert.equal(afterSettlement.data.tables.find(table => table.id === target.id).status, "dirty");
    assert.equal((await request(baseUrl, "POST", `/api/tables/${target.id}/clean`, {}, cookie)).data.table.status, "available");
    assert.equal((await request(baseUrl, "DELETE", `/api/tables/${source.id}`, undefined, cookie)).response.status, 200);

    const exportResult = await request(baseUrl, "GET", "/api/export", undefined, cookie);
    assert.equal(exportResult.response.status, 200);
    assert.equal(exportResult.data.tables.length, 10);
    assert.equal(exportResult.data.users, undefined);
    assert.equal(exportResult.data.orders.find(order => order.id === orderId).status, "settled");

    const logout = await request(baseUrl, "POST", "/api/auth/logout", {}, cookie);
    assert.equal(logout.response.status, 204);
    assert.equal((await request(baseUrl, "GET", "/api/state", undefined, cookie)).response.status, 401);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    await fs.rm(dataDirectory, { recursive: true, force: true });
  }
});

test("local demo login accepts entered credentials as a Captain only", async () => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dinesync-demo-test-"));
  const port = await findAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["backend/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "development",
      DINESYNC_DEMO_AUTH: "true",
      DINESYNC_DATA_DIR: dataDirectory,
      PORT: String(port),
      JWT_SECRET: "test-only-signing-secret-for-dinesync",
      ADMIN_PASSWORD: TEST_PASSWORD,
      CAPTAIN_PASSWORD: "Captain_Test_Password_2026!"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = [];
  child.stdout.on("data", chunk => logs.push(chunk.toString()));
  child.stderr.on("data", chunk => logs.push(chunk.toString()));

  try {
    await waitForServer(child, baseUrl, logs);
    const login = await request(baseUrl, "POST", "/api/auth/login", {
      email: "someone@example.test",
      password: "anything"
    });
    assert.equal(login.response.status, 200);
    assert.equal(login.data.user.role, "captain");
    assert.equal(login.data.user.email, "captain@dinesync.local");
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    await fs.rm(dataDirectory, { recursive: true, force: true });
  }
});

test("production refuses local demo authentication", () => {
  const result = spawnSync(process.execPath, ["-e", "require('./backend/server')"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      DINESYNC_DEMO_AUTH: "true",
      JWT_SECRET: "test-only-signing-secret-for-dinesync"
    },
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DINESYNC_DEMO_AUTH cannot be enabled in production/);
});
