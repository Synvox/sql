import Debug from "debug";
import { Client, Pool, PoolClient, QueryResult } from "pg";
import { caseMethods, transformKey, transformKeys } from "./case";

const { escapeLiteral, escapeIdentifier } = Client.prototype;

const debugQuery = Debug("sql:query");
const debugBinding = Debug("sql:binding");
const debugTransaction = Debug("sql:transaction");
const debugError = Debug("sql:error");

const statementWeakSet = new WeakSet<Statement>();
const dependencyWeakSet = new WeakSet<Dependency>();

export function isStatement(anything: any): anything is Statement {
  return anything && statementWeakSet.has(anything);
}

export function isDependency(anything: any): anything is Dependency {
  return anything && dependencyWeakSet.has(anything);
}

export function dependency<Name extends string>(
  name: Name,
  statement: Statement,
  options: { mode?: "materialized" | "not materialized" } = {}
) {
  const dep = { name, statement, options };
  dependencyWeakSet.add(dep);
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
  dependents: Dependency[];
}

interface Statement extends StatementState {
  toNative: () => { text: string; values: Value[] };
  exec: () => Promise<QueryResult>;
  paginate: (page?: number, per?: number) => Promise<unknown[]>;
  nestAll: () => Statement;
  nestFirst: () => Statement;
  all: <T>() => Promise<T[]>;
  first: <T>() => Promise<T | undefined>;
  compile: () => string;
}

type Dependency = ReturnType<typeof dependency>;

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
        if (Object.keys(state.dependents).length) {
          let dependents: Dependency[] = [];

          let walk = (dep: Dependency) => {
            const preexisting = dependents.find((v) => v.name === dep.name);
            if (!preexisting) {
              dependents.push(dep);
            } else if (preexisting.statement.text !== dep.statement.text) {
              throw new Error(`Conflicting dependency name: ${dep.name}`);
            }

            dep.statement.dependents.forEach(walk);
          };
          state.dependents.forEach(walk);

          text = `with ${dependents
            .map((dependency) => {
              const { mode } = dependency.options;
              const { text, values: v } = dependency.statement;
              const key = dependency.name;
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
      async paginate(page: number = 0, per: number = 250) {
        page = Math.max(0, page);

        const dep: Dependency = dependency("paginated", builder, {
          mode: "not materialized",
        });

        const paginated = sql`
          select paginated.* from ${dep} limit ${per} offset ${page * per}
        `;

        return paginated.all();
      },
      nestAll() {
        return sql`coalesce((select jsonb_agg(subquery) as nested from (${builder}) subquery), '[]'::jsonb)`;
      },
      nestFirst() {
        return sql`(select row_to_json(subquery) as nested from (${builder}) subquery limit 1)`;
      },
      async all<T>() {
        const result = await this.exec();
        return transformKeys(result.rows, caseMethodFromDb) as T[];
      },
      async first<T>() {
        const result = await this.all<T>();
        return result[0];
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
      dependents: [],
    };

    const toStatement = (value: InterpolatedValue) => {
      if (isStatement(value)) {
        return value;
      } else {
        const statement = Statement({
          text: "?",
          values: [value],
          dependents: [],
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
        for (let dep of arg.dependents) {
          state.dependents.push(dep);
        }
      }

      // dependencies
      else if (isDependency(arg)) {
        for (let dep of arg.statement.dependents) {
          state.dependents.push(dep);
        }
        state.dependents.push(arg);
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
        dependents: [],
      }),
    literal: (value: any) =>
      Statement({ text: "?", values: [value], dependents: [] }),
  });

  return sql;
}

type Sql = ReturnType<typeof connect>;
