import { PoolClient as PGPoolClient, Pool as PGPool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { PoolClient, Pool, SqlFragment, connect } from "../src";

let client = new PGPool();

class TestClient extends Pool {
  pgClient: PGPool;
  constructor(pgClient: PGPool) {
    super();
    this.pgClient = pgClient;
  }
  async query<T>(
    text: string,
    values: (string | number | boolean | Date | SqlFragment | null)[]
  ): Promise<{ rows: T[] }> {
    //@ts-expect-error
    return await this.pgClient.query(text, values);
  }
  async isolate(): Promise<TestIsolatedClient> {
    let pgClient = await this.pgClient.connect();
    return new TestIsolatedClient(pgClient);
  }
}

class TestIsolatedClient extends PoolClient {
  pgClient: PGPoolClient;
  constructor(pgClient: PGPoolClient) {
    super();
    this.pgClient = pgClient;
  }
  async query<T>(
    text: string,
    values: (string | number | boolean | Date | SqlFragment | null)[]
  ): Promise<{ rows: T[] }> {
    //@ts-expect-error
    return await this.pgClient.query(text, values);
  }
  async release() {
    this.pgClient.release();
  }
}

let sql = connect(new TestClient(client), {
  deadlockRetryCount: 2,
});

async function interceptConsoleError<T>(fn: (logs: any[]) => T) {
  let messages: string[] = [];
  let log = global.console.error;
  global.console.error = (x: string) => messages.push(x);
  let result = await fn(messages);
  global.console.error = log;
  return result;
}

describe("substitutions", () => {
  it("supports basic substitution", () => {
    expect(sql`select * from users where id=${1}`).toMatchObject({
      text: "select * from users where id=❓",
      values: [1],
    });
  });

  it("supports many substitutions in .preview", () => {
    expect(
      sql`select * from users where id in (${sql.array(Array.from({ length: 25 }).map((_, i) => i))})`.preview()
    ).toMatchInlineSnapshot(
      `"select * from users where id in ('0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24')"`
    );
  });

  it("supports dates", () => {
    let d = new Date();
    expect(sql`select * from users where created_at=${d}`).toMatchObject({
      text: "select * from users where created_at=❓",
      values: [d],
    });
  });

  it("supports subqueries", () => {
    expect(
      sql`select * from users where id in (${sql`select id from comments where id=${1}`})`
    ).toMatchObject({
      text: "select * from users where id in (select id from comments where id=❓)",
      values: [1],
    });
  });

  it("supports interpolation from async function", async () => {
    async function policy() {
      return sql`deleted_at=${false}`; // sql doesn't return a promise so this should work
    }

    expect(sql`select * from users where ${await policy()}`).toMatchObject({
      text: "select * from users where deleted_at=❓",
      values: [false],
    });
  });

  it("supports dependencies", async () => {
    async function users() {
      return sql`select * from users where id = ${"abc"}`;
    }

    async function posts() {
      return sql`select * from posts`;
    }

    expect(
      sql`
        select *
        from (${await users()}) users
        where id = 1
        and where exists (
          select *
          from (${await posts()}) posts
          where users.id = posts.user_id
        )
        limit ${1}
      `.toNative()
    ).toMatchInlineSnapshot(`
      {
        "text": "select *
      from (select * from users where id = $1) users
      where id = 1
      and where exists (
        select *
        from (select * from posts) posts
        where users.id = posts.user_id
      )
      limit $2",
        "values": [
          "abc",
          1,
        ],
      }
    `);
  });

  it("supports raw substitutions", () => {
    expect(sql`select ${sql.ref("column")} from users`).toMatchObject({
      text: `select "column" from users`,
      values: [],
    });
  });

  it("supports or statements", () => {
    expect(
      sql`select * from users where ${sql.or({
        id: 1,
        public: true,
      })}`
    ).toMatchObject({
      text: `select * from users where ("id" = ❓ or "public" = ❓)`,
      values: [1, true],
    });
  });

  it("supports arrays", () => {
    expect(
      sql`select * from users where id in (${sql.array([1, 2, 3])})`
    ).toMatchObject({
      text: "select * from users where id in (❓, ❓, ❓)",
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
      sql`select * from users where ${sql.and({
        name: "Ryan",
        number: 0,
      })}`
    ).toMatchObject({
      text: 'select * from users where ("name" = ❓ and "number" = ❓)',
      values: ["Ryan", 0],
    });
  });

  it("supports where null values", () => {
    expect(
      sql`select * from users where ${sql.and({
        name: "Ryan",
        number: null,
      })}`
    ).toMatchObject({
      text: 'select * from users where ("name" = ❓ and "number" is null)',
      values: ["Ryan"],
    });
  });

  it("supports inserting values", () => {
    expect(
      sql`insert into users ${sql.values({
        name: "Ryan",
        number: 0,
      })}`
    ).toMatchObject({
      text: 'insert into users ("name", "number") values (❓, ❓)',
      values: ["Ryan", 0],
    });
  });

  it("supports inserting multiple values", () => {
    expect(
      sql`insert into users ${sql.values([
        {
          name: "Ryan",
          number: 0,
        },
        {
          name: "Nolan",
          number: 1,
        },
      ])}`
    ).toMatchObject({
      text: 'insert into users ("name", "number") values (❓, ❓), (❓, ❓)',
      values: ["Ryan", 0, "Nolan", 1],
    });
  });

  it("supports setting values", () => {
    expect(
      sql`update users ${sql.set({
        name: "Ryan",
        active: true,
      })}`
    ).toMatchObject({
      text: 'update users set "name" = ❓, "active" = ❓',
      values: ["Ryan", true],
    });
  });

  it("supports updating values", () => {
    expect(
      sql`update users ${sql.set({
        name: "Ryan",
        active: true,
      })}`
    ).toMatchObject({
      text: 'update users set "name" = ❓, "active" = ❓',
      values: ["Ryan", true],
    });
  });

  it("supports where", () => {
    expect(
      sql`select * from table_name where ${sql.and({ val: 1, val2: false })}`
    ).toMatchObject({
      text: 'select * from table_name where ("val" = ❓ and "val2" = ❓)',
      values: [1, false],
    });
  });

  it("supports interpolating within arrays and objects", async () => {
    expect(
      sql`insert into test.users ${sql.values({
        firstName: "Ryan",
        lastName: "Allred",
        createdAt: sql`now()`,
      })}`.preview()
    ).toEqual(
      `insert into test.users ("first_name", "last_name", "created_at") values ('Ryan', 'Allred', now())`
    );
  });

  it("supports compiling to a plain string", async () => {
    expect(
      await sql`insert into test.users ${sql.values({
        firstName: "Ryan",
        lastName: "Allred",
      })}`.preview()
    ).toEqual(
      `insert into test.users ("first_name", "last_name") values ('Ryan', 'Allred')`
    );
  });
});

describe("connects to postgres", () => {
  beforeEach(async () => {
    await sql`
      drop schema if exists test cascade;
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
      insert into test.users ${sql.values({
        firstName: "Ryan",
        lastName: "Allred",
      })}
    `.exec();

    let result = await sql`select * from test.users`.all();

    expect(result).toEqual([{ id: 1, firstName: "Ryan", lastName: "Allred" }]);
  });

  it("handles failures", async () => {
    await interceptConsoleError(async (errors) => {
      await expect(
        sql`limit from`.exec()
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `[error: syntax error at or near "limit"]`
      );
      expect(errors).toMatchInlineSnapshot(`
        [
          [error: syntax error at or near "limit"],
        ]
      `);
    });

    await expect(
      sql`select 2+2; select 4+4`.all()
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: Multiple statements in query, use "exec" instead.]`
    );

    expect(
      //@ts-expect-error
      () => sql`select ${undefined} + 2`
    ).toThrowErrorMatchingInlineSnapshot(
      `[Error: cannot bind undefined value to query]`
    );
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
      insert into test.users ${sql.values({
        firstName: "Ryan",
        lastName: "Allred",
      })}
    `.exec();

    let result = await sql`select * from test.users`.first();

    expect(result).toEqual({ id: 1, firstName: "Ryan", lastName: "Allred" });

    expect(await sql`select * from test.users where id=${123}`.first()).toEqual(
      undefined
    );
  });

  it("supports count", async () => {
    await sql`
      create table test.users (
        id serial primary key,
        first_name text not null,
        last_name text not null
      );
    `.exec();

    expect(await sql`select * from test.users`.count()).toEqual(0);

    await sql`
      insert into test.users ${sql.values({
        firstName: "Ryan",
        lastName: "Allred",
      })}
    `.exec();

    expect(await sql`select * from test.users`.count()).toEqual(1);
  });

  it("supports exists", async () => {
    await sql`
      create table test.users (
        id serial primary key,
        first_name text not null,
        last_name text not null
      );
    `.exec();

    await sql`
      insert into test.users ${sql.values({
        firstName: "Ryan",
        lastName: "Allred",
      })}
    `.exec();

    expect(await sql`select * from test.users`.exists()).toEqual(true);
    expect(
      await sql`select * from test.users where id=${123}`.exists()
    ).toEqual(false);
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
      insert into test.users ${sql.values({
        firstName: "Ryan",
        lastName: "Allred",
      })}
    `.exec();

    let result = await sql`select * from test.users`.all();

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
      insert into test.logs ${sql.values({
        data: sql.literal({ thing: 0 }),
      })}
    `.exec();

    let result = await sql`select * from test.logs`.all();

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
      insert into test.logs ${sql.values({
        data: sql.literal(["thing1", "thing2"]),
      })}
    `.exec();

    let result = await sql`select * from test.logs`.all();

    expect(result).toEqual([{ data: ["thing1", "thing2"], id: 1 }]);
  });

  it("supports inserting literals", async () => {
    await sql`
      create table test.logs (
        id serial primary key,
        data text[]
      );
    `.exec();

    await sql`
      insert into test.logs ${sql.values([
        {
          data: sql.literal(["thing1", "thing2"]),
        },
        {
          data: sql.literal(["thing3", "thing4"]),
        },
      ])}
    `.exec();

    let stmt = sql`select * from test.logs where data = ${sql.literal([
      "thing1",
      "thing2",
    ])}`;
    let result = await stmt.all();

    expect(stmt.toNative()).toMatchObject({
      text: "select * from test.logs where data = $1",
      values: [["thing1", "thing2"]],
    });
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
      insert into test.logs ${sql.values({
        date: new Date("2020-01-01T00:00:00.000Z"),
        data: sql.literal(Buffer.from("hello")),
      })}
    `.exec();

    let result = await sql`select * from test.logs`.first();

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

    const multiLineStmt = sql`
      begin;
        insert into test.logs (body) values ('hello1');
        insert into test.logs (body) values ('hello2');
        select *
        into temp logs2
        from test.logs;
        delete from test.logs where body='hello1';
        insert into test.logs(body) select string_agg(logs2.body, ', ') from logs2;
      commit;
    `;
    expect(multiLineStmt.toNative().text).toEqual(
      "begin;\n  insert into test.logs (body) values ('hello1');\n  insert into test.logs (body) values ('hello2');\n  select *\n  into temp logs2\n  from test.logs;\n  delete from test.logs where body='hello1';\n  insert into test.logs(body) select string_agg(logs2.body, ', ') from logs2;\ncommit;"
    );
    await multiLineStmt.exec();

    let rows = await sql`select * from test.logs`.all();

    expect(rows).toMatchInlineSnapshot(`
      [
        {
          "body": "hello2",
          "id": 2,
        },
        {
          "body": "hello1, hello2",
          "id": 3,
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
    let user = (await sql`insert into test.users ${sql.values({
      name: "Ryan",
    })} returning *`.first<User>())!;

    let post1 = (await sql`insert into test.posts ${sql.values({
      name: "My Post",
    })} returning *`.first<Post>())!;
    await sql`insert into test.post_likes ${sql.values({
      userId: user.id,
      postId: post1.id,
    })} returning *`.first();

    let post2 = (await sql`insert into test.posts ${sql.values({
      name: "My Post",
    })} returning *`.first<Post>())!;
    await sql`insert into test.post_likes ${sql.values({
      userId: user.id,
      postId: post2.id,
    })} returning *`.first();

    async function posts() {
      // if this needed to come from somewhere
      let u =
        await sql`select * from test.users where id = ${user.id}`.first<User>();

      return sql`
        select *
        from test.posts
        where exists (
          select *
          from test.post_likes
          where post_likes.post_id = posts.id
          and user_id = ${u!.id}
        )
      `;
    }

    let stmt = sql`
      select *
      from (${await posts()}) posts
      where id = ${post1.id}
    `;

    let result = await stmt.first<Post>();

    expect(result).toMatchInlineSnapshot(`
      {
        "id": 1,
        "name": "My Post",
      }
    `);

    expect(stmt.toNative()).toMatchInlineSnapshot(`
      {
        "text": "select *
      from (
        select *
        from test.posts
        where exists (
          select *
          from test.post_likes
          where post_likes.post_id = posts.id
          and user_id = $1
        )
      ) posts
      where id = $2",
        "values": [
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
            insert into test.users ${sql.values({
              firstName: "Ryan",
              lastName: "Allred",
            })}
          `.exec();

          let result = await sql`select * from test.users`.all();

          expect(result).toEqual([
            { id: 1, firstName: "Ryan", lastName: "Allred" },
          ]);
        });
      } catch (e) {}

      let result = await sql`select * from test.users`.all();

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
            insert into test.users ${sql.values({
              firstName: "Ryan",
              lastName: "Allred",
            })}
          `.exec();

          let result = await sql`select * from test.users`.all();

          expect(result).toEqual([
            { id: 1, firstName: "Ryan", lastName: "Allred" },
          ]);

          throw new Error("rollback");
        });
      } catch (e) {}

      let result = await sql`select * from test.users`.all();

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

      try {
        await sql.transaction(async (sql) => {
          await sql`
            insert into test.users ${sql.values({
              firstName: "Ryan",
              lastName: "Allred",
            })}
          `.exec();

          try {
            await sql.transaction(async (sql) => {
              await sql`
                insert into test.users ${sql.values({
                  firstName: "Ryan",
                  lastName: "Allred",
                })}
              `.exec();

              let result = await sql`select * from test.users`.all();

              expect(result).toEqual([
                { id: 1, firstName: "Ryan", lastName: "Allred" },
                { id: 2, firstName: "Ryan", lastName: "Allred" },
              ]);

              throw new Error("rollback");
            });
          } catch (e) {}

          let result = await sql`select * from test.users`.all();

          expect(result).toEqual([
            { id: 1, firstName: "Ryan", lastName: "Allred" },
          ]);
          throw new Error("rollback");
        });
      } catch (e) {}

      let result = await sql`select * from test.users`.all();

      expect(result).toEqual([]);
    });

    it("deadlocks as expected", async () => {
      let sql1 = connect(new TestClient(client), {});
      let sql2 = connect(new TestClient(client), {});

      await sql1`
          drop table if exists test.deadlock;
        `.exec();

      await sql1`
          create table test.deadlock (
            id text primary key,
            data text not null
          );
        `.exec();

      await sql1`
          insert into test.deadlock ${sql1.values([
            { id: "1", data: "(unset)" },
            { id: "2", data: "(unset)" },
          ])}
        `.exec();

      function withResolvers<T>() {
        type Resolve = (value: T) => void;
        type Reject = (reason: any) => void;
        let a: Resolve | null, b: Reject | null;
        let c = new Promise<T>(function (resolve, reject) {
          a = resolve;
          b = reject;
        });

        return { resolve: a!, reject: b!, promise: c };
      }

      const { promise: promise1Start, resolve: resolve1Start } =
        withResolvers<void>();
      const { promise: promise2Start, resolve: resolve2Start } =
        withResolvers<void>();
      const {
        promise: promise1End,
        resolve: resolve1End,
        reject: reject1,
      } = withResolvers<void>();
      const {
        promise: promise2End,
        resolve: resolve2End,
        reject: reject2,
      } = withResolvers<void>();

      let tsql1: typeof sql;
      let tsql2: typeof sql;

      let callCount1 = 0;
      const promise1 = sql1.impureTransaction(async (sql) => {
        callCount1++;
        tsql1 = sql;
        resolve1Start();
        await promise1End;
        return sql`select * from test.deadlock order by id asc`.all();
      });

      let callCount2 = 0;
      const promise2 = sql2.impureTransaction(async (sql) => {
        callCount2++;
        tsql2 = sql;
        resolve2Start();
        await promise2End;
        return sql`select * from test.deadlock order by id asc`.all();
      });

      await Promise.all([promise1Start, promise2Start]);

      await interceptConsoleError(async (errors) => {
        await tsql1!`
          select * from test.deadlock where id = '1' for update
        `
          .exec()
          .catch(reject1);

        await tsql2!`
          select * from test.deadlock where id = '2' for update
        `
          .exec()
          .catch(reject2);

        await Promise.all([
          tsql1!`
            update test.deadlock set data = 'second row' where id = '2'
          `
            .exec()
            .catch(reject1),
          tsql2!`
          update test.deadlock set data = 'first row' where id = '1'
        `
            .exec()
            .catch(reject2),
        ]);

        resolve1End();
        resolve2End();

        expect(errors).toMatchInlineSnapshot(`
          [
            [error: deadlock detected],
          ]
        `);
      });

      expect(callCount1).toBe(1);
      expect(callCount2).toBe(1);

      // make sure we got a deadlock with the expected error name
      let [p1, p2]: any[] = await Promise.allSettled([promise1, promise2]);
      if (p1.status === "rejected") {
        expect(p2.value).toMatchObject([
          {
            id: "1",
            data: "first row",
          },
          {
            id: "2",
            data: "(unset)", // unset because the transaction was rolled back
          },
        ]);

        expect(p1.reason.message).toMatch("deadlock detected");
      } else {
        expect(p1.value).toMatchObject([
          {
            id: "1",
            data: "(unset)", // unset because the transaction was rolled back
          },
          {
            id: "2",
            data: "second row",
          },
        ]);

        expect(p2.reason.message).toMatch("deadlock detected");
      }
    });

    it("retries when using transaction on deadlocks", async () => {
      let runs = 0;
      await expect(() =>
        sql.transaction(() => {
          runs++;
          // make sure this is the same name as in the previous test
          throw new Error("deadlock detected");
        })
      ).rejects.toThrowError("deadlock detected");
      expect(runs).toBe(2);

      runs = 0;
      await expect(() =>
        sql.transaction(() => {
          runs++;
          throw new Error("unrelated error");
        })
      ).rejects.toThrowError("unrelated error");
      expect(runs).toBe(1);
    });
  });
});
