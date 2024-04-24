import type { Sql } from "../../src";

export async function seed(sql: Sql) {
  let users = await sql`
    insert into test_migrations.users
    ${sql.values(
      ["Alice", "Bob", "Carol"].map((name) => ({
        first_name: name,
        last_name: "Smith",
      }))
    )}
    returning id
  `.all<{ id: number }>();

  await sql`
    insert into test_migrations.notes
    ${sql.values([
      { body: "Alice's first note", authorId: users[0].id },
      { body: "Alice's second note", authorId: users[0].id },
      { body: "Bob's first note", authorId: users[1].id },
      { body: "Carol's first note", authorId: users[2].id },
    ])}
  `.exec();
}
