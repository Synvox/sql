import Debug from "debug";
import { caseMethods, transformKey, transformKeys } from "./case";
import { escapeIdentifier, escapeLiteral } from "./escape";

export { migrate, seed, types } from "./migrations";
export { connect };

type InterpolatedValue = number | string | boolean | Date | SqlFragment | null;

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
  raw: (text: string) => SqlFragment;
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

let debugQuery = Debug("sql:query");
let debugBinding = Debug("sql:binding");
let debugTransaction = Debug("sql:transaction");
let debugError = Debug("sql:error");

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

  toNative() {
    let values: any[] = [];

    let text = this.text;

    values.push(...this.values);
    let segments = text.split(/❓/i);
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
  }
  preview() {
    let { text, values } = this.toNative();
    return text.replace(/\$\d+/g, () => escapeLiteral(String(values.shift())));
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
    let { text, values } = this.toNative();

    debugQuery(text);
    debugBinding(values);
    try {
      let result = await this.query(text, values);
      return result;
    } catch (e) {
      debugError("Query failed: ", this.preview());
      console.error(e);
      throw e;
    }
  }
  async all<T>() {
    let result = await this.exec();
    if (typeof result.rows === "undefined")
      throw new Error('Multiple statements in query, use "exec" instead.');

    let items = transformKeys(result.rows, this.options.caseMethodFromDb);

    return items as T[];
  }
  async paginate<T>({
    page = 0,
    per = 250,
  }: {
    page?: number;
    per?: number;
  } = {}): Promise<T[]> {
    page = Math.max(0, page);

    let stmt = new SqlStatement(
      this.query,
      `select paginated.* from (${this.text}) paginated limit ❓ offset ❓`,
      [...this.values, per, page * per],
      this.options
    );

    return stmt.all<T>();
  }
  async first<T>() {
    let result = await this.all<T>();
    let item = result[0];
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

let isClientInTransactionWeakMap = new WeakMap<Sql>();

function connect(
  client: Client,
  {
    caseMethod = "snake",
    deadlockRetryCount = 5,
  }: {
    caseMethod?: "snake" | "camel" | "none";
    deadlockRetryCount?: number;
  } = {}
): Sql {
  if (!(client instanceof Client)) {
    throw new Error("Invalid client");
  }

  let query = (text: string, values: InterpolatedValue[]) => {
    return client.query(text, values);
  };

  let caseMethodFromDb = caseMethods["camel"];
  let caseMethodToDb = caseMethods[caseMethod];

  let sanitizeIdentifier = (key: string) =>
    escapeIdentifier(transformKey(key, caseMethodToDb));

  function toSqlFragment(value: InterpolatedValue) {
    if (value instanceof SqlFragment) return value;

    if (value === undefined)
      throw new Error("cannot bind undefined value to query");

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
  ) {
    let state: {
      text: string;
      values: InterpolatedValue[];
    } = {
      text: "",
      values: [],
    };

    for (let index = 0; index < strings.length; index++) {
      let item = strings[index];
      state.text += item;

      // last item
      if (!(index in values)) {
        continue;
      }

      let arg = values[index];

      if (arg === undefined)
        throw new Error("cannot bind undefined value to query");

      arg = toSqlFragment(arg);
      state.text += arg.text;
      state.values.push(...arg.values);
    }

    return new SqlStatement(query, state.text, state.values, {
      caseMethodFromDb,
    });
  }

  async function transaction<T>(caller: (trxSql: Sql) => Promise<T>) {
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
      return await impureTransaction(caller);
    } catch (e) {
      if (e instanceof Error && e.message === "deadlock detected") {
        debugTransaction(`retrying transaction due to deadlock`);
        retryCount--;
        if (retryCount === 0) {
          throw e;
        }

        let delay = attemptNumber * 100;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return transactionInner(caller, retryCount, attemptNumber);
      }
      throw e;
    }
  }

  async function impureTransaction<T>(
    caller: (trxSql: Sql) => Promise<T>
  ): Promise<T> {
    return await connection(async (trxSql) => {
      let isInSubTransaction = isClientInTransactionWeakMap.has(trxSql);
      let txId = (isClientInTransactionWeakMap.get(trxSql) || 0) + 1;
      isClientInTransactionWeakMap.set(trxSql, txId);
      let txName = `tx_${txId}`;
      let id = sql.raw(txName);
      if (!isInSubTransaction) {
        debugTransaction(`begin ${txName}`);
        await trxSql`begin`.exec();
      } else {
        debugTransaction(`savepoint ${txName}`);
        await trxSql`savepoint ${id}`.exec();
      }

      try {
        let result = await caller(trxSql);
        if (isInSubTransaction) {
          debugTransaction(`release ${txName}`);
          await trxSql`release savepoint ${id}`.exec();
        } else {
          debugTransaction(`commit ${txName}`);
          await trxSql`commit`.exec();
        }
        return result;
      } catch (e) {
        if (isInSubTransaction) {
          debugTransaction(`rollback to ${txName}`);
          await trxSql`rollback to savepoint ${id}`.exec();
        } else {
          debugTransaction(`rollback ${txName}`);
          await trxSql`rollback`.exec();
        }
        throw e;
      } finally {
        if (!isInSubTransaction) isClientInTransactionWeakMap.delete(trxSql);
      }
    });
  }

  async function connection<T>(caller: (sql: Sql) => Promise<T>): Promise<T> {
    let createConnection = client instanceof Pool;
    let connectionClient = createConnection
      ? await (client as Pool).isolate()
      : client;
    let s = createConnection ? connect(connectionClient, { caseMethod }) : sql;

    try {
      return caller(s);
    } finally {
      if (connectionClient !== client && connectionClient instanceof PoolClient)
        connectionClient.release();
    }
  }

  let sql = Object.assign(sqlTemplateTag, {
    transaction,
    impureTransaction,
    connection,
    ref: (identifier: string) =>
      new SqlFragment(escapeIdentifier(identifier), []),
    raw: (text: string) => new SqlFragment(text, []),
    literal: (value: any) => new SqlFragment("❓", [value]),
    join: (delimiter: SqlFragment, [first, ...statements]: SqlFragment[]) =>
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

      let keys = new Set<string>([
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
      if (Object.keys(values).length === 0) {
        throw new Error("values must not be empty");
      }

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
      if (Object.keys(values).length === 0) {
        throw new Error("values must not be empty");
      }

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
