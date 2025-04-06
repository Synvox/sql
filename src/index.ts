import Debug from "debug";
import { caseMethods, transformKey, transformKeys } from "./case";
import { escapeIdentifier, escapeLiteral } from "./escape";
import { getRandomValues } from "crypto";

export type InterpolatedValue =
  | number
  | string
  | boolean
  | Date
  | SqlFragment
  | null;

function dedent(str: string): string {
  const matches = str.match(/^[ \t]*(?=\S)/gm);

  if (!matches) return str;

  const shortest = matches.reduce((min, current) => {
    return current.length < min.length ? current : min;
  });

  const shortestWhitespaceRegex = new RegExp(`^${shortest}`, "g");

  return str
    .split("\n")
    .map((line) => line.replace(shortestWhitespaceRegex, ""))
    .join("\n");
}

const rawSymbol = Symbol("dangerously execute raw SQL");

/**
 * The main `Sql` interface is a callable template-tag plus extra methods
 * for transactions, references, and various query helpers.
 */
export type Sql = ((
  strings: TemplateStringsArray,
  ...values: InterpolatedValue[]
) => SqlStatement) & {
  /**
   * Transactions that only affect the database. These will be retried on deadlock.
   * Otherwise use `impureTransaction` for transactions with side effects.
   */
  transaction: <T>(caller: (trxSql: Sql) => Promise<T>) => Promise<T>;
  /**
   * Transactions that have side effects outside the database.
   * Otherwise use `transaction` for database transactions. These
   * will be retried on deadlock.
   */
  impureTransaction: <T>(caller: (trxSql: Sql) => Promise<T>) => Promise<T>;
  connection: <T>(caller: (sql: Sql) => Promise<T>) => Promise<T>;
  ref: (identifier: string) => SqlFragment;
  [rawSymbol]: (text: string) => SqlFragment;
  literal: (value: any) => SqlFragment;
  join: (
    delimiter: SqlFragment,
    [first, ...statements]: SqlFragment[]
  ) => SqlFragment;
  array<T extends InterpolatedValue>(values: T[]): SqlStatement;
  values<T extends Record<string, InterpolatedValue>>(
    values: T | T[]
  ): SqlStatement;
  set<T extends Record<string, InterpolatedValue>>(values: T): SqlStatement;
  and<T extends Record<string, InterpolatedValue>>(values: T): SqlStatement;
  or<T extends Record<string, InterpolatedValue>>(values: T): SqlStatement;
  identifierFromDb(key: string): string;
  identifierToDb(key: string): string;
};

const debugQuery = Debug("sql:query");
const debugBinding = Debug("sql:binding");
const debugTransaction = Debug("sql:transaction");
const debugError = Debug("sql:error");

type QueryResult<T> = {
  rows: T[];
};

export abstract class Client {
  abstract query<T>(
    text: string,
    values: InterpolatedValue[]
  ): Promise<QueryResult<T> | QueryResult<T>[]>;
}

export abstract class Pool extends Client {
  abstract isolate(): Promise<PoolClient>;
}

export abstract class PoolClient extends Client {
  abstract release(): Promise<void>;
}

export class SqlFragment {
  text: string;
  values: InterpolatedValue[];

  constructor(text: string, values: InterpolatedValue[]) {
    this.text = text;
    this.values = values;
  }

  toNative(): { text: string; values: InterpolatedValue[] } {
    const values: InterpolatedValue[] = [];
    let text = this.text;

    values.push(...this.values);
    const segments = text.split(/❓/i);
    text = segments
      .map((segment, index) => {
        if (index + 1 === segments.length) return segment;
        return `${segment}$${index + 1}`;
      })
      .join("");

    return {
      text: dedent(text).trim(),
      values,
    };
  }

  preview(): string {
    const { text, values } = this.toNative();
    return text.replace(/\$\d+/g, () => {
      const value = values.shift();
      const str = typeof value === "string" ? value : JSON.stringify(value);
      return escapeLiteral(str);
    });
  }
}

class SqlStatement extends SqlFragment {
  query: (text: string, values: InterpolatedValue[]) => Promise<any>;
  options: {
    caseMethodFromDb: (typeof caseMethods)[keyof typeof caseMethods];
  };

  constructor(
    query: typeof SqlStatement.prototype.query,
    text: string,
    values: InterpolatedValue[],
    options?: typeof SqlStatement.prototype.options
  ) {
    super(text, values);
    this.query = query;
    this.options = {
      caseMethodFromDb: caseMethods["camel"],
      ...options,
    };
  }

  async exec() {
    const { text, values } = this.toNative();

    debugQuery(text);
    debugBinding(values);
    try {
      const result = await this.query(text, values);
      return result;
    } catch (e) {
      debugError("Query failed: ", this.preview());
      console.error(e);
      throw e;
    }
  }

