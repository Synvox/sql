import { Pool } from "pg";
import { number, object, string } from "zod";
import { connect, cte } from "../src";

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
      text: "select * from users where id in (select id from comments where id=?)",
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

  it("supports dependencies", async () => {
    async function users() {
      return cte("users", sql`select * from users where id = ${"abc"}`);
    }

    async function posts() {
      return cte("posts", sql`select * from posts`, {
        mode: "materialized",
      });
    }

    expect(
      sql`
        select *
        from ${await users()}
        where id = 1
        and where exists (
          select *
          from ${await posts()}
          where users.id = posts.user_id
        )
        limit ${1}
      `.toNative()
    ).toMatchObject({
      text: "with users as (select * from users where id = $1), posts as materialized (select * from posts) ( select * from users where id = 1 and where exists ( select * from posts where users.id = posts.user_id ) limit $2 )",
      values: ["abc", 1],
    });
  });

  it("supports raw substitutions", () => {
    expect(sql`select ${sql.ref("column")} from users`).toMatchObject({
      text: `select "column" from users`,
      values: [],
    });
  });

  it("supports joining statements", () => {
    expect(
      sql`select * from users where ${sql.join(sql`or`, [
        sql`id = ${1}`,
        sql`public = ${true}`,
      ])}`
    ).toMatchObject({
      text: `select * from users where id = ? or public = ?`,
      values: [1, true],
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

  it("supports first with zod schema", async () => {
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

    const UserSchema = object({
      id: number(),
      firstName: string(),
      lastName: string(),
    });

    const result = await sql`select * from test.users`.first(UserSchema);

    expect(result).toEqual({ id: 1, firstName: "Ryan", lastName: "Allred" });

    expect(
      await sql`select * from test.users where id=${123}`.first(
        UserSchema.optional()
      )
    ).toEqual(undefined);

    // rejects because the row was not found
    await expect(
      sql`select * from test.users where id=${123}`.first(UserSchema)
    ).rejects.toThrow();
  });

  it("supports all with zod schema", async () => {
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

    const UserSchema = object({
      id: number(),
      firstName: string(),
      lastName: string(),
    });

    const result = await sql`select * from test.users`.all(UserSchema);

    expect(result).toEqual([{ id: 1, firstName: "Ryan", lastName: "Allred" }]);

    expect(
      await sql`select * from test.users where id=${123}`.all(UserSchema)
    ).toEqual([]);

    await expect(
      sql`select * from test.users where`.all(
        object({
          id: string(),
        })
      )
    ).rejects.toThrow();
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

  it("supports special types (Date, Buffer)", async () => {
    await sql`
      create table test.logs (
        id serial primary key,
        date timestamp with time zone not null,
        data bytea
      );
    `.exec();

    await sql`
      insert into test.logs ${{
        date: new Date("2020-01-01T00:00:00.000Z"),
        data: Buffer.from("hello"),
      }}
    `.exec();

    const result = await sql`select * from test.logs`.first();

    expect(result).toMatchObject({
      date: new Date("2020-01-01T00:00:00.000Z"),
      data: Buffer.from("hello"),
    });
  });

  it("supports establishing a connection without a transaction", async () => {
    expect(
      await sql.connection((sql) => sql`select 1+1 as two`.first())
    ).toEqual({
      two: 2,
    });
  });

  it("supports multiple lines", async () => {
    await sql`
      create table test.logs (
        id serial primary key,
        body text
      );
    `.exec();

    await sql`
      begin;
        insert into test.logs (body) values ('hello1');
        insert into test.logs (body) values ('hello2');
        select *
        into temp logs2
        from test.logs;
        delete from test.logs where body='hello1';
        insert into test.logs(body) select string_agg(logs2.body, ', ') from logs2;
      commit;
    `.exec();

    const rows = await sql`select * from test.logs`.all();

    expect(rows).toMatchInlineSnapshot(`
      Array [
        Object {
          "body": "hello2",
          "id": 2,
        },
        Object {
          "body": "hello1, hello2",
          "id": 3,
        },
      ]
    `);

    const stmt = sql`
      select * from test.logs where id=${2};
      select * from test.logs where id=${3};
    `;

    expect(stmt.compile()).toMatchInlineSnapshot(
      `"select * from test.logs where id='2'; select * from test.logs where id='3';"`
    );

    const results = await stmt.execRaw({
      areYouSureYouKnowWhatYouAreDoing: true,
    });

    expect((results as any).map((r: any) => r.rows)).toMatchInlineSnapshot(`
      Array [
        Array [
          Object {
            "body": "hello2",
            "id": 2,
          },
        ],
        Array [
          Object {
            "body": "hello1, hello2",
            "id": 3,
          },
        ],
      ]
    `);
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
        `.nestAll()} as liked_posts
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

  it("supports nesting with dependencies", async () => {
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
    }}`.exec();

    const post2 = (await sql`insert into test.posts ${{
      name: "My Post",
    }} returning *`.first<{ id: number; name: string }>())!;

    await sql`insert into test.post_likes ${{
      userId: user.id,
      postId: post2.id,
    }}`.exec();

    async function users() {
      return cte(
        "users",
        sql`
          select users.*
          from test.users
          where users.id = ${user.id}
        `
      );
    }

    async function postLikes() {
      return cte(
        "post_likes",
        sql`
          select post_likes.* from test.post_likes
          where post_likes.user_id = ${user.id}
        `
      );
    }

    async function posts() {
      return cte(
        "posts",
        sql`
          select posts.* from test.posts
          where exists (
            select 1
            from ${await postLikes()}
            where post_likes.post_id = posts.id
          )
        `
      );
    }

    const stmt = sql`
      select
        users.*,
        ${sql`
          select
            post_likes.*,
            ${sql`
              select posts.*
              from ${await posts()}
              where posts.id = post_likes.post_id
            `.nestFirst()} as post
          from ${await postLikes()}
          where post_likes.user_id = users.id
        `.nestAll()} as post_likes
      from ${await users()}
      where users.id = ${user.id}
    `;

    expect(stmt.compile()).toMatchInlineSnapshot(
      `"with post_likes as ( select post_likes.* from test.post_likes where post_likes.user_id = '1' ), posts as ( select posts.* from test.posts where exists ( select 1 from post_likes where post_likes.post_id = posts.id ) ), users as ( select users.* from test.users where users.id = '1' ) ( select users.*, coalesce((select jsonb_agg(subquery) as nested from ( select post_likes.*, (select row_to_json(subquery) as nested from ( select posts.* from posts where posts.id = post_likes.post_id ) subquery limit 1) as post from post_likes where post_likes.user_id = users.id ) subquery), '[]'::jsonb) as post_likes from users where users.id = '1' )"`
    );
    const result = await stmt.paginate();
    expect(result).toMatchInlineSnapshot(`
      Array [
        Object {
          "id": 1,
          "name": "Ryan",
          "postLikes": Array [
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
        },
      ]
    `);
  });

  it("supports dependencies", async () => {
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

    type User = { id: number; name: string };
    type Post = { id: number; name: string };
    const user = (await sql`insert into test.users ${{
      name: "Ryan",
    }} returning *`.first<User>())!;

    const post1 = (await sql`insert into test.posts ${{
      name: "My Post",
    }} returning *`.first<Post>())!;
    await sql`insert into test.post_likes ${{
      userId: user.id,
      postId: post1.id,
    }} returning *`.first();

    const post2 = (await sql`insert into test.posts ${{
      name: "My Post",
    }} returning *`.first<Post>())!;
    await sql`insert into test.post_likes ${{
      userId: user.id,
      postId: post2.id,
    }} returning *`.first();

    async function posts() {
      // if this needed to come from somewhere
      const u =
        await sql`select * from test.users where id = ${user.id}`.first<User>();

      return cte(
        "posts",
        sql`
        select *
        from test.posts
        where exists (
          select *
          from test.post_likes
          where post_likes.post_id = posts.id
          and user_id = ${u!.id}
        )
      `,
        { mode: "not materialized" }
      );
    }

    const stmt = sql`
      select *
      from ${await posts()}
      where id = ${post1.id}
    `;

    const result = await stmt.first<Post>();

    expect(result).toMatchInlineSnapshot(`
      Object {
        "id": 1,
        "name": "My Post",
      }
    `);

    expect(stmt.toNative()).toMatchInlineSnapshot(`
      Object {
        "text": "with posts as not materialized ( select * from test.posts where exists ( select * from test.post_likes where post_likes.post_id = posts.id and user_id = $1 ) ) ( select * from posts where id = $2 )",
        "values": Array [
          1,
          1,
        ],
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
