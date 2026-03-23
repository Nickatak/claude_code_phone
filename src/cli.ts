import "dotenv/config";
import crypto from "crypto";
import readline from "readline";
import { v4 as uuid } from "uuid";
import { getDb } from "./db";
import { devices } from "./schema";
import { eq } from "drizzle-orm";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise((r) => rl.question(q, r));

async function addDevice() {
  const name = await ask("Device name (e.g. Mom's phone): ");
  const typeInput = await ask("Type — worker or client [client]: ");
  const type = typeInput === "worker" ? "worker" : "client";
  const roleInput = await ask("Role — admin or chat [chat]: ");
  const role = roleInput === "admin" ? "admin" : "chat";
  const customToken = await ask("Custom token (leave blank to generate): ");
  const token = customToken || crypto.randomBytes(16).toString("hex");

  const db = getDb();
  db.insert(devices).values({
    id: uuid(),
    name,
    type,
    role,
    token,
  }).run();

  console.log(`\nDevice created:`);
  console.log(`  Name:  ${name}`);
  console.log(`  Type:  ${type}`);
  console.log(`  Role:  ${role}`);
  console.log(`  Token: ${token}`);
}

async function listDevices() {
  const db = getDb();
  const rows = db.select().from(devices).all();

  if (rows.length === 0) {
    console.log("No devices registered.");
    return;
  }

  console.log(`\n${"Name".padEnd(25)} ${"Type".padEnd(8)} ${"Role".padEnd(6)} ${"Last Seen".padEnd(20)} Token`);
  console.log("-".repeat(90));
  for (const d of rows) {
    console.log(`${(d.name || "").padEnd(25)} ${d.type.padEnd(8)} ${d.role.padEnd(6)} ${(d.lastSeen || "never").padEnd(20)} ${d.token}`);
  }
}

async function removeDevice() {
  const db = getDb();
  const rows = db.select().from(devices).all();

  if (rows.length === 0) {
    console.log("No devices to remove.");
    return;
  }

  rows.forEach((d, i) => console.log(`  ${i + 1}. ${d.name} (${d.type}, ${d.role})`));
  const choice = await ask("\nRemove which device (number): ");
  const idx = parseInt(choice, 10) - 1;

  if (idx < 0 || idx >= rows.length) {
    console.log("Invalid selection.");
    return;
  }

  const target = rows[idx];
  db.delete(devices).where(eq(devices.id, target.id)).run();
  console.log(`Removed: ${target.name}`);
}

async function main() {
  const command = process.argv[2];

  switch (command) {
    case "add":
      // Support non-interactive: cli add <name> <type> <role> [token]
      if (process.argv[3]) {
        const name = process.argv[3];
        const type = (process.argv[4] || "client") as "worker" | "client";
        const role = (process.argv[5] || "chat") as "admin" | "chat";
        const token = process.argv[6] || crypto.randomBytes(16).toString("hex");
        const db = getDb();
        db.insert(devices).values({ id: uuid(), name, type, role, token }).run();
        console.log(`Device created: ${name} (${type}, ${role}) token=${token}`);
      } else {
        await addDevice();
      }
      break;
    case "list":
      await listDevices();
      break;
    case "remove":
      await removeDevice();
      break;
    default:
      console.log("Usage: cli <add|list|remove>");
      console.log("       cli add <name> <type> <role> [token]");
  }

  rl.close();
}

main().catch(console.error);
