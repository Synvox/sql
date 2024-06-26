# `@synvox/sql`

**`sql` is another sql template string library**

```
npm i @synvox/sql
```

## Setting up for your client

`@synvox/sql` does not depend on a specific SQL client. You need to implement the `Pool`, `PoolClient`, and `Client` interfaces to use the library with your drivers of choice.

```ts
import { connect, Pool, PoolClient, Client } from "@synvox/sql";
import * as pg from "pg";

// Implement the Pool and PoolClient interfaces to use pooling
// connections. If you don't need pooling you can implement the Client.
class MyPool extends Pool {
  constructor() {
    super();
    this.client = new pg.Pool();
  }
  query(query: string, values: any[]) {
    return this.client.query(query, values);
  }
  isolate() {
    return new MyPoolClient(this.client.connect());
  }
}

class MyPoolClient extends PoolClient {
  constructor(client: pg.PoolClient) {
    super();
    this.client = client;
  }
  query(query: string, values: any[]) {
    return MyPool.prototype.query.call(this, query, values);
  }
  release() {
    this.client.release();
  }
}

class MyClient extends Client {
  constructor() {
    super();
    this.client = new pg.Client();
  }
  query(query: string, values: any[]) {
    return this.client.query(query, values);
  }
}

const sql = connect(new MyPool());
// or if you don't need pooling
// const sql = connect(new MyClient());
```

## Executing Queries

**`exec`** for running queries.

```ts
await sql`
  create table example (
    id serial primary key
  )
`.exec();
```

**`all`** for getting the rows returned from a query.

```ts
let users = await sql`
  select * from users
`.all<User>();
```

**`first`** for getting the first row returned from a query.

```ts
let user = await sql`
  select * from users
`.first<User>();
```

**`exists`** returns a boolean if a row exists.

```ts
let runJobs = await sql`
  select * from jobs where run_at < now() limit 1
`.exists();
```

**`paginate`** for getting the rows returned from a query.

```ts
let users = await sql`
  select * from users
`.paginate<User>(page, 100);
```

Note: `paginate` will wrap your query in a `select q.* from (...) q limit ? offset ?` query.

## Composing Queries

**Sub queries** can be used to compose queries together.

```ts
sql`select * from table_name where other_id in (${sql`select id from other_table`}`);
```

**Query Builders**

```ts
await sql`
  insert into users ${sql.values({ name: "Ryan", active: false })}
`.exec();
// Executes:
// insert into users(name, active) values ($0, $1)
// $0 = "Ryan"
// $1 = false
```

```ts
await sql`
  insert into users ${sql.values([
    { name: "Ryan", active: false },
    { name: "Nolan", active: false },
  ])}
`.exec();
// Executes:
// insert into users(name, active) values ($0, $1), ($2, $3)
// $0 = "Ryan"
// $1 = false
// $2 = "Nolan"
// $3 = false
```

```ts
await sql`
  update users
  ${sql.set({ name: "Ryan", active: true })}
  where id = ${1}
`.exec();
// Executes:
// update users set name = $0, active = $1 where id = $2
// $0 = "Ryan"
// $1 = true
// $2 = 1
```

```ts
await sql`
  select *
  from users
  where ${sql.and({ id: 1, active: true })}
`.exec();
// Executes:
// select * from users where (id = $0 and active = $1)
// $0 = 1
// $1 = true
```

```ts
await sql`
  select *
  from users
  where ${sql.or({ id: 1, active: true })}
`.exec();
// Executes:
// select * from users where (id = $0 or active = $1)
// $0 = 1
// $1 = true
```

**Arrays**

Arrays are converted to comma separated values:

```ts
await sql`
  select *
  from users
  where id in (${sql.array([1, 2, 3])})
`.exec();
// Executes:
// select * from users where id in ($0, $1, $2)
// $0 = 1
// $1 = 2
// $2 = 3
```

**References**

If you need to reference a column in a query you can use `sql.ref`:

```ts
await sql`
  select ${sql.ref("users.id")}
  from users
`.all();
```

**Raw Values**

Use `sql.raw` for building query from a string. This function does not sanitize any inputs so use with care.

_hint:_ You probably want to use `sql.ref` instead.

```ts
let column = "id";

if (!(column in attributes)) throw new Error("...");

return await sql`select ${sql.raw(column)} from table_name`.many();
```

**Join**

If you need to join values in a query you can use `sql.join`:

```ts
await sql`
  select ${sql.join([sql`users.id`, sql`users.name`], ", ")}
  from users
`.all();
```

**Literals**

If you need to use a literal value in a query you can use `sql.literal`:

```ts
await sql`
  insert into points (location) values (${sql.literal([100, 100])})
`.all();
```

## Transactions

```ts
await sql.transaction(async (sql) => {
  // use sql like normal, commit and rollback are handled for you.
  // if an error is thrown the transaction will be rolled back.
});
```

## Dedicated Connection

If you need to get a dedicated connection for a single query you can use `connection`. This will use your `PoolClient` implementation.

```ts
await sql.connection(async (sql) => {
  // use sql like normal. Connection is closed after function ends.
});
```

## Previewing queries

To get a sql string representing a query run `preview`.

```ts
// In a migration script
let migration = sql`
insert into users ${{ firstName: "Ryan" }}
`.preview(); // insert into users (first_name) values ('Ryan')
```

## Migrations

`@synvox/sql` comes with a simple migration system, but it does not come with a CLI. You can use the migration system in your own scripts.

```ts
// where directory name is the path to your migrations
await migrate(sql, directoryName);
```

Migrations are `.ts` files that export an `up` function that accepts a `sql` instance.

```ts
export async function up(sql) {
  await sql`
    create table users (
      id serial primary key,
      first_name text not null,
      last_name text not null
    )
  `.exec();
}
```

_Note:_ Migrations do not support down migrations.

## Seeds

`@synvox/sql` comes with a simple seed system, but it does not come with a CLI. You can use the seed system in your own scripts.

```ts
// where directory name is the path to your seeds
await seed(sql, directoryName);
```

Seeds are `.ts` files that export an `seed` function that accepts a `sql` instance.

```ts
export async function seed(sql) {
  await sql`
    insert into users ${sql.values({ first_name: "Ryan", last_name: "Allred" })}
    on conflict do nothing
  `.exec();
}
```

## Types

`@synvox/sql` comes with type generation for your queries.

```ts
await types(sql, fileNameToWriteTypes, ["schema_name"]);
```

This will generate a file with types for table rows in the schema. If you don't pass a schema name it will generate types for all schemas.

## Case Transforms

- `sql` will `camelCase` rows from the database
- `sql` will `snake_case` identifiers to the database when used in a helper function

To change this behavior pass `{caseMethod: 'snake' | 'camel' | 'none'}` as the `connect` function's second argument.

## Debugging

This project uses the excellent `debug` library. Run your app with `DEBUG=sql:*` set to see debug logs.

```

```
