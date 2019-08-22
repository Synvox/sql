# `@synvox/sql`

![Travis (.org)](https://img.shields.io/travis/synvox/sql)
![Codecov](https://img.shields.io/codecov/c/github/synvox/sql)

**`sql` is another sql template string library on node-postgres.**

```
npm i @synvox/sql
```

## Basic Example

```js
import { connect } from '@synvox/sql';

const sql = connect({
  // parameters for the Pool constructor of node-postgres
});

const user = await sql`
  select * from users where id=${1}
`.one();

// do something with user
```

## Executing Queries

**`exec`** for running queries.

```js
await sql`
  create table example (
    id serial primary key
  )
`.exec();
```

**`maybeMany`** for getting the rows returned form a query.

```js
const users = await sql`
  select * from users
`.maybeMany();
```

**`many`** for getting the rows returned form a query but throw when no rows are returned.

```js
const users = await sql`
  select * from users
`.many();
```

**`maybeOne`** for getting the first row returned form a query.

```js
const users = await sql`
  select * from users
`.maybeOne();
```

**`one`** for getting the first row returned form a query and throwing if no rows are returned.

```js
const users = await sql`
  select * from users
`.one();
```

## Query Helpers

**Sub queries** can be used to compose queries together.

```js
sql`select * from table_name where other_id in (${sql`select id from other_table`}`);
```

**`sql.raw`** for building query from a string. This function does not sanitize any inputs so use with care.

```js
const column = 'id';

if (!(column in attributes)) throw new Error('...');

return await sql`select ${sql.raw(column)} from table_name`.many();
```

**`sql.insertValues`** for inserting data into a table

```js
sql`
  insert into table_name ${sql.insertValues({ key1: value2, key2: value2 })}
`.exec();
```

**`sql.setValues`** for updating data into a table

```js
sql`
  update table_name
  set ${sql.setValues({ key: value })}
  where value=${something}
`.exec();
```

**`sql.cond`** for conditionally combining queries together

```js
sql`
  select * from table_name
  ${cond(showDeleted, sql`where deleted_at is not null`)}
`.exec();
```

**`where`, `andWhere`, `orWhere`, `andWhereNot`, `orWhereNot`, `andWhereOr`** for building a where clause from an object.

```js
sql`select * from users ${sql.where({ active: true, orgId: 123 })}`;
```

## Transactions

```js
await sql.transaction(async sql => {
  // use sql like normal, commit and rollback are handled for you.
});
```

## Dedicated Connection

`sql` uses a pool to run queries. To get a version of `sql` backed by a `pg.PoolClient` use `connection`.

```js
await sql.connection(async sql => {
  // use sql like normal. Connection is closed after function ends.
});
```

## Compiling queries to strings

To get a sql string representing a query run `compile`.

```js
// In a migration script
const migration = sql`
insert into users ${sql.insertValues({ firstName: 'Ryan' })}
`.compile(); // insert into users (first_name) values ('Ryan')
```

## Closing the Pool

```js
await sql.end();
```

## Case Transforms

- `sql` will `camelCase` rows from the database
- `sql` will `snake_case` identifiers to the database when used in a helper function

To change this behavior pass `{caseMethod: 'snake' | 'camel' | 'constant' | 'pascal' | 'none'}` as the `connect` function's second argument.

## Debugging

This project uses the excellent `debug` library. Run your app with `DEBUG=sql:*` set to see debug logs.
