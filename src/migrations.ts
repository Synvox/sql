import fs from "fs";
import path from "path";
import { singular } from "pluralize";
import type { Sql } from ".";

let regex = /^\d+_[^.]*\.(js|ts|mjs|cjs)$/;

export async function migrate(sql: Sql, directory: string) {
  await setup(sql);

  let files = Object.fromEntries(
    await Promise.all(
      (await fs.promises.readdir(directory))
        .filter((file) => regex.test(file))
        .sort((a, b) => parseInt(a.split("_")[0]) - parseInt(b.split("_")[0]))
        .map(async (file) => [file, await import(path.join(directory, file))])
    )
  ) as Record<string, { up?: (sql: Sql) => Promise<void> }>;

  let count = await sql.transaction(async (sql) => {
    await sql`lock table migrations.migrations`.exec();

    let migrations = await sql`
      select name from migrations.migrations
    `.all<{ name: string }>();

    let missing = migrations.filter((migration) => !files[migration.name]);
    if (missing.length > 0) {
      throw new Error(
        `A migration is missing from the filesystem: ${missing
          .map((x) => x.name)
          .join(", ")}`
      );
    }

    let { maxBatch = 0 } = await sql`
      select max(batch) as max_batch from migrations.migrations
    `.first<{ maxBatch?: number }>();

    let toMigrate = Object.fromEntries(
      Object.entries(files).filter(([file, { up }]) => {
        return (
          typeof up === "function" &&
          !migrations.find((migration) => migration.name === file)
        );
      })
    );

    let batch = maxBatch + 1;

    if (Object.keys(toMigrate).length !== 0) {
      await sql`
        insert into migrations.migrations
        ${sql.values(
          Object.entries(toMigrate).map(([file]) => ({
            name: file,
            batch,
          }))
        )}
      `.exec();

      for (let [file, { up }] of Object.entries(toMigrate)) {
        if (typeof up !== "function") {
          throw new Error(
            `expected ${file} to have a export a migrate function`
          );
        }

        await up(sql);
      }
    }

    return Object.keys(toMigrate).length;
  });

  console.log(`Migrated ${count} file${count === 1 ? "" : "s"}`);
}

export async function seed(sql: Sql, directory: string) {
  await setup(sql);

  let files = Object.fromEntries(
    await Promise.all(
      (await fs.promises.readdir(directory))
        .filter((file) => regex.test(file))
        .sort((a, b) => parseInt(a.split("_")[0]) - parseInt(b.split("_")[0]))
        .map(async (file) => [file, await import(path.join(directory, file))])
    )
  ) as Record<string, { seed?: (sql: Sql) => Promise<void> }>;

  let count = await sql.transaction(async (sql) => {
    await sql`lock table migrations.migrations`.exec();

    for (let [file, { seed }] of Object.entries(files)) {
      if (typeof seed !== "function") {
        throw new Error(`expected ${file} to have a export a seed function`);
      }

      await seed(sql);
    }

    return Object.keys(files).length;
  });

  console.log(`Seeded ${count} file${count === 1 ? "" : "s"}`);
}

export type TypeOptions = {
  typeMap?: Record<string, string>;
};

export async function types(
  sql: Sql,
  outfile: string,
  schemaNames?: string[],
  options?: TypeOptions
) {
  let tables = await sql`
    select
      table_schema,
      table_name,
      json_agg(
        json_build_object(
          'column_name', column_name,
          'data_type', data_type,
          'is_nullable', is_nullable
        )
      ) as columns
    from (
      select
        table_schema,
        table_name,
        column_name,
        data_type,
        case when is_nullable = 'YES' then true else false end as is_nullable,
        ordinal_position
      from information_schema.columns
      where table_schema ${
        schemaNames
          ? sql`in (${sql.join(
              sql`, `,
              schemaNames.map((s) => sql`${s}`)
            )})`
          : sql`not in ('information_schema', 'pg_catalog')`
      }
      order by table_schema, table_name, ordinal_position
    ) x
    group by table_schema, table_name
  `.all<{
    tableSchema: string;
    tableName: string;
    columns: {
      columnName: string;
      dataType: string;
      isNullable: string;
    }[];
  }>();

  let types: string[] = [];

  let capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  for (let table of tables) {
    let name = capitalize(singular(sql.identifierFromDb(table.tableName)));
    let tableType = "";
    tableType += `export type ${name} = {\n`;
    for (let column of table.columns) {
      let type = postgresTypesToJSONTsTypes(column.dataType, options);
      tableType += `  ${sql.identifierFromDb(column.columnName)}: ${type}${
        column.isNullable ? " | null" : ""
      };\n`;
    }
    tableType += `}`;
    types.push(tableType);
  }

  let oldContent = await fs.promises.readFile(outfile, "utf8").catch(() => "");
  let newContent = types.join("\n\n") + "\n";

  if (oldContent !== newContent) {
    await fs.promises.writeFile(outfile, newContent, "utf8");
  }
}

async function setup(sql: Sql) {
  await sql`
    create schema if not exists migrations;

    create table if not exists migrations.migrations (
      id serial primary key,
      name text not null,
      batch int not null,
      migrated_at timestamp not null default now()
    )
  `.exec();

  return { sql };
}

function postgresTypesToJSONTsTypes(type: string, options: TypeOptions = {}) {
  let { typeMap = {} } = options;
  if (typeMap[type]) {
    return typeMap[type];
  }

  switch (type) {
    case "timestamp with time zone":
    case "timestamp without time zone":
    case "date":
    case "timestamp":
    case "timestamptz":
      return "Date";
    case "bpchar":
    case "char":
    case "varchar":
    case "text":
    case "citext":
    case "uuid":
    case "inet":
    case "time":
    case "timetz":
    case "interval":
    case "name":
    case "character varying":
    case "int8":
    case "bigint":
      return "string";
    case "int2":
    case "int4":
    case "float4":
    case "float8":
    case "numeric":
    case "money":
    case "oid":
    case "int":
    case "integer":
      return "number";
    case "bool":
    case "boolean":
      return "boolean";
    case "json":
    case "jsonb":
    case "bytea":
      return "any";
    default:
      return "any";
  }
}
