import type { Sql } from "../../../../src";

export async function up(sql: Sql) {
  await sql`
    create table test_migrations.users (
      id serial primary key,
      first_name text not null,
      last_name text not null
    );
  `.exec();

  await sql`
    insert into test_migrations.users
    ${sql.values(
      ["Alice", "Bob", "Carol"].map((name) => ({
        first_name: name,
        last_name: "Smith",
      }))
    )}
  `.exec();
}