  async all<T>() {
    const result = await this.exec();
    if (typeof result.rows === "undefined") {
      throw new Error('Multiple statements in query; use "exec" instead.');
    }
    const items = transformKeys(result.rows, this.options.caseMethodFromDb);
    return items as T[];
  }

  async paginate<T>({
    page = 0,
    per = 250,
  }: {
    page?: number;
    per?: number;
  } = {}): Promise<T[]> {
    const safePage = Math.max(0, page);

    const stmt = new SqlStatement(
      this.query,
      `select paginated.* from (${this.text}) paginated limit ❓ offset ❓`,
      [...this.values, per, safePage * per],
      this.options
    );

    return stmt.all<T>();
  }

  async first<T>() {
    const result = await this.all<T>();
    const item = result[0];
    return item as T;
  }

  async count() {
    const stmt = new SqlStatement(
      this.query,
      `select count(*) from (${this.text}) count`,
      this.values,
      this.options
    );
    const result = await stmt.first<{ count: number }>();
    return Number(result.count);
  }

  async exists() {
    const stmt = new SqlStatement(
      this.query,
      `select exists(${this.text})`,
      this.values,
      this.options
    );
    const result = await stmt.first<{ exists: boolean }>();
    return result.exists;
  }
}

/**
 * Connects a Client (or Pool) with a custom configuration to create a new Sql instance.
 */
