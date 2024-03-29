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

**`all`** for getting the rows returned from a query.

```ts
const users = await sql`
  select * from users
`.all<User>();
```

**`first`** for getting the first row returned from a query.

```ts
const user = await sql`
  select * from users
`.first<User>();
```

**`paginate`** for getting the rows returned from a query.

```ts
const users = await sql`
  select * from users
`.paginate<User>(page, 100);
```

Note: `paginate` will wrap your query in a `select q.* from (...) q limit ? offset ?` query.

## Composing Queries

**Sub queries** can be used to compose queries together.

```ts
sql`select * from table_name where other_id in (${sql`select id from other_table`}`);
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

**References**

If you need to reference a column in a query you can use `sql.ref`:

```ts
await sql`
  select ${sql.ref("users.id")}
  from users
`.all();
```

**Raw Values**

Use `sql.raw` for building query from a string. This function does not sanitize any inputs so use with care. You probably want to use `sql.ref` instead.

```ts
const column = "id";

if (!(column in attributes)) throw new Error("...");

return await sql`select ${sql.raw(column)} from table_name`.many();
```

**Join**

If you need to join values in a query you can use `sql.join`:

```ts
await sql`
  select ${sql.join(["users.id", "users.name"], ", ")}
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

## Nested Resources

Eager load related data using `nestAll` and `nestFirst` helpers:

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
    `.nestAll()} as liked_posts
  from test.users
  where users.id = ${user.id}
`.first();
```

## Shared Policies

Shared Policies can be used to share common logic between queries. Policies are functions that take a context and return a query. Policies can be used in other policies. Under the hood policies are functions that return a standard query.

```ts
async function users(ctx) {
  const team = await getTeam(ctx);
  return sql`
    select *
    from users
    where team_id = ${team.id}
    and deleted_at is null
  `;
}

async function projects(ctx) {
  const team = await getTeam(ctx);
  return sql`
    select *
    from projects
    where team_id = ${team.id}
  `;
}

const projects = await sql`
  select
    projects.*
    ${sql`
      select users.email
      from (${await users(ctx)}) users
      where projects.user_id = users.id
    `} as contact_email
  from (${await projects(ctx)}) projects
`;
```

Queries are inlined when used in other queries:

```sql
select
  projects.*,
  (
    select users.email
    from (
      select *
      from users
      where team_id = $1
      and deleted_at is null
    ) users
    where projects.user_id = users.id
  ) as contact_email
from (
  select *
  from projects
  where team_id = $2
) projects
```

## Transactions

```ts
await sql.transaction(async (sql) => {
  // use sql like normal, commit and rollback are handled for you.
  // if an error is thrown the transaction will be rolled back.
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
