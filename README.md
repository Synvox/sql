# `@synvox/sql`

![Travis (.org)](https://img.shields.io/travis/synvox/sql)
![Codecov](https://img.shields.io/codecov/c/github/synvox/sql)

**`sql` is another sql template string library.**

```
npm i @synvox/sql
```

## Basic Example

```ts
import { connect } from "@synvox/sql";
import { Client } from "pg";

const client = new Client(/* ... */); // client from pg
const sql = connect(client);

const user = await sql`
  select * from users where id = ${1}
`.first<User>();

// do something with user
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

**`all`** for getting the rows returned form a query.

```ts
const users = await sql`
  select * from users
`.all<User>();
```

**`first`** for getting the first row returned form a query.

```ts
const user = await sql`
  select * from users
`.first<User>();
```

**`paginate`** for getting the rows returned form a query.

```ts
const users = await sql`
  select * from users
`.paginate<User>(page, 100);
```

## Composing Queries

**Sub queries** can be used to compose queries together.

```ts
sql`select * from table_name where other_id in (${sql`select id from other_table`}`);
```

**`sql.raw`** for building query from a string. This function does not sanitize any inputs so use with care.

```ts
const column = "id";

if (!(column in attributes)) throw new Error("...");

return await sql`select ${sql.raw(column)} from table_name`.many();
```

**Objects**

Objects are converted to a sql equivalent based on the query:

```ts
await sql`
  insert into users ${{ name: "Ryan", active: false }}
`.exec();
// Executes:
// insert into users(name, active) values ($0, $1)
// $0 = "Ryan"
// $1 = false
```

```ts
await sql`
  update users set ${{ name: "Ryan", active: true }}
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
  where ${{ id: 1, active: true }}
`.exec();
// Executes:
// select * from users where (id = $0 and active = $1)
// $0 = 1
// $1 = true
```

**Arrays**

Arrays are converted to comma separated values:

```ts
await sql`
  select *
  from users
  where id in (${[1, 2, 3]})
`.exec();
// Executes:
// select * from users where id in ($0, $1, $2)
// $0 = 1
// $1 = 2
// $2 = 3
```

**Arrays of Objects**

Arrays of Objects are only supported on insert statements:

```ts
await sql`
  insert into users ${[
    { name: "Ryan", active: false },
    { name: "Nolan", active: false },
  ]}
`.exec();
// Executes:
// insert into users(name, active) values ($0, $1), ($2, $3)
// $0 = "Ryan"
// $1 = false
// $2 = "Nolan"
// $3 = false
```

## Nested Resources

Eager load related data using `nest` and `nestFirst` helpers:

```ts
await sql`
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
```

## Transactions

```ts
await sql.transaction(async (sql) => {
  // use sql like normal, commit and rollback are handled for you.
});
```

## Dedicated Connection

`sql` uses a pool to run queries. To get a version of `sql` backed by a `pg.PoolClient` use `connection`.

```ts
await sql.connection(async (sql) => {
  // use sql like normal. Connection is closed after function ends.
});
```

## Compiling queries to strings

To get a sql string representing a query run `compile`.

```ts
// In a migration script
const migration = sql`
insert into users ${{ firstName: "Ryan" }}
`.compile(); // insert into users (first_name) values ('Ryan')
```

## Case Transforms

- `sql` will `camelCase` rows from the database
- `sql` will `snake_case` identifiers to the database when used in a helper function

To change this behavior pass `{caseMethod: 'snake' | 'camel' | 'constant' | 'pascal' | 'none'}` as the `connect` function's second argument.

## Debugging

This project uses the excellent `debug` library. Run your app with `DEBUG=sql:*` set to see debug logs.
