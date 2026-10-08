import { createServer, type Server } from "node:net";
import { PgClient } from "@effect/sql-pg";
import { eq } from "drizzle-orm";
import { ConfigProvider, Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { afterAll, beforeAll, expect, it } from "vitest";
import { smtpSettings, user } from "~/db/schema/index.ts";
import { MailService } from "~/modules/notifications/server/mail.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { Db } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<MailService | Db, unknown>;
let smtp: Server;
let smtpPort = 0;
/** Each message the fake server accepted: envelope recipient and raw data. */
const received: Array<{ to: string; data: string }> = [];
const mail = <A, E>(use: (mail: MailService["Service"]) => Effect.Effect<A, E>) =>
  runtime.runPromise(Effect.flatMap(MailService, use));

/** Just enough SMTP for one unauthenticated, unencrypted relay. */
function fakeSmtp() {
  return createServer((socket) => {
    let to = "";
    let data: string | null = null;
    socket.write("220 fake ESMTP\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data !== null) {
          if (line === ".") {
            received.push({ to, data });
            data = null;
            socket.write("250 queued\r\n");
          } else data += `${line}\n`;
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO" || verb === "HELO") socket.write("250 fake\r\n");
        else if (verb === "RCPT") {
          to = /<([^>]+)>/.exec(line)?.[1] ?? "";
          socket.write("250 ok\r\n");
        } else if (verb === "DATA") {
          data = "";
          socket.write("354 go\r\n");
        } else if (verb === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
}

beforeAll(async () => {
  smtp = fakeSmtp();
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  smtpPort = (smtp.address() as { port: number }).port;
  database = await createTestDatabase();
  const infra = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(database.url), maxConnections: 5 })),
  );
  const cipher = KeyCipher.layer.pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") }),
      ),
    ),
  );
  runtime = ManagedRuntime.make(
    MailService.layer.pipe(Layer.provideMerge(cipher), Layer.provideMerge(infra)),
  );
  await runtime.runPromise(
    Effect.flatMap(Db, (db) =>
      db.insert(user).values({ id: "owner", name: "Owner", email: "owner@t.io" }),
    ),
  );
}, 120_000);

afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
  smtp?.close();
});

const stored = () =>
  runtime.runPromise(
    Effect.flatMap(Db, (db) =>
      db.select().from(smtpSettings).where(eq(smtpSettings.id, "instance")),
    ),
  );

it("keeps the password encrypted and unchanged unless a new one is given", async () => {
  expect(await mail((m) => m.settings)).toBeNull();
  const base = {
    host: "smtp.example.test",
    port: 587,
    security: "starttls" as const,
    username: "neema",
    fromAddress: "neema@example.test",
  };
  await mail((m) => m.save({ ...base, password: "hunter2" }));
  const [first] = await stored();
  expect(first!.passwordCiphertext).not.toContain("hunter2");
  await mail((m) => m.save({ ...base, host: "smtp2.example.test" }));
  const [second] = await stored();
  expect(second!.passwordCiphertext).toBe(first!.passwordCiphertext);
  expect(await mail((m) => m.settings)).toEqual({
    ...base,
    host: "smtp2.example.test",
    passwordSet: true,
  });
  await mail((m) => m.save({ ...base, username: null, password: null }));
  expect(await mail((m) => m.settings)).toMatchObject({ passwordSet: false });
});

it("mails a notification only to someone who turned email on", async () => {
  await mail((m) =>
    m.save({
      host: "127.0.0.1",
      port: smtpPort,
      security: "none",
      username: null,
      fromAddress: "neema@example.test",
    }),
  );
  const notification = {
    id: "run",
    title: "Morning digest",
    body: "Rain after 3pm.",
    path: "/chat/c",
  };
  expect(await mail((m) => m.preferences("owner"))).toEqual({ email: false, available: true });
  await mail((m) => m.send("owner", notification));
  expect(received).toEqual([]);

  await mail((m) => m.setEmail("owner", true));
  await mail((m) => m.send("owner", notification));
  expect(received).toHaveLength(1);
  expect(received[0]!.to).toBe("owner@t.io");
  expect(received[0]!.data).toContain("Subject: Morning digest");
  expect(received[0]!.data).toContain("Rain after 3pm.");

  await mail((m) => m.test("owner@t.io"));
  expect(received).toHaveLength(2);
});
