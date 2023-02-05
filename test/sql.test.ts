import { Pool } from "pg";
import { connect } from "../src";

const client = new Pool();
const sql = connect(client);

describe("substitutions", () => {
  it("supports basic substitution", () => {
    expect(sql`select * from users where id=${1}`).toMatchObject({
      text: "select * from users where id=?",
      values: [1],
    });
  });

  it("supports dates", () => {
    const d = new Date();
    expect(sql`select * from users where created_at=${d}`).toMatchObject({
      text: "select * from users where created_at=?",
      values: [d],
    });
  });

  it("supports subqueries", () => {
    expect(
      sql`select * from users where id in (${sql`select id from comments where id=${1}`})`
    ).toMatchObject({
      text:
        "select * from users where id in (select id from comments where id=?)",
      values: [1],
    });
  });

  it("supports interpolation from async function", async () => {
    async function policy() {
      return sql`deleted_at=${false}`; // sql doesn't return a promise so this should work
    }

    expect(sql`select * from users where ${await policy()}`).toMatchObject({
      text: "select * from users where deleted_at=?",
      values: [false],
    });
  });

  it("supports raw substitutions", () => {
    expect(sql`select ${sql.identifier("column")} from users`).toMatchObject({
      text: `select "column" from users`,
      values: [],
    });
  });

  it("supports arrays", () => {
    expect(sql`select * from users where id in (${[1, 2, 3]})`).toMatchObject({
      text: "select * from users where id in (?,?,?)",
      values: [1, 2, 3],
    });
  });

  it("supports conditional substitution", () => {
    expect(
      sql`select * from users where ${
        false ? sql`deleted_at is null` : sql`true`
      }`
    ).toMatchObject({
      text: "select * from users where true",
      values: [],
    });

    expect(
      sql`select * from users where ${
        true ? sql`deleted_at is null` : sql`true`
      }`
    ).toMatchObject({
      text: "select * from users where deleted_at is null",
      values: [],
    });
  });

  it("supports where values", () => {
    expect(
      sql`select * from users where ${{
        name: "Ryan",
        number: 0,
      }}`
    ).toMatchObject({
      text: 'select * from users where ("name" = ? and "number" = ?)',
      values: ["Ryan", 0],
    });
  });

  it("supports where null values", () => {
    expect(
      sql`select * from users where ${{
        name: "Ryan",
        number: null,
      }}`
    ).toMatchObject({
      text: 'select * from users where ("name" = ? and "number" is null)',
      values: ["Ryan"],
    });
  });

  it("supports inserting values", () => {
    expect(
      sql`insert into users ${{
        name: "Ryan",
        number: 0,
      }}`
    ).toMatchObject({
      text: 'insert into users ("name", "number") values (?, ?)',
      values: ["Ryan", 0],
    });
  });

  it("supports inserting multiple values", () => {
    expect(
      sql`insert into users ${[
        {
          name: "Ryan",
          number: 0,
        },
        {
          name: "Nolan",
          number: 1,
        },
      ]}`
    ).toMatchObject({
      text: 'insert into users ("name", "number") values (?,?),(?,?)',
      values: ["Ryan", 0, "Nolan", 1],
    });
  });

  it("supports setting values", () => {
    expect(
      sql`update users set ${{
        name: "Ryan",
        active: true,
      }}`
    ).toMatchObject({
      text: 'update users set "name" = ?, "active" = ?',
      values: ["Ryan", true],
    });
  });

  it("supports updating values", () => {
    expect(
      sql`update users set ${{
        name: "Ryan",
        active: true,
      }}`
    ).toMatchObject({
      text: 'update users set "name" = ?, "active" = ?',
      values: ["Ryan", true],
    });
  });

  it("supports where", () => {
    expect(
      sql`select * from table_name where ${{ val: 1, val2: false }}`
    ).toMatchObject({
      text: 'select * from table_name where ("val" = ? and "val2" = ?)',
      values: [1, false],
    });
  });

  it("supports interpolating within arrays and objects", async () => {
    expect(
      await sql`insert into test.users ${{
        firstName: "Ryan",
        lastName: "Allred",
        createdAt: sql`now()`,
      }}`.compile()
    ).toEqual(
      `insert into test.users ("first_name", "last_name", "created_at") values ('Ryan', 'Allred', now())`
    );
  });

  it("supports compiling to a plain string", async () => {
    expect(
      await sql`insert into test.users ${{
        firstName: "Ryan",
        lastName: "Allred",
      }}`.compile()
    ).toEqual(
      `insert into test.users ("first_name", "last_name") values ('Ryan', 'Allred')`
    );
  });
});

