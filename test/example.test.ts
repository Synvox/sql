import { beforeAll, afterAll, it, expect } from "vitest";
import { Pool } from "pg";
import { connect } from "../src";

const client = new Pool();
const sql = connect(client);
type Sql = typeof sql;

beforeAll(async () => {
  await sql`
    drop schema if exists test_example cascade;
    create schema test_example;
  `.exec();
});

afterAll(async () => {
  await sql`
    drop schema test_example cascade;
  `.exec();
  client.end();
});

it("supports this example", async () => {
  // migration
  await sql`
    create table test_example.users (
      id serial primary key,
      first_name text not null,
      last_name text not null
    );
  `.exec();

  await sql`
    create table test_example.notes (
      id serial primary key,
      body text not null,
      author_id int not null references test_example.users(id),
      created_at timestamp not null default now()
    );
  `.exec();

  // seed
  await sql`
    insert into test_example.users
    ${sql.values(
      ["Alice", "Bob", "Carol"].map((name) => ({
        firstName: name,
        lastName: "Smith",
      }))
    )}
  `.exec();

  await sql`
    insert into test_example.notes
    ${sql.values([
      { body: "Alice's first note", authorId: 1 },
      { body: "Alice's second note", authorId: 1 },
      { body: "Bob's first note", authorId: 2 },
      { body: "Carol's first note", authorId: 3 },
    ])}
  `.exec();

  // modules
  const context = {
    userId: 1,
  };

  type Context = typeof context;

  // users.ts

  type User = {
    id: number;
    firstName: string;
    lastName: string;
  };
  (() => {
    async function usersPolicy() {
      return sql`select * from test_example.users`;
    }

    async function updateUser(
      sql: Sql,
      ctx: Context,
      {
        firstName,
        lastName,
      }: {
        firstName: string;
        lastName: string;
      }
    ) {
      return await sql`
        update test_example.users
        ${sql.set({ firstName, lastName })}
        where id = ${ctx.userId}
        returning *
      `.first<User>();
    }

    return { updateUser, usersPolicy };
  })();

  // notes.ts
  type Note = {
    id: number;
    body: string;
    authorId: number;
    createdAt: Date;
  };
  const { notesPolicy, createNote } = (() => {
    async function notesPolicy(ctx: Context) {
      return sql`select * from test_example.notes where author_id = ${ctx.userId}`;
    }

    async function updateNote(
      sql: Sql,
      ctx: Context,
      where: { id: number },
      update: { body: string }
    ) {
      return await sql`
        update test_example.notes
        ${sql.set({ body: update.body })}
        where author_id = ${ctx.userId}
        and id = ${where.id}
        returning *
      `.first<Note>();
    }

    async function createNote(
      sql: Sql,
      ctx: Context,
      insert: { body: string }
    ) {
      return await sql`
        insert into test_example.notes
        ${sql.values({ body: insert.body, authorId: ctx.userId })}
        returning *
      `.first<Note>();
    }

    async function deleteNote(sql: Sql, ctx: Context, where: { id: number }) {
      return await sql`
        delete from test_example.notes
        where author_id = ${ctx.userId}
        and id = ${where.id}
        returning *
      `.first<Note>();
    }

    //@ts-expect-error
    return { notesPolicy, updateNote, createNote, deleteNote };
  })();

  // index.ts
  await sql.transaction(async (sql) => {
    const noteRows = await sql`
      select *
      from (${await notesPolicy(context)}) notes
    `.all();

    expect(noteRows).toMatchObject([
      {
        id: 1,
        body: "Alice's first note",
        authorId: 1,
        createdAt: expect.any(Date),
      },
      {
        id: 2,
        body: "Alice's second note",
        authorId: 1,
        createdAt: expect.any(Date),
      },
    ]);

    const newNote = await createNote(sql, context, {
      body: "Alice's third note",
    });

    expect(newNote).toMatchObject({
      id: expect.any(Number),
      body: "Alice's third note",
      authorId: 1,
      createdAt: expect.any(Date),
    });
  });
});
