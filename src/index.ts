import Debug from "debug";
import type { Pool, PoolClient, QueryResult } from "pg";
import { Client } from "pg";
import { caseMethods, transformKey, transformKeys } from "./case";
import { ZodSchema, array } from "zod";

const { escapeLiteral, escapeIdentifier } = Client.prototype;

const debugQuery = Debug("sql:query");
const debugBinding = Debug("sql:binding");
const debugTransaction = Debug("sql:transaction");
const debugError = Debug("sql:error");

const statementWeakSet = new WeakSet<Statement>();
const cteWeakSet = new WeakSet<CTE>();

export function isStatement(anything: any): anything is Statement {
  return anything && statementWeakSet.has(anything);
}

export function isCTE(anything: any): anything is CTE {
  return anything && cteWeakSet.has(anything);
}

export function cte<Name extends string>(
  name: Name,
  statement: Statement,
  options: { mode?: "materialized" | "not materialized" } = {}
) {
  const dep = { name, statement, options };
  cteWeakSet.add(dep);
  return dep;
}

type Value = any;

type InterpolatedValue =
  | Value
  | (Value | StatementState)[]
  | Record<string, Value | StatementState>
  | Record<string, Value | StatementState>[]
  | StatementState;

interface StatementState {
  text: string;
  values: Value[];
  ctes: CTE[];
}

export interface Statement extends StatementState {
  toNative: () => { text: string; values: Value[] };
  exec: () => Promise<QueryResult>;
  execRaw: (opt: {
    areYouSureYouKnowWhatYouAreDoing: true;
  }) => Promise<QueryResult>;
  nestAll: () => Statement;
  nestFirst: () => Statement;
  paginate: <T>(options?: {
    page?: number;
    per?: number;
    schema?: ZodSchema<T>;
  }) => Promise<T[]>;
  all: <T>(schema?: ZodSchema<T>) => Promise<T[]>;
  first: <T>(schema?: ZodSchema<T>) => Promise<T>;
  compile: () => string;
}

type CTE = ReturnType<typeof cte>;

type Options = {
  caseMethod: "snake" | "camel" | "constant" | "pascal" | "none";
  depth: number;
};

type AcceptableClient = Client | Pool | PoolClient;

export function connect(
  client: AcceptableClient,
  options: Options = {
    caseMethod: "snake",
    depth: 0,
  }
) {
  return makeSql(client, { ...options, depth: 0 });
}

