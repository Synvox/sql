import { beforeEach, afterAll, it, expect } from "vitest";
import { Pool } from "pg";
import { connect, migrate, seed, types } from "../src";

const client = new Pool();
const sql = connect(client);

beforeEach(async () => {
  await sql`
    drop schema if exists migrations cascade;
    drop schema if exists test_migrations cascade;
    create schema test_migrations;
  `.exec();
});

afterAll(async () => {
  await sql`
    drop schema test_migrations cascade;
  `.exec();
  client.end();
});

async function interceptConsole<T>(fn: (messages: string[]) => T) {
  const messages: string[] = [];
  const log = global.console.log;
  global.console.log = (x: string) => messages.push(x);
  const result = await fn(messages);
  global.console.log = log;
  return result;
}

it("supports migrations sequentially", async () => {
  await interceptConsole(async (messages) => {
    await migrate(sql, `${__dirname}/migrations/a/1`);
    expect(messages).toMatchObject(["Migrated 1 file"]);
  });

  expect(
    await sql`
    select * from migrations.migrations
  `.all()
  ).toMatchObject([
    {
      id: 1,
      name: "001_init.ts",
      migratedAt: expect.any(Date),
      batch: 1,
    },
  ]);

  const users = await sql`select * from test_migrations.users`.all();

  expect(users).toMatchObject([
    { firstName: "Alice", lastName: "Smith" },
    { firstName: "Bob", lastName: "Smith" },
    { firstName: "Carol", lastName: "Smith" },
  ]);

  await expect(
    sql`select * from test_migrations.notes`.all()
  ).rejects.toThrowError();

  await interceptConsole(async (messages) => {
    await migrate(sql, `${__dirname}/migrations/a/2`);
    expect(messages).toMatchObject(["Migrated 1 file"]);
  });

  expect(
    await sql`
    select * from migrations.migrations
  `.all()
  ).toMatchObject([
    {
      id: 1,
      name: "001_init.ts",
      migratedAt: expect.any(Date),
      batch: 1,
    },
    {
      id: 2,
      name: "002_second.ts",
      migratedAt: expect.any(Date),
      batch: 2,
    },
  ]);

  const notes2 = await sql`
  select * from test_migrations.notes
`.all();

  expect(notes2).toMatchObject([
    {
      body: "Alice's first note",
      authorId: 1,
    },
    {
      body: "Alice's second note",
      authorId: 1,
    },
    {
      body: "Bob's first note",
      authorId: 2,
    },
    {
      body: "Carol's first note",
      authorId: 3,
    },
  ]);

  await interceptConsole(async (messages) => {
    await migrate(sql, `${__dirname}/migrations/a/2`);
    expect(messages).toMatchObject(["Migrated 0 files"]);
  });

  // should error if a migration is missing from the filesystem.
  expect(migrate(sql, `${__dirname}/migrations/a/1`)).rejects.toThrowError(
    "A migration is missing from the filesystem: 002_second.ts"
  );
});

it("supports migrations in batches", async () => {
  await interceptConsole(async (messages) => {
    await migrate(sql, `${__dirname}/migrations/b`);
    expect(messages).toMatchObject(["Migrated 2 files"]);
  });

  expect(
    await sql`
    select * from migrations.migrations
  `.all()
  ).toMatchObject([
    {
      id: 1,
      name: "001_init.ts",
      migratedAt: expect.any(Date),
      batch: 1,
    },
    {
      id: 2,
      name: "002_second.ts",
      migratedAt: expect.any(Date),
      batch: 1,
    },
  ]);

  expect(await sql`select * from test_migrations.users`.all()).toMatchObject([
    { firstName: "Alice", lastName: "Smith" },
    { firstName: "Bob", lastName: "Smith" },
    { firstName: "Carol", lastName: "Smith" },
  ]);

  expect(await sql`select * from test_migrations.notes`.all()).toMatchObject([
    {
      body: "Alice's first note",
      authorId: 1,
    },
    {
      body: "Alice's second note",
      authorId: 1,
    },
    {
      body: "Bob's first note",
      authorId: 2,
    },
    {
      body: "Carol's first note",
      authorId: 3,
    },
  ]);
});

it("supports seeds", async () => {
  await interceptConsole(async (messages) => {
    await migrate(sql, `${__dirname}/migrations/c`);
    expect(messages).toMatchObject(["Migrated 1 file"]);
  });

  expect(await sql`select * from test_migrations.users`.all()).toMatchObject(
    []
  );
  expect(await sql`select * from test_migrations.notes`.all()).toMatchObject(
    []
  );

  await interceptConsole(async (messages) => {
    await seed(sql, `${__dirname}/seeds`);
    expect(messages).toMatchObject(["Seeded 1 file"]);
  });

  expect(await sql`select * from test_migrations.users`.all()).toMatchObject([
    { id: 1, firstName: "Alice", lastName: "Smith" },
    { id: 2, firstName: "Bob", lastName: "Smith" },
    { id: 3, firstName: "Carol", lastName: "Smith" },
  ]);

  expect(await sql`select * from test_migrations.notes`.all()).toMatchObject([
    {
      id: 1,
      body: "Alice's first note",
      authorId: 1,
    },
    {
      id: 2,
      body: "Alice's second note",
      authorId: 1,
    },
    {
      id: 3,
      body: "Bob's first note",
      authorId: 2,
    },
    {
      id: 4,
      body: "Carol's first note",
      authorId: 3,
    },
  ]);

  // seed again and see if the data is duplicated

  await interceptConsole(async (messages) => {
    await seed(sql, `${__dirname}/seeds`);
    expect(messages).toMatchObject(["Seeded 1 file"]);
  });

  expect(await sql`select * from test_migrations.users`.all()).toMatchObject([
    { id: 1, firstName: "Alice", lastName: "Smith" },
    { id: 2, firstName: "Bob", lastName: "Smith" },
    { id: 3, firstName: "Carol", lastName: "Smith" },
    { id: 4, firstName: "Alice", lastName: "Smith" },
    { id: 5, firstName: "Bob", lastName: "Smith" },
    { id: 6, firstName: "Carol", lastName: "Smith" },
  ]);

  expect(await sql`select * from test_migrations.notes`.all()).toMatchObject([
    {
      id: 1,
      body: "Alice's first note",
      authorId: 1,
    },
    {
      id: 2,
      body: "Alice's second note",
      authorId: 1,
    },
    {
      id: 3,
      body: "Bob's first note",
      authorId: 2,
    },
    {
      id: 4,
      body: "Carol's first note",
      authorId: 3,
    },
    {
      id: 5,
      body: "Alice's first note",
      authorId: 4,
    },
    {
      id: 6,
      body: "Alice's second note",
      authorId: 4,
    },
    {
      id: 7,
      body: "Bob's first note",
      authorId: 5,
    },
    {
      id: 8,
      body: "Carol's first note",
      authorId: 6,
    },
  ]);
});

it("supports outputting types", async () => {
  await interceptConsole(async (messages) => {
    await migrate(sql, `${__dirname}/migrations/c`);
    expect(messages).toMatchObject(["Migrated 1 file"]);
  });

  await interceptConsole(async (messages) => {
    await seed(sql, `${__dirname}/seeds`);
    expect(messages).toMatchObject(["Seeded 1 file"]);
  });

  await types(sql, `${__dirname}/types/types.ts`, ["test_migrations"]);
});
