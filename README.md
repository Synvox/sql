# `@synvox/sql`

**`sql` is another SQL template string library**

```bash
npm i @synvox/sql
```

---

## Setting up for your client

`@synvox/sql` does not depend on a specific SQL client. You need to implement the `Pool`, `PoolClient`, and `Client` interfaces (exported from `@synvox/sql`) to use the library with the database drivers of your choice. Below is an example using `pg`:

```ts
import { connect, Pool, PoolClient, Client } from "@synvox/sql";
import * as pg from "pg";

// Example Pool implementation
class MyPool extends Pool {
  client: pg.Pool;

  constructor() {
    super();
    this.client = new pg.Pool();
  }

  query(query: string, values: any[]) {
    return this.client.query(query, values);
  }

  async isolate() {
    const pgClient = await this.client.connect();
    return new MyPoolClient(pgClient);
  }
}

// Example PoolClient implementation
class MyPoolClient extends PoolClient {
  client: pg.PoolClient;

  constructor(client: pg.PoolClient) {
    super();
    this.client = client;
  }

  query(query: string, values: any[]) {
    return this.client.query(query, values);
  }

  async release() {
    this.client.release();
  }
}

// Example Client implementation (no pooling)
class MyClient extends Client {
  client: pg.Client;

  constructor() {
    super();
    this.client = new pg.Client();
  }

  async query(query: string, values: any[]) {
    return this.client.query(query, values);
  }
}

// Creating a connection using pooling:
const sql = connect(new MyPool());

// or if you don't need pooling:
const sql2 = connect(new MyClient());
```

---

## Executing Queries

### `exec()`

Use **`exec`** to run queries that do not need to return rows or for multi-statement execution:

```ts
await sql`
  create table example (
    id serial primary key
  )
`.exec();
```

### `all()`

Use **`all`** to get the rows returned from a query:

```ts
let users = await sql`
  select * from users
`.all<User>();
```

### `first()`

Use **`first`** to get the first row returned from a query:

```ts
let user = await sql`
  select * from users
`.first<User>();
```

### `exists()`

Use **`exists`** to quickly check if any rows match a condition:

```ts
let runJobs = await sql`
  select *
  from jobs
  where run_at < now()
  limit 1
`.exists();
```

### `paginate()`

Use **`paginate`** to limit and offset results:

```ts
let users = await sql`
  select * from users
`.paginate<User>({ page: 0, per: 100 });
```

_This wraps your query like:_

```sql
select paginated.* from ( ... ) paginated limit ? offset ?
```

---

## Composing Queries

### Subqueries

Compose queries together with subqueries:

```ts
let subQuery = sql`select id from other_table`;

await sql`
  select *
  from table_name
  where other_id in (${subQuery})
`.all();
```

### Query Builders

```ts
await sql`
  insert into users ${sql.values({ name: "Ryan", active: false })}
`.exec();
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
`.all();
// select * from users where (id = $0 and active = $1)
// $0 = 1
// $1 = true
```

```ts
await sql`
  select *
  from users
  where ${sql.or({ id: 1, active: true })}
`.all();
// select * from users where (id = $0 or active = $1)
// $0 = 1
// $1 = true
```

---

### Arrays

Convert arrays into a comma-separated list:

```ts
await sql`
  select *
  from users
  where id in (${sql.array([1, 2, 3])})
`.exec();
// select * from users where id in ($0, $1, $2)
// $0 = 1
// $1 = 2
// $2 = 3
```

---

### References

Use **`sql.ref`** to reference a column or table:

```ts
await sql`
  select ${sql.ref("users.id")}
  from users
`.all();
```

---

### Join

The signature for `join` is:

```ts
join(delimiter: SqlFragment, [first, ...rest]: SqlFragment[]): SqlFragment
```

So, the **delimiter** is the first parameter, and the **array of fragments** is the second parameter:

```ts
await sql`
  select ${sql.join(sql`, `, [sql`users.id`, sql`users.name`])}
  from users
`.all();
// select users.id, users.name from users
```

---

### Literals

Use **`sql.literal`** for direct literal insertion:

```ts
await sql`
  insert into points (location)
  values (${sql.literal([100, 100])})
`.exec();
```

---

## Transactions

`@synvox/sql` supports two transaction helpers:

1. **`sql.transaction`** – Retries on deadlock. Use this for queries that affect only the database.
2. **`sql.impureTransaction`** – Does **not** retry on deadlock by default. Use this if the transaction has side effects outside of the database.

```ts
await sql.transaction(async (trxSql) => {
  // Use trxSql like normal. Commit and rollback are handled for you.
  // If an error is thrown, the transaction will be rolled back.
});
```

---

## Dedicated Connection

Use **`sql.connection`** if you need a dedicated connection (via your `PoolClient`) for a set of queries:

```ts
await sql.connection(async (sql) => {
  // This block uses a dedicated connection.
  await sql`select pg_sleep(1)`.exec();
});
// Connection is automatically released afterward.
```

---

## Previewing Queries

You can preview a query string by calling **`preview`**:

```ts
let migration = sql`
  insert into users ${sql.values({ firstName: "Ryan" })}
`.preview();

// => insert into users (first_name) values ('Ryan')
```

---

## Migrations

If you’ve installed the optional migration helpers (or have your own system), you can run migrations with something like:

```ts
import { migrate } from "@synvox/sql/migrate"; // Hypothetical import

// Where directoryName is the path to your migration files:
await migrate(sql, directoryName);
```

A migration file might look like:

```ts
// migrations/001-create-users.ts

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

> **Note**: Migrations in `@synvox/sql` do not currently support “down” migrations.

---

## Seeds

Similarly, if you have the optional seed helpers:

```ts
import { seed } from "@synvox/sql/seed"; // Hypothetical import

await seed(sql, directoryName);
```

A seed file might look like:

```ts
// seeds/001-insert-default-users.ts

export async function seed(sql) {
  await sql`
    insert into users ${sql.values({ first_name: "Ryan", last_name: "Allred" })}
    on conflict do nothing
  `.exec();
}
```

---

## Types

If you’re using the optional type generator:

```ts
import { types } from "@synvox/sql/types"; // Hypothetical import

await types(sql, fileNameToWriteTypes, ["schema_name"]);
```

This will generate a file containing interfaces for each table in the schema. If you omit `["schema_name"]`, it will generate types for all schemas.

---

## Case Transforms

By default:

- Rows from the database are **`camelCased`**.
- Identifiers passed through the helper functions (like `sql.values` or `sql.set`) are **`snake_cased`** in the database.

To change this behavior, call `connect` with a `caseMethod` option:

```ts
const sql = connect(new MyPool(), {
  caseMethod: "none", // or 'snake' | 'camel'
});
```

---

## Debugging

This project uses the `debug` library. To see debug logs, run your app with:

```bash
DEBUG=sql:* node yourApp.js
```

You’ll see logs for queries, transaction attempts, and errors.