function makeSql(
  client: AcceptableClient,
  options: Options = {
    caseMethod: "snake",
    depth: 0,
  }
) {
  const caseMethodFromDb = caseMethods["camel"];
  const caseMethodToDb = caseMethods[options.caseMethod];

  const sanitizeIdentifier = (key: string) =>
    escapeIdentifier(transformKey(key, caseMethodToDb));

  function Statement(
    state: StatementState,
    queryClient: AcceptableClient = client
  ): Statement {
    const builder = Object.assign({}, state, {
      toNative() {
        let values: any[] = [];

        let text = state.text;
        if (Object.keys(state.ctes).length) {
          let ctes: CTE[] = [];

          let walk = (dep: CTE) => {
            const preexisting = ctes.find((v) => v.name === dep.name);
            if (!preexisting) {
              ctes.push(dep);
            } else if (preexisting.statement.text !== dep.statement.text) {
              throw new Error(`Conflicting cte name: ${dep.name}`);
            }

            dep.statement.ctes.forEach(walk);
          };
          state.ctes.forEach(walk);

          text = `with ${ctes
            .map((cte) => {
              const { mode } = cte.options;
              const { text, values: v } = cte.statement;
              const key = cte.name;
              const pragma = mode ? `${mode} ` : "";
              values.push(...v);

              return `${key} as ${pragma}(${text})`;
            })
            .join(", ")} (${state.text})`;
        }

        values.push(...state.values);
        const segments = text.split(/\?/i);
        text = segments
          .map((segment, index) => {
            if (index + 1 === segments.length) return segment;
            return `${segment}$${index + 1}`;
          })
          .join("")
          .replace(/(\s)+/g, " ")
          .trim();

        return {
          text,
          values,
        };
      },
      async exec() {
        const { text, values } = builder.toNative();

        debugQuery(text);
        debugBinding(values);
        try {
          const result = await queryClient.query({ text, values });
          return result;
        } catch (e) {
          debugError("Query failed: ", this.compile());
          throw e;
        }
      },
      async execRaw({ areYouSureYouKnowWhatYouAreDoing = false } = {}) {
        if (!areYouSureYouKnowWhatYouAreDoing)
          throw new Error(
            "You must pass {areYouSureYouKnowWhatYouAreDoing: true} to this function to execute it without parameters"
          );

        const text = this.compile();

        debugQuery(text);
        try {
          const result = await queryClient.query({ text });
          return result;
        } catch (e) {
          debugError("Query failed: ", text);
          throw e;
        }
      },
      nestAll() {
        return sql`coalesce((select jsonb_agg(subquery) as nested from (${builder}) subquery), '[]'::jsonb)`;
      },
      nestFirst() {
        return sql`(select row_to_json(subquery) as nested from (${builder}) subquery limit 1)`;
      },
      async all<T>(schema?: ZodSchema<T>) {
        const result = await this.exec();
        if (typeof result.rows === "undefined")
          throw new Error('Multiple statements in query, use "exec" instead.');

        const items = transformKeys(result.rows, caseMethodFromDb);

        if (schema) return array(schema).parse(items);
        return items as T[];
      },
      async paginate<T>({
        page = 0,
        per = 250,
        schema,
      }: {
        page?: number;
        per?: number;
        schema?: ZodSchema<T>;
      } = {}) {
        page = Math.max(0, page);

        const dep: CTE = cte("paginated", builder, {
          mode: "not materialized",
        });

        const paginated = sql`
          select paginated.* from ${dep} limit ${per} offset ${page * per}
        `;

        return paginated.all<T>(schema);
      },
      async first<T>(schema?: ZodSchema<T>) {
        const result = await this.all<T>();
        const item = result[0];
        if (schema) return schema.parse(item);
        return item as T;
      },
      compile() {
        const { text, values } = this.toNative();
        return text.replace(/\$\d/g, () =>
          escapeLiteral(String(values.shift()))
        );
      },
    });

    statementWeakSet.add(builder);

    return builder;
  }

  function unboundSql(
    strings: TemplateStringsArray,
    ...values: InterpolatedValue[]
  ): Statement {
    let state: StatementState = {
      text: "",
      values: [],
      ctes: [],
    };

    const toStatement = (value: InterpolatedValue) => {
      if (isStatement(value)) {
        return value;
      } else {
        const statement = Statement({
          text: "?",
          values: [value],
          ctes: [],
        });
        return statement;
      }
    };

    for (let index = 0; index < strings.length; index++) {
      const item = strings[index];
      state.text += item;

      // last item
      if (!(index in values)) {
        continue;
      }

      let arg = values[index];

      if (arg === undefined)
        throw new Error("undefined cannot be interpolated");

      if (typeof arg !== "object" || arg === null || arg instanceof Date)
        arg = toStatement(arg);

      if (isStatement(arg)) {
        state.text += arg.text;
        state.values.push(...arg.values);
        for (let dep of arg.ctes) {
          state.ctes.push(dep);
        }
      }

      // CTEs
      else if (isCTE(arg)) {
        for (let dep of arg.statement.ctes) {
          state.ctes.push(dep);
        }
        state.ctes.push(arg);
        state.text += arg.name;
      }

      // arrays
      else if (Array.isArray(arg) && typeof arg[0] !== "object") {
        const list = arg as Value[];
        state.text += list
          .map((item) => {
            const statement = toStatement(item);
            state.values.push(...statement.values);
            return statement.text;
          })
          .join(",");
      }

      // special query type interpolations
      else {
        const whereIndex = state.text.lastIndexOf("where");
        const insertIndex = state.text.lastIndexOf(
          "insert",
          whereIndex < 0 ? undefined : whereIndex
        );
        const updateIndex = state.text.lastIndexOf(
          "update",
          Math.max(insertIndex, whereIndex) < 0
            ? undefined
            : Math.max(insertIndex, whereIndex)
        );

        const isInsert = insertIndex > whereIndex && insertIndex > updateIndex;
        const isUpdate =
          !isInsert && updateIndex > whereIndex && updateIndex > insertIndex;
        const isWhere = !isInsert && !isUpdate;

        // arrays of objects
        if (
          Array.isArray(arg) &&
          typeof arg[0] === "object" &&
          arg[0] !== null
        ) {
          if (isInsert) {
            const arr = arg as Record<string, Value>[];
            // (key1, key2) values (value1, value2)
            state.text += "(";
            state.text += Object.keys(arr[0])
              .map((key) => sanitizeIdentifier(key))
              .join(", ");
            state.text += ") values ";
            state.text += arr
              .map((obj) => {
                let text = "(";
                const values = Object.values(obj).map((value) =>
                  toStatement(value)
                );

                text += values
                  .map((v) => {
                    state.values.push(...v.values);
                    return v.text;
                  })
                  .join(",");

                text += ")";
                return text;
              })
              .join(",");
          }
        }

        // objects
        else if (typeof arg === "object" && arg !== null) {
          const obj = Object.fromEntries(
            Object.entries(arg).map(([key, value]) => [
              sanitizeIdentifier(key),
              toStatement(value),
            ])
          );

          if (isInsert) {
            // (key1, key2) values (value1, value2)
            state.text += "(";
            state.text += Object.keys(obj).join(", ");
            state.text += ") values (";
            state.text += Object.entries(obj)
              .map(([_, val]) => {
                state.values.push(...val.values);
                return val.text;
              })
              .join(", ");
            state.text += ")";
          } else if (isUpdate) {
            // key1 = value1, key2 = value2
            state.text += Object.entries(obj)
              .map(([key, val]) => {
                state.values.push(...val.values);
                return `${key} = ${val.text}`;
              })
              .join(", ");
          } else if (isWhere) {
            // key1 = value1 and key2 = value2
            state.text += "(";
            if (Object.keys(obj).length === 0) state.text += "true";
            else
              state.text += Object.entries(obj)
                .map(([key, value]) => {
                  const isNull =
                    value.values[0] === null && value.values.length === 1;
                  if (isNull) return `${key} is null`;
                  else {
                    state.values.push(...value.values);
                    return `${key} = ${value.text}`;
                  }
                })
                .join(" and ");
            state.text += ")";
          }
        }
      }
    }

    return Statement(state);
  }

  let txId = 0;
  async function transaction<T>(caller: (trxSql: Sql) => Promise<T>) {
    const isTopLevel = options.depth === 0;
    const createNewConnection = isTopLevel && !(client instanceof Client);
    const trxClient = createNewConnection
      ? ((await client.connect()) as PoolClient)
      : client;

    txId++;
    if (txId > Number.MAX_VALUE) txId = 0;

    const beginStmt = isTopLevel ? "begin" : `savepoint tx${txId}`;

    const rollbackStmt = isTopLevel
      ? "rollback"
      : `rollback to savepoint tx${txId}`;

    debugTransaction(beginStmt, `(tx${txId})`);
    trxClient.query(beginStmt);
    const sql = makeSql(trxClient, { ...options, depth: options.depth + 1 });

    try {
      const result = await caller(sql);

      if (isTopLevel) {
        debugTransaction("commit", `(tx${txId})`);
        await trxClient.query("commit");
      }

      return result;
    } catch (e) {
      debugTransaction(rollbackStmt, `(tx${txId})`);
      trxClient.query(rollbackStmt);
      throw e;
    } finally {
      if (createNewConnection) (trxClient as PoolClient).release();
    }
  }

  async function connection<T>(caller: (sql: Sql) => Promise<T>) {
    const isTopLevel = options.depth === 0;
    const createNewConnection = isTopLevel && !(client instanceof Client);
    const connectionClient = createNewConnection
      ? ((await client.connect()) as PoolClient)
      : client;

    const sql = makeSql(connectionClient, {
      ...options,
      depth: options.depth + 1,
    });

    try {
      const result = await caller(sql);
      return result;
    } finally {
      if (createNewConnection) (connectionClient as PoolClient).release();
    }
  }

  const sql = Object.assign(unboundSql, {
    transaction,
    connection,
    ref: (identifier: string) =>
      Statement({
        text: escapeIdentifier(identifier),
        values: [],
        ctes: [],
      }),
    join: (delimiter: Statement, [first, ...statements]: Statement[]) =>
      statements.reduce((acc, item) => sql`${acc} ${delimiter} ${item}`, first),
    literal: (value: any) =>
      Statement({ text: "?", values: [value], ctes: [] }),
  });

  return sql;
}

type Sql = ReturnType<typeof connect>;
