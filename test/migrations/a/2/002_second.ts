import type { Sql } from "../../../../src";

export async function up(sql: Sql) {
  await sql`
    create table test_migrations.notes (
      id serial primary key,
      body text not null,
      author_id int not null references test_migrations.users(id),
      created_at timestamp not null default now()
    );
  `.exec();

  await sql`
    insert into test_migrations.notes
    ${sql.values([
      { body: "Alice's first note", authorId: 1 },
      { body: "Alice's second note", authorId: 1 },
      { body: "Bob's first note", authorId: 2 },
      { body: "Carol's first note", authorId: 3 },
    ])}
  `.exec();
}