export function connect(
  client: Client,
  {
    caseMethod = "snake",
    deadlockRetryCount = 5,
    beginTransactionCommand = new SqlFragment("begin", []),
    rollbackTransactionCommand = new SqlFragment("rollback", []),
    commitTransactionCommand = new SqlFragment("commit", []),
    signal,
  }: {
    caseMethod?: "snake" | "camel" | "none";
    deadlockRetryCount?: number;
    beginTransactionCommand?: SqlFragment;
    rollbackTransactionCommand?: SqlFragment;
    commitTransactionCommand?: SqlFragment;
    signal?: AbortSignal;
  } = {}
): Sql {
  if (!(client instanceof Client)) {
    throw new Error("Invalid client");
  }

  function queryFn(text: string, values: InterpolatedValue[]) {
    signal?.throwIfAborted();
    return client.query(text, values);
  }

  const caseMethodFromDb = caseMethods["camel"];
  const caseMethodToDb = caseMethods[caseMethod];

  function sanitizeIdentifier(key: string): string {
    return escapeIdentifier(transformKey(key, caseMethodToDb));
  }

  function toSqlFragment(value: InterpolatedValue): SqlFragment {
    if (value instanceof SqlFragment) {
      return value;
    }
    if (value === undefined) {
      throw new Error("cannot bind undefined value to query");
    }
    if (
      typeof value === "object" &&
      value !== null &&
      !(value instanceof Date)
    ) {
      throw new Error("invalid value in query: " + JSON.stringify(value));
    }
    return new SqlFragment("❓", [value]);
  }

  function sqlTemplateTag(
    strings: TemplateStringsArray,
    ...values: InterpolatedValue[]
  ): SqlStatement {
    const state: { text: string; values: InterpolatedValue[] } = {
      text: "",
      values: [],
    };

    for (let index = 0; index < strings.length; index++) {
      state.text += strings[index];

      // Not beyond the last interpolation
      if (!(index in values)) {
        continue;
      }

      const arg = values[index];
      if (arg === undefined) {
        throw new Error("cannot bind undefined value to query");
      }

      const fragment = toSqlFragment(arg);
      state.text += fragment.text;
      state.values.push(...fragment.values);
    }

    return new SqlStatement(queryFn, state.text, state.values, {
      caseMethodFromDb,
    });
  }

  function transactionFn<T>(caller: (trxSql: Sql) => Promise<T>): Promise<T> {
    return transactionInner(caller);
  }

  async function transactionInner<T>(
    caller: (trxSql: Sql) => Promise<T>,
    retryCount = deadlockRetryCount,
    attemptNumber = 1
  ): Promise<T> {
    if (retryCount <= 0) {
      throw new Error("transaction failed due to deadlock");
    }

    try {
      return await impureTransactionFn(caller);
    } catch (e) {
      if (e instanceof Error && e.message === "deadlock detected") {
        debugTransaction(`retrying transaction due to deadlock`);
        retryCount--;
        if (retryCount === 0) {
          throw e;
        }

        const delay = attemptNumber * 100;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return transactionInner(caller, retryCount, attemptNumber + 1);
      }
      throw e;
    }
  }

  function impureTransactionFn<T>(
    caller: (trxSql: Sql) => Promise<T>
  ): Promise<T> {
    const txId = getRandomValues(new Uint32Array(1))[0].toString(16);
    const txName = `tx_${txId}`;
    const controller = new AbortController();
    const signal = controller.signal;

    return connectionFn(
      async (trxSql) => {
        await trxSql`${beginTransactionCommand}`.exec();

        try {
          const result = await caller(trxSql);
          await trxSql`${commitTransactionCommand}`.exec();
          return result;
        } catch (e) {
          await trxSql`${rollbackTransactionCommand}`.exec();
          throw e;
        } finally {
          controller.abort();
        }
      },
      {
        beginTransactionCommand: sql`${new SqlFragment(`savepoint ${txName}`, [])}`,
        rollbackTransactionCommand: sql`${new SqlFragment(`rollback to ${txName}`, [])}`,
        commitTransactionCommand: sql`${new SqlFragment(`release ${txName}`, [])}`,
        signal,
      }
    );
  }

  async function connectionFn<T>(
    caller: (sql: Sql) => Promise<T>,
    {
      beginTransactionCommand,
      rollbackTransactionCommand,
      commitTransactionCommand,
      signal,
    }: {
      beginTransactionCommand?: SqlFragment;
      rollbackTransactionCommand?: SqlFragment;
      commitTransactionCommand?: SqlFragment;
      signal?: AbortSignal;
    } = {}
  ): Promise<T> {
    const createConnection = client instanceof Pool;
    const connectionClient = createConnection
      ? await (client as Pool).isolate()
      : client;

    const s = createConnection
      ? connect(connectionClient, {
          caseMethod,
          beginTransactionCommand,
          rollbackTransactionCommand,
          commitTransactionCommand,
          signal,
        })
      : sql;

    try {
      return caller(s);
    } finally {
      if (
        connectionClient !== client &&
        connectionClient instanceof PoolClient
      ) {
        connectionClient.release();
      }
    }
  }

  // Build the `sql` object. It's a tag function plus extra methods.
  const sql = Object.assign(sqlTemplateTag, {
    transaction: transactionFn,
    impureTransaction: impureTransactionFn,
    connection: connectionFn,

    ref(identifier: string): SqlFragment {
      return new SqlFragment(escapeIdentifier(identifier), []);
    },

    [rawSymbol](text: string): SqlFragment {
      return new SqlFragment(text, []);
    },

    literal(value: any): SqlFragment {
      return new SqlFragment("❓", [value]);
    },

    join(
      delimiter: SqlFragment,
      [first, ...statements]: SqlFragment[]
    ): SqlFragment {
      return statements.reduce(
        (acc, item) => sql`${acc}${delimiter}${item}`,
        first
      );
    },

    array<T extends InterpolatedValue>(values: T[]): SqlStatement {
      return sql`${sql.join(
        sql`, `,
        values.map((v) => sql`${v}`)
      )}`;
    },

    values<T extends Record<string, InterpolatedValue>>(
      vals: T | T[]
    ): SqlStatement {
      const _vals = Array.isArray(vals) ? vals : [vals];
      if (_vals.length === 0) {
        throw new Error("values must not be empty");
      }

      const keys = new Set<string>([
        ..._vals.map((row) => Object.keys(row)).flat(),
      ]);

      return sql`(${sql.join(
        sql`, `,
        Array.from(keys).map((key) => sql[rawSymbol](sanitizeIdentifier(key)))
      )}) values ${sql.join(
        sql`, `,
        _vals.map(
          (row) =>
            sql`(${sql.join(
              sql`, `,
              Object.keys(row).map((key) => sql`${row[key]}`)
            )})`
        )
      )}`;
    },

    set<T extends Record<string, InterpolatedValue>>(values: T): SqlStatement {
      if (Object.keys(values).length === 0) {
        throw new Error("values must not be empty");
      }
      return sql`set ${sql.join(
        sql`, `,
        Object.keys(values).map(
          (v) => sql`${sql[rawSymbol](sanitizeIdentifier(v))} = ${values[v]}`
        )
      )}`;
    },

    and<T extends Record<string, InterpolatedValue>>(values: T): SqlStatement {
      if (Object.keys(values).length === 0) {
        throw new Error("values must not be empty");
      }
      return sql`(${sql.join(
        sql` and `,
        Object.keys(values).map((v) =>
          values[v] === null
            ? sql`${sql[rawSymbol](sanitizeIdentifier(v))} is null`
            : sql`${sql[rawSymbol](sanitizeIdentifier(v))} = ${values[v]}`
        )
      )})`;
    },

    or<T extends Record<string, InterpolatedValue>>(values: T): SqlStatement {
      if (Object.keys(values).length === 0) {
        throw new Error("values must not be empty");
      }
      return sql`(${sql.join(
        sql` or `,
        Object.keys(values).map((v) =>
          values[v] === null
            ? sql`${sql[rawSymbol](sanitizeIdentifier(v))} is null`
            : sql`${sql[rawSymbol](sanitizeIdentifier(v))} = ${values[v]}`
        )
      )})`;
    },

    identifierFromDb(key: string): string {
      return transformKey(key, caseMethodFromDb);
    },

    identifierToDb(key: string): string {
      return transformKey(key, caseMethodToDb);
    },
  });

  return sql;
}
