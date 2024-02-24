import type { Sql } from "../../../src";

export async function up(sql: Sql) {
  await sql`
    create table test_migrations.users (
      id serial primary key,
      first_name text not null,
      last_name text not null
    );
  `.exec();

  await sql`
    create table test_migrations.notes (
      id serial primary key,
      body text not null,
      author_id int not null references test_migrations.users(id),
      created_at timestamp not null default now()
    );
  `.exec();
}