describe("connects to postgres", () => {
  beforeEach(async () => {
    await sql`
      drop schema if exists test;
      create schema test;
    `.exec();
  });

  afterEach(async () => {
    await sql`
      drop schema test cascade;
    `.exec();
  });

  afterAll(async () => {
    await client.end();
  });

  it("inserts and queries", async () => {
    await sql`
      create table test.users (
        id serial primary key,
        first_name text not null,
        last_name text not null
      );
    `.exec();

    await sql`
      insert into test.users ${{
        firstName: "Ryan",
        lastName: "Allred",
      }}
    `.exec();

    const result = await sql`select * from test.users`.all();

    expect(result).toEqual([{ id: 1, firstName: "Ryan", lastName: "Allred" }]);
  });

  it("supports first", async () => {
    await sql`
      create table test.users (
        id serial primary key,
        first_name text not null,
        last_name text not null
      );
    `.exec();

    await sql`
      insert into test.users ${{
        firstName: "Ryan",
        lastName: "Allred",
      }}
    `.exec();

    const result = await sql`select * from test.users`.first();

    expect(result).toEqual({ id: 1, firstName: "Ryan", lastName: "Allred" });

    expect(await sql`select * from test.users where id=${123}`.first()).toEqual(
      undefined
    );
  });

  it("supports all", async () => {
    await sql`
      create table test.users (
        id serial primary key,
        first_name text not null,
        last_name text not null
      );
    `.exec();

    await sql`
      insert into test.users ${{
        firstName: "Ryan",
        lastName: "Allred",
      }}
    `.exec();

    const result = await sql`select * from test.users`.all();

    expect(result).toEqual([{ id: 1, firstName: "Ryan", lastName: "Allred" }]);

    expect(await sql`select * from test.users where id=${123}`.all()).toEqual(
      []
    );
  });

  it("supports inserting objects", async () => {
    await sql`
      create table test.logs (
        id serial primary key,
        data jsonb
      );
    `.exec();

    await sql`
      insert into test.logs ${{
        data: { thing: 0 },
      }}
    `.exec();

    const result = await sql`select * from test.logs`.all();

    expect(result).toEqual([{ data: { thing: 0 }, id: 1 }]);
  });

  it("supports inserting arrays", async () => {
    await sql`
      create table test.logs (
        id serial primary key,
        data text[]
      );
    `.exec();

    await sql`
      insert into test.logs ${{
        data: ["thing1", "thing2"],
      }}
    `.exec();

    const result = await sql`select * from test.logs`.all();

    expect(result).toEqual([{ data: ["thing1", "thing2"], id: 1 }]);
  });

  it("supports establishing a connection without a transaction", async () => {
    expect(
      await sql.connection((sql) => sql`select 1+1 as two`.first())
    ).toEqual({
      two: 2,
    });
  });

  it("supports nesting", async () => {
    await sql`
      create table test.users (
        id serial primary key,
        name text not null
      );
    `.exec();

    await sql`
      create table test.posts (
        id serial primary key,
        name text not null
      );
    `.exec();

    await sql`
      create table test.post_likes (
        id serial primary key,
        user_id int not null references test.users(id) on delete cascade,
        post_id int not null references test.posts(id) on delete cascade
      );
    `.exec();

    const user = (await sql`insert into test.users ${{
      name: "Ryan",
    }} returning *`.first<{ id: number; name: string }>())!;

    const post1 = (await sql`insert into test.posts ${{
      name: "My Post",
    }} returning *`.first<{ id: number; name: string }>())!;
    await sql`insert into test.post_likes ${{
      userId: user.id,
      postId: post1.id,
    }} returning *`.first();

    const post2 = (await sql`insert into test.posts ${{
      name: "My Post",
    }} returning *`.first<{ id: number; name: string }>())!;
    await sql`insert into test.post_likes ${{
      userId: user.id,
      postId: post2.id,
    }} returning *`.first();

    const result = await sql`
      select
        users.*,
        ${sql`
          select
            post_likes.*,
            ${sql`
              select posts.*
              from test.posts
              where posts.id = post_likes.post_id
              limit 1
            `.nestFirst()} as post
          from test.post_likes
          where post_likes.user_id = users.id
        `.nest()} as liked_posts
      from test.users
      where users.id = ${user.id}
    `.first();

    expect(result).toMatchInlineSnapshot(`
      Object {
        "id": 1,
        "likedPosts": Array [
          Object {
            "id": 1,
            "post": Object {
              "id": 1,
              "name": "My Post",
            },
            "postId": 1,
            "userId": 1,
          },
          Object {
            "id": 2,
            "post": Object {
              "id": 2,
              "name": "My Post",
            },
            "postId": 2,
            "userId": 1,
          },
        ],
        "name": "Ryan",
      }
    `);
  });

  describe("transactions", () => {
    it("supports commit", async () => {
      await sql`
        create table test.users (
          id serial primary key,
          first_name text not null,
          last_name text not null
        );
      `.exec();

      try {
        await sql.transaction(async (sql) => {
          await sql`
            insert into test.users ${{
              firstName: "Ryan",
              lastName: "Allred",
            }}
          `.exec();

          const result = await sql`select * from test.users`.all();

          expect(result).toEqual([
            { id: 1, firstName: "Ryan", lastName: "Allred" },
          ]);
        });
      } catch (e) {}

      const result = await sql`select * from test.users`.all();

      expect(result).toEqual([
        { id: 1, firstName: "Ryan", lastName: "Allred" },
      ]);
    });

    it("supports rollback", async () => {
      await sql`
        create table test.users (
          id serial primary key,
          first_name text not null,
          last_name text not null
        );
      `.exec();

      try {
        await sql.transaction(async (sql) => {
          await sql`
            insert into test.users ${{
              firstName: "Ryan",
              lastName: "Allred",
            }}
          `.exec();

          const result = await sql`select * from test.users`.all();

          expect(result).toEqual([
            { id: 1, firstName: "Ryan", lastName: "Allred" },
          ]);

          throw new Error("rollback");
        });
      } catch (e) {}

      const result = await sql`select * from test.users`.all();

      expect(result).toEqual([]);
    });

    it("supports savepoints", async () => {
      await sql`
        create table test.users (
          id serial primary key,
          first_name text not null,
          last_name text not null
        );
      `.exec();

      await sql.transaction(async (sql) => {
        await sql`
          insert into test.users ${{
            firstName: "Ryan",
            lastName: "Allred",
          }}
        `.exec();

        try {
          await sql.transaction(async (sql) => {
            await sql`
              insert into test.users ${{
                firstName: "Ryan",
                lastName: "Allred",
              }}
            `.exec();

            const result = await sql`select * from test.users`.all();

            expect(result).toEqual([
              { id: 1, firstName: "Ryan", lastName: "Allred" },
              { id: 2, firstName: "Ryan", lastName: "Allred" },
            ]);

            throw new Error("rollback");
          });
        } catch (e) {}

        const result = await sql`select * from test.users`.all();

        expect(result).toEqual([
          { id: 1, firstName: "Ryan", lastName: "Allred" },
        ]);
      });

      const result = await sql`select * from test.users`.all();

      expect(result).toEqual([
        { id: 1, firstName: "Ryan", lastName: "Allred" },
      ]);
    });
  });
});
