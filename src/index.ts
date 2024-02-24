import Debug from "debug";
import type { Pool, PoolClient, QueryResult } from "pg";
import { Client } from "pg";
import { caseMethods, transformKey, transformKeys } from "./case";

export { migrate, seed, types } from "./migrations";
export { connect, isStatement };
export type { Statement, Sql };

const { escapeLiteral, escapeIdentifier } = Client.prototype;

const debugQuery = Debug("sql:query");
const debugBinding = Debug("sql:binding");
const debugTransaction = Debug("sql:transaction");
const debugError = Debug("sql:error");

const statementWeakSet = new WeakSet<Statement>();

function isStatement(anything: any): anything is Statement {
  return anything && statementWeakSet.has(anything);
}

type Value = any;

type InterpolatedValue =
  | number
  | string
  | boolean
  | Date
  | StatementState
  | null;

interface Sql {
  (strings: TemplateStringsArray, ...values: InterpolatedValue[]): Statement;
  transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  connection<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  ref(identifier: string): Statement;
  raw(text: any): Statement;
  literal(value: any): Statement;
  join(delimiter: Statement, statements: Statement[]): Statement;
  array<T extends InterpolatedValue>(values: T[]): Statement;
  values<T extends Record<string, InterpolatedValue>>(
    values: T[] | T
  ): Statement;
  set<T extends Record<string, InterpolatedValue>>(values: T): Statement;
  and<T extends Record<string, InterpolatedValue>>(values: T): Statement;
  or<T extends Record<string, InterpolatedValue>>(values: T): Statement;
  identifierFromDb: (key: string) => string;
  identifierToDb: (key: string) => string;
}

interface StatementState {
  text: string;
  values: Value[];
}

interface Statement extends StatementState {
  toNative: () => { text: string; values: Value[] };
  exec: () => Promise<QueryResult>;
  execRaw: (opt: {
    areYouSureYouKnowWhatYouAreDoing: true;
  }) => Promise<QueryResult>;
  nestAll: () => Statement;
  nestFirst: () => Statement;
  paginate: <T>(options?: { page?: number; per?: number }) => Promise<T[]>;
  all: <T>() => Promise<T[]>;
  first: <T>() => Promise<T>;
  exists: () => Promise<boolean>;
  compile: () => string;
}

type Options = {
  caseMethod: "snake" | "camel" | "constant" | "pascal" | "none";
  depth: number;
};

type AcceptableClient = Client | Pool | PoolClient;

function connect(
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
      async all<T>() {
        const result = await this.exec();
        if (typeof result.rows === "undefined")
          throw new Error('Multiple statements in query, use "exec" instead.');

        const items = transformKeys(result.rows, caseMethodFromDb);

        return items as T[];
      },
      async paginate<T>({
        page = 0,
        per = 250,
      }: {
        page?: number;
        per?: number;
      } = {}) {
        page = Math.max(0, page);

        const paginated = sql`
          select paginated.*
          from (${builder}) paginated
          limit ${per}
          offset ${page * per}
        `;

        return paginated.all<T>();
      },
      async first<T>() {
        const result = await this.all<T>();
        const item = result[0];
        return item as T;
      },
      async exists() {
        const result = await this.all();
        return result.length > 0;
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
    };

    const toStatement = (value: InterpolatedValue) => {
      if (isStatement(value)) {
        return value;
      } else {
        const statement = Statement({
          text: "?",
          values: [value],
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
        throw new Error("cannot bind undefined value to query");

      if (typeof arg !== "object" || arg === null || arg instanceof Date)
        arg = toStatement(arg);

      if (isStatement(arg)) {
        state.text += arg.text;
        state.values.push(...arg.values);
      } else {
        throw new Error("invalid value in query: " + JSON.stringify(arg));
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

  const sql: Sql = Object.assign(unboundSql, {
    transaction,
    connection,
    ref: (identifier: string) =>
      Statement({
        text: escapeIdentifier(identifier),
        values: [],
      }),
    raw: (text: string) =>
      Statement({
        text,
        values: [],
      }),
    literal: (value: any) => Statement({ text: "?", values: [value] }),
    join: (delimiter: Statement, [first, ...statements]: Statement[]) =>
      statements.reduce((acc, item) => sql`${acc}${delimiter}${item}`, first),
    array<T extends InterpolatedValue>(values: T[]) {
      return sql`${sql.join(
        sql`, `,
        values.map((v) => sql`${v}`)
      )}`;
    },
    values<T extends Record<string, InterpolatedValue>>(values: T[] | T) {
      if (!Array.isArray(values)) values = [values];

      if (values.length === 0) {
        throw new Error("values must not be empty");
      }

      const keys = new Set<string>([
        ...values.map((row) => Object.keys(row)).flat(),
      ]);
      return sql`(${sql.join(
        sql`, `,
        Array.from(keys).map((key) => sql.raw(sanitizeIdentifier(key)))
      )}) values ${sql.join(
        sql`, `,
        values.map(
          (row) =>
            sql`(${sql.join(
              sql`, `,
              Object.keys(row).map((key) => sql`${row[key]}`)
            )})`
        )
      )}`;
    },
    set<T extends Record<string, InterpolatedValue>>(values: T) {
      if (Object.keys(values).length === 0) {
        throw new Error("values must not be empty");
      }

      return sql`set ${sql.join(
        sql`, `,
        Object.keys(values).map(
          (v) => sql`${sql.raw(sanitizeIdentifier(v))} = ${values[v]}`
        )
      )}`;
    },
    and<T extends Record<string, InterpolatedValue>>(values: T) {
      return sql`(${sql.join(
        sql` and `,
        Object.keys(values).map((v) =>
          values[v] === null
            ? sql`${sql.raw(sanitizeIdentifier(v))} is null`
            : sql`${sql.raw(sanitizeIdentifier(v))} = ${values[v]}`
        )
      )})`;
    },
    or<T extends Record<string, InterpolatedValue>>(values: T) {
      return sql`(${sql.join(
        sql` or `,
        Object.keys(values).map((v) =>
          values[v] === null
            ? sql`${sql.raw(sanitizeIdentifier(v))} is null`
            : sql`${sql.raw(sanitizeIdentifier(v))} = ${values[v]}`
        )
      )})`;
    },
    identifierFromDb(key: string) {
      return transformKey(key, caseMethodFromDb);
    },
    identifierToDb(key: string) {
      return transformKey(key, caseMethodToDb);
    },
  });

  return sql;
}
