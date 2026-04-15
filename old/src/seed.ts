import "./env";
import { getDb } from "./db";
import { devices } from "./schema";

const db = getDb();

const seedDevices = [
  {
    id: "dev-worker",
    name: "Dev Worker",
    type: "worker" as const,
    role: "admin" as const,
    token: "dev-worker-token",
  },
  {
    id: "dev-admin",
    name: "Dev Admin",
    type: "client" as const,
    role: "admin" as const,
    token: "asdf",
  },
  {
    id: "dev-chat",
    name: "Dev Chat",
    type: "client" as const,
    role: "chat" as const,
    token: "chat",
    sandbox: "/tmp/rc-sandbox-dev",
  },
];

for (const device of seedDevices) {
  db.insert(devices).values(device).onConflictDoNothing().run();
  console.log(`  ${device.name} (token: ${device.token})`);
}

console.log("Seed complete.");
